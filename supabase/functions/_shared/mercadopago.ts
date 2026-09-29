/**
 * Integración con Mercado Pago (suscripciones "preapproval").
 * Módulo sin dependencias de Deno: los tests lo importan desde Node.
 *
 * Documentación: https://www.mercadopago.com.pe/developers/es/docs/subscriptions
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

/** Cuerpo para crear una suscripción sin plan asociado, con pago pendiente (checkout de Mercado Pago). */
export function buildPreapprovalBody(options: { userId: string; email: string; interval: Interval; backUrl: string }) {
  const price = PRICES[options.interval];
  return {
    reason: `Ciclo de Tarjetas Premium (${price.label})`,
    external_reference: options.userId,
    payer_email: options.email,
    back_url: options.backUrl,
    status: 'pending',
    auto_recurring: {
      frequency: price.frequency,
      frequency_type: 'months',
      transaction_amount: price.amount,
      currency_id: 'PEN',
    },
  };
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
    throw new Error(`Mercado Pago respondió ${response.status}: ${body?.message ?? JSON.stringify(body)}`);
  }
  return body;
}

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
