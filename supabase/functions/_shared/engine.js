/**
 * =============================================================================
 *  CUÁLTOCA · js/engine.js
 * -----------------------------------------------------------------------------
 *  Motor de fechas y ciclos de facturación. Es un módulo PURO: no toca el DOM
 *  ni el almacenamiento, así que funciona igual en el navegador y en el servidor.
 *
 *  Lo usan:
 *    - js/app.js (interfaz).
 *    - Las Edge Functions de Supabase, que envían los avisos por correo.
 *      IMPORTANTE: supabase/functions/_shared/engine.js debe ser una copia
 *      exacta de este archivo. El test tests/shared-engine.test.mjs lo verifica.
 *
 *  Modelo de tarjeta:  { id, name, closingDay: 1-31, paymentDay: 1-31, color }
 *  Modelo de compra:   { id, cardId, description, amount, currency: 'PEN'|'USD',
 *                        date: 'AAAA-MM-DD', installments: 1-36 }
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
 *    5. Una compra en N cuotas se reparte en N estados de cuenta consecutivos,
 *       empezando por el del ciclo en que se hizo la compra.
 * =============================================================================
 */

/* ---------------------------------------------------------------------------
 * 1. CONSTANTES
 * ------------------------------------------------------------------------- */

export const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export const MONTHS_SHORT = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
export const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];

/** Tipos de evento del calendario. */
export const EVENT_META = {
  start: { icon: '🟢', label: 'Inicio de ciclo', hint: 'mejor día para comprar', order: 0 },
  closing: { icon: '🔴', label: 'Cierre de facturación', hint: 'último día del ciclo', order: 1 },
  payment: { icon: '⚠️', label: 'Fecha límite de pago', hint: 'paga el total', order: 2 },
};

/** Calidad de la recomendación según los días de crédito sin intereses. */
export const TIERS = [
  { min: 45, key: 'excelente', label: 'Excelente' },
  { min: 35, key: 'buena', label: 'Buena' },
  { min: 25, key: 'regular', label: 'Regular' },
  { min: -Infinity, key: 'evitar', label: 'Evitar' },
];

export const CURRENCIES = ['PEN', 'USD'];
export const MAX_INSTALLMENTS = 36;

/* ---------------------------------------------------------------------------
 * 2. UTILIDADES DE FECHA
 *    Todas las fechas son objetos Date en hora local a las 00:00.
 * ------------------------------------------------------------------------- */

const MS_PER_DAY = 86400000;

export const pad2 = (n) => String(n).padStart(2, '0');
export const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);
export const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** Devuelve la fecha sin la hora (00:00 local). */
export const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/** Cantidad de días de un mes (month: 0-11). */
export const daysInMonth = (year, month) => new Date(year, month + 1, 0).getDate();

/**
 * Crea una fecha ajustando el día al último del mes si no existe
 * (ej. 31 de febrero → 28/29 de febrero). Acepta meses fuera de rango
 * (-1 = diciembre del año anterior, 12 = enero del siguiente), lo que
 * resuelve automáticamente los saltos de mes y de año.
 */
export function safeDate(year, month, day) {
  const base = new Date(year, month, 1);
  const y = base.getFullYear();
  const m = base.getMonth();
  return new Date(y, m, Math.min(day, daysInMonth(y, m)));
}

export const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

/** Días enteros entre `a` y `b` (b - a). Usa UTC para ignorar cambios de horario. */
export function diffDays(a, b) {
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((utcB - utcA) / MS_PER_DAY);
}

export const isSameDay = (a, b) => diffDays(a, b) === 0;

/** Date → 'AAAA-MM-DD' (formato de <input type="date"> y de la base de datos). */
export const toISO = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** 'AAAA-MM-DD' → Date local, o null si el texto no es una fecha válida. */
export function fromISO(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ''));
  if (!match) return null;
  const [, y, m, d] = match.map(Number);
  const date = new Date(y, m - 1, d);
  return date.getMonth() === m - 1 && date.getDate() === d ? date : null;
}

/** Fecha de "hoy" en una zona horaria (el servidor corre en UTC; Perú es UTC-5). */
export function todayInTimeZone(timeZone = 'America/Lima', now = new Date()) {
  const iso = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return fromISO(iso) || startOfDay(now);
}

/** 26/09 */
export const fmtShort = (d) => `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)}`;

/** 20 de noviembre (agrega el año si difiere del de `ref`). */
export function fmtLong(d, ref) {
  const text = `${d.getDate()} de ${MONTHS[d.getMonth()]}`;
  return ref && ref.getFullYear() !== d.getFullYear() ? `${text} de ${d.getFullYear()}` : text;
}

/** sábado 26 de septiembre */
export const fmtWeekday = (d, ref) => `${WEEKDAYS[d.getDay()]} ${fmtLong(d, ref)}`;

/** Sábado, 26 de septiembre de 2026 */
export const fmtFull = (d) => `${capitalize(WEEKDAYS[d.getDay()])}, ${d.getDate()} de ${MONTHS[d.getMonth()]} de ${d.getFullYear()}`;

/** "hoy", "mañana", "en 3 días", "hace 2 días"… respecto de `ref`. */
export function relativeDay(date, ref) {
  const n = diffDays(ref, date);
  if (n === 0) return 'hoy';
  if (n === 1) return 'mañana';
  if (n === -1) return 'ayer';
  return n > 0 ? `en ${n} días` : `hace ${-n} días`;
}

/* ---------------------------------------------------------------------------
 * 3. CICLOS DE FACTURACIÓN
 * ------------------------------------------------------------------------- */

export const isValidDay = (n) => Number.isInteger(n) && n >= 1 && n <= 31;

/** Fecha de cierre de una tarjeta en un mes dado (month puede salirse de 0-11). */
export const closingDateIn = (card, year, month) => safeDate(year, month, card.closingDay);

/** Fecha límite de pago de un estado de cuenta: primer `paymentDay` posterior al cierre. */
export function paymentDateFor(card, closing) {
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
export function getCycleInfo(card, date) {
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
export function rankCards(cards, date) {
  return cards
    .map((card) => ({ card, info: getCycleInfo(card, date) }))
    .sort((a, b) =>
      b.info.financingDays - a.info.financingDays ||
      b.info.daysToClosing - a.info.daysToClosing ||
      a.card.name.localeCompare(b.card.name, 'es'));
}

export const getTier = (days) => TIERS.find((tier) => days >= tier.min);

/** Próximo inicio de ciclo (de cualquier tarjeta) posterior a `date`. */
export function nextCycleStart(cards, date) {
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
export function getEventsInRange(cards, from, to) {
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
export function paysSameMonth(card) {
  const closing = closingDateIn(card, 2025, 0); // enero tiene 31 días
  return paymentDateFor(card, closing).getMonth() === closing.getMonth();
}

/** Día del mes a partir del cual conviene comprar (día siguiente al cierre). */
export const bestDayOfMonth = (card) => (card.closingDay >= 31 ? 1 : card.closingDay + 1);

/* ---------------------------------------------------------------------------
 * 4. AVISOS (Premium)
 * ------------------------------------------------------------------------- */

/**
 * Avisos vigentes para `today`:
 *   - Pago: desde `daysBefore` días antes de la fecha límite hasta el mismo día.
 *   - Cierre: el día anterior y el mismo día del cierre (si `includeClosing`).
 * Cada aviso tiene una `key` única para no repetir notificaciones o correos.
 * `kind` distingue el aviso previo de pago ('payment') del aviso del día ('payment_today').
 */
export function computeAlerts(cards, today, { daysBefore = 3, includeClosing = true } = {}) {
  const horizon = Math.max(daysBefore, includeClosing ? 1 : 0);
  return getEventsInRange(cards, today, addDays(today, horizon))
    .filter((ev) => {
      const daysLeft = diffDays(today, ev.date);
      if (ev.type === 'payment') return daysLeft <= daysBefore;
      if (ev.type === 'closing') return includeClosing && daysLeft <= 1;
      return false;
    })
    .map((ev) => {
      const daysLeft = diffDays(today, ev.date);
      const kind = ev.type === 'payment' && daysLeft === 0 ? 'payment_today' : ev.type;
      return { ...ev, daysLeft, kind, key: `${kind}:${ev.card.id}:${toISO(ev.date)}` };
    });
}

/** Texto de un aviso (se usa en la app, en notificaciones y en correos). */
export function alertMessage(alert) {
  const { card, date, daysLeft, type } = alert;
  if (type === 'payment') {
    const weekday = date.getDay();
    const weekendTip = weekday === 0 || weekday === 6 ? ` Cae ${WEEKDAYS[weekday]}: mejor paga el día hábil anterior.` : '';
    const title = daysLeft === 0
      ? `Hoy vence el pago de ${card.name}`
      : `Pago de ${card.name} ${daysLeft === 1 ? 'mañana' : `en ${daysLeft} días`}`;
    return {
      title,
      body: `Fecha límite: ${fmtWeekday(date)}. Paga el total del estado de cuenta para no generar intereses.${weekendTip}`,
    };
  }
  const nextStart = addDays(date, 1);
  const credit = getCycleInfo(card, nextStart).financingDays;
  return {
    title: `${card.name} cierra su facturación ${daysLeft === 0 ? 'hoy' : 'mañana'}`,
    body: `Si puedes, deja las compras grandes con ${card.name} para el ${fmtWeekday(nextStart)}: tendrás ${credit} días para pagarlas.`,
  };
}

/* ---------------------------------------------------------------------------
 * 5. PROYECCIÓN DE PAGOS (Premium)
 *    Los montos se manejan en céntimos (enteros) para evitar errores de redondeo.
 * ------------------------------------------------------------------------- */

export const toCents = (amount) => Math.round(Number(amount) * 100);

/** Reparte un monto en N cuotas (en céntimos); el sobrante va a las primeras. */
export function splitInstallments(amount, installments) {
  const cents = toCents(amount);
  const n = Math.max(1, Math.floor(Number(installments)) || 1);
  const base = Math.floor(cents / n);
  const remainder = cents - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

/** Cuotas de una compra: en qué estado de cuenta cae cada una. */
export function purchaseSchedule(card, purchase) {
  const date = fromISO(purchase.date);
  if (!card || !date) return [];
  const firstClosing = getCycleInfo(card, date).closing;
  const parts = splitInstallments(purchase.amount, purchase.installments);
  return parts.map((cents, k) => {
    const closing = closingDateIn(card, firstClosing.getFullYear(), firstClosing.getMonth() + k);
    return { installment: k + 1, installments: parts.length, cents, closing, payment: paymentDateFor(card, closing) };
  });
}

/**
 * Agrupa las compras en estados de cuenta por pagar (fecha de pago >= `today`).
 * @returns {Array<{ card, closing: Date, payment: Date,
 *   items: Array<{ purchase, installment, installments, cents }>,
 *   totals: { PEN?: number, USD?: number } }>}  totales en céntimos
 */
export function projectPayments(cards, purchases, today) {
  const cardsById = new Map(cards.map((card) => [card.id, card]));
  const statements = new Map();

  for (const purchase of purchases) {
    const card = cardsById.get(purchase.cardId);
    for (const part of purchaseSchedule(card, purchase)) {
      if (diffDays(today, part.payment) < 0) continue; // ya vencido
      const key = `${card.id}|${toISO(part.closing)}`;
      if (!statements.has(key)) {
        statements.set(key, { card, closing: part.closing, payment: part.payment, items: [], totals: {} });
      }
      const statement = statements.get(key);
      statement.items.push({ purchase, installment: part.installment, installments: part.installments, cents: part.cents });
      statement.totals[purchase.currency] = (statement.totals[purchase.currency] || 0) + part.cents;
    }
  }

  return [...statements.values()].sort((a, b) =>
    a.payment - b.payment || a.card.name.localeCompare(b.card.name, 'es'));
}

const CURRENCY_PREFIX = { PEN: 'S/', USD: 'US$' };
const amountFormatter = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** 123456 (céntimos), 'PEN' → 'S/ 1,234.56' · 'USD' → 'US$ 1,234.56' (formato usual en Perú). */
export function formatMoney(cents, currency = 'PEN') {
  const sign = cents < 0 ? '-' : '';
  return `${sign}${CURRENCY_PREFIX[currency] || currency} ${amountFormatter.format(Math.abs(cents) / 100)}`;
}
