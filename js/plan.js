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

/** Filas de la tabla comparativa de planes. */
export const PLAN_FEATURES = [
  { label: 'Recomendador, simulador y calendario', free: true, premium: true },
  { label: 'Tarjetas', free: `Hasta ${FREE_CARD_LIMIT}`, premium: 'Ilimitadas' },
  { label: 'Avisos antes de cada pago y cierre', free: false, premium: true },
  { label: 'Notificaciones en el celular y por correo', free: false, premium: true },
  { label: 'Proyección de pagos y cuotas', free: false, premium: true },
];

/**
 * ¿La suscripción da acceso Premium? Misma regla que la función SQL
 * public.user_is_premium: activa, o cancelada pero con el periodo pagado vigente.
 */
export function isSubscriptionActive(subscription, now = new Date()) {
  if (!subscription) return false;
  if (subscription.status === 'active') return true;
  return subscription.status === 'cancelled' &&
    Boolean(subscription.currentPeriodEnd) &&
    new Date(subscription.currentPeriodEnd) > now;
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
