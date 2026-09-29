/**
 * =============================================================================
 *  CUÁLTOCA · js/plan.js
 * -----------------------------------------------------------------------------
 *  Planes, precios y límites. La interfaz usa estas reglas para mostrar u
 *  ocultar funciones; la base de datos aplica las mismas reglas del lado del
 *  servidor (supabase/schema.sql), así que no se pueden saltar desde el navegador.
 * =============================================================================
 */

export const FREE_CARD_LIMIT = 2;

export const PLANS = Object.freeze({
  free: Object.freeze({
    id: 'free',
    name: 'Gratis',
    cardLimit: FREE_CARD_LIMIT,
    alerts: false,
    projection: false,
  }),
  premium: Object.freeze({
    id: 'premium',
    name: 'Premium',
    cardLimit: Infinity,
    alerts: true,
    projection: true,
  }),
});

/**
 * Precios en soles. Deben coincidir con supabase/functions/_shared/mercadopago.ts
 * (el test tests/plan.test.mjs lo verifica).
 */
export const PRICING = Object.freeze({
  currency: 'PEN',
  monthly: 7.9,
  yearly: 59,
});

/** Porcentaje que se ahorra con el plan anual frente a 12 meses del mensual. */
export const yearlySavingsPercent = () => Math.round((1 - PRICING.yearly / (PRICING.monthly * 12)) * 100);

/** Prueba gratis para cuentas nuevas (la duración la fija start_trial() en schema.sql). */
export const TRIAL_LABEL = '1 mes';

/** Pases de pago único con Yape. Deben coincidir con PASS_LABELS en _shared/mercadopago.ts. */
export const PASS_LABELS = Object.freeze({ monthly: '1 mes', yearly: '12 meses' });

/** Filas de la tabla comparativa de planes. */
export const PLAN_FEATURES = [
  { label: 'Recomendador, simulador y calendario', free: true, premium: true },
  { label: 'Tarjetas', free: `Hasta ${FREE_CARD_LIMIT}`, premium: 'Ilimitadas' },
  { label: 'Avisos antes de cada pago y cierre', free: false, premium: true },
  { label: 'Notificaciones en el celular y por correo', free: false, premium: true },
  { label: 'Proyección de pagos y cuotas', free: false, premium: true },
];

const isFuture = (value, now) => Boolean(value) && new Date(value) > now;

/**
 * ¿La suscripción da acceso Premium? Misma regla que la función SQL
 * public.user_is_premium: suscripción activa, cancelada con el periodo pagado
 * vigente, o prueba gratis / pase con Yape vigente (accessUntil).
 */
export function isSubscriptionActive(subscription, now = new Date()) {
  if (!subscription) return false;
  if (subscription.status === 'active') return true;
  if (subscription.status === 'cancelled' && isFuture(subscription.currentPeriodEnd, now)) return true;
  return isFuture(subscription.accessUntil, now);
}

/**
 * De dónde viene el Premium y hasta cuándo, para mostrarlo en la app.
 *   kind: 'subscription' (tarjeta, se renueva) | 'trial' | 'pass' | 'cancelled' (días pagados)
 *         | 'pending' | 'paused' | 'none'
 *   until:      fin del Premium sin renovación (prueba, pase o periodo cancelado)
 *   nextCharge: próximo cobro de la suscripción con tarjeta
 */
export function premiumStatus(subscription, now = new Date()) {
  const sub = subscription || {};
  if (sub.status === 'active') {
    return { kind: 'subscription', until: null, nextCharge: isFuture(sub.currentPeriodEnd, now) ? sub.currentPeriodEnd : null };
  }
  const access = isFuture(sub.accessUntil, now) ? sub.accessUntil : null;
  const paid = sub.status === 'cancelled' && isFuture(sub.currentPeriodEnd, now) ? sub.currentPeriodEnd : null;
  if (access || paid) {
    const until = [access, paid].filter(Boolean).sort((a, b) => new Date(a) - new Date(b)).pop();
    // Sigue en la prueba si accessUntil no se movió desde que empezó (un pase la alarga al menos 1 mes).
    const inTrial = Boolean(sub.trialEndsAt) && Math.abs(new Date(access) - new Date(sub.trialEndsAt)) < 60 * 1000;
    let kind = 'cancelled';
    if (access) kind = inTrial ? 'trial' : 'pass';
    return { kind, until, nextCharge: null };
  }
  if (sub.status === 'pending' || sub.status === 'paused') return { kind: sub.status, until: null, nextCharge: null };
  return { kind: 'none', until: null, nextCharge: null };
}

/**
 * ¿Se le puede ofrecer la prueba gratis? Solo a cuentas que nunca tuvieron
 * Premium. El servidor lo vuelve a comprobar (start_trial en schema.sql),
 * incluso si la persona ya la usó con otra cuenta del mismo correo.
 */
export function canStartTrial(subscription) {
  if (!subscription) return true;
  if (subscription.trialEndsAt || subscription.accessUntil) return false;
  return !['active', 'paused', 'cancelled'].includes(subscription.status);
}

/**
 * Separa las tarjetas que el plan permite usar de las bloqueadas.
 * Si alguien baja de Premium a Gratis, sus tarjetas extra no se borran:
 * quedan bloqueadas (fuera de los cálculos) hasta que vuelva a Premium o elimine otras.
 */
export function partitionCards(cards, planId) {
  const limit = PLANS[planId].cardLimit;
  return { active: cards.slice(0, limit), locked: cards.slice(limit) };
}

export const canAddCard = (cardCount, planId) => cardCount < PLANS[planId].cardLimit;
