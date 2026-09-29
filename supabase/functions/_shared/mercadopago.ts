/**
 * Integración con Mercado Pago:
 *   - Suscripción con tarjeta ("preapproval"): se renueva sola.
 *   - Pase con Yape (Checkout API, pago único): 1 o 12 meses, no se renueva.
 * Módulo sin dependencias de Deno: los tests lo importan desde Node.
 *
 * Documentación:
 *   https://www.mercadopago.com.pe/developers/es/docs/subscriptions
 *   https://www.mercadopago.com.pe/developers/es/docs/checkout-api-payments/integration-configuration/yape
 */

export const MP_API = 'https://api.mercadopago.com';

/** Precios en soles. Deben coincidir con PRICING en js/plan.js (lo verifica un test). */
export const PRICES = {
  monthly: { amount: 7.9, frequency: 1, label: 'mensual' },
  yearly: { amount: 59, frequency: 12, label: 'anual' },
} as const;

export type Interval = keyof typeof PRICES;
export type SubscriptionStatus = 'inactive' | 'pending' | 'active' | 'paused' | 'cancelled';

export const isInterval = (value: unknown): value is Interval => value === 'monthly' || value === 'yearly';

/** Nombre del pase de pago único según el intervalo. */
export const PASS_LABELS: Record<Interval, string> = { monthly: '1 mes', yearly: '12 meses' };

/** Premium restante mínimo (1 día) para diferir el primer cobro de la suscripción. */
const MIN_DEFER_MS = 24 * 60 * 60 * 1000;

/**
 * Cuerpo para crear una suscripción sin plan asociado, con pago pendiente (checkout de Mercado Pago).
 * Si la persona aún tiene Premium (prueba, pase o periodo pagado), `startDate` hace que el
 * primer cobro llegue cuando ese Premium termine, así no pierde los días que le quedan.
 */
export function buildPreapprovalBody(options: {
  userId: string;
  email: string;
  interval: Interval;
  backUrl: string;
  startDate?: string | null;
}) {
  const price = PRICES[options.interval];
  return {
    reason: `CuálToca Premium (${price.label})`,
    external_reference: options.userId,
    payer_email: options.email,
    back_url: options.backUrl,
    status: 'pending',
    auto_recurring: {
      frequency: price.frequency,
      frequency_type: 'months',
      ...(options.startDate ? { start_date: options.startDate } : {}),
      transaction_amount: price.amount,
      currency_id: 'PEN',
    },
  };
}

/**
 * Fecha en que termina el Premium que la persona ya tiene sin suscripción activa
 * (prueba, pases o suscripción cancelada con días pagados). null si no le queda
 * al menos un día: en ese caso el primer cobro es inmediato.
 */
export function premiumEndsAt(
  subscription: { status?: string; access_until?: string | null; current_period_end?: string | null } | null,
  now = new Date(),
): string | null {
  if (!subscription) return null;
  const dates = [subscription.access_until, subscription.status === 'cancelled' ? subscription.current_period_end : null]
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()));
  if (!dates.length) return null;
  const latest = new Date(Math.max(...dates.map((date) => date.getTime())));
  return latest.getTime() - now.getTime() >= MIN_DEFER_MS ? latest.toISOString() : null;
}

/* ---- Pases con Yape (pago único) ---------------------------------------- */

/** Referencia que identifica un pase en Mercado Pago: "pass:<intervalo>:<usuario>". */
export const passReference = (userId: string, interval: Interval) => `pass:${interval}:${userId}`;

export function parsePassReference(reference: unknown): { interval: Interval; userId: string } | null {
  const match = /^pass:(monthly|yearly):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(String(reference ?? ''));
  return match ? { interval: match[1] as Interval, userId: match[2].toLowerCase() } : null;
}

/** Token de un solo uso que genera MercadoPago.js con el celular y el código de aprobación de Yape. */
export const isYapeToken = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{8,128}$/.test(value);

/** Cuerpo del cobro con Yape (POST /v1/payments). */
export function buildYapePaymentBody(options: { userId: string; email: string; interval: Interval; token: string }) {
  return {
    token: options.token,
    transaction_amount: PRICES[options.interval].amount,
    description: `CuálToca Premium · ${PASS_LABELS[options.interval]}`,
    installments: 1,
    payment_method_id: 'yape',
    payer: { email: options.email },
    external_reference: passReference(options.userId, options.interval),
  };
}

/** ¿El pago corresponde a un pase aprobado por el monto correcto? */
export function isApprovedPass(
  payment: { status?: string; currency_id?: string; transaction_amount?: number },
  interval: Interval,
): boolean {
  return payment?.status === 'approved' &&
    payment.currency_id === 'PEN' &&
    Number(payment.transaction_amount) >= PRICES[interval].amount;
}

/** Mensaje para la persona cuando Yape rechaza el pago (según `status_detail`). */
export function yapeRejectionMessage(statusDetail: string | undefined): string {
  switch (statusDetail) {
    case 'cc_rejected_call_for_authorize':
      return 'Yape no autorizó el pago. Revisa tu app de Yape e intenta de nuevo.';
    case 'cc_rejected_insufficient_amount':
      return 'No tienes saldo suficiente en Yape para este pago.';
    case 'cc_rejected_bad_filled_security_code':
      return 'El código de aprobación no es correcto. Genera uno nuevo en Yape.';
    case 'cc_rejected_form_error':
      return 'Revisa tu número de celular y el código de aprobación.';
    case 'cc_rejected_max_attempts':
      return 'Superaste el número de intentos. Espera unos minutos y usa un código nuevo.';
    case 'cc_rejected_card_type_not_allowed':
      return 'Tu cuenta de Yape no permite este pago. Prueba con la suscripción con tarjeta.';
    default:
      return 'Yape rechazó el pago. Intenta de nuevo con un código nuevo.';
  }
}

/** Error de la API de Mercado Pago con su código HTTP. */
export class MercadoPagoError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'MercadoPagoError';
    this.status = status;
  }
}

async function mpRequest(path: string, accessToken: string, init: RequestInit = {}) {
  const response = await fetch(`${MP_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new MercadoPagoError(response.status, `Mercado Pago respondió ${response.status}: ${body?.message ?? JSON.stringify(body)}`);
  }
  return body;
}

export const createPayment = (accessToken: string, body: unknown, idempotencyKey: string) =>
  mpRequest('/v1/payments', accessToken, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'X-Idempotency-Key': idempotencyKey },
  });

export const getPayment = (accessToken: string, id: string) =>
  mpRequest(`/v1/payments/${encodeURIComponent(id)}`, accessToken);

export const createPreapproval = (accessToken: string, body: unknown, idempotencyKey: string) =>
  mpRequest('/preapproval', accessToken, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'X-Idempotency-Key': idempotencyKey },
  });

export const getPreapproval = (accessToken: string, id: string) =>
  mpRequest(`/preapproval/${encodeURIComponent(id)}`, accessToken);

export const cancelPreapproval = (accessToken: string, id: string) =>
  mpRequest(`/preapproval/${encodeURIComponent(id)}`, accessToken, {
    method: 'PUT',
    body: JSON.stringify({ status: 'cancelled' }),
  });

/** Estado de Mercado Pago → estado de nuestra tabla `subscriptions`. */
export function mapPreapprovalStatus(status: string | undefined): SubscriptionStatus {
  switch (status) {
    case 'authorized':
      return 'active';
    case 'pending':
      return 'pending';
    case 'paused':
      return 'paused';
    case 'cancelled':
      return 'cancelled';
    default:
      return 'inactive';
  }
}

export const intervalFromPreapproval = (preapproval: { auto_recurring?: { frequency?: number } }): Interval =>
  preapproval?.auto_recurring?.frequency === 12 ? 'yearly' : 'monthly';

/** Fin del periodo pagado (próximo cobro) si está en el futuro; si no, null. */
export function periodEndFromPreapproval(preapproval: { next_payment_date?: string }, now = new Date()): string | null {
  const next = preapproval?.next_payment_date ? new Date(preapproval.next_payment_date) : null;
  return next && !Number.isNaN(next.getTime()) && next > now ? next.toISOString() : null;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Valida la cabecera `x-signature` de un webhook de Mercado Pago.
 * Plantilla: "id:[data.id];request-id:[x-request-id];ts:[ts];" firmada con HMAC-SHA256
 * usando la clave secreta del webhook. Las partes ausentes se omiten.
 */
export async function verifyWebhookSignature(options: {
  secret: string;
  xSignature: string | null;
  xRequestId: string | null;
  dataId: string | null;
}): Promise<boolean> {
  const { secret, xSignature, xRequestId, dataId } = options;
  if (!secret || !xSignature) return false;

  const parts: Record<string, string> = {};
  for (const piece of xSignature.split(',')) {
    const index = piece.indexOf('=');
    if (index > 0) parts[piece.slice(0, index).trim()] = piece.slice(index + 1).trim();
  }
  if (!parts.ts || !parts.v1) return false;

  // Si el id es alfanumérico, Mercado Pago lo firma en minúsculas.
  const id = dataId && /^[a-z0-9]+$/i.test(dataId) ? dataId.toLowerCase() : dataId;
  let manifest = '';
  if (id) manifest += `id:${id};`;
  if (xRequestId) manifest += `request-id:${xRequestId};`;
  manifest += `ts:${parts.ts};`;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(manifest));
  const hex = [...new Uint8Array(signature)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return timingSafeEqual(hex, parts.v1.toLowerCase());
}
