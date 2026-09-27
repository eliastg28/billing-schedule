/**
 * =============================================================================
 *  CICLO DE TARJETAS · app.js
 * -----------------------------------------------------------------------------
 *  SPA en JavaScript puro (ES6+), sin dependencias, para gestionar tarjetas de
 *  crédito:
 *    - Recomienda la mejor tarjeta para comprar HOY (se actualiza sola a medianoche).
 *    - Simula compras en cualquier fecha y muestra el "mapa del mes".
 *    - Calendario con inicios de ciclo, cierres y fechas límite de pago.
 *    - CRUD de tarjetas persistido en LocalStorage (con exportar / importar).
 *
 *  Modelo de una tarjeta:
 *    { id: string, name: string, closingDay: 1-31, paymentDay: 1-31, color: '#rrggbb' }
 *
 *  Reglas de cálculo:
 *    1. La facturación cierra el día `closingDay` de cada mes. Si el mes es más
 *       corto (ej. cierre 31 en febrero), se usa el último día del mes.
 *       Una compra hecha el mismo día del cierre entra en ese estado de cuenta.
 *    2. El ciclo nuevo inicia el día siguiente al cierre: es el MEJOR día para
 *       comprar porque maximiza los días de crédito sin intereses.
 *    3. La fecha límite de pago es el primer `paymentDay` POSTERIOR al cierre
 *       (normalmente en el mes siguiente al cierre).
 *       Ej.: cierre 26/09 → compras desde el 27/09 → cierre 26/10 → pago 20/11.
 *    4. Las tarjetas se ordenan por días de crédito (compra → fecha de pago).
 * =============================================================================
 */
'use strict';

(() => {
  // #region 1. CONFIGURACIÓN Y CONSTANTES ======================================

  /** Claves usadas en LocalStorage. */
  const STORAGE_KEYS = Object.freeze({
    cards: 'ciclo-tarjetas:cards:v1',
    theme: 'ciclo-tarjetas:theme',
  });

  /** Tarjetas precargadas la primera vez que se abre la app. */
  const DEFAULT_CARDS = [
    { id: 'falabella', name: 'Falabella', closingDay: 9, paymentDay: 5, color: '#9ccc3c' },
    { id: 'bcp', name: 'BCP', closingDay: 26, paymentDay: 20, color: '#ff7a00' },
    { id: 'interbank', name: 'Interbank', closingDay: 24, paymentDay: 20, color: '#1e88e5' },
  ];

  /** Paleta sugerida en el formulario de tarjetas. */
  const PRESET_COLORS = [
    '#ff7a00', '#1e88e5', '#9ccc3c', '#e53935', '#8e24aa', '#00acc1',
    '#fbc02d', '#ec407a', '#43a047', '#5c6bc0', '#8d6e63', '#78909c',
  ];

  const ROUTES = ['inicio', 'simulador', 'calendario', 'tarjetas', 'reglas'];
  const ROUTE_TITLES = {
    inicio: '¿Con qué tarjeta compro hoy?',
    simulador: 'Simulador de compras',
    calendario: 'Calendario de facturación',
    tarjetas: 'Mis tarjetas',
    reglas: 'Reglas de oro',
  };

  const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const WEEK_INITIALS = ['L', 'M', 'M', 'J', 'V', 'S', 'D']; // La semana empieza en lunes

  /** Tipos de evento del calendario. */
  const EVENT_META = {
    start: { icon: '🟢', label: 'Inicio de ciclo', hint: 'mejor día para comprar', order: 0 },
    closing: { icon: '🔴', label: 'Cierre de facturación', hint: 'último día del ciclo', order: 1 },
    payment: { icon: '⚠️', label: 'Fecha límite de pago', hint: 'paga el total', order: 2 },
  };

  /** Calidad de la recomendación según los días de crédito sin intereses. */
  const TIERS = [
    { min: 45, key: 'excelente', label: 'Excelente' },
    { min: 35, key: 'buena', label: 'Buena' },
    { min: 25, key: 'regular', label: 'Regular' },
    { min: -Infinity, key: 'evitar', label: 'Evitar' },
  ];

  /** Reglas de oro. Las marcadas con `core` se muestran siempre en la portada. */
  const RULES = [
    {
      core: true,
      icon: '💳',
      title: 'Compra siempre en 1 sola cuota',
      text: 'Si compras en <b>1 cuota</b> y pagas el total del estado de cuenta antes de la fecha límite, pagas <b>0% de intereses</b>. Las compras en cuotas suelen generar intereses desde la primera cuota.',
    },
    {
      core: true,
      icon: '🚫',
      title: 'Evita retirar efectivo',
      text: 'La disposición de efectivo cobra comisión y genera intereses <b>desde el primer día</b>, sin periodo de gracia. Para efectivo, usa tu tarjeta de débito.',
    },
    {
      core: true,
      icon: '📅',
      title: 'El pago se hace el mes siguiente al cierre',
      text: 'Lo que compras hasta el día de cierre llega en ese estado de cuenta y se paga en el <b>mes siguiente al cierre</b>. Por eso, comprar justo después del cierre te da el máximo plazo (~50–55 días).',
    },
    {
      icon: '💯',
      title: 'Paga el total, nunca solo el mínimo',
      text: 'El 0% de intereses solo aplica si pagas el <b>total</b> del estado de cuenta. Pagar el mínimo o un monto parcial genera intereses sobre el saldo pendiente.',
    },
    {
      icon: '⏰',
      title: 'Paga unos días antes del vencimiento',
      text: 'Si la fecha límite cae en fin de semana o feriado, adelanta el pago. Las transferencias entre bancos pueden tardar en procesarse.',
    },
    {
      icon: '📊',
      title: 'No uses toda tu línea',
      text: 'Mantén tu consumo por debajo del <b>30–40%</b> de tu línea de crédito: cuidas tu historial crediticio y te queda margen para imprevistos.',
    },
    {
      icon: '🧾',
      title: 'Revisa cada estado de cuenta',
      text: 'Verifica consumos, comisiones y la fecha límite real. Los bancos pueden ajustar fechas: esta app es una guía, <b>tu estado de cuenta manda</b>.',
    },
    {
      icon: '🔔',
      title: 'Automatiza el pago total',
      text: 'Programa un recordatorio o el débito automático del <b>pago total</b> para no olvidar ninguna fecha límite.',
    },
  ];

  // #endregion 1.

  // #region 2. UTILIDADES DE FECHA =============================================
  // Todas las fechas se manejan como objetos Date en hora local a las 00:00.

  const MS_PER_DAY = 86400000;
  const pad2 = (n) => String(n).padStart(2, '0');
  const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  /** Devuelve la fecha sin la hora (00:00 local). */
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  /** Cantidad de días de un mes (month: 0-11). */
  const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();

  /**
   * Crea una fecha ajustando el día al último del mes si no existe
   * (ej. 31 de febrero → 28/29 de febrero). Acepta meses fuera de rango
   * (-1 = diciembre del año anterior, 12 = enero del siguiente), lo que
   * resuelve automáticamente los saltos de mes y de año.
   */
  function safeDate(year, month, day) {
    const base = new Date(year, month, 1);
    const y = base.getFullYear();
    const m = base.getMonth();
    return new Date(y, m, Math.min(day, daysInMonth(y, m)));
  }

  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

  /** Días enteros entre `a` y `b` (b - a). Usa UTC para ignorar cambios de horario. */
  function diffDays(a, b) {
    const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
    const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
    return Math.round((utcB - utcA) / MS_PER_DAY);
  }

  const isSameDay = (a, b) => diffDays(a, b) === 0;

  /** Date → 'AAAA-MM-DD' (formato de <input type="date">). */
  const toISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

  /** 'AAAA-MM-DD' → Date local, o null si el texto no es una fecha válida. */
  function fromISO(text) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
    if (!match) return null;
    const [, y, m, d] = match.map(Number);
    const date = new Date(y, m - 1, d);
    return date.getMonth() === m - 1 && date.getDate() === d ? date : null;
  }

  /** 26/09 */
  const fmtShort = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;

  /** 20 de noviembre (agrega el año si difiere del de `ref`). */
  function fmtLong(d, ref) {
    const text = `${d.getDate()} de ${MONTHS[d.getMonth()]}`;
    return ref && ref.getFullYear() !== d.getFullYear() ? `${text} de ${d.getFullYear()}` : text;
  }

  /** sábado 26 de septiembre */
  const fmtWeekday = (d, ref) => `${WEEKDAYS[d.getDay()]} ${fmtLong(d, ref)}`;

  /** Sábado, 26 de septiembre de 2026 */
  const fmtFull = (d) => `${capitalize(WEEKDAYS[d.getDay()])}, ${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`;

  /** "hoy", "mañana", "en 3 días", "hace 2 días"… respecto de `ref`. */
  function relativeDay(date, ref) {
    const n = diffDays(ref, date);
    if (n === 0) return 'hoy';
    if (n === 1) return 'mañana';
    if (n === -1) return 'ayer';
    return n > 0 ? `en ${n} días` : `hace ${-n} días`;
  }

  // #endregion 2.

  // #region 3. MOTOR DE CÁLCULO DE CICLOS ======================================

  const isValidDay = (n) => Number.isInteger(n) && n >= 1 && n <= 31;

  /** Fecha de cierre de una tarjeta en un mes dado (month puede salirse de 0-11). */
  const closingDateIn = (card, year, month) => safeDate(year, month, card.closingDay);

  /** Fecha límite de pago de un estado de cuenta: primer `paymentDay` posterior al cierre. */
  function paymentDateFor(card, closing) {
    let due = safeDate(closing.getFullYear(), closing.getMonth(), card.paymentDay);
    if (diffDays(closing, due) <= 0) {
      due = safeDate(closing.getFullYear(), closing.getMonth() + 1, card.paymentDay);
    }
    return due;
  }

  /**
   * Analiza en qué ciclo cae una compra hecha el día `date` con la tarjeta `card`.
   * @returns {{
   *   purchase: Date, cycleStart: Date, closing: Date, prevClosing: Date,
   *   payment: Date, nextCycleStart: Date, cycleLength: number,
   *   daysSinceStart: number, daysToClosing: number,
   *   financingDays: number, maxFinancingDays: number
   * }}
   */
  function getCycleInfo(card, date) {
    const purchase = startOfDay(date);

    // Cierre del ciclo actual: el de este mes o, si ya pasó, el del mes siguiente.
    let closing = closingDateIn(card, purchase.getFullYear(), purchase.getMonth());
    if (diffDays(purchase, closing) < 0) {
      closing = closingDateIn(card, purchase.getFullYear(), purchase.getMonth() + 1);
    }

    const prevClosing = closingDateIn(card, closing.getFullYear(), closing.getMonth() - 1);
    const cycleStart = addDays(prevClosing, 1);
    const payment = paymentDateFor(card, closing);

    return {
      purchase,
      cycleStart,
      closing,
      prevClosing,
      payment,
      nextCycleStart: addDays(closing, 1),
      cycleLength: diffDays(cycleStart, closing) + 1,
      daysSinceStart: diffDays(cycleStart, purchase),
      daysToClosing: diffDays(purchase, closing),
      financingDays: diffDays(purchase, payment),
      maxFinancingDays: diffDays(cycleStart, payment),
    };
  }

  /**
   * Ordena las tarjetas de la mejor a la peor para una compra en `date`.
   * Criterio: más días de crédito. En empate, la que cierra más tarde
   * (deja más margen para seguir comprando en el mismo ciclo).
   */
  function rankCards(cards, date) {
    return cards
      .map((card) => ({ card, info: getCycleInfo(card, date) }))
      .sort((a, b) =>
        b.info.financingDays - a.info.financingDays ||
        b.info.daysToClosing - a.info.daysToClosing ||
        a.card.name.localeCompare(b.card.name, 'es'));
  }

  const getTier = (days) => TIERS.find((tier) => days >= tier.min);

  /** Próximo inicio de ciclo (de cualquier tarjeta) posterior a `date`. */
  function nextCycleStart(cards, date) {
    let best = null;
    for (const card of cards) {
      const start = getCycleInfo(card, date).nextCycleStart;
      const info = getCycleInfo(card, start);
      const earlier = !best || diffDays(start, best.date) > 0;
      const tieButBetter = best && isSameDay(start, best.date) && info.financingDays > best.info.financingDays;
      if (earlier || tieButBetter) best = { card, date: start, info };
    }
    return best;
  }

  /**
   * Genera los eventos (inicio de ciclo, cierre, pago) de las tarjetas entre
   * `from` y `to` (ambos inclusive), ordenados por fecha.
   */
  function getEventsInRange(cards, from, to) {
    const events = [];
    // Se revisan cierres desde 2 meses antes hasta 1 mes después del rango:
    // así se capturan pagos e inicios que caen dentro del rango.
    const firstIndex = from.getFullYear() * 12 + from.getMonth() - 2;
    const lastIndex = to.getFullYear() * 12 + to.getMonth() + 1;
    const inRange = (d) => diffDays(from, d) >= 0 && diffDays(d, to) >= 0;

    for (const card of cards) {
      for (let index = firstIndex; index <= lastIndex; index++) {
        const closing = closingDateIn(card, Math.floor(index / 12), index % 12);
        const payment = paymentDateFor(card, closing);
        const start = addDays(closing, 1);
        if (inRange(closing)) events.push({ type: 'closing', date: closing, card, closing, payment });
        if (inRange(start)) events.push({ type: 'start', date: start, card });
        if (inRange(payment)) events.push({ type: 'payment', date: payment, card, closing });
      }
    }

    return events.sort((a, b) =>
      a.date - b.date ||
      EVENT_META[a.type].order - EVENT_META[b.type].order ||
      a.card.name.localeCompare(b.card.name, 'es'));
  }

  /** true si el pago vence en el mismo mes del cierre (paymentDay > closingDay). */
  function paysSameMonth(card) {
    const closing = closingDateIn(card, 2025, 0); // enero tiene 31 días
    return paymentDateFor(card, closing).getMonth() === closing.getMonth();
  }

  /** Día del mes a partir del cual conviene comprar (día siguiente al cierre). */
  const bestDayOfMonth = (card) => (card.closingDay >= 31 ? 1 : card.closingDay + 1);

  // #endregion 3.

  // #region 4. ESTADO Y PERSISTENCIA ===========================================

  const state = {
    cards: [],
    today: startOfDay(new Date()),
    simDate: null,
    calYear: 0,
    calMonth: 0,
    calSelected: null,
    calHidden: new Set(), // ids de tarjetas ocultas en el calendario
    editingId: null, // id de la tarjeta que se edita (null = nueva)
  };

  const HEX_COLOR = /^#[0-9a-f]{6}$/i;

  const uid = () =>
    window.crypto && typeof window.crypto.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  function storageGet(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function storageSet(key, value) {
    try {
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  }

  const cloneDefaults = () => DEFAULT_CARDS.map((card) => ({ ...card }));

  /** Valida y normaliza una tarjeta (datos guardados o importados). */
  function sanitizeCard(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const name = String(raw.name ?? '').trim().slice(0, 24);
    const closingDay = Number(raw.closingDay);
    const paymentDay = Number(raw.paymentDay);
    if (!name || !isValidDay(closingDay) || !isValidDay(paymentDay)) return null;
    const color = HEX_COLOR.test(String(raw.color)) ? String(raw.color).toLowerCase() : PRESET_COLORS[0];
    const id = typeof raw.id === 'string' && /^[\w-]{1,64}$/.test(raw.id) ? raw.id : uid();
    return { id, name, closingDay, paymentDay, color };
  }

  /** Sanea una lista de tarjetas y garantiza ids únicos. */
  function normalizeCards(list) {
    const seen = new Set();
    return list
      .map(sanitizeCard)
      .filter(Boolean)
      .map((card) => {
        if (seen.has(card.id)) card.id = uid();
        seen.add(card.id);
        return card;
      });
  }

  function loadCards() {
    const raw = storageGet(STORAGE_KEYS.cards);
    if (raw === null) {
      // Primera visita: se guardan las tarjetas iniciales.
      const cards = cloneDefaults();
      storageSet(STORAGE_KEYS.cards, JSON.stringify(cards));
      return cards;
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new TypeError('Formato inválido');
      return normalizeCards(parsed);
    } catch (err) {
      console.warn('No se pudieron leer las tarjetas guardadas; se usan las iniciales.', err);
      return cloneDefaults();
    }
  }

  function saveCards() {
    if (!storageSet(STORAGE_KEYS.cards, JSON.stringify(state.cards))) {
      toast('No se pudo guardar: el almacenamiento del navegador está bloqueado.', 'error');
    }
  }

  // #endregion 4.

  // #region 5. HELPERS DE INTERFAZ =============================================

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

  const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  /** Escapa texto del usuario antes de insertarlo en HTML. */
  const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

  const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

  const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  function focusSelector(selector) {
    const el = $(selector);
    if (el) el.focus({ preventScroll: true });
  }

  /* ---- Colores de tarjeta -------------------------------------------------- */

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }

  function relativeLuminance({ r, g, b }) {
    const lin = (v) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  }

  const darken = ({ r, g, b }, amount) => {
    const k = 1 - amount;
    return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
  };

  const colorVarsCache = new Map();

  /**
   * Variables CSS derivadas del color de la tarjeta:
   * --c (color), --c-rgb (para transparencias), --c-dark / --c-deep (fondos
   * de la tarjeta visual) y --c-ink (texto legible sobre el color sólido).
   */
  function cardVars(card) {
    const hex = card.color;
    if (!colorVarsCache.has(hex)) {
      const rgb = hexToRgb(hex);
      colorVarsCache.set(hex, [
        `--c:${hex}`,
        `--c-rgb:${rgb.r},${rgb.g},${rgb.b}`,
        `--c-dark:${darken(rgb, 0.4)}`,
        `--c-deep:${darken(rgb, 0.72)}`,
        `--c-ink:${relativeLuminance(rgb) > 0.179 ? '#0a0d14' : '#ffffff'}`,
      ].join(';'));
    }
    return colorVarsCache.get(hex);
  }

  /* ---- Toasts -------------------------------------------------------------- */

  function toast(message, type = 'info') {
    const region = $('#toast-region');
    if (!region) return;
    const el = document.createElement('div');
    el.className = `toast toast--${type}`;
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.textContent = message;
    region.append(el);
    requestAnimationFrame(() => el.classList.add('is-visible'));
    setTimeout(() => {
      el.classList.remove('is-visible');
      setTimeout(() => el.remove(), 300);
    }, 3200);
  }

  /* ---- Diálogo de confirmación (devuelve una promesa) ---------------------- */

  function confirmDialog({ title, message, confirmText = 'Confirmar', danger = true }) {
    const dialog = $('#confirm-dialog');
    $('#confirm-title').textContent = title;
    $('#confirm-message').textContent = message;
    const okButton = $('#confirm-ok');
    okButton.textContent = confirmText;
    okButton.className = `btn ${danger ? 'btn--danger' : 'btn--primary'}`;
    dialog.returnValue = '';
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
    });
  }

  /* ---- Piezas reutilizables ------------------------------------------------ */

  /** Tarjeta de crédito visual. */
  function miniCardHTML(card) {
    return `
      <div class="mini-card" style="${cardVars(card)}">
        <div class="mini-card-top">
          <span class="mini-card-chip"></span>
          <svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8.5 7.5a6 6 0 0 1 0 9M12 5a9.5 9.5 0 0 1 0 14M15.5 2.5a13 13 0 0 1 0 19"/></svg>
        </div>
        <div>
          <span class="mini-card-name">${esc(card.name)}</span>
          <span class="mini-card-meta">Cierre ${pad2(card.closingDay)} · Pago ${pad2(card.paymentDay)}</span>
        </div>
      </div>`;
  }

  const noteHTML = (emoji, html, variant = '') =>
    `<p class="note ${variant ? `note--${variant}` : ''}"><span class="note-icon" aria-hidden="true">${emoji}</span><span>${html}</span></p>`;

  function emptyStateHTML() {
    return `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">💳</div>
        <h2>Aún no tienes tarjetas</h2>
        <p>Agrega tus tarjetas de crédito con su día de cierre y su día de pago para recibir recomendaciones.</p>
        <button type="button" class="btn btn--primary" data-action="add-card">${icon('plus')}Agregar tarjeta</button>
      </div>`;
  }

  function joinNames(cards) {
    const names = cards.map((c) => `<strong>${esc(c.name)}</strong>`);
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}` : names[0];
  }

  // #endregion 5.

  // #region 6. RECOMENDADOR (HERO + RANKING) ===================================

  /** Describe en qué punto del ciclo cae la compra. */
  function cyclePhrase(info, isToday) {
    const s = info.daysSinceStart;
    const c = info.daysToClosing;
    const start = fmtShort(info.cycleStart);
    const prev = fmtShort(info.prevClosing);
    const close = fmtShort(info.closing);

    if (s === 0) {
      return isToday
        ? `tu facturación cerró ayer (${prev}) y hoy inicia un nuevo ciclo`
        : `ese día inicia un nuevo ciclo (la facturación cerró el ${prev})`;
    }
    if (c <= 3 && s > 3) {
      if (c === 0) {
        return isToday
          ? `tu facturación cierra hoy (${close}) y la compra entra en el estado de cuenta actual`
          : `la facturación cierra ese mismo día (${close}) y la compra entra en ese estado de cuenta`;
      }
      return `${isToday ? 'tu' : 'la'} facturación cierra en ${plural(c, 'día', 'días')} (${close})`;
    }
    if (s === 1) {
      return isToday ? `tu ciclo recién inició ayer (${start})` : `el ciclo recién inició el día anterior (${start})`;
    }
    if (s <= 6) {
      return isToday
        ? `tu ciclo inició hace apenas ${s} días (${start})`
        : `el ciclo lleva apenas ${s} días (inició el ${start})`;
    }
    return `${isToday ? 'tu' : 'el'} ciclo inició el ${start} y cierra el ${close}`;
  }

  /** Frase principal de la recomendación. */
  function buildReason({ card, info }, date, isToday) {
    const intro = isToday ? `Hoy es ${fmtWeekday(date)}. Si usas` : `Para una compra el ${fmtWeekday(date)}: si usas`;
    const closingSoon = info.daysToClosing <= 3 && info.daysSinceStart > 3;
    const connector = closingSoon ? 'así que solo tendrás' : 'por lo que tendrás hasta';
    return `${intro} <strong>${esc(card.name)}</strong>, ${cyclePhrase(info, isToday)}, ${connector} <strong>${plural(info.financingDays, 'día', 'días')} de crédito libre de intereses</strong> para pagar hasta el <strong>${fmtLong(info.payment, date)}</strong>.`;
  }

  function closingPhrase(info, isToday) {
    const c = info.daysToClosing;
    if (c === 0) return `cierra su facturación ${isToday ? 'hoy' : 'ese mismo día'} (${fmtShort(info.closing)}).`;
    if (c === 1) return `cierra su facturación ${isToday ? 'mañana' : 'al día siguiente'} (${fmtShort(info.closing)}).`;
    return `cierra su facturación en ${c} días (${fmtShort(info.closing)}).`;
  }

  /** Tarjeta principal con la mejor opción para `date`. */
  function heroHTML(ranked, date, isToday) {
    const best = ranked[0];
    const { card, info } = best;
    const tier = getTier(info.financingDays);
    const notes = [];

    // Empates: otras tarjetas con los mismos días de crédito.
    const ties = ranked.slice(1).filter((r) => r.info.financingDays === info.financingDays);
    if (ties.length) {
      notes.push(noteHTML('🤝', `${joinNames(ties.map((r) => r.card))} ${ties.length > 1 ? 'también te dan' : 'también te da'} <strong>${info.financingDays} días</strong> (pago el ${fmtShort(info.payment)}). Puedes usar cualquiera.`));
    }

    // Advertencia sobre la peor opción si está por cerrar.
    const worst = ranked[ranked.length - 1];
    if (
      ranked.length > 1 &&
      worst.info.financingDays < info.financingDays &&
      (worst.info.daysToClosing <= 3 || getTier(worst.info.financingDays).key === 'evitar')
    ) {
      notes.push(noteHTML('⛔', `Evita <strong>${esc(worst.card.name)}</strong>: ${closingPhrase(worst.info, isToday)} Pagarías el ${fmtLong(worst.info.payment, date)} (solo ${plural(worst.info.financingDays, 'día', 'días')}).`, 'warn'));
    }

    // Consejo: si ninguna tarjeta está en su mejor momento, sugerir esperar.
    if (tier.key !== 'excelente') {
      const next = nextCycleStart(state.cards, date);
      if (next && next.info.financingDays > info.financingDays) {
        notes.push(noteHTML('💡', `Si puedes esperar: el <strong>${fmtWeekday(next.date, date)}</strong> inicia el ciclo de <strong>${esc(next.card.name)}</strong> y tendrías <strong>${next.info.financingDays} días</strong> de crédito.`, 'tip'));
      }
    }

    if (!isToday && diffDays(state.today, date) < 0) {
      notes.push(noteHTML('📅', 'Esta fecha ya pasó: el cálculo es solo referencial.', 'info'));
    }

    return `
      <article class="hero" style="${cardVars(card)}">
        <div class="hero-top">
          <p class="eyebrow">⭐ ${isToday ? 'Mejor tarjeta para comprar hoy' : `Mejor tarjeta para el ${fmtShort(date)}`}</p>
          <span class="badge badge--${tier.key}">${tier.label}</span>
        </div>
        <div class="hero-main">
          ${miniCardHTML(card)}
          <div class="hero-days">
            <span class="hero-days-num">${info.financingDays}</span>
            <span class="hero-days-label">días de crédito<br />sin intereses</span>
          </div>
        </div>
        <p class="hero-reason">${buildReason(best, date, isToday)}</p>
        <ol class="timeline" aria-label="Línea de tiempo de la compra">
          <li><span class="tl-label">${isToday ? 'Compras hoy' : 'Compras'}</span><strong>${fmtShort(date)}</strong></li>
          <li><span class="tl-label">Cierra</span><strong>${fmtShort(info.closing)}</strong></li>
          <li><span class="tl-label">Pagas hasta</span><strong>${fmtShort(info.payment)}</strong></li>
        </ol>
        ${notes.length ? `<div class="notes">${notes.join('')}</div>` : ''}
      </article>`;
  }

  /** Estado corto de cada tarjeta dentro del ranking. */
  function statusText(info, isToday) {
    const s = info.daysSinceStart;
    const c = info.daysToClosing;
    const that = isToday ? 'hoy' : 'ese día';
    let text;
    if (s === 0) text = `🟢 Ciclo inicia ${that}: plazo máximo`;
    else if (c === 0) text = `🔴 Cierra ${that}: pagarías pronto`;
    else if (c === 1) text = `🔴 Cierra ${isToday ? 'mañana' : 'al día siguiente'}`;
    else if (c <= 5) text = `⏳ Cierra en ${c} días`;
    else text = `Día ${s + 1} de ${info.cycleLength} del ciclo`;
    return `${text} · pagas el ${fmtShort(info.payment)}`;
  }

  /** Barra: [ciclo abierto | periodo de gracia] con marcador en la fecha de compra. */
  function cycleBarHTML(info) {
    const total = info.maxFinancingDays + 1;
    const openWidth = (info.cycleLength / total) * 100;
    const marker = ((info.daysSinceStart + 0.5) / total) * 100;
    const label = `Compra en el día ${info.daysSinceStart + 1} de ${info.cycleLength} del ciclo. Cierre ${fmtShort(info.closing)}, pago ${fmtShort(info.payment)}.`;
    return `
      <div class="cycle-bar" role="img" aria-label="${label}">
        <span class="cycle-seg cycle-seg--open" style="width:${openWidth.toFixed(2)}%"></span>
        <span class="cycle-seg cycle-seg--grace" style="width:${(100 - openWidth).toFixed(2)}%"></span>
        <span class="cycle-elapsed" style="width:${marker.toFixed(2)}%"></span>
        <span class="cycle-marker" style="left:${marker.toFixed(2)}%"></span>
      </div>
      <div class="cycle-labels">
        <span>Inicio ${fmtShort(info.cycleStart)}</span>
        <span>Cierre ${fmtShort(info.closing)}</span>
        <span>Pago ${fmtShort(info.payment)}</span>
      </div>`;
  }

  function rankingHTML(ranked, isToday) {
    if (!ranked.length) {
      return `<li class="empty-inline">Aún no tienes tarjetas. <button type="button" class="link-btn" data-action="add-card">Agrega una</button>.</li>`;
    }
    return ranked
      .map(({ card, info }, i) => {
        const tier = getTier(info.financingDays);
        let badge = tier.label;
        if (i === 0) badge = 'Mejor opción';
        else if (i === ranked.length - 1) badge = isToday ? 'Menos recomendada hoy' : 'Menos recomendada';
        return `
          <li class="rank-item ${i === 0 ? 'is-best' : ''}" style="${cardVars(card)}">
            <span class="rank-pos" aria-hidden="true">${i + 1}</span>
            <div class="rank-body">
              <div class="rank-head">
                <h3 class="rank-name">${esc(card.name)}</h3>
                <span class="badge badge--${tier.key}">${badge}</span>
              </div>
              <p class="rank-status">${statusText(info, isToday)}</p>
              ${cycleBarHTML(info)}
            </div>
            <div class="rank-days">
              <strong>${info.financingDays}</strong><span>días</span>
            </div>
          </li>`;
      })
      .join('');
  }

  // #endregion 6.

  // #region 7. VISTAS ==========================================================

  function renderHeader() {
    $('#header-date').textContent = fmtFull(state.today);
  }

  /* ---- Vista: Hoy ---------------------------------------------------------- */

  function renderHome() {
    const ranked = rankCards(state.cards, state.today);
    $('#hero').innerHTML = ranked.length ? heroHTML(ranked, state.today, true) : emptyStateHTML();
    $('#ranking-today').innerHTML = rankingHTML(ranked, true);
    renderUpcoming();
    renderCoreRules();
  }

  function renderUpcoming() {
    const list = $('#upcoming');
    if (!state.cards.length) {
      list.innerHTML = '<li class="empty-inline">Sin eventos: agrega una tarjeta.</li>';
      return;
    }
    const events = getEventsInRange(state.cards, state.today, addDays(state.today, 30)).slice(0, 10);
    if (!events.length) {
      list.innerHTML = '<li class="empty-inline">No hay eventos en los próximos 30 días.</li>';
      return;
    }
    list.innerHTML = events
      .map((ev) => {
        const meta = EVENT_META[ev.type];
        const daysLeft = diffDays(state.today, ev.date);
        const urgent = ev.type === 'payment' && daysLeft <= 5;
        const hint = urgent ? `<strong>¡${capitalize(meta.hint)}!</strong>` : meta.hint;
        return `
          <li>
            <button type="button" class="up-item ${urgent ? 'is-urgent' : ''}" style="${cardVars(ev.card)}" data-action="open-calendar" data-date="${toISO(ev.date)}">
              <span class="up-date" aria-hidden="true">
                <span class="up-day">${ev.date.getDate()}</span>
                <span class="up-mon">${MONTHS_SHORT[ev.date.getMonth()]}</span>
              </span>
              <span class="up-body">
                <span class="up-title">${meta.icon} <span class="up-card">${esc(ev.card.name)}</span> · ${meta.label}</span>
                <span class="up-sub">${capitalize(relativeDay(ev.date, state.today))} (${WEEKDAYS[ev.date.getDay()]} ${fmtShort(ev.date)}) · ${hint}</span>
              </span>
            </button>
          </li>`;
      })
      .join('');
  }

  function renderCoreRules() {
    $('#core-rules').innerHTML = RULES.filter((r) => r.core)
      .map((r) => `<li><span class="rule-icon" aria-hidden="true">${r.icon}</span><span><strong>${r.title}</strong>${r.text}</span></li>`)
      .join('');
  }

  /* ---- Vista: Simulador ---------------------------------------------------- */

  function renderSimulator() {
    const date = state.simDate;
    const isToday = isSameDay(date, state.today);
    const ranked = rankCards(state.cards, date);

    $('#sim-date').value = toISO(date);
    $('#sim-hero').innerHTML = ranked.length ? heroHTML(ranked, date, isToday) : emptyStateHTML();
    $('#sim-ranking').innerHTML = rankingHTML(ranked, isToday);

    const offset = diffDays(state.today, date);
    $$('#sim-quick [data-offset]').forEach((chip) => {
      const active = Number(chip.dataset.offset) === offset;
      chip.classList.toggle('is-active', active);
      chip.setAttribute('aria-pressed', String(active));
    });

    renderMonthMap(date);
  }

  /** Mapa del mes: cada día coloreado con la mejor tarjeta + resumen por rangos. */
  function renderMonthMap(date) {
    const year = date.getFullYear();
    const month = date.getMonth();
    $('#month-map-title').textContent = `Mapa de ${MONTHS[month]} ${year}`;

    const map = $('#month-map');
    const rangesList = $('#month-ranges');
    if (!state.cards.length) {
      map.innerHTML = '';
      rangesList.innerHTML = '<li class="empty-inline">Agrega tarjetas para ver el mapa.</li>';
      return;
    }

    const offset = (new Date(year, month, 1).getDay() + 6) % 7; // lunes = 0
    let html = WEEK_INITIALS.map((w) => `<span class="mm-wd" aria-hidden="true">${w}</span>`).join('');
    html += '<span aria-hidden="true"></span>'.repeat(offset);

    const ranges = [];
    for (let d = 1; d <= daysInMonth(year, month); d++) {
      const day = new Date(year, month, d);
      const { card, info } = rankCards(state.cards, day)[0];
      const classes = ['mm-day'];
      if (isSameDay(day, date)) classes.push('is-selected');
      if (isSameDay(day, state.today)) classes.push('is-today');
      const label = `${d} de ${MONTHS[month]}: ${card.name}, ${info.financingDays} días de crédito`;
      html += `<button type="button" class="${classes.join(' ')}" style="${cardVars(card)}" data-action="sim-date" data-date="${toISO(day)}" title="${esc(label)}" aria-label="${esc(label)}">${d}</button>`;

      const last = ranges[ranges.length - 1];
      if (last && last.card.id === card.id) {
        last.to = d;
        last.minDays = Math.min(last.minDays, info.financingDays);
        last.maxDays = Math.max(last.maxDays, info.financingDays);
      } else {
        ranges.push({ card, from: d, to: d, minDays: info.financingDays, maxDays: info.financingDays });
      }
    }
    map.innerHTML = html;

    rangesList.innerHTML = ranges
      .map((r) => {
        const days = r.from === r.to ? `Día ${r.from}` : `Días ${r.from}–${r.to}`;
        const credit = r.minDays === r.maxDays ? `${r.maxDays} días` : `${r.maxDays} a ${r.minDays} días`;
        return `<li style="${cardVars(r.card)}"><span class="dot"></span><span class="range-days">${days}</span><strong>${esc(r.card.name)}</strong><span class="range-credit">${credit} de crédito</span></li>`;
      })
      .join('');
  }

  /* ---- Vista: Calendario --------------------------------------------------- */

  const visibleCalendarCards = () => state.cards.filter((c) => !state.calHidden.has(c.id));

  function renderCalendar() {
    const year = state.calYear;
    const month = state.calMonth;
    $('#cal-title').textContent = `${capitalize(MONTHS[month])} ${year}`;
    renderCalendarFilters();

    // La cuadrícula empieza el lunes anterior (o igual) al día 1.
    const first = new Date(year, month, 1);
    const offset = (first.getDay() + 6) % 7;
    const gridStart = addDays(first, -offset);
    const cellCount = Math.ceil((offset + daysInMonth(year, month)) / 7) * 7;
    const gridEnd = addDays(gridStart, cellCount - 1);

    // Agrupa los eventos por día.
    const byDay = new Map();
    for (const ev of getEventsInRange(visibleCalendarCards(), gridStart, gridEnd)) {
      const key = toISO(ev.date);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(ev);
    }

    let html = '';
    for (let i = 0; i < cellCount; i++) {
      const date = addDays(gridStart, i);
      const iso = toISO(date);
      const events = byDay.get(iso) || [];
      const isToday = isSameDay(date, state.today);
      const isSelected = state.calSelected && isSameDay(date, state.calSelected);
      const classes = ['cal-day'];
      if (date.getMonth() !== month) classes.push('is-outside');
      if (isToday) classes.push('is-today');
      if (isSelected) classes.push('is-selected');

      const label = capitalize(fmtWeekday(date)) +
        (isToday ? ' (hoy)' : '') +
        (events.length ? `: ${events.map((ev) => `${EVENT_META[ev.type].label} de ${ev.card.name}`).join('; ')}` : '');

      html += `
        <button type="button" class="${classes.join(' ')}" data-date="${iso}" aria-label="${esc(label)}" aria-pressed="${isSelected ? 'true' : 'false'}"${isToday ? ' aria-current="date"' : ''}>
          <span class="cal-num">${date.getDate()}</span>
          <span class="cal-events">${events.map(calendarChipHTML).join('')}</span>
        </button>`;
    }
    $('#cal-grid').innerHTML = html;
    renderCalendarDetail();
  }

  const calendarChipHTML = (ev) =>
    `<span class="cal-ev" style="${cardVars(ev.card)}"><span aria-hidden="true">${EVENT_META[ev.type].icon}</span><span class="cal-ev-name">${esc(ev.card.name)}</span></span>`;

  function renderCalendarFilters() {
    $('#cal-filters').innerHTML = state.cards
      .map((card) => {
        const active = !state.calHidden.has(card.id);
        return `<button type="button" class="chip chip--card ${active ? 'is-active' : ''}" style="${cardVars(card)}" data-action="toggle-filter" data-id="${esc(card.id)}" aria-pressed="${active}"><span class="dot" aria-hidden="true"></span>${esc(card.name)}</button>`;
      })
      .join('');
  }

  /** Explicación larga de un evento (panel de detalle). */
  function describeEvent(ev) {
    const name = `<strong>${esc(ev.card.name)}</strong>`;
    if (ev.type === 'start') {
      const info = getCycleInfo(ev.card, ev.date);
      return `Inicia un nuevo ciclo de ${name}: es el <b>mejor día para comprar</b>. Lo que compres se factura el ${fmtShort(info.closing)} y lo pagas hasta el ${fmtLong(info.payment, ev.date)} (${info.financingDays} días de crédito).`;
    }
    if (ev.type === 'closing') {
      return `${name} cierra su facturación. Las compras hasta este día se pagan hasta el ${fmtLong(ev.payment, ev.date)}. Si puedes, espera al día siguiente para comprar con ella.`;
    }
    const weekday = ev.date.getDay();
    const weekend = weekday === 0 || weekday === 6;
    return `Último día para pagar el estado de cuenta de ${name} que cerró el ${fmtShort(ev.closing)}. Paga el <b>total</b> para no generar intereses.${weekend ? ` Cae ${WEEKDAYS[weekday]}: mejor paga el día hábil anterior.` : ''}`;
  }

  function renderCalendarDetail() {
    const panel = $('#cal-detail');
    const date = state.calSelected || state.today;
    const events = getEventsInRange(visibleCalendarCards(), date, date);
    const ranked = rankCards(state.cards, date);

    const eventsHTML = events.length
      ? `<ul class="detail-events">${events
          .map((ev) => `
            <li class="detail-ev" style="${cardVars(ev.card)}">
              <span class="detail-ev-icon" aria-hidden="true">${EVENT_META[ev.type].icon}</span>
              <div>
                <p class="detail-ev-title">${EVENT_META[ev.type].label} · ${esc(ev.card.name)}</p>
                <p class="detail-ev-text">${describeEvent(ev)}</p>
              </div>
            </li>`)
          .join('')}</ul>`
      : '<p class="detail-empty">No hay inicios de ciclo, cierres ni pagos este día.</p>';

    const bestHTML = ranked.length
      ? `<div class="detail-best" style="${cardVars(ranked[0].card)}">
          <p class="eyebrow">🛒 Mejor tarjeta para comprar este día</p>
          <p><strong>${esc(ranked[0].card.name)}</strong>: ${ranked[0].info.financingDays} días de crédito, pagas hasta el ${fmtLong(ranked[0].info.payment, date)}.</p>
        </div>`
      : '';

    panel.innerHTML = `
      <p class="eyebrow">${capitalize(relativeDay(date, state.today))}</p>
      <h2 class="detail-title">${capitalize(fmtWeekday(date))} de ${date.getFullYear()}</h2>
      ${eventsHTML}
      ${bestHTML}
      ${ranked.length ? `<button type="button" class="btn btn--primary btn--block" data-action="simulate-date" data-date="${toISO(date)}">Simular una compra este día ${icon('arrow-right')}</button>` : ''}`;
  }

  function selectCalendarDate(date, { focus = false, reveal = false } = {}) {
    state.calSelected = date;
    state.calYear = date.getFullYear();
    state.calMonth = date.getMonth();
    renderCalendar();
    if (focus) focusSelector(`#cal-grid [data-date="${toISO(date)}"]`);
    if (reveal && window.matchMedia('(max-width: 959px)').matches) {
      $('#cal-detail').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
    }
  }

  function shiftCalendarMonth(delta) {
    const target = new Date(state.calYear, state.calMonth + delta, 1);
    state.calYear = target.getFullYear();
    state.calMonth = target.getMonth();
    renderCalendar();
  }

  /* Tooltip del calendario (solo en dispositivos con cursor) */
  const hoverQuery = window.matchMedia('(hover: hover) and (pointer: fine)');
  let tooltipCell = null;

  function showCalendarTooltip(cell) {
    const tip = $('#cal-tooltip');
    const date = fromISO(cell.dataset.date);
    const events = getEventsInRange(visibleCalendarCards(), date, date);
    if (!events.length) {
      tip.hidden = true;
      return;
    }
    tip.innerHTML = `
      <p class="tt-date">${capitalize(fmtWeekday(date))}</p>
      <ul>${events
        .map((ev) => `<li><span aria-hidden="true">${EVENT_META[ev.type].icon}</span><span class="dot" style="${cardVars(ev.card)}"></span><span><strong>${esc(ev.card.name)}</strong> · ${EVENT_META[ev.type].label}</span></li>`)
        .join('')}</ul>`;
    tip.hidden = false;

    // Posiciona el tooltip encima de la celda sin salirse de la pantalla.
    const cellRect = cell.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    const margin = 8;
    let left = cellRect.left + cellRect.width / 2 - tipRect.width / 2;
    left = Math.max(margin, Math.min(left, window.innerWidth - tipRect.width - margin));
    let top = cellRect.top - tipRect.height - margin;
    if (top < margin) top = cellRect.bottom + margin;
    tip.style.left = `${Math.round(left)}px`;
    tip.style.top = `${Math.round(top)}px`;
  }

  function hideTooltip() {
    const tip = $('#cal-tooltip');
    if (tip) tip.hidden = true;
    tooltipCell = null;
  }

  function onCalendarHover(event) {
    if (!hoverQuery.matches) return;
    const cell = event.target.closest('.cal-day');
    if (!cell || cell === tooltipCell) return;
    tooltipCell = cell;
    showCalendarTooltip(cell);
  }

  function onCalendarKeydown(event) {
    const moves = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 };
    const cell = event.target.closest('.cal-day');
    if (!cell || !(event.key in moves)) return;
    event.preventDefault();
    hideTooltip();
    selectCalendarDate(addDays(fromISO(cell.dataset.date), moves[event.key]), { focus: true });
  }

  /* ---- Vista: Tarjetas (CRUD) ---------------------------------------------- */

  function renderCards() {
    const grid = $('#cards-grid');
    if (!state.cards.length) {
      grid.innerHTML = emptyStateHTML();
      return;
    }
    grid.innerHTML =
      state.cards
        .map((card) => {
          const info = getCycleInfo(card, state.today);
          return `
            <article class="card-item">
              ${miniCardHTML(card)}
              <dl class="card-facts">
                <div><dt>🔴 Cierre de facturación</dt><dd>Día ${card.closingDay}</dd></div>
                <div><dt>🟢 Mejor compra desde</dt><dd>Día ${bestDayOfMonth(card)}</dd></div>
                <div><dt>⚠️ Fecha límite de pago</dt><dd>Día ${card.paymentDay} · ${paysSameMonth(card) ? 'mismo mes' : 'mes siguiente'}</dd></div>
                <div><dt>📆 Ciclo actual</dt><dd>${fmtShort(info.cycleStart)} – ${fmtShort(info.closing)}</dd></div>
                <div><dt>💳 Si compras hoy</dt><dd>${info.financingDays} días · pagas ${fmtShort(info.payment)}</dd></div>
              </dl>
              <div class="card-actions">
                <button type="button" class="btn btn--ghost btn--sm" data-action="edit-card" data-id="${esc(card.id)}" aria-label="Editar ${esc(card.name)}">${icon('edit')}Editar</button>
                <button type="button" class="btn btn--ghost btn--sm btn--danger-text" data-action="delete-card" data-id="${esc(card.id)}" aria-label="Eliminar ${esc(card.name)}">${icon('trash')}Eliminar</button>
              </div>
            </article>`;
        })
        .join('') +
      `<button type="button" class="card-add" data-action="add-card">${icon('plus')}<span>Agregar tarjeta</span></button>`;
  }

  async function deleteCard(id) {
    const card = state.cards.find((c) => c.id === id);
    if (!card) return;
    const ok = await confirmDialog({
      title: 'Eliminar tarjeta',
      message: `¿Eliminar "${card.name}"? Esta acción no se puede deshacer.`,
      confirmText: 'Eliminar',
    });
    if (!ok) return;
    state.cards = state.cards.filter((c) => c.id !== id);
    state.calHidden.delete(id);
    saveCards();
    renderAll();
    toast(`"${card.name}" se eliminó.`, 'success');
  }

  async function resetCards() {
    const ok = await confirmDialog({
      title: 'Restaurar tarjetas iniciales',
      message: 'Se reemplazarán tus tarjetas actuales por Falabella, BCP e Interbank con sus fechas originales.',
      confirmText: 'Restaurar',
    });
    if (!ok) return;
    state.cards = cloneDefaults();
    state.calHidden.clear();
    saveCards();
    renderAll();
    toast('Se restauraron las tarjetas iniciales.', 'success');
  }

  function exportCards() {
    const payload = {
      app: 'ciclo-tarjetas',
      version: 1,
      exportedAt: new Date().toISOString(),
      cards: state.cards,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tarjetas-${toISO(state.today)}.json`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    toast('Respaldo exportado.', 'success');
  }

  async function importCards(file) {
    try {
      const data = JSON.parse(await file.text());
      const list = Array.isArray(data) ? data : data && data.cards;
      if (!Array.isArray(list)) throw new Error('el archivo no tiene una lista de tarjetas');
      const cards = normalizeCards(list);
      if (!cards.length) throw new Error('no se encontraron tarjetas válidas');
      const ok = await confirmDialog({
        title: 'Importar tarjetas',
        message: `Se reemplazarán tus ${plural(state.cards.length, 'tarjeta', 'tarjetas')} por ${plural(cards.length, 'tarjeta', 'tarjetas')} del archivo. ¿Continuar?`,
        confirmText: 'Importar',
        danger: false,
      });
      if (!ok) return;
      state.cards = cards;
      state.calHidden.clear();
      saveCards();
      renderAll();
      toast(`Se importaron ${plural(cards.length, 'tarjeta', 'tarjetas')}.`, 'success');
    } catch (err) {
      toast(`No se pudo importar: ${err.message}.`, 'error');
    }
  }

  /* ---- Vista: Reglas de oro ------------------------------------------------ */

  function renderRules() {
    $('#rules-grid').innerHTML = RULES.map(
      (r) => `
        <article class="rule-card ${r.core ? 'is-core' : ''}">
          <span class="rule-icon" aria-hidden="true">${r.icon}</span>
          <h3>${r.title}</h3>
          <p>${r.text}</p>
        </article>`,
    ).join('');
    renderHowItWorks();
  }

  /** Ejemplo del ciclo con datos reales (BCP si existe, si no la primera tarjeta). */
  function renderHowItWorks() {
    const card =
      state.cards.find((c) => c.name.trim().toLowerCase() === 'bcp') ||
      state.cards[0] ||
      DEFAULT_CARDS[1];
    const current = getCycleInfo(card, state.today);
    const start = current.daysSinceStart === 0 ? state.today : current.nextCycleStart;
    const info = getCycleInfo(card, start);
    const onClosingDay = getCycleInfo(card, info.closing);

    const steps = [
      { color: 'var(--success)', emoji: '🟢', date: fmtShort(start), text: `Compras el <b>${fmtLong(start)}</b>, el día siguiente al cierre (${fmtShort(info.prevClosing)}): inicia un ciclo nuevo.` },
      { color: 'var(--primary)', emoji: '🛒', date: `${fmtShort(start)} – ${fmtShort(info.closing)}`, text: 'Todo lo que compres en este rango entra en el <b>mismo estado de cuenta</b>.' },
      { color: 'var(--danger)', emoji: '🔴', date: fmtShort(info.closing), text: 'Cierra la facturación y el banco emite tu estado de cuenta.' },
      { color: 'var(--warning)', emoji: '⚠️', date: fmtShort(info.payment), text: `Pagas el <b>total</b> hasta el ${fmtLong(info.payment, start)}, en el mes siguiente al cierre.` },
    ];

    $('#how-it-works').innerHTML = `
      <header class="panel-head">
        <h2 id="t-how">¿Cómo funciona el ciclo? Ejemplo con ${esc(card.name)}</h2>
        <p class="panel-sub">Cierre el día ${card.closingDay} · pago el día ${card.paymentDay} del mes siguiente al cierre.</p>
      </header>
      <ol class="steps">
        ${steps
          .map((s) => `
            <li class="step" style="--step:${s.color}">
              <div class="step-top"><span class="step-date">${s.date}</span><span aria-hidden="true">${s.emoji}</span></div>
              <p>${s.text}</p>
            </li>`)
          .join('')}
      </ol>
      ${noteHTML('💡', `Comprar el ${fmtShort(start)} te da <strong>${info.financingDays} días</strong> para pagar. Comprar el día del cierre (${fmtShort(info.closing)}) solo te da <strong>${onClosingDay.financingDays} días</strong>. ¡La fecha de pago es la misma (${fmtShort(info.payment)}), pero el plazo es mucho mayor!`, 'tip how-result')}`;
  }

  function renderAll() {
    renderHeader();
    renderHome();
    renderSimulator();
    renderCalendar();
    renderCards();
    renderRules();
  }

  // #endregion 7.

  // #region 8. FORMULARIO DE TARJETA (AGREGAR / EDITAR) =========================

  function readForm() {
    return {
      name: $('#f-name').value.trim(),
      closingDay: Number($('#f-closing').value),
      paymentDay: Number($('#f-payment').value),
      color: HEX_COLOR.test($('#f-color').value) ? $('#f-color').value.toLowerCase() : PRESET_COLORS[0],
    };
  }

  function validateForm(data) {
    const errors = {};
    if (!data.name) {
      errors.name = 'Escribe el nombre de la tarjeta o del banco.';
    } else if (state.cards.some((c) => c.id !== state.editingId && c.name.toLowerCase() === data.name.toLowerCase())) {
      errors.name = 'Ya tienes una tarjeta con ese nombre. Usa uno distinto (ej: "BCP Visa").';
    }
    if (!isValidDay(data.closingDay)) errors.closingDay = 'Ingresa un día entre 1 y 31.';
    if (!isValidDay(data.paymentDay)) errors.paymentDay = 'Ingresa un día entre 1 y 31.';
    return errors;
  }

  const FIELD_INPUTS = { name: '#f-name', closingDay: '#f-closing', paymentDay: '#f-payment' };

  function showFormErrors(errors) {
    Object.entries(FIELD_INPUTS).forEach(([field, selector]) => {
      const message = errors[field] || '';
      $(`[data-error-for="${field}"]`).textContent = message;
      const input = $(selector);
      if (message) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
    });
  }

  function renderSwatches(selected) {
    $('#f-swatches').innerHTML = PRESET_COLORS.map(
      (color) =>
        `<button type="button" class="swatch ${color === selected ? 'is-selected' : ''}" style="--c:${color}" data-color="${color}" aria-pressed="${color === selected}" aria-label="Color ${color}"></button>`,
    ).join('');
  }

  /** Vista previa en vivo de la tarjeta y de un ciclo de ejemplo. */
  function updateFormPreview() {
    const data = readForm();
    const closingOk = isValidDay(data.closingDay);
    const paymentOk = isValidDay(data.paymentDay);
    const preview = {
      id: 'preview',
      name: data.name || 'Mi tarjeta',
      closingDay: closingOk ? data.closingDay : 26,
      paymentDay: paymentOk ? data.paymentDay : 20,
      color: data.color,
    };
    $('#card-preview').innerHTML = miniCardHTML(preview);

    const summary = $('#form-summary');
    if (!closingOk || !paymentOk) {
      summary.textContent = 'Completa el día de cierre y el día de pago para ver un ejemplo del ciclo.';
      return;
    }
    const current = getCycleInfo(preview, state.today);
    const start = current.daysSinceStart === 0 ? state.today : current.nextCycleStart;
    const info = getCycleInfo(preview, start);
    const gap = diffDays(info.closing, info.payment);

    let html = `🟢 Mejor día para comprar: el <strong>${bestDayOfMonth(preview)}</strong> de cada mes.<br />Ejemplo: compras el <strong>${fmtShort(start)}</strong> → cierra el <strong>${fmtShort(info.closing)}</strong> → pagas hasta el <strong>${fmtShort(info.payment)}</strong> (${info.financingDays} días de crédito).`;
    if (preview.closingDay > 28) {
      html += '<span class="warn">ℹ️ En los meses más cortos, el cierre se toma el último día del mes.</span>';
    }
    if (gap < 10) {
      html += `<span class="warn">⚠️ El pago vencería solo ${plural(gap, 'día', 'días')} después del cierre. Revisa que los días sean correctos.</span>`;
    }
    summary.innerHTML = html;
  }

  function openCardDialog(card = null) {
    const dialog = $('#card-dialog');
    if (dialog.open) return;
    state.editingId = card ? card.id : null;

    const usedColors = new Set(state.cards.map((c) => c.color));
    const color = card ? card.color : PRESET_COLORS.find((c) => !usedColors.has(c)) || PRESET_COLORS[0];

    $('#card-dialog-title').textContent = card ? `Editar ${card.name}` : 'Agregar tarjeta';
    $('#card-submit').textContent = card ? 'Guardar cambios' : 'Agregar tarjeta';
    $('#f-name').value = card ? card.name : '';
    $('#f-closing').value = card ? card.closingDay : '';
    $('#f-payment').value = card ? card.paymentDay : '';
    $('#f-color').value = color;

    showFormErrors({});
    renderSwatches(color);
    updateFormPreview();
    dialog.showModal();
    $('#f-name').focus();
  }

  function onCardSubmit(event) {
    event.preventDefault();
    const data = readForm();
    const errors = validateForm(data);
    showFormErrors(errors);

    const firstInvalid = Object.keys(FIELD_INPUTS).find((field) => errors[field]);
    if (firstInvalid) {
      $(FIELD_INPUTS[firstInvalid]).focus();
      return;
    }

    if (state.editingId) {
      state.cards = state.cards.map((c) => (c.id === state.editingId ? { ...c, ...data } : c));
      toast(`"${data.name}" se actualizó.`, 'success');
    } else {
      state.cards.push({ id: uid(), ...data });
      toast(`"${data.name}" se agregó.`, 'success');
    }
    saveCards();
    $('#card-dialog').close();
    renderAll();
  }

  // #endregion 8.

  // #region 9. NAVEGACIÓN, TEMA Y EVENTOS ======================================

  function getRoute() {
    const route = location.hash.replace(/^#\/?/, '');
    return ROUTES.includes(route) ? route : 'inicio';
  }

  function applyRoute() {
    const route = getRoute();
    $$('.view').forEach((view) => {
      view.hidden = view.dataset.view !== route;
    });
    $$('.nav-link').forEach((link) => {
      if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    document.title = `${ROUTE_TITLES[route]} · Ciclo de Tarjetas`;
    hideTooltip();
    window.scrollTo(0, 0);
  }

  const getTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

  function setTheme(theme, persist = true) {
    document.documentElement.dataset.theme = theme;
    const meta = $('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f3f5fa' : '#0a0d14');
    $('#theme-toggle').setAttribute('aria-label', theme === 'light' ? 'Cambiar a tema oscuro' : 'Cambiar a tema claro');
    if (persist) storageSet(STORAGE_KEYS.theme, theme);
  }

  /** Acciones declarativas: cualquier elemento con [data-action]. */
  function onActionClick(event) {
    const el = event.target.closest('[data-action]');
    if (!el) return;
    const { action, id } = el.dataset;
    const date = el.dataset.date ? fromISO(el.dataset.date) : null;

    switch (action) {
      case 'add-card':
        openCardDialog();
        break;
      case 'edit-card': {
        const card = state.cards.find((c) => c.id === id);
        if (card) openCardDialog(card);
        break;
      }
      case 'delete-card':
        deleteCard(id);
        break;
      case 'sim-date': // clic en el mapa del mes
        if (date) {
          state.simDate = date;
          renderSimulator();
          focusSelector(`#month-map [data-date="${toISO(date)}"]`);
        }
        break;
      case 'simulate-date': // desde el calendario
        if (date) {
          state.simDate = date;
          renderSimulator();
          location.hash = '#simulador';
        }
        break;
      case 'open-calendar': // desde "Próximos 30 días"
        if (date) {
          selectCalendarDate(date);
          location.hash = '#calendario';
        }
        break;
      case 'next-start': {
        const next = nextCycleStart(state.cards, state.simDate);
        if (next) {
          state.simDate = next.date;
          renderSimulator();
        }
        break;
      }
      case 'toggle-filter':
        if (state.calHidden.has(id)) state.calHidden.delete(id);
        else state.calHidden.add(id);
        renderCalendar();
        break;
      default:
        break;
    }
  }

  /** Cierra un <dialog> al hacer clic en el fondo (solo si el clic empezó ahí). */
  function enableBackdropClose(dialog) {
    let startedOnBackdrop = false;
    dialog.addEventListener('pointerdown', (e) => {
      startedOnBackdrop = e.target === dialog;
    });
    dialog.addEventListener('click', (e) => {
      if (startedOnBackdrop && e.target === dialog) dialog.close();
    });
  }

  /** Si cambió el día (app abierta pasada la medianoche), recalcula todo. */
  function checkDateChange() {
    const now = startOfDay(new Date());
    if (isSameDay(now, state.today)) return;
    if (isSameDay(state.simDate, state.today)) state.simDate = now;
    if (state.calSelected && isSameDay(state.calSelected, state.today)) {
      state.calSelected = now;
      state.calYear = now.getFullYear();
      state.calMonth = now.getMonth();
    }
    state.today = now;
    renderAll();
  }

  function bindEvents() {
    window.addEventListener('hashchange', applyRoute);
    document.addEventListener('click', onActionClick);
    $('#theme-toggle').addEventListener('click', () => setTheme(getTheme() === 'dark' ? 'light' : 'dark'));

    // Simulador
    $('#sim-date').addEventListener('change', (e) => {
      const date = fromISO(e.target.value);
      if (date) {
        state.simDate = date;
        renderSimulator();
      } else {
        e.target.value = toISO(state.simDate);
      }
    });
    $('#sim-quick').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-offset]');
      if (!chip) return;
      state.simDate = addDays(state.today, Number(chip.dataset.offset));
      renderSimulator();
    });

    // Calendario
    const grid = $('#cal-grid');
    $('#cal-prev').addEventListener('click', () => shiftCalendarMonth(-1));
    $('#cal-next').addEventListener('click', () => shiftCalendarMonth(1));
    $('#cal-today').addEventListener('click', () => selectCalendarDate(state.today));
    grid.addEventListener('click', (e) => {
      const cell = e.target.closest('.cal-day');
      if (cell) selectCalendarDate(fromISO(cell.dataset.date), { focus: true, reveal: true });
    });
    grid.addEventListener('keydown', onCalendarKeydown);
    grid.addEventListener('mouseover', onCalendarHover);
    grid.addEventListener('mouseleave', hideTooltip);
    window.addEventListener('scroll', hideTooltip, { passive: true });

    // Tarjetas: respaldo
    $('#btn-export').addEventListener('click', exportCards);
    $('#btn-import').addEventListener('click', () => $('#file-import').click());
    $('#file-import').addEventListener('change', (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) importCards(file);
      e.target.value = ''; // permite volver a elegir el mismo archivo
    });
    $('#btn-reset').addEventListener('click', resetCards);

    // Formulario de tarjeta
    const form = $('#card-form');
    form.addEventListener('submit', onCardSubmit);
    form.addEventListener('input', (e) => {
      if (e.target.id === 'f-color') renderSwatches(e.target.value.toLowerCase());
      const field = Object.keys(FIELD_INPUTS).find((key) => FIELD_INPUTS[key] === `#${e.target.id}`);
      if (field) {
        $(`[data-error-for="${field}"]`).textContent = '';
        e.target.removeAttribute('aria-invalid');
      }
      updateFormPreview();
    });
    $('#f-swatches').addEventListener('click', (e) => {
      const swatch = e.target.closest('[data-color]');
      if (!swatch) return;
      $('#f-color').value = swatch.dataset.color;
      renderSwatches(swatch.dataset.color);
      updateFormPreview();
    });
    $$('#card-dialog [data-close]').forEach((btn) => btn.addEventListener('click', () => $('#card-dialog').close()));
    $$('dialog').forEach(enableBackdropClose);

    // Recalcular al pasar la medianoche o al volver a la pestaña.
    setInterval(checkDateChange, 60 * 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) checkDateChange();
    });
  }

  // #endregion 9.

  // #region 10. INICIO =========================================================

  function init() {
    state.cards = loadCards();
    state.simDate = state.today;
    state.calSelected = state.today;
    state.calYear = state.today.getFullYear();
    state.calMonth = state.today.getMonth();

    setTheme(getTheme(), false);
    bindEvents();
    renderAll();
    applyRoute();
  }

  init();

  // #endregion 10.
})();
