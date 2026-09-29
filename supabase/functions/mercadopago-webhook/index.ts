/**
 * Edge Function: mercadopago-webhook
 * Recibe las notificaciones de Mercado Pago y actualiza la tabla `subscriptions`.
 * Es lo ÚNICO que activa Premium: el navegador nunca puede marcarse como Premium.
 *
 * Configura en Mercado Pago (Tus integraciones > Webhooks):
 *   URL:     https://TU-PROYECTO.supabase.co/functions/v1/mercadopago-webhook
 *   Evento:  Planes y suscripciones (subscription_preapproval)
 * Despliegue sin verificación JWT (Mercado Pago no envía tokens de Supabase):
 *   supabase functions deploy mercadopago-webhook --no-verify-jwt
 *
 * Secretos: MP_ACCESS_TOKEN, MP_WEBHOOK_SECRET
 */
import { isUuid, json, requireEnv } from '../_shared/http.ts';
import { adminClient } from '../_shared/supabase.ts';
import {
  getPreapproval,
  intervalFromPreapproval,
  mapPreapprovalStatus,
  periodEndFromPreapproval,
  verifyWebhookSignature,
} from '../_shared/mercadopago.ts';

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ ok: true });

  const url = new URL(req.url);
  const body = await req.json().catch(() => ({}));
  const type = body?.type ?? url.searchParams.get('type') ?? body?.topic ?? url.searchParams.get('topic');
  const dataId = String(url.searchParams.get('data.id') ?? body?.data?.id ?? '');

  // Solo interesan los cambios de suscripción.
  if (type !== 'subscription_preapproval' || !dataId) return json({ ignored: true });

  const valid = await verifyWebhookSignature({
    secret: requireEnv('MP_WEBHOOK_SECRET'),
    xSignature: req.headers.get('x-signature'),
    xRequestId: req.headers.get('x-request-id'),
    dataId,
  });
  if (!valid) return json({ error: 'Firma inválida.' }, 401);

  try {
    // Nunca se confía en el cuerpo del aviso: se consulta el estado real a Mercado Pago.
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

    // Al cancelar se conserva la fecha de fin de periodo más lejana conocida.
    let periodEnd: string | null = null;
    if (status === 'cancelled') {
      const fromProvider = periodEndFromPreapproval(preapproval);
      const known = current?.current_period_end ?? null;
      periodEnd = [fromProvider, known].filter(Boolean).sort().pop() ?? null;
    }

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
  } catch (err) {
    console.error('mercadopago-webhook', err);
    // Un 500 hace que Mercado Pago reintente el aviso más tarde.
    return json({ error: 'Error al procesar el aviso.' }, 500);
  }
});
