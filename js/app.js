/**
 * =============================================================================
 *  CUÁLTOCA · js/app.js (interfaz)
 * -----------------------------------------------------------------------------
 *  SPA en JavaScript puro (módulos ES). Este archivo maneja la interfaz:
 *  vistas, formularios, planes (Gratis / Premium), avisos y cuenta.
 *
 *    engine.js   → cálculo de ciclos, avisos y proyección (compartido con el servidor)
 *    plan.js     → planes, precios y límites
 *    store.js    → datos: LocalStorage (sin cuenta) o Supabase (con cuenta)
 *    backend.js  → sesión y cobros con Supabase
 *    notify.js   → Service Worker y notificaciones del navegador
 *
 *  Índice:
 *    1. Constantes         6. Vistas: Hoy, Simular, Calendario
 *    2. Estado y plan      7. Vistas: Pagos, Tarjetas, Reglas, Cuenta
 *    3. Helpers de UI      8. Formularios y diálogos
 *    4. Datos y sesión     9. Navegación, tema y eventos
 *    5. Recomendador      10. Inicio
 * =============================================================================
 */
import { CONFIG, hasBackend } from './config.js';
import {
  MONTHS, MONTHS_SHORT, WEEKDAYS, EVENT_META, pad2, capitalize, plural, startOfDay,
  daysInMonth, addDays, diffDays, isSameDay, toISO, fromISO, fmtShort, fmtLong,
  fmtWeekday, fmtFull, relativeDay, isValidDay, getCycleInfo, rankCards, getTier,
  nextCycleStart, getEventsInRange, paysSameMonth, bestDayOfMonth, computeAlerts,
  alertMessage, projectPayments, purchaseSchedule, formatMoney, toCents, MAX_INSTALLMENTS,
} from './engine.js';
import {
  PLANS, PRICING, PLAN_FEATURES, FREE_CARD_LIMIT, TRIAL_LABEL, PASS_LABELS, isSubscriptionActive,
  premiumStatus, canStartTrial, partitionCards, canAddCard, yearlySavingsPercent,
} from './plan.js';
import {
  LocalStore, RemoteStore, StoreError, storageGet, storageSet, normalizeCards,
  DEFAULT_SETTINGS, HEX_COLOR, MAX_AMOUNT,
} from './store.js';
import * as backend from './backend.js';
import * as notify from './notify.js';
import {
  guardInput, sanitizeInteger, sanitizeDecimal, sanitizeDigits, sanitizePhone, isValidPhone,
} from './inputs.js';

// #region 1. CONSTANTES ======================================================

// Prefijo heredado de la primera versión: no cambiarlo, o se perderían las preferencias guardadas.
const THEME_KEY = 'ciclo-tarjetas:theme';
const DEV_PLAN_KEY = 'ciclo-tarjetas:dev-plan';
const DEVICE_KEY = 'ciclo-tarjetas:device:v1';
const migrationKey = (userId) => `ciclo-tarjetas:migrated:${userId}`;

/** Tarjetas de ejemplo para quien empieza sin tarjetas. */
const EXAMPLE_CARDS = [
  { name: 'Falabella', closingDay: 9, paymentDay: 5, color: '#9ccc3c' },
  { name: 'BCP', closingDay: 26, paymentDay: 20, color: '#ff7a00' },
  { name: 'Interbank', closingDay: 24, paymentDay: 20, color: '#1e88e5' },
];

const PRESET_COLORS = [
  '#ff7a00', '#1e88e5', '#9ccc3c', '#e53935', '#8e24aa', '#00acc1',
  '#fbc02d', '#ec407a', '#43a047', '#5c6bc0', '#8d6e63', '#78909c',
];

const ROUTES = ['inicio', 'simulador', 'calendario', 'pagos', 'tarjetas', 'reglas', 'cuenta'];
const ROUTE_TITLES = {
  inicio: '¿Qué tarjeta toca hoy?',
  simulador: 'Simulador de compras',
  calendario: 'Calendario de facturación',
  pagos: 'Proyección de pagos',
  tarjetas: 'Mis tarjetas',
  reglas: 'Reglas de oro',
  cuenta: 'Cuenta y plan',
};

const WEEK_INITIALS = ['L', 'M', 'M', 'J', 'V', 'S', 'D']; // La semana empieza en lunes

const PREMIUM_BENEFITS = [
  'Tarjetas ilimitadas',
  'Avisos antes de cada pago y cada cierre',
  'Notificaciones en el celular y por correo',
  'Proyección de pagos y cuotas',
];

/** Textos del diálogo de Premium según qué intentó hacer el usuario. */
const UPGRADE_REASONS = {
  cards: {
    title: `Llegaste al límite de ${FREE_CARD_LIMIT} tarjetas`,
    text: `El plan Gratis permite hasta ${FREE_CARD_LIMIT} tarjetas. Con Premium agregas todas las que quieras y la app las compara siempre.`,
  },
  locked: {
    title: 'Esta tarjeta está bloqueada',
    text: `El plan Gratis usa solo tus primeras ${FREE_CARD_LIMIT} tarjetas. Con Premium se desbloquean todas.`,
  },
  alerts: {
    title: 'Los avisos son parte de Premium',
    text: 'Recibe un aviso antes de cada fecha límite de pago y de cada cierre: en la app, en tu celular y por correo.',
  },
  projection: {
    title: 'La proyección de pagos es parte de Premium',
    text: 'Registra tus compras y cuotas, y mira cuánto pagarás en cada tarjeta y en qué fecha.',
  },
  generic: {
    title: 'Hazte Premium',
    text: 'Desbloquea tarjetas ilimitadas, avisos de pago y la proyección de tus pagos.',
  },
};

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

// #region 2. ESTADO Y PLAN ===================================================

const localStore = new LocalStore();

const state = {
  // Datos
  cards: [],
  purchases: [],
  settings: { ...DEFAULT_SETTINGS },
  device: loadDevicePrefs(), // preferencias propias de este dispositivo
  loading: true,

  // Servidor, sesión y plan
  backend: hasBackend() ? 'supabase' : 'none',
  client: null, // cliente de Supabase (null en modo local o si falló la conexión)
  connecting: hasBackend(), // true mientras se conecta con Supabase al abrir la app
  user: null,
  subscription: null,
  store: localStore,
  loginSentTo: null, // correo al que se envió el enlace de acceso
  authProviders: {}, // proveedores activos en Supabase, ej. { email: true, google: false }
  payMethod: 'yape', // forma de pago elegida en Planes: 'yape' (pase) | 'card' (suscripción)
  yapeInterval: 'monthly', // pase que se está pagando en el diálogo de Yape

  // Interfaz
  today: startOfDay(new Date()),
  simDate: null,
  calYear: 0,
  calMonth: 0,
  calSelected: null,
  calHidden: new Set(), // ids de tarjetas ocultas en el calendario
  editingId: null, // id de la tarjeta que se edita (null = nueva)
  purchaseCardTouched: false, // el usuario eligió la tarjeta a mano en el formulario de compra
};

/** Modo de prueba: sin servidor se puede simular el plan desde la pantalla Cuenta. */
const isDevMode = () => state.backend === 'none' && CONFIG.devTools;

/** ¿Se puede iniciar un pago? (en modo de prueba se simula; en producción depende de CONFIG.paymentsEnabled) */
const paymentsAvailable = () => isDevMode() || CONFIG.paymentsEnabled;

/** ¿Se puede pagar con Yape? Además de los cobros, requiere la Public Key de Mercado Pago. */
const yapeAvailable = () => isDevMode() || (CONFIG.paymentsEnabled && Boolean(CONFIG.mercadoPagoPublicKey));

/** ¿Está activa la prueba gratis? (en modo de prueba se simula; en producción depende de CONFIG.trialEnabled) */
const trialAvailable = () => isDevMode() || CONFIG.trialEnabled;

/** ¿Ofrecer la prueba gratis? También a quien aún no tiene cuenta (se le pide crearla). */
const trialOffered = () =>
  trialAvailable() &&
  !isPremium() &&
  (isDevMode() || (state.backend === 'supabase' && (!state.user || canStartTrial(state.subscription))));

/** 'free' | 'premium' */
function currentPlanId() {
  if (state.user) return isSubscriptionActive(state.subscription) ? 'premium' : 'free';
  if (isDevMode() && storageGet(DEV_PLAN_KEY) === 'premium') return 'premium';
  return 'free';
}

const currentPlan = () => PLANS[currentPlanId()];
const isPremium = () => currentPlanId() === 'premium';

/** Tarjetas que el plan permite usar en recomendaciones, calendario y avisos. */
const activeCards = () => partitionCards(state.cards, currentPlanId()).active;
const lockedCardIds = () => new Set(partitionCards(state.cards, currentPlanId()).locked.map((c) => c.id));

function loadDevicePrefs() {
  try {
    const prefs = JSON.parse(storageGet(DEVICE_KEY) || '{}');
    return { browserNotifications: prefs.browserNotifications === true };
  } catch {
    return { browserNotifications: false };
  }
}

const saveDevicePrefs = () => storageSet(DEVICE_KEY, JSON.stringify(state.device));

const alertOptions = () => ({ daysBefore: state.settings.daysBefore, includeClosing: state.settings.notifyClosing });

// #endregion 2.

// #region 3. HELPERS DE INTERFAZ =============================================

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
/** Escapa texto del usuario antes de insertarlo en HTML. */
const esc = (value) => String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

const icon = (name, cls = '') => `<svg class="icon ${cls}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;

const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function focusSelector(selector) {
  const el = $(selector);
  if (el) el.focus({ preventScroll: true });
}

/** Deshabilita un botón mientras se espera al servidor. */
function setBusy(button, busy) {
  if (!button) return;
  button.disabled = busy;
  button.setAttribute('aria-busy', String(busy));
}

const priceText = (interval) => formatMoney(toCents(PRICING[interval]), PRICING.currency);

/** { PEN: 12345, USD: 500 } (céntimos) → "S/ 123.45 + US$ 5.00" */
function formatTotals(totals) {
  const parts = ['PEN', 'USD'].filter((cur) => totals[cur]).map((cur) => formatMoney(totals[cur], cur));
  return parts.length ? parts.join(' + ') : formatMoney(0, 'PEN');
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
  }, type === 'error' ? 5000 : 3200);
}

/* ---- Diálogo de confirmación (devuelve una promesa) ---------------------- */

function confirmDialog({ title, message, confirmText = 'Confirmar', cancelText = 'Cancelar', danger = true }) {
  const dialog = $('#confirm-dialog');
  if (dialog.open) return Promise.resolve(false);
  $('#confirm-title').textContent = title;
  $('#confirm-message').textContent = message;
  $('#confirm-cancel').textContent = cancelText;
  const okButton = $('#confirm-ok');
  okButton.textContent = confirmText;
  okButton.className = `btn ${danger ? 'btn--danger' : 'btn--primary'}`;
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok'), { once: true });
  });
}

/* ---- Diálogo de Premium -------------------------------------------------- */

function openUpgrade(reason = 'generic') {
  const dialog = $('#upgrade-dialog');
  if (dialog.open) return;
  const copy = UPGRADE_REASONS[reason] || UPGRADE_REASONS.generic;
  $('#upgrade-title').textContent = copy.title;
  $('#upgrade-text').textContent = copy.text;
  $('#upgrade-benefits').innerHTML = PREMIUM_BENEFITS.map((b) => `<li>${icon('check')}<span>${b}</span></li>`).join('');
  const trial = trialOffered();
  const prices = `${priceText('monthly')} al mes o ${priceText('yearly')} al año`;
  let priceLine = `Muy pronto: ${prices}.`;
  if (trial) priceLine = `Pruébalo ${TRIAL_LABEL} gratis, sin tarjeta. Después, desde ${priceText('monthly')} al mes.`;
  else if (paymentsAvailable()) priceLine = `${prices}${yapeAvailable() ? ', con Yape o con tarjeta.' : '. Cancela cuando quieras.'}`;
  $('#upgrade-price').textContent = priceLine;
  const go = $('#upgrade-go');
  go.value = trial ? 'trial' : 'plans';
  go.textContent = trial ? `Probar ${TRIAL_LABEL} gratis` : 'Ver planes';
  dialog.returnValue = '';
  dialog.showModal();
  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'trial') startTrial();
    else if (dialog.returnValue === 'plans') goToPlans();
  }, { once: true });
}

/** Lleva a la sección de planes en Cuenta. */
function goToPlans() {
  location.hash = '#cuenta';
  setTimeout(() => $('#plans-panel').scrollIntoView({ block: 'start', behavior: prefersReducedMotion() ? 'auto' : 'smooth' }), 60);
}

/** Días de calendario que faltan hasta una fecha (0 = hoy). */
const daysUntil = (iso) => diffDays(state.today, startOfDay(new Date(iso)));

function daysLeftText(iso) {
  const days = daysUntil(iso);
  if (days <= 0) return 'termina hoy';
  if (days === 1) return 'termina mañana';
  return `quedan ${days} días`;
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

const premiumPill = () => `<span class="plan-pill plan-pill--premium">${icon('star', 'icon--sm')}Premium</span>`;

function emptyStateHTML() {
  if (state.loading) {
    return `
      <div class="empty-state">
        <div class="spinner" aria-hidden="true"></div>
        <p>Cargando tus tarjetas…</p>
      </div>`;
  }
  return `
    <div class="empty-state">
      <div class="empty-icon" aria-hidden="true">💳</div>
      <h2>Aún no tienes tarjetas</h2>
      <p>Agrega tus tarjetas de crédito con su día de cierre y su día de pago para recibir recomendaciones.</p>
      <div class="btn-row btn-row--center">
        <button type="button" class="btn btn--primary" data-action="add-card">${icon('plus')}Agregar tarjeta</button>
        <button type="button" class="btn btn--ghost" data-action="load-examples">Probar con tarjetas de ejemplo</button>
      </div>
    </div>`;
}

function joinNames(cards) {
  const names = cards.map((c) => `<strong>${esc(c.name)}</strong>`);
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} y ${names[names.length - 1]}` : names[0];
}

// #endregion 3.

// #region 4. DATOS Y SESIÓN ==================================================

/** Carga tarjetas, compras y preferencias desde el almacén activo. */
async function loadData() {
  state.loading = true;
  renderAll();
  try {
    const [cards, purchases, settings] = await Promise.all([
      state.store.getCards(),
      state.store.getPurchases(),
      state.store.getSettings(),
    ]);
    Object.assign(state, { cards, purchases, settings });
  } catch (err) {
    console.error(err);
    toast(err.message || 'No se pudieron cargar tus datos.', 'error');
  }
  state.loading = false;
  state.calHidden.clear();
  renderAll();
}

async function reloadCards() {
  try {
    [state.cards, state.purchases] = await Promise.all([state.store.getCards(), state.store.getPurchases()]);
  } catch (err) {
    toast(err.message, 'error');
  }
  renderAll();
  runAlertNotifications();
}

async function refreshSubscription() {
  if (!state.user) return;
  try {
    state.subscription = await state.store.getSubscription();
  } catch (err) {
    toast(err.message, 'error');
  }
  renderAll();
}

/** Cambia de usuario (o a modo sin cuenta) y recarga los datos. */
async function applySession(user) {
  state.user = user;
  state.store = user ? new RemoteStore(state.client, user.id) : localStore;
  state.subscription = null;
  state.loginSentTo = null;
  if (user) {
    try {
      state.subscription = await state.store.getSubscription();
    } catch (err) {
      toast(err.message, 'error');
    }
  }
  await loadData();
  if (user) await offerMigration();
}

/** Conecta con Supabase y recupera la sesión (si hay). */
async function connectBackend() {
  try {
    state.client = await backend.getClient();
    const [{ user, error }, providers] = await Promise.all([
      backend.getSessionUser(state.client),
      backend.getAuthProviders(),
    ]);
    state.authProviders = providers;
    if (error) toast(`No se pudo iniciar sesión: ${error}`, 'error');
    await applySession(user);

    // Se registra después de aplicar la sesión inicial para no cargar dos veces.
    state.client.auth.onAuthStateChange((_event, session) => {
      const nextUser = session?.user ?? null;
      if ((nextUser?.id ?? null) === (state.user?.id ?? null)) return;
      // Supabase recomienda no llamar a su API dentro de este callback.
      setTimeout(() => {
        if ((nextUser?.id ?? null) === (state.user?.id ?? null)) return; // ya se aplicó
        applySession(nextUser).then(runAlertNotifications);
      }, 0);
    });
  } catch (err) {
    console.error(err);
    state.client = null;
    toast('No se pudo conectar con el servidor. Se usan los datos de este navegador.', 'error');
    state.connecting = false;
    await loadData();
    return;
  }
  state.connecting = false;
  renderAccount();
}

/** Al entrar por primera vez, ofrece copiar a la cuenta las tarjetas del navegador. */
async function offerMigration() {
  if (!state.user || state.cards.length) return;
  const key = migrationKey(state.user.id);
  if (storageGet(key)) return;
  const localCards = await localStore.getCards();
  if (!localCards.length) return;
  storageSet(key, '1');

  const toUpload = localCards.slice(0, currentPlan().cardLimit);
  const extra = localCards.length > toUpload.length ? ` Con el plan Gratis se copiarán ${toUpload.length}.` : '';
  const ok = await confirmDialog({
    title: 'Copiar tus tarjetas a tu cuenta',
    message: `Tienes ${plural(localCards.length, 'tarjeta guardada', 'tarjetas guardadas')} en este navegador. ¿Quieres copiarlas a tu cuenta?${extra}`,
    confirmText: 'Copiar a mi cuenta',
    cancelText: 'Ahora no',
    danger: false,
  });
  if (!ok) return;
  try {
    state.cards = await state.store.replaceCards(toUpload);
    renderAll();
    toast(`Se copiaron ${plural(state.cards.length, 'tarjeta', 'tarjetas')} a tu cuenta.`, 'success');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** Traduce errores del almacén a acciones de la interfaz. */
function handleStoreError(err, { dialog = null, nameField = false } = {}) {
  if (err instanceof StoreError && (err.code === 'limit' || err.code === 'premium')) {
    if (dialog && $(dialog).open) $(dialog).close();
    openUpgrade(err.code === 'limit' ? 'cards' : 'generic');
    return;
  }
  if (err instanceof StoreError && err.code === 'duplicate' && nameField) {
    showFieldErrors(CARD_FIELDS, { name: err.message });
    $('#f-name').focus();
    return;
  }
  console.error(err);
  toast(err.message || 'Ocurrió un error inesperado.', 'error');
}

/** Muestra notificaciones de los avisos pendientes (Premium y con permiso). */
async function runAlertNotifications() {
  if (!isPremium() || !state.device.browserNotifications) return;
  const alerts = computeAlerts(activeCards(), state.today, alertOptions());
  await notify.deliverAlertNotifications(alerts, alertMessage, state.today);
}

/** Tras volver de Mercado Pago, espera a que el webhook active la suscripción. */
async function handleCheckoutReturn() {
  const url = new URL(location.href);
  if (!url.searchParams.has('checkout') && !url.searchParams.has('preapproval_id')) return;
  url.searchParams.delete('checkout');
  url.searchParams.delete('preapproval_id');
  history.replaceState(null, '', `${url.pathname}${url.search}#cuenta`);
  applyRoute();
  if (!state.user) return;

  // Se espera a la suscripción, no solo a Premium: quien está en su prueba ya es Premium.
  toast('Estamos confirmando tu suscripción…');
  for (let attempt = 0; attempt < 10; attempt++) {
    await sleep(3000);
    await refreshSubscription();
    if (state.subscription?.status === 'active') {
      toast('¡Listo! Tu suscripción Premium está activa.', 'success');
      runAlertNotifications();
      return;
    }
  }
  toast('Tu suscripción sigue en proceso. Vuelve a abrir esta pantalla en unos minutos.');
}

// #endregion 4.

// #region 5. RECOMENDADOR (HERO + RANKING) ===================================

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
function heroHTML(ranked, date, isToday, cards) {
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
    const next = nextCycleStart(cards, date);
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
        <p class="eyebrow">⭐ ${isToday ? 'Hoy toca' : `El ${fmtShort(date)} toca`}</p>
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
    return state.loading
      ? '<li class="empty-inline">Cargando…</li>'
      : '<li class="empty-inline">Aún no tienes tarjetas. <button type="button" class="link-btn" data-action="add-card">Agrega una</button>.</li>';
  }
  const locked = lockedCardIds().size;
  const lockedNote = locked
    ? `<li class="empty-inline">${icon('lock', 'icon--sm')} ${plural(locked, 'tarjeta bloqueada no aparece', 'tarjetas bloqueadas no aparecen')} en el ranking. <button type="button" class="link-btn" data-action="upgrade" data-reason="locked">Desbloquear con Premium</button></li>`
    : '';
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
    .join('') + lockedNote;
}

// #endregion 5.

// #region 6. VISTAS: HOY, SIMULAR, CALENDARIO =================================

function renderHeader() {
  $('#header-date').textContent = fmtFull(state.today);
  const chip = $('#plan-chip');
  const premium = isPremium();
  chip.classList.toggle('is-premium', premium);
  chip.innerHTML = `${icon(premium ? 'star' : 'user')}<span>${premium ? 'Premium' : state.user ? 'Gratis' : 'Cuenta'}</span>`;
  chip.setAttribute('aria-label', `Cuenta y plan: ${premium ? 'Premium' : 'Gratis'}`);
}

/* ---- Vista: Hoy ---------------------------------------------------------- */

function renderHome() {
  const cards = activeCards();
  const ranked = rankCards(cards, state.today);
  $('#hero').innerHTML = ranked.length ? heroHTML(ranked, state.today, true, cards) : emptyStateHTML();
  $('#ranking-today').innerHTML = rankingHTML(ranked, true);
  renderAlertsPanel(cards);
  renderPremiumPromo();
  renderUpcoming(cards);
  renderCoreRules();
}

/** Avisos en la portada (solo Premium). */
function renderAlertsPanel(cards) {
  const box = $('#alerts');
  if (!isPremium() || !cards.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  const alerts = computeAlerts(cards, state.today, alertOptions());
  const head = `
    <header class="alerts-head">
      <h2>${icon('bell')}Avisos</h2>
      <a class="link-btn" href="#cuenta">Configurar</a>
    </header>`;
  if (!alerts.length) {
    box.innerHTML = `<section class="alerts-panel is-empty" aria-label="Avisos">${head}<p class="alerts-empty">Sin pagos ni cierres cercanos. Te avisaremos a tiempo.</p></section>`;
    return;
  }
  box.innerHTML = `
    <section class="alerts-panel" aria-label="Avisos">
      ${head}
      <ul class="alert-list">
        ${alerts
          .map((alert) => {
            const { title, body } = alertMessage(alert);
            const level = alert.type === 'payment' ? (alert.daysLeft <= 1 ? 'danger' : 'warning') : 'info';
            return `
              <li class="alert-item alert-item--${level}" style="${cardVars(alert.card)}">
                <span class="alert-icon" aria-hidden="true">${EVENT_META[alert.type].icon}</span>
                <div>
                  <p class="alert-title">${esc(title)}</p>
                  <p class="alert-body">${esc(body)}</p>
                </div>
              </li>`;
          })
          .join('')}
      </ul>
    </section>`;
}

/**
 * Premium en la portada: invitación (plan Gratis, con la prueba gratis si
 * corresponde) o aviso de que la prueba o el pase terminan pronto.
 */
function renderPremiumPromo() {
  const box = $('#premium-promo');
  const html = state.loading ? '' : isPremium() ? endingPromoHTML() : offerPromoHTML();
  box.hidden = !html;
  box.innerHTML = html;
}

function offerPromoHTML() {
  const benefits = `<ul class="benefits">${PREMIUM_BENEFITS.map((b) => `<li>${icon('check')}<span>${b}</span></li>`).join('')}</ul>`;
  if (trialOffered()) {
    return `
      <section class="promo" aria-labelledby="t-promo">
        <p class="eyebrow">${premiumPill()}</p>
        <h2 id="t-promo">Prueba Premium ${TRIAL_LABEL} gratis</h2>
        <p class="promo-sub">Sin tarjeta y sin compromiso. Al terminar vuelves al plan Gratis, a menos que decidas seguir.</p>
        ${benefits}
        <button type="button" class="btn btn--premium btn--block" data-action="start-trial">🎁 Empezar mi mes gratis</button>
      </section>`;
  }
  return `
    <section class="promo" aria-labelledby="t-promo">
      <p class="eyebrow">${premiumPill()}</p>
      <h2 id="t-promo">Que no se te pase ningún pago</h2>
      ${benefits}
      <button type="button" class="btn btn--premium btn--block" data-action="upgrade" data-reason="alerts">Ver Premium · ${priceText('monthly')} al mes</button>
    </section>`;
}

/** Aviso cuando la prueba gratis o el Premium sin renovación terminan en 5 días o menos. */
function endingPromoHTML() {
  const status = premiumStatus(state.subscription);
  if (!['trial', 'pass', 'cancelled'].includes(status.kind) || daysUntil(status.until) > 5) return '';
  const what = status.kind === 'trial' ? 'Tu prueba gratis' : 'Tu Premium';
  const days = daysUntil(status.until);
  const when = days <= 0 ? 'termina hoy' : days === 1 ? 'termina mañana' : `termina en ${days} días`;
  const methods = yapeAvailable() ? ', con Yape o con tarjeta' : '';
  const afterwards = 'vuelves al plan Gratis: tus tarjetas extra se guardan, pero quedan bloqueadas.';
  const text = paymentsAvailable()
    ? `Sigue con tarjetas ilimitadas y avisos de pago desde ${priceText('monthly')} al mes${methods}. Si no, ${afterwards}`
    : `Después ${afterwards} Muy pronto podrás seguir con Premium desde ${priceText('monthly')} al mes.`;
  return `
    <section class="promo promo--ending" aria-labelledby="t-promo">
      <h2 id="t-promo">⏳ ${what} ${when}</h2>
      <p class="promo-sub">${text}</p>
      <button type="button" class="btn btn--premium btn--block" data-action="see-plans">${paymentsAvailable() ? 'Seguir con Premium' : 'Ver planes'}</button>
    </section>`;
}

function renderUpcoming(cards) {
  const list = $('#upcoming');
  if (!cards.length) {
    list.innerHTML = `<li class="empty-inline">${state.loading ? 'Cargando…' : 'Sin eventos: agrega una tarjeta.'}</li>`;
    return;
  }
  const events = getEventsInRange(cards, state.today, addDays(state.today, 30)).slice(0, 10);
  if (!events.length) {
    list.innerHTML = '<li class="empty-inline">No hay eventos en los próximos 30 días.</li>';
    return;
  }
  list.innerHTML = events
    .map((ev) => {
      const meta = EVENT_META[ev.type];
      const urgent = ev.type === 'payment' && diffDays(state.today, ev.date) <= 5;
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
  const cards = activeCards();
  const ranked = rankCards(cards, date);

  $('#sim-date').value = toISO(date);
  $('#sim-hero').innerHTML = ranked.length ? heroHTML(ranked, date, isToday, cards) : emptyStateHTML();
  $('#sim-ranking').innerHTML = rankingHTML(ranked, isToday);

  const offset = diffDays(state.today, date);
  $$('#sim-quick [data-offset]').forEach((chip) => {
    const active = Number(chip.dataset.offset) === offset;
    chip.classList.toggle('is-active', active);
    chip.setAttribute('aria-pressed', String(active));
  });

  renderMonthMap(date, cards);
}

/** Mapa del mes: cada día coloreado con la mejor tarjeta + resumen por rangos. */
function renderMonthMap(date, cards) {
  const year = date.getFullYear();
  const month = date.getMonth();
  $('#month-map-title').textContent = `Mapa de ${MONTHS[month]} ${year}`;

  const map = $('#month-map');
  const rangesList = $('#month-ranges');
  if (!cards.length) {
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
    const { card, info } = rankCards(cards, day)[0];
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

const visibleCalendarCards = () => activeCards().filter((c) => !state.calHidden.has(c.id));

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
  $('#cal-filters').innerHTML = activeCards()
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
  const ranked = rankCards(activeCards(), date);

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

// #endregion 6.

// #region 7. VISTAS: PAGOS, TARJETAS, REGLAS, CUENTA ==========================

/* ---- Vista: Pagos (Premium) ---------------------------------------------- */

function renderPayments() {
  const box = $('#payments');
  if (state.loading) {
    box.innerHTML = emptyStateHTML();
    return;
  }
  if (!isPremium()) {
    box.innerHTML = paymentsLockedHTML();
    return;
  }
  const cards = activeCards();
  if (!cards.length) {
    box.innerHTML = emptyStateHTML();
    return;
  }

  const cardIds = new Set(cards.map((c) => c.id));
  const purchases = state.purchases.filter((p) => cardIds.has(p.cardId));
  const statements = projectPayments(cards, purchases, state.today);

  if (!purchases.length) {
    box.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon" aria-hidden="true">🧾</div>
        <h2>Registra tu primera compra</h2>
        <p>Anota tus compras con tarjeta y sus cuotas. Te mostraremos cuánto pagarás en cada tarjeta y en qué fecha.</p>
        <button type="button" class="btn btn--primary" data-action="add-purchase">${icon('plus')}Registrar compra</button>
      </div>`;
    return;
  }

  // Agrupa los estados de cuenta por fecha de pago.
  const groups = [];
  for (const statement of statements) {
    const last = groups[groups.length - 1];
    if (last && isSameDay(last.payment, statement.payment)) last.statements.push(statement);
    else groups.push({ payment: statement.payment, statements: [statement] });
  }

  const grandTotal = {};
  for (const s of statements) {
    for (const [cur, cents] of Object.entries(s.totals)) grandTotal[cur] = (grandTotal[cur] || 0) + cents;
  }
  const next = groups[0];
  const nextTotal = {};
  if (next) {
    for (const s of next.statements) {
      for (const [cur, cents] of Object.entries(s.totals)) nextTotal[cur] = (nextTotal[cur] || 0) + cents;
    }
  }

  const summary = `
    <div class="stat-grid">
      <div class="stat">
        <p class="stat-label">Próximo pago</p>
        <p class="stat-value">${next ? formatTotals(nextTotal) : '—'}</p>
        <p class="stat-sub">${next ? `${capitalize(fmtWeekday(next.payment))} · ${relativeDay(next.payment, state.today)}` : 'Sin pagos pendientes'}</p>
      </div>
      <div class="stat">
        <p class="stat-label">Total por pagar</p>
        <p class="stat-value">${formatTotals(grandTotal)}</p>
        <p class="stat-sub">${plural(groups.length, 'fecha de pago', 'fechas de pago')}</p>
      </div>
      <div class="stat">
        <p class="stat-label">Compras registradas</p>
        <p class="stat-value">${purchases.length}</p>
        <p class="stat-sub">Montos sin intereses de cuotas</p>
      </div>
    </div>`;

  const groupsHTML = groups.length
    ? `<ol class="pay-groups">${groups.map(paymentGroupHTML).join('')}</ol>`
    : '<p class="empty-inline">No tienes pagos pendientes: todas tus compras registradas ya vencieron.</p>';

  const purchasesHTML = `
    <ul class="purchase-list">
      ${purchases.slice(0, 60).map(purchaseRowHTML).join('')}
    </ul>`;

  box.innerHTML = `
    ${summary}
    <div class="split">
      <section class="panel" aria-labelledby="t-pay-dates">
        <header class="panel-head">
          <h2 id="t-pay-dates">Pagos por fecha</h2>
          <p class="panel-sub">Toca una tarjeta para ver qué compras incluye.</p>
        </header>
        ${groupsHTML}
      </section>
      <section class="panel" aria-labelledby="t-purchases">
        <header class="panel-head">
          <h2 id="t-purchases">Compras registradas</h2>
          <p class="panel-sub">Las más recientes primero.</p>
        </header>
        ${purchasesHTML}
      </section>
    </div>`;
}

function paymentGroupHTML(group) {
  const total = {};
  for (const s of group.statements) {
    for (const [cur, cents] of Object.entries(s.totals)) total[cur] = (total[cur] || 0) + cents;
  }
  const soon = diffDays(state.today, group.payment) <= 5;
  return `
    <li class="pay-group ${soon ? 'is-soon' : ''}">
      <div class="pay-date" aria-hidden="true">
        <span class="pay-day">${group.payment.getDate()}</span>
        <span class="pay-mon">${MONTHS_SHORT[group.payment.getMonth()]}</span>
      </div>
      <div class="pay-body">
        <p class="pay-when">${capitalize(fmtWeekday(group.payment, state.today))} · ${relativeDay(group.payment, state.today)}</p>
        <ul class="pay-cards">
          ${group.statements
            .map((s) => `
              <li style="${cardVars(s.card)}">
                <details>
                  <summary>
                    <span class="dot" aria-hidden="true"></span>
                    <span class="pay-card-name">${esc(s.card.name)}</span>
                    <span class="pay-amount">${formatTotals(s.totals)}</span>
                  </summary>
                  <p class="pay-closing">Estado de cuenta que cierra el ${fmtShort(s.closing)}</p>
                  <ul class="pay-items">
                    ${s.items
                      .map((item) => `
                        <li>
                          <span>${esc(item.purchase.description)}${item.installments > 1 ? ` · cuota ${item.installment} de ${item.installments}` : ''}</span>
                          <span>${formatMoney(item.cents, item.purchase.currency)}</span>
                        </li>`)
                      .join('')}
                  </ul>
                </details>
              </li>`)
            .join('')}
        </ul>
        ${group.statements.length > 1 ? `<p class="pay-total">Total del día: <strong>${formatTotals(total)}</strong></p>` : ''}
      </div>
    </li>`;
}

function purchaseRowHTML(purchase) {
  const card = state.cards.find((c) => c.id === purchase.cardId);
  const schedule = purchaseSchedule(card, purchase);
  const last = schedule[schedule.length - 1];
  const paid = last && diffDays(state.today, last.payment) < 0;
  const date = fromISO(purchase.date);
  return `
    <li class="purchase ${paid ? 'is-paid' : ''}" style="${card ? cardVars(card) : ''}">
      <span class="dot" aria-hidden="true"></span>
      <div class="purchase-body">
        <p class="purchase-title">${esc(purchase.description)}</p>
        <p class="purchase-sub">${esc(card ? card.name : 'Tarjeta eliminada')} · ${date ? fmtShort(date) : ''}${purchase.installments > 1 ? ` · ${purchase.installments} cuotas` : ''}${paid ? ' · pagada' : ''}</p>
      </div>
      <span class="purchase-amount">${formatMoney(toCents(purchase.amount), purchase.currency)}</span>
      <button type="button" class="icon-btn icon-btn--sm" data-action="delete-purchase" data-id="${esc(purchase.id)}" aria-label="Eliminar ${esc(purchase.description)}">${icon('trash')}</button>
    </li>`;
}

function paymentsLockedHTML() {
  const sample = [
    ['20', 'nov', 'Interbank', 'S/ 1,240.50'],
    ['5', 'dic', 'Falabella', 'S/ 386.90'],
    ['20', 'dic', 'BCP', 'S/ 912.00'],
  ];
  return `
    <div class="locked-view">
      <div class="locked-preview" aria-hidden="true">
        ${sample
          .map(([day, mon, name, amount]) => `
            <div class="pay-group">
              <div class="pay-date"><span class="pay-day">${day}</span><span class="pay-mon">${mon}</span></div>
              <div class="pay-body"><p class="pay-when">${name}</p><p class="pay-amount">${amount}</p></div>
            </div>`)
          .join('')}
      </div>
      <div class="locked-cta">
        <p class="eyebrow">${premiumPill()}</p>
        <h2>¿Cuánto pagarás el próximo mes?</h2>
        <p>Registra tus compras y cuotas, y la app te muestra cuánto pagarás en cada tarjeta y en qué fecha.</p>
        <button type="button" class="btn btn--premium" data-action="upgrade" data-reason="projection">Ver Premium · ${priceText('monthly')} al mes</button>
      </div>
    </div>`;
}

/* ---- Vista: Tarjetas (CRUD) ---------------------------------------------- */

function renderCards() {
  renderCardsUsage();
  $('#backup-sub').textContent = state.user
    ? 'Tus tarjetas están guardadas en tu cuenta. Exporta un respaldo si quieres una copia.'
    : 'Tus tarjetas se guardan solo en este navegador. Exporta un respaldo para llevarlas a otro dispositivo.';
  const grid = $('#cards-grid');
  if (!state.cards.length) {
    grid.innerHTML = emptyStateHTML();
    return;
  }
  const locked = lockedCardIds();
  grid.innerHTML = state.cards.map((card) => cardItemHTML(card, locked.has(card.id))).join('') + addTileHTML();
}

function renderCardsUsage() {
  const box = $('#cards-usage');
  const plan = currentPlan();
  const count = state.cards.length;
  if (state.loading) {
    box.innerHTML = '';
    return;
  }
  if (plan.id === 'premium') {
    box.innerHTML = `<div class="usage">${premiumPill()}<span>${plural(count, 'tarjeta', 'tarjetas')} · sin límite</span></div>`;
    return;
  }
  const used = Math.min(count, plan.cardLimit);
  const lockedCount = Math.max(0, count - plan.cardLimit);
  box.innerHTML = `
    <div class="usage">
      <span class="plan-pill">Plan Gratis</span>
      <span>${used} de ${plan.cardLimit} tarjetas${lockedCount ? ` · ${plural(lockedCount, 'bloqueada', 'bloqueadas')}` : ''}</span>
      <span class="meter" role="progressbar" aria-label="Tarjetas usadas" aria-valuemin="0" aria-valuemax="${plan.cardLimit}" aria-valuenow="${used}">
        <span style="width:${(used / plan.cardLimit) * 100}%"></span>
      </span>
      <button type="button" class="link-btn" data-action="upgrade" data-reason="cards">Tarjetas ilimitadas con Premium</button>
    </div>`;
}

function cardItemHTML(card, isLocked) {
  const info = getCycleInfo(card, state.today);
  return `
    <article class="card-item ${isLocked ? 'is-locked' : ''}">
      ${miniCardHTML(card)}
      ${isLocked
        ? `<p class="locked-banner">${icon('lock', 'icon--sm')}<span>Bloqueada: el plan Gratis usa ${FREE_CARD_LIMIT} tarjetas.</span><button type="button" class="link-btn" data-action="upgrade" data-reason="locked">Desbloquear</button></p>`
        : ''}
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
}

function addTileHTML() {
  if (canAddCard(state.cards.length, currentPlanId())) {
    return `<button type="button" class="card-add" data-action="add-card">${icon('plus')}<span>Agregar tarjeta</span></button>`;
  }
  return `
    <button type="button" class="card-add card-add--locked" data-action="upgrade" data-reason="cards">
      ${icon('lock')}
      <span>Límite del plan Gratis</span>
      <small>Hazte Premium para agregar más tarjetas</small>
    </button>`;
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

/** Ejemplo del ciclo con datos reales (BCP si existe; si no, la primera tarjeta). */
function renderHowItWorks() {
  const cards = activeCards();
  const card =
    cards.find((c) => c.name.trim().toLowerCase() === 'bcp') ||
    cards[0] ||
    { id: 'ejemplo', ...EXAMPLE_CARDS[1] };
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

/* ---- Vista: Cuenta, plan y avisos ---------------------------------------- */

function renderAccount() {
  $('#account-panel').innerHTML = accountPanelHTML();
  $('#plans-panel').innerHTML = plansPanelHTML();
  $('#alerts-settings').innerHTML = alertsSettingsHTML();
}

function accountPanelHTML() {
  if (state.backend === 'none') {
    return `
      <header class="panel-head">
        <h2>${icon('user')}Cuenta</h2>
        <p class="panel-sub">Modo local: tus datos se guardan solo en este navegador.</p>
      </header>
      <p class="small muted">Las cuentas, la sincronización entre dispositivos, los avisos por correo y los cobros se activan al conectar el servidor (Supabase). Los pasos están en el README del proyecto.</p>
      ${isDevMode() ? devToolsHTML() : ''}`;
  }

  if (state.connecting) {
    return `
      <header class="panel-head">
        <h2>${icon('user')}Cuenta</h2>
        <p class="panel-sub">Conectando con tu cuenta…</p>
      </header>
      <div class="spinner" aria-hidden="true"></div>`;
  }

  if (!state.client) {
    return `
      <header class="panel-head">
        <h2>${icon('user')}Cuenta</h2>
        <p class="panel-sub">No se pudo conectar con el servidor.</p>
      </header>
      <p class="small muted">Mientras tanto, la app usa los datos guardados en este navegador.</p>
      <button type="button" class="btn btn--ghost" data-action="reload">${icon('refresh')}Reintentar</button>`;
  }

  if (!state.user) {
    if (state.loginSentTo) {
      return `
        <header class="panel-head">
          <h2>${icon('mail')}Revisa tu correo</h2>
          <p class="panel-sub">Te enviamos un enlace de acceso a <strong>${esc(state.loginSentTo)}</strong>.</p>
        </header>
        <p class="small muted">Ábrelo en este mismo navegador. Si no lo ves, revisa la carpeta de spam.</p>
        <button type="button" class="btn btn--ghost" data-action="login-reset">Usar otro correo</button>`;
    }
    return `
      <header class="panel-head">
        <h2>${icon('user')}Inicia sesión</h2>
        <p class="panel-sub">Guarda tus tarjetas en tu cuenta y úsalas en cualquier dispositivo.</p>
      </header>
      <form id="login-form" class="login-form" novalidate>
        <label class="field-label" for="login-email">Correo electrónico</label>
        <div class="input-row">
          <input id="login-email" class="input" type="email" autocomplete="email" placeholder="tu@correo.com" required />
          <button type="submit" class="btn btn--primary">Enviarme un enlace</button>
        </div>
        <p class="field-hint">Te enviamos un enlace para entrar sin contraseña.</p>
      </form>
      ${state.authProviders.google
        ? `<div class="divider"><span>o</span></div>
      <button type="button" class="btn btn--ghost btn--block" data-action="login-google">Continuar con Google</button>`
        : ''}
      <p class="login-legal">Al continuar, aceptas los <a href="terminos.html">Términos y condiciones</a> y la <a href="privacidad.html">Política de privacidad</a>.</p>`;
  }

  const email = state.user.email || 'Tu cuenta';
  return `
    <header class="panel-head">
      <h2>${icon('user')}Tu cuenta</h2>
    </header>
    <div class="account-row">
      <span class="avatar" aria-hidden="true">${esc(email.charAt(0).toUpperCase())}</span>
      <div>
        <p class="account-email">${esc(email)}</p>
        <p class="panel-sub">Tus tarjetas se sincronizan con tu cuenta.</p>
      </div>
    </div>
    <button type="button" class="btn btn--ghost" data-action="logout">${icon('logout')}Cerrar sesión</button>`;
}

function devToolsHTML() {
  const premium = isPremium();
  return `
    <div class="dev-box">
      <p class="eyebrow">🧪 Modo de prueba</p>
      <p class="small">Simula el plan para probar los límites, los avisos y la proyección de pagos. Este control desaparece al conectar el servidor.</p>
      <div class="segmented" role="group" aria-label="Plan simulado">
        <button type="button" class="${premium ? '' : 'is-active'}" data-action="dev-plan" data-plan="free" aria-pressed="${!premium}">Gratis</button>
        <button type="button" class="${premium ? 'is-active' : ''}" data-action="dev-plan" data-plan="premium" aria-pressed="${premium}">Premium</button>
      </div>
    </div>`;
}

function plansPanelHTML() {
  const premium = isPremium();
  const sub = state.subscription;
  const status = premiumStatus(sub);
  const cell = (value) => {
    if (value === true) return `<span class="yes">${icon('check')}<span class="sr-only">Incluido</span></span>`;
    if (value === false) return '<span class="no" aria-label="No incluido">—</span>';
    return esc(value);
  };

  let actions = trialOffered() ? trialOfferHTML() : '';
  if (status.kind !== 'subscription' && !(premium && isDevMode())) actions += payOptionsHTML(premium, status);
  if (status.kind === 'subscription' && state.user) {
    actions += `<button type="button" class="btn btn--ghost btn--danger-text" data-action="cancel-subscription">Cancelar suscripción</button>`;
  }
  if (sub?.status === 'pending') {
    actions += `<button type="button" class="btn btn--ghost" data-action="refresh-plan">${icon('refresh')}Actualizar estado</button>`;
  }

  return `
    <header class="panel-head">
      <h2>${icon('star')}Plan ${premium ? premiumPill() : '<span class="plan-pill">Gratis</span>'}</h2>
      <p class="panel-sub">${planStatusText(premium, sub, status)}</p>
    </header>
    <table class="plans-table">
      <thead><tr><th scope="col"><span class="sr-only">Función</span></th><th scope="col">Gratis</th><th scope="col">Premium</th></tr></thead>
      <tbody>
        ${PLAN_FEATURES.map((f) => `<tr><th scope="row">${f.label}</th><td>${cell(f.free)}</td><td>${cell(f.premium)}</td></tr>`).join('')}
      </tbody>
    </table>
    ${actions}`;
}

/** Una línea que explica el plan actual: de dónde viene Premium y hasta cuándo. */
function planStatusText(premium, sub, status) {
  if (isDevMode()) return premium ? 'Premium de prueba activo. No se hizo ningún cobro.' : 'Estás en el plan Gratis.';
  const date = (iso) => fmtLong(new Date(iso), state.today);
  switch (status.kind) {
    case 'subscription': {
      const plan = sub.interval === 'yearly' ? 'anual' : 'mensual';
      return status.nextCharge
        ? `Tu suscripción ${plan} con tarjeta está activa. Próximo cobro: ${date(status.nextCharge)}.`
        : `Tu suscripción ${plan} con tarjeta está activa. ¡Gracias por apoyar la app!`;
    }
    case 'trial':
      return `Estás en tu prueba gratis: termina el ${date(status.until)} (${daysLeftText(status.until)}). No se te cobrará nada.`;
    case 'pass':
      return `Tienes Premium hasta el ${date(status.until)} (${daysLeftText(status.until)}). No se renueva solo.`;
    case 'cancelled':
      return `Tu Premium sigue activo hasta el ${date(status.until)}. No se renovará.`;
    case 'pending':
      return 'Tu pago está en proceso. Puede tardar unos minutos en confirmarse.';
    case 'paused':
      return 'Tu suscripción está pausada. Revisa tu medio de pago en Mercado Pago.';
    default:
      return sub?.trialEndsAt ? 'Tu prueba gratis terminó. Estás en el plan Gratis.' : 'Estás en el plan Gratis.';
  }
}

function trialOfferHTML() {
  return `
    <div class="trial-offer">
      <span class="trial-offer-icon" aria-hidden="true">🎁</span>
      <div class="trial-offer-text">
        <p class="trial-offer-title">Prueba Premium ${TRIAL_LABEL} gratis</p>
        <p>Sin tarjeta y sin compromiso. Al terminar vuelves al plan Gratis, a menos que decidas pagar.</p>
      </div>
      <button type="button" class="btn btn--premium" data-action="start-trial">Empezar mi mes gratis</button>
    </div>`;
}

/** Formas de pago: pase con Yape (pago único) o suscripción con tarjeta (se renueva sola). */
function payOptionsHTML(premium, status) {
  const payable = paymentsAvailable();
  const yape = yapeAvailable();
  const method = yape ? state.payMethod : 'card';
  const until = status.until; // Premium vigente que no se renueva (prueba, pase o cancelada)
  const date = (iso) => fmtLong(new Date(iso), state.today);

  let note = 'Pago seguro con Mercado Pago.';
  if (isDevMode()) note = 'Modo de prueba: al elegir un plan se activa Premium sin cobrar.';
  else if (!payable) note = '<strong>Muy pronto</strong> podrás pagar Premium. Mientras tanto, todo el plan Gratis está disponible.';
  else if (!state.user) note = 'Inicia sesión para pagar. Pago seguro con Mercado Pago.';
  else if (until && method === 'yape') note = `Los días se suman: tu pase empieza el ${date(until)}, cuando termine tu Premium actual.`;
  else if (until) note = `No pierdes tus días: el primer cobro será el ${date(until)}, cuando termine tu Premium actual.`;

  const methodText = method === 'yape'
    ? 'Sin tarjeta: pagas con tu celular y el código de aprobación de Yape. Es un pago único y no se renueva solo.'
    : 'Se renueva sola y la cancelas cuando quieras. Tu tarjeta se ingresa en la página segura de Mercado Pago, nunca en CuálToca. También puedes pagar con tu saldo de Mercado Pago.';
  const periods = method === 'yape'
    ? { monthly: `${PASS_LABELS.monthly} · pago único`, yearly: `${PASS_LABELS.yearly} · pago único` }
    : { monthly: 'al mes', yearly: 'al año' };
  const action = method === 'yape' ? 'pay-yape' : 'checkout';
  const disabled = payable ? '' : 'disabled';
  const methodButton = (id, label) =>
    `<button type="button" class="${method === id ? 'is-active' : ''}" data-action="pay-method" data-method="${id}" aria-pressed="${method === id}">${label}</button>`;

  return `
    <section class="pay-block" aria-labelledby="t-pay">
      <h3 class="pay-title" id="t-pay">${premium ? 'Sigue con Premium' : 'Hazte Premium'}</h3>
      ${yape ? `<div class="segmented pay-methods" role="group" aria-label="Forma de pago">${methodButton('yape', '📱 Yape')}${methodButton('card', '💳 Tarjeta')}</div>` : ''}
      <p class="pay-method-text">${methodText}</p>
      <div class="price-options">
        <button type="button" class="price-option" data-action="${action}" data-interval="monthly" ${disabled}>
          <span class="price">${priceText('monthly')}</span><span class="price-period">${periods.monthly}</span>
        </button>
        <button type="button" class="price-option price-option--best" data-action="${action}" data-interval="yearly" ${disabled}>
          <span class="price-save">Ahorra ${yearlySavingsPercent()}%</span>
          <span class="price">${priceText('yearly')}</span><span class="price-period">${periods.yearly}</span>
        </button>
      </div>
      <p class="field-hint">${note}</p>
    </section>`;
}

function alertsSettingsHTML() {
  const premium = isPremium();
  const s = state.settings;
  const permission = notify.notificationPermission();
  const browserOn = state.device.browserNotifications && permission === 'granted';
  const permissionText = {
    granted: browserOn ? 'Activadas en este dispositivo.' : 'Permiso concedido.',
    denied: 'Bloqueadas en el navegador. Actívalas en la configuración del sitio.',
    default: 'Te pediremos permiso al activarlas. En iPhone, instala la app en la pantalla de inicio.',
    unsupported: 'Este navegador no permite notificaciones.',
  }[permission];
  const emailText = state.user
    ? `Se envían a ${esc(state.user.email || 'tu correo')} cada mañana.`
    : state.backend === 'none' ? 'Requiere conectar el servidor.' : 'Inicia sesión para recibirlos.';

  const dayOptions = Array.from({ length: 8 }, (_, d) =>
    `<option value="${d}" ${d === s.daysBefore ? 'selected' : ''}>${d === 0 ? 'El mismo día' : `${plural(d, 'día', 'días')} antes`}</option>`).join('');

  return `
    <header class="panel-head">
      <h2>${icon('bell')}Avisos ${premium ? '' : premiumPill()}</h2>
      <p class="panel-sub">Te avisamos antes de cada fecha límite de pago y de cada cierre de facturación.</p>
    </header>
    ${premium ? '' : noteHTML('🔒', `Los avisos son parte de Premium. <button type="button" class="link-btn link-btn--inline" data-action="upgrade" data-reason="alerts">Ver Premium</button>`, 'tip')}
    <form id="alerts-form" class="settings-form" novalidate>
      <fieldset ${premium ? '' : 'disabled'}>
        <legend class="sr-only">Preferencias de avisos</legend>
        <div class="field">
          <label for="s-days">Avisar el pago</label>
          <select id="s-days" class="input">${dayOptions}</select>
        </div>
        <label class="switch">
          <input type="checkbox" id="s-closing" ${s.notifyClosing ? 'checked' : ''} />
          <span class="switch-ui" aria-hidden="true"></span>
          <span class="switch-text">Avisar también el cierre de facturación<small>El día anterior y el mismo día.</small></span>
        </label>
        <label class="switch">
          <input type="checkbox" id="s-browser" ${browserOn ? 'checked' : ''} ${permission === 'unsupported' ? 'disabled' : ''} />
          <span class="switch-ui" aria-hidden="true"></span>
          <span class="switch-text">Notificaciones en este dispositivo<small>${permissionText}</small></span>
        </label>
        <label class="switch">
          <input type="checkbox" id="s-email" ${s.emailReminders && state.user ? 'checked' : ''} ${state.user ? '' : 'disabled'} />
          <span class="switch-ui" aria-hidden="true"></span>
          <span class="switch-text">Avisos por correo<small>${emailText}</small></span>
        </label>
        <button type="button" class="btn btn--ghost btn--sm" data-action="test-notification" ${browserOn ? '' : 'disabled'}>${icon('bell')}Probar notificación</button>
      </fieldset>
    </form>`;
}

function renderAll() {
  renderHeader();
  renderHome();
  renderSimulator();
  renderCalendar();
  renderPayments();
  renderCards();
  renderRules();
  renderAccount();
}

// #endregion 7.

// #region 8. FORMULARIOS Y DIÁLOGOS ==========================================

/** Muestra (o limpia) los mensajes de error de un formulario. */
function showFieldErrors(fields, errors) {
  Object.entries(fields).forEach(([field, selector]) => {
    const message = errors[field] || '';
    const errorEl = $(`${selector.form} [data-error-for="${field}"]`);
    if (errorEl) errorEl.textContent = message;
    const input = $(selector.input);
    if (message) input.setAttribute('aria-invalid', 'true');
    else input.removeAttribute('aria-invalid');
  });
}

/* ---- Tarjeta ------------------------------------------------------------- */

const CARD_FIELDS = {
  name: { form: '#card-form', input: '#f-name' },
  closingDay: { form: '#card-form', input: '#f-closing' },
  paymentDay: { form: '#card-form', input: '#f-payment' },
};

function readCardForm() {
  return {
    name: $('#f-name').value.trim(),
    closingDay: Number($('#f-closing').value),
    paymentDay: Number($('#f-payment').value),
    color: HEX_COLOR.test($('#f-color').value) ? $('#f-color').value.toLowerCase() : PRESET_COLORS[0],
  };
}

function validateCardForm(data) {
  const errors = {};
  if (!data.name) {
    errors.name = 'Escribe el nombre de la tarjeta o del banco.';
  } else if (state.cards.some((c) => c.id !== state.editingId && c.name.toLowerCase() === data.name.toLowerCase())) {
    errors.name = 'Ya tienes una tarjeta con ese nombre. Usa uno distinto (ej: "BCP Visa").';
  }
  if (!isValidDay(data.closingDay)) errors.closingDay = 'El día de cierre debe estar entre 1 y 31.';
  if (!isValidDay(data.paymentDay)) errors.paymentDay = 'El día de pago debe estar entre 1 y 31.';
  return errors;
}

function renderSwatches(selected) {
  $('#f-swatches').innerHTML = PRESET_COLORS.map(
    (color) =>
      `<button type="button" class="swatch ${color === selected ? 'is-selected' : ''}" style="--c:${color}" data-color="${color}" aria-pressed="${color === selected}" aria-label="Color ${color}"></button>`,
  ).join('');
}

/** Vista previa en vivo de la tarjeta y de un ciclo de ejemplo. */
function updateCardPreview() {
  const data = readCardForm();
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
  if (!card && !canAddCard(state.cards.length, currentPlanId())) {
    openUpgrade('cards');
    return;
  }
  state.editingId = card ? card.id : null;

  const usedColors = new Set(state.cards.map((c) => c.color));
  const color = card ? card.color : PRESET_COLORS.find((c) => !usedColors.has(c)) || PRESET_COLORS[0];

  $('#card-dialog-title').textContent = card ? `Editar ${card.name}` : 'Agregar tarjeta';
  $('#card-submit').textContent = card ? 'Guardar cambios' : 'Agregar tarjeta';
  $('#f-name').value = card ? card.name : '';
  $('#f-closing').value = card ? card.closingDay : '';
  $('#f-payment').value = card ? card.paymentDay : '';
  $('#f-color').value = color;

  showFieldErrors(CARD_FIELDS, {});
  renderSwatches(color);
  updateCardPreview();
  dialog.showModal();
  $('#f-name').focus();
}

async function onCardSubmit(event) {
  event.preventDefault();
  const submit = $('#card-submit');
  if (submit.disabled) return;
  const data = readCardForm();
  const errors = validateCardForm(data);
  showFieldErrors(CARD_FIELDS, errors);
  const firstInvalid = Object.keys(CARD_FIELDS).find((field) => errors[field]);
  if (firstInvalid) {
    $(CARD_FIELDS[firstInvalid].input).focus();
    return;
  }

  setBusy(submit, true);
  try {
    if (state.editingId) {
      await state.store.updateCard(state.editingId, data);
      toast(`"${data.name}" se actualizó.`, 'success');
    } else {
      if (!canAddCard(state.cards.length, currentPlanId())) {
        $('#card-dialog').close();
        openUpgrade('cards');
        return;
      }
      await state.store.addCard(data);
      toast(`"${data.name}" se agregó.`, 'success');
    }
    $('#card-dialog').close();
    await reloadCards();
  } catch (err) {
    handleStoreError(err, { dialog: '#card-dialog', nameField: true });
  } finally {
    setBusy(submit, false);
  }
}

async function deleteCard(id) {
  const card = state.cards.find((c) => c.id === id);
  if (!card) return;
  const purchasesCount = state.purchases.filter((p) => p.cardId === id).length;
  const ok = await confirmDialog({
    title: 'Eliminar tarjeta',
    message: `¿Eliminar "${card.name}"?${purchasesCount ? ` También se borrarán ${plural(purchasesCount, 'compra registrada', 'compras registradas')}.` : ''} Esta acción no se puede deshacer.`,
    confirmText: 'Eliminar',
  });
  if (!ok) return;
  try {
    await state.store.deleteCard(id);
    state.calHidden.delete(id);
    await reloadCards();
    toast(`"${card.name}" se eliminó.`, 'success');
  } catch (err) {
    handleStoreError(err);
  }
}

/** Reemplaza todas las tarjetas (importar o cargar ejemplos) respetando el límite del plan. */
async function replaceAllCards(list, { title, successText }) {
  const limit = currentPlan().cardLimit;
  const cards = list.slice(0, limit);
  const trimmed = list.length - cards.length;
  const ok = await confirmDialog({
    title,
    message: `${state.cards.length ? `Se reemplazarán tus ${plural(state.cards.length, 'tarjeta', 'tarjetas')} actuales y sus compras. ` : ''}Se cargarán ${plural(cards.length, 'tarjeta', 'tarjetas')}.${trimmed ? ` El plan Gratis permite ${limit}: ${plural(trimmed, 'tarjeta queda', 'tarjetas quedan')} fuera.` : ''}`,
    confirmText: 'Continuar',
    danger: state.cards.length > 0,
  });
  if (!ok) return;
  try {
    await state.store.replaceCards(cards);
    state.calHidden.clear();
    await reloadCards();
    toast(successText(cards.length), 'success');
  } catch (err) {
    handleStoreError(err);
  }
}

function exportCards() {
  const payload = {
    app: 'cualtoca',
    version: 1,
    exportedAt: new Date().toISOString(),
    cards: state.cards,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `cualtoca-tarjetas-${toISO(state.today)}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('Respaldo exportado.', 'success');
}

async function importCards(file) {
  let cards;
  try {
    const data = JSON.parse(await file.text());
    const list = Array.isArray(data) ? data : data && data.cards;
    if (!Array.isArray(list)) throw new Error('el archivo no tiene una lista de tarjetas');
    cards = normalizeCards(list);
    if (!cards.length) throw new Error('no se encontraron tarjetas válidas');
  } catch (err) {
    toast(`No se pudo importar: ${err.message}.`, 'error');
    return;
  }
  await replaceAllCards(cards, {
    title: 'Importar tarjetas',
    successText: (n) => `Se importaron ${plural(n, 'tarjeta', 'tarjetas')}.`,
  });
}

/* ---- Compra (Premium) ---------------------------------------------------- */

const PURCHASE_FIELDS = {
  description: { form: '#purchase-form', input: '#p-description' },
  amount: { form: '#purchase-form', input: '#p-amount' },
  date: { form: '#purchase-form', input: '#p-date' },
  installments: { form: '#purchase-form', input: '#p-installments' },
  cardId: { form: '#purchase-form', input: '#p-card' },
};

function readPurchaseForm() {
  return {
    description: $('#p-description').value.trim(),
    amount: Number($('#p-amount').value),
    currency: $('#p-currency').value === 'USD' ? 'USD' : 'PEN',
    date: $('#p-date').value,
    installments: Number($('#p-installments').value),
    cardId: $('#p-card').value,
  };
}

function validatePurchaseForm(data) {
  const errors = {};
  if (!data.description) errors.description = 'Describe la compra (ej: "Zapatillas").';
  if (!(data.amount > 0)) errors.amount = 'Ingresa un monto mayor que cero.';
  else if (data.amount > MAX_AMOUNT) errors.amount = 'El monto es demasiado alto.';
  if (!fromISO(data.date)) errors.date = 'Elige una fecha válida.';
  if (!Number.isInteger(data.installments) || data.installments < 1 || data.installments > MAX_INSTALLMENTS) {
    errors.installments = `Entre 1 y ${MAX_INSTALLMENTS} cuotas.`;
  }
  if (!activeCards().some((c) => c.id === data.cardId)) errors.cardId = 'Elige una tarjeta.';
  return errors;
}

/** Llena el selector de tarjetas ordenado por la mejor opción para la fecha. */
function fillPurchaseCards() {
  const select = $('#p-card');
  const date = fromISO($('#p-date').value) || state.today;
  const previous = select.value;
  const ranked = rankCards(activeCards(), date);
  select.innerHTML = ranked
    .map(({ card, info }, i) => `<option value="${esc(card.id)}">${esc(card.name)} · ${info.financingDays} días${i === 0 ? ' · recomendada' : ''}</option>`)
    .join('');
  if (state.purchaseCardTouched && ranked.some((r) => r.card.id === previous)) select.value = previous;
}

function updatePurchasePreview() {
  const data = readPurchaseForm();
  const summary = $('#purchase-summary');
  const card = activeCards().find((c) => c.id === data.cardId);
  const date = fromISO(data.date);
  const validInstallments = Number.isInteger(data.installments) && data.installments >= 1 && data.installments <= MAX_INSTALLMENTS;
  if (!card || !date || !(data.amount > 0) || !validInstallments) {
    summary.textContent = 'Completa el monto, la fecha y las cuotas para ver cuándo lo pagarás.';
    return;
  }
  const schedule = purchaseSchedule(card, data);
  const first = schedule[0];
  const last = schedule[schedule.length - 1];
  if (schedule.length === 1) {
    summary.innerHTML = `Se factura el <strong>${fmtShort(first.closing)}</strong> y lo pagas hasta el <strong>${fmtLong(first.payment, date)}</strong>: ${plural(diffDays(date, first.payment), 'día', 'días')} de crédito sin intereses.`;
    return;
  }
  summary.innerHTML = `${schedule.length} cuotas de <strong>${formatMoney(first.cents, data.currency)}</strong>: la primera se paga el <strong>${fmtShort(first.payment)}</strong> y la última el <strong>${fmtLong(last.payment, date)}</strong>.<span class="warn">⚠️ Las compras en cuotas suelen tener intereses. Aquí ves solo el monto sin intereses.</span>`;
}

function openPurchaseDialog() {
  if (!isPremium()) {
    openUpgrade('projection');
    return;
  }
  if (!activeCards().length) {
    toast('Primero agrega una tarjeta.');
    location.hash = '#tarjetas';
    return;
  }
  const dialog = $('#purchase-dialog');
  if (dialog.open) return;
  $('#purchase-form').reset();
  $('#p-date').value = toISO(state.today);
  $('#p-installments').value = '1';
  state.purchaseCardTouched = false;
  fillPurchaseCards();
  showFieldErrors(PURCHASE_FIELDS, {});
  updatePurchasePreview();
  dialog.showModal();
  $('#p-description').focus();
}

async function onPurchaseSubmit(event) {
  event.preventDefault();
  const submit = $('#purchase-submit');
  if (submit.disabled) return;
  const data = readPurchaseForm();
  const errors = validatePurchaseForm(data);
  showFieldErrors(PURCHASE_FIELDS, errors);
  const firstInvalid = Object.keys(PURCHASE_FIELDS).find((field) => errors[field]);
  if (firstInvalid) {
    $(PURCHASE_FIELDS[firstInvalid].input).focus();
    return;
  }
  setBusy(submit, true);
  try {
    await state.store.addPurchase({ ...data, amount: Math.round(data.amount * 100) / 100 });
    $('#purchase-dialog').close();
    state.purchases = await state.store.getPurchases();
    renderPayments();
    toast(`"${data.description}" se registró.`, 'success');
  } catch (err) {
    handleStoreError(err, { dialog: '#purchase-dialog' });
  } finally {
    setBusy(submit, false);
  }
}

async function deletePurchase(id) {
  const purchase = state.purchases.find((p) => p.id === id);
  if (!purchase) return;
  const ok = await confirmDialog({
    title: 'Eliminar compra',
    message: `¿Eliminar "${purchase.description}" de tus compras registradas?`,
    confirmText: 'Eliminar',
  });
  if (!ok) return;
  try {
    await state.store.deletePurchase(id);
    state.purchases = await state.store.getPurchases();
    renderPayments();
    toast('Compra eliminada.', 'success');
  } catch (err) {
    handleStoreError(err);
  }
}

/* ---- Cuenta, plan y avisos ----------------------------------------------- */

async function login(email) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    toast('Escribe un correo válido.', 'error');
    focusSelector('#login-email');
    return;
  }
  const button = $('#login-form button[type="submit"]');
  setBusy(button, true);
  try {
    await backend.signInWithEmail(state.client, email);
    state.loginSentTo = email;
    renderAccount();
  } catch (err) {
    toast(`No se pudo enviar el enlace: ${err.message}`, 'error');
    setBusy(button, false);
  }
}

async function checkout(interval, button) {
  if (isDevMode()) {
    storageSet(DEV_PLAN_KEY, 'premium');
    onPlanChanged();
    toast('Premium de prueba activado. No se hizo ningún cobro.', 'success');
    return;
  }
  if (!readyToPay(paymentsAvailable(), 'Inicia sesión para suscribirte.')) return;
  setBusy(button, true);
  try {
    location.href = await backend.startCheckout(state.client, interval);
  } catch (err) {
    toast(`No se pudo iniciar el pago: ${err.message}`, 'error');
    setBusy(button, false);
  }
}

/**
 * Comprueba que se pueda pagar o empezar la prueba: función activa (`enabled`),
 * servidor conectado y sesión iniciada (si no, lleva al inicio de sesión).
 */
function readyToPay(enabled, loginMessage) {
  if (!enabled) {
    toast('Premium estará disponible muy pronto.');
    return false;
  }
  if (!state.client) {
    toast('Los pagos se activan al conectar el servidor.', 'error');
    return false;
  }
  if (!state.user) {
    toast(loginMessage);
    location.hash = '#cuenta';
    setTimeout(() => {
      $('#account-panel').scrollIntoView({ block: 'start' });
      focusSelector('#login-email');
    }, 60);
    return false;
  }
  return true;
}

/** Activa la prueba gratis de 1 mes (una vez por persona, sin medio de pago). */
async function startTrial(button = null) {
  if (isDevMode()) {
    storageSet(DEV_PLAN_KEY, 'premium');
    onPlanChanged();
    toast('Prueba gratis simulada: Premium activo. No se hizo ningún cobro.', 'success');
    return;
  }
  if (!readyToPay(trialAvailable(), `Crea tu cuenta gratis o inicia sesión para empezar tu ${TRIAL_LABEL} de prueba.`)) return;
  setBusy(button, true);
  try {
    const endsAt = await backend.startTrial(state.client);
    state.subscription = await state.store.getSubscription();
    onPlanChanged();
    toast(`¡Listo! Tienes Premium gratis hasta el ${fmtLong(new Date(endsAt), state.today)}. No se te cobrará nada.`, 'success');
  } catch (err) {
    toast(err.message, 'error');
    await refreshSubscription();
  } finally {
    setBusy(button, false);
  }
}

/* ---- Pago con Yape ------------------------------------------------------- */

const YAPE_FIELDS = {
  phone: { form: '#yape-form', input: '#y-phone' },
  otp: { form: '#yape-form', input: '#y-otp' },
};

function showYapeError(message) {
  const box = $('#yape-error');
  box.textContent = message || '';
  box.hidden = !message;
}

function openYapeDialog(interval) {
  if (!isDevMode() && !readyToPay(yapeAvailable(), 'Inicia sesión para pagar con Yape.')) return;
  state.yapeInterval = interval;
  const until = premiumStatus(state.subscription).until;
  $('#yape-plan').textContent = `Premium · ${PASS_LABELS[interval]}`;
  $('#yape-note').textContent = until
    ? `Pago único. Se suma a tu Premium actual: empieza el ${fmtLong(new Date(until), state.today)}.`
    : 'Pago único. No se renueva solo.';
  $('#yape-amount').textContent = priceText(interval);
  $('#yape-submit').textContent = `Pagar ${priceText(interval)}`;
  $('#yape-form').reset();
  showFieldErrors(YAPE_FIELDS, {});
  showYapeError('');
  $('#yape-dialog').showModal();
  focusSelector('#y-phone');
  if (!isDevMode()) backend.loadMercadoPago().catch(() => {}); // se precarga mientras la persona abre Yape
}

async function onYapeSubmit(event) {
  event.preventDefault();
  const phoneNumber = $('#y-phone').value;
  const otp = $('#y-otp').value;
  const errors = {};
  if (!isValidPhone(phoneNumber)) errors.phone = 'Escribe tu celular de 9 dígitos (empieza con 9).';
  if (!/^\d{6}$/.test(otp)) errors.otp = 'El código tiene 6 dígitos.';
  showFieldErrors(YAPE_FIELDS, errors);
  if (errors.phone || errors.otp) {
    focusSelector(errors.phone ? '#y-phone' : '#y-otp');
    return;
  }

  const submit = $('#yape-submit');
  showYapeError('');
  setBusy(submit, true);
  try {
    if (isDevMode()) {
      await sleep(600);
      storageSet(DEV_PLAN_KEY, 'premium');
      $('#yape-dialog').close();
      onPlanChanged();
      toast('Pago con Yape simulado. No se hizo ningún cobro.', 'success');
      return;
    }
    const token = await backend.createYapeToken({ phoneNumber, otp });
    const { accessUntil } = await backend.payWithYape(state.client, state.yapeInterval, token);
    $('#yape-dialog').close();
    state.subscription = await state.store.getSubscription();
    onPlanChanged();
    toast(`¡Pago aprobado! Tienes Premium hasta el ${fmtLong(new Date(accessUntil), state.today)}.`, 'success');
  } catch (err) {
    // El código de aprobación es de un solo uso: para reintentar hace falta uno nuevo.
    showYapeError(err.message || 'No se pudo completar el pago.');
    $('#y-otp').value = '';
    focusSelector('#y-otp');
  } finally {
    setBusy(submit, false);
  }
}

async function cancelPlan(button) {
  const ok = await confirmDialog({
    title: 'Cancelar suscripción',
    message: 'Tu plan Premium seguirá activo hasta el final del periodo pagado. Después volverás al plan Gratis y tus tarjetas extra quedarán bloqueadas, sin borrarse.',
    confirmText: 'Cancelar suscripción',
    cancelText: 'Mantener Premium',
  });
  if (!ok) return;
  setBusy(button, true);
  try {
    await backend.cancelSubscription(state.client);
    await refreshSubscription();
    toast('Suscripción cancelada. No se volverá a cobrar.', 'success');
  } catch (err) {
    toast(`No se pudo cancelar: ${err.message}`, 'error');
    setBusy(button, false);
  }
}

/** Tras cambiar de plan: vuelve a dibujar todo y revisa los avisos. */
function onPlanChanged() {
  state.calHidden.clear();
  renderAll();
  runAlertNotifications();
}

async function onAlertsSettingChange(event) {
  const target = event.target;
  if (!isPremium()) return;

  if (target.id === 's-browser') {
    if (target.checked) {
      const permission = await notify.requestNotificationPermission();
      if (permission !== 'granted') {
        target.checked = false;
        toast('El navegador no permitió las notificaciones.', 'error');
        renderAccount();
        return;
      }
      state.device.browserNotifications = true;
      saveDevicePrefs();
      renderAccount();
      runAlertNotifications();
      toast('Notificaciones activadas en este dispositivo.', 'success');
    } else {
      state.device.browserNotifications = false;
      saveDevicePrefs();
      renderAccount();
    }
    return;
  }

  const next = { ...state.settings };
  if (target.id === 's-days') next.daysBefore = Number(target.value);
  else if (target.id === 's-closing') next.notifyClosing = target.checked;
  else if (target.id === 's-email') next.emailReminders = target.checked;
  else return;

  try {
    state.settings = await state.store.saveSettings(next);
    renderHome();
    runAlertNotifications();
    toast('Preferencias de avisos guardadas.', 'success');
  } catch (err) {
    handleStoreError(err);
    renderAccount();
  }
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
  $$('[data-route]').forEach((link) => {
    if (link.dataset.route === route) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
  document.title = `${ROUTE_TITLES[route]} · CuálToca`;
  hideTooltip();
  window.scrollTo(0, 0);
}

const getTheme = () => (document.documentElement.dataset.theme === 'light' ? 'light' : 'dark');

function setTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  const meta = $('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f3f5fa' : '#0a0d14');
  $('#theme-toggle').setAttribute('aria-label', theme === 'light' ? 'Cambiar a tema oscuro' : 'Cambiar a tema claro');
  if (persist) storageSet(THEME_KEY, theme);
}

/** Acciones declarativas: cualquier elemento con [data-action]. */
function onActionClick(event) {
  const el = event.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const { action, id } = el.dataset;
  const date = el.dataset.date ? fromISO(el.dataset.date) : null;

  switch (action) {
    /* Tarjetas */
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
    case 'load-examples':
      replaceAllCards(EXAMPLE_CARDS, {
        title: 'Cargar tarjetas de ejemplo',
        successText: (n) => `Se cargaron ${plural(n, 'tarjeta de ejemplo', 'tarjetas de ejemplo')}. Edítalas con tus fechas reales.`,
      });
      break;

    /* Simulador y calendario */
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
      const next = nextCycleStart(activeCards(), state.simDate);
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

    /* Pagos */
    case 'add-purchase':
      openPurchaseDialog();
      break;
    case 'delete-purchase':
      deletePurchase(id);
      break;

    /* Plan y cuenta */
    case 'upgrade':
      openUpgrade(el.dataset.reason);
      break;
    case 'checkout':
      checkout(el.dataset.interval === 'yearly' ? 'yearly' : 'monthly', el);
      break;
    case 'pay-yape':
      openYapeDialog(el.dataset.interval === 'yearly' ? 'yearly' : 'monthly');
      break;
    case 'pay-method':
      state.payMethod = el.dataset.method === 'card' ? 'card' : 'yape';
      renderAccount();
      focusSelector(`[data-action="pay-method"][data-method="${state.payMethod}"]`);
      break;
    case 'start-trial':
      startTrial(el);
      break;
    case 'see-plans':
      goToPlans();
      break;
    case 'cancel-subscription':
      cancelPlan(el);
      break;
    case 'refresh-plan':
      refreshSubscription();
      break;
    case 'dev-plan':
      if (isDevMode()) {
        storageSet(DEV_PLAN_KEY, el.dataset.plan === 'premium' ? 'premium' : 'free');
        onPlanChanged();
        toast(`Plan simulado: ${isPremium() ? 'Premium' : 'Gratis'}.`, 'success');
      }
      break;
    case 'login-google':
      backend.signInWithGoogle(state.client).catch((err) => toast(`No se pudo iniciar sesión: ${err.message}`, 'error'));
      break;
    case 'login-reset':
      state.loginSentTo = null;
      renderAccount();
      focusSelector('#login-email');
      break;
    case 'logout':
      backend.signOut(state.client)
        .then(() => (state.user ? applySession(null) : null))
        .then(() => toast('Cerraste sesión.', 'success'))
        .catch((err) => toast(err.message, 'error'));
      break;
    case 'reload':
      location.reload();
      break;
    case 'test-notification':
      notify.showNotification('CuálToca', { body: 'Así se verán tus avisos de pago.', tag: 'prueba' })
        .then((shown) => { if (!shown) toast('No se pudo mostrar la notificación.', 'error'); });
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
  runAlertNotifications();
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

  // Campos numéricos: solo aceptan valores posibles mientras se escribe.
  const dayOfMonth = (text) => sanitizeInteger(text, { max: 31, maxLength: 2 });
  guardInput($('#f-closing'), dayOfMonth);
  guardInput($('#f-payment'), dayOfMonth);
  guardInput($('#p-installments'), (text) => sanitizeInteger(text, { max: MAX_INSTALLMENTS, maxLength: 2 }));
  guardInput($('#p-amount'), (text) => sanitizeDecimal(text, { max: MAX_AMOUNT, decimals: 2 }));
  guardInput($('#y-phone'), sanitizePhone);
  guardInput($('#y-otp'), (text) => sanitizeDigits(text, 6));

  // Pago con Yape
  const yapeForm = $('#yape-form');
  yapeForm.addEventListener('submit', onYapeSubmit);
  yapeForm.addEventListener('input', (e) => {
    const field = Object.keys(YAPE_FIELDS).find((key) => YAPE_FIELDS[key].input === `#${e.target.id}`);
    if (field) showFieldErrors({ [field]: YAPE_FIELDS[field] }, {});
    showYapeError('');
  });

  // Formulario de tarjeta
  const cardForm = $('#card-form');
  cardForm.addEventListener('submit', onCardSubmit);
  cardForm.addEventListener('input', (e) => {
    if (e.target.id === 'f-color') renderSwatches(e.target.value.toLowerCase());
    const field = Object.keys(CARD_FIELDS).find((key) => CARD_FIELDS[key].input === `#${e.target.id}`);
    if (field) showFieldErrors({ [field]: CARD_FIELDS[field] }, {});
    updateCardPreview();
  });
  cardForm.addEventListener('focusout', (e) => {
    const field = Object.keys(CARD_FIELDS).find((key) => CARD_FIELDS[key].input === `#${e.target.id}`);
    if (!field || field === 'name' || e.target.value === '') return;
    showFieldErrors({ [field]: CARD_FIELDS[field] }, validateCardForm(readCardForm()));
  });
  $('#f-swatches').addEventListener('click', (e) => {
    const swatch = e.target.closest('[data-color]');
    if (!swatch) return;
    $('#f-color').value = swatch.dataset.color;
    renderSwatches(swatch.dataset.color);
    updateCardPreview();
  });

  // Formulario de compra
  const purchaseForm = $('#purchase-form');
  purchaseForm.addEventListener('submit', onPurchaseSubmit);
  purchaseForm.addEventListener('input', (e) => {
    const field = Object.keys(PURCHASE_FIELDS).find((key) => PURCHASE_FIELDS[key].input === `#${e.target.id}`);
    if (field) showFieldErrors({ [field]: PURCHASE_FIELDS[field] }, {});
    if (e.target.id === 'p-date') fillPurchaseCards();
    updatePurchasePreview();
  });
  purchaseForm.addEventListener('focusout', (e) => {
    const field = Object.keys(PURCHASE_FIELDS).find((key) => PURCHASE_FIELDS[key].input === `#${e.target.id}`);
    if (!['amount', 'installments'].includes(field) || e.target.value === '') return;
    showFieldErrors({ [field]: PURCHASE_FIELDS[field] }, validatePurchaseForm(readPurchaseForm()));
  });
  $('#p-card').addEventListener('change', () => {
    state.purchaseCardTouched = true;
    updatePurchasePreview();
  });

  // Cuenta: inicio de sesión y preferencias de avisos (se vuelven a dibujar, por eso se delega)
  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'login-form') return;
    e.preventDefault();
    login($('#login-email').value.trim());
  });
  $('#alerts-settings').addEventListener('change', onAlertsSettingChange);

  // Diálogos
  $$('dialog [data-close]').forEach((btn) => btn.addEventListener('click', () => btn.closest('dialog').close()));
  $$('dialog').forEach(enableBackdropClose);

  // Recalcular al pasar la medianoche o al volver a la pestaña.
  setInterval(checkDateChange, 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    checkDateChange();
    runAlertNotifications();
  });
}

// #endregion 9.

// #region 10. INICIO =========================================================

async function init() {
  state.simDate = state.today;
  state.calSelected = state.today;
  state.calYear = state.today.getFullYear();
  state.calMonth = state.today.getMonth();

  setTheme(getTheme(), false);
  bindEvents();
  applyRoute();
  renderAll(); // estado "cargando"
  notify.registerServiceWorker();

  if (state.backend === 'supabase') await connectBackend();
  else await loadData();

  await handleCheckoutReturn();
  runAlertNotifications();
}

init();

// #endregion 10.
