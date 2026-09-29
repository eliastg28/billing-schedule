/**
 * Edge Function: mercadopago-webhook
 * Recibe las notificaciones de Mercado Pago y actualiza la base de datos.
 * Es lo ÚNICO (junto con pay-with-yape) que activa Premium pagado: el
 * navegador nunca puede marcarse como Premium.
 *
 *   - subscription_preapproval → estado de la suscripción con tarjeta.
 *   - payment                  → pases con Yape (respaldo de pay-with-yape).
 *
 * Configura en Mercado Pago (Tus integraciones > Webhooks):
 *   URL:     https://TU-PROYECTO.supabase.co/functions/v1/mercadopago-webhook
 *   Eventos: Planes y suscripciones  +  Pagos
 * Despliegue sin verificación JWT (Mercado Pago no envía tokens de Supabase):
 *   supabase functions deploy mercadopago-webhook --no-verify-jwt
 *
 * Secretos: MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET
 */
import { isUuid, json, requireEnv } from '../_shared/http.ts';
import { adminClient } from '../_shared/supabase.ts';
import {
  getPayment,
  getPreapproval,
  intervalFromPreapproval,
  isApprovedPass,
  mapPreapprovalStatus,
  parsePassReference,
  periodEndFromPreapproval,
  verifyWebhookSignature,
} from '../_shared/mercadopago.ts';

const HANDLED = new Set(['subscription_preapproval', 'payment']);

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: true });

  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));
  const type = body?.type ?? url.searchParams.get('type') ?? body?.topic ?? url.searchParams.get('topic');
  const dataId = String(url.searchParams.get('data.id') ?? body?.data?.id ?? '');

  if (!HANDLED.has(type) || !dataId) return json({ ignored: true });

  const valid = await verifyWebhookSignature({
    secret: requireEnv('MP_WEBHOOK_SECRET'),
    xSignature: req.headers.get('x-signature'),
    xRequestId: req.headers.get('x-request-id'),
    dataId,
  });
  if (!valid) return json({ error: 'Firma inválida.' }, 401);

  try {
    // Nunca se confía en el cuerpo del aviso: se consulta el estado real a Mercado Pago.
    return type === 'payment' ? await handlePayment(dataId) : await handlePreapproval(dataId);
  } catch (err) {
    console.error('mercadopago-webhook', err);
    // Un 500 hace que Mercado Pago reintente el aviso más tarde.
    return json({ error: 'Error al procesar el aviso.' }, 500);
  }
});

/** Cambios de la suscripción con tarjeta. */
async function handlePreapproval(dataId: string): Promise<Response> {
  const preapproval = await getPreapproval(requireEnv('MP_ACCESS_TOKEN'), dataId);
  const userId = preapproval.external_reference;
  if (!isUuid(userId)) return json({ ignored: 'sin usuario' });

  const status = mapPreapprovalStatus(preapproval.status);
  const admin = adminClient();
  const { data: current, error: readError } = await admin
    .from('subscriptions')
    .select('provider_subscription_id,current_period_end')
    .eq('user_id', userId)
    .maybeSingle();
  if (readError) throw readError;

  // Un aviso de una suscripción vieja (p. ej. un pago abandonado) no pisa la vigente.
  // Una suscripción autorizada siempre gana.
  if (status !== 'active' && current?.provider_subscription_id && current.provider_subscription_id !== preapproval.id) {
    return json({ ignored: 'suscripción anterior' });
  }

  // Activa: se guarda el próximo cobro (para mostrarlo en la app).
  // Cancelada: se conserva la fecha de fin de periodo más lejana conocida.
  let periodEnd: string | null = null;
  if (status === 'active') {
    periodEnd = periodEndFromPreapproval(preapproval);
  } else if (status === 'cancelled') {
    const fromProvider = periodEndFromPreapproval(preapproval);
    const known = current?.current_period_end ?? null;
    periodEnd = [fromProvider, known].filter(Boolean).sort().pop() ?? null;
  }

  // Solo se envían estas columnas: los días de la prueba y de los pases (access_until) no se tocan.
  const { error: saveError } = await admin.from('subscriptions').upsert(
    {
      user_id: userId,
      status,
      provider: 'mercadopago',
      provider_subscription_id: preapproval.id,
      plan_interval: intervalFromPreapproval(preapproval),
      current_period_end: periodEnd,
    },
    { onConflict: 'user_id' },
  );
  if (saveError) throw saveError;

  return json({ ok: true, status });
}

/** Pagos únicos: acredita los pases con Yape aprobados. Los cobros de la suscripción se ignoran. */
async function handlePayment(dataId: string): Promise<Response> {
  const payment = await getPayment(requireEnv('MP_ACCESS_TOKEN'), dataId);
  const pass = parsePassReference(payment.external_reference);
  if (!pass) return json({ ignored: 'no es un pase' });
  if (!isApprovedPass(payment, pass.interval)) return json({ ignored: `pago ${payment.status}` });

  const { data: accessUntil, error } = await adminClient().rpc('grant_premium_pass', {
    p_user_id: pass.userId,
    p_payment_id: String(payment.id),
    p_interval: pass.interval,
    p_amount: payment.transaction_amount,
    p_method: payment.payment_method_id ?? null,
  });
  if (error) throw error;

  return json({ ok: true, accessUntil });
}
