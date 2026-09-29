/**
 * Edge Function: cancel-subscription
 * Cancela la suscripción en Mercado Pago. Premium sigue activo hasta el
 * final del periodo pagado (próxima fecha de cobro) y luego pasa a Gratis.
 *
 * Secretos: MP_ACCESS_TOKEN
 */
import { corsHeaders, json, requireEnv } from '../_shared/http.ts';
import { adminClient, getUserFromRequest } from '../_shared/supabase.ts';
import { cancelPreapproval, getPreapproval, periodEndFromPreapproval } from '../_shared/mercadopago.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);

  try {
    const user = await getUserFromRequest(req);
    if (!user) return json({ error: 'Inicia sesión.' }, 401);

    const admin = adminClient();
    const { data: sub, error: readError } = await admin
      .from('subscriptions')
      .select('status,provider_subscription_id')
      .eq('user_id', user.id)
      .maybeSingle();
    if (readError) throw readError;
    if (!sub?.provider_subscription_id || sub.status !== 'active') {
      return json({ error: 'No tienes una suscripción activa.' }, 409);
    }

    const token = requireEnv('MP_ACCESS_TOKEN');
    // Se lee antes de cancelar para conocer hasta cuándo está pagado.
    const before = await getPreapproval(token, sub.provider_subscription_id);
    await cancelPreapproval(token, sub.provider_subscription_id);
    const periodEnd = periodEndFromPreapproval(before);

    const { error: saveError } = await admin
      .from('subscriptions')
      .update({ status: 'cancelled', current_period_end: periodEnd })
      .eq('user_id', user.id);
    if (saveError) throw saveError;

    return json({ ok: true, currentPeriodEnd: periodEnd });
  } catch (err) {
    console.error('cancel-subscription', err);
    return json({ error: 'No se pudo cancelar. Intenta de nuevo o cancélala desde tu cuenta de Mercado Pago.' }, 500);
  }
});
