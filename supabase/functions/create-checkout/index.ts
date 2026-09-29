/**
 * Edge Function: create-checkout
 * Crea una suscripción Premium en Mercado Pago y devuelve el enlace de pago.
 * La tarjeta se ingresa en la página de Mercado Pago, nunca en CuálToca.
 *
 * Si la persona aún tiene Premium (prueba gratis, pase con Yape o una
 * suscripción cancelada con días pagados), el primer cobro se programa para
 * cuando ese Premium termine: no pierde los días que le quedan.
 *
 * Petición (desde la app, con la sesión del usuario):
 *   POST { interval: 'monthly' | 'yearly' }
 * Respuesta:
 *   { url }  → la app redirige al checkout de Mercado Pago.
 *
 * Secretos: MP_ACCESS_TOKEN, APP_URL
 * Secreto opcional, SOLO para pruebas: MP_TEST_PAYER_EMAIL
 *   Mercado Pago exige que el pagador de prueba sea un "comprador de prueba"
 *   con su propio correo. Si este secreto existe, se usa ese correo en vez del
 *   del usuario. Bórralo antes de cobrar de verdad:
 *     supabase secrets unset MP_TEST_PAYER_EMAIL
 */
import { corsHeaders, json, requireEnv } from '../_shared/http.ts';
import { adminClient, getUserFromRequest } from '../_shared/supabase.ts';
import { buildPreapprovalBody, createPreapproval, isInterval, premiumEndsAt } from '../_shared/mercadopago.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);

  try {
    const user = await getUserFromRequest(req);
    if (!user?.email) return json({ error: 'Inicia sesión para suscribirte.' }, 401);

    const { interval } = await req.json().catch(() => ({}));
    if (!isInterval(interval)) return json({ error: 'Plan no válido.' }, 400);

    const admin = adminClient();
    const { data: current, error: readError } = await admin
      .from('subscriptions')
      .select('status,current_period_end,access_until')
      .eq('user_id', user.id)
      .maybeSingle();
    if (readError) throw readError;
    if (current?.status === 'active') return json({ error: 'Ya tienes una suscripción activa.' }, 409);

    // Mercado Pago devuelve al usuario a la app con ?checkout=1#cuenta
    const backUrl = new URL(requireEnv('APP_URL'));
    backUrl.searchParams.set('checkout', '1');
    backUrl.hash = 'cuenta';

    // En pruebas, el pago lo hace el comprador de prueba de Mercado Pago (ver arriba).
    const payerEmail = Deno.env.get('MP_TEST_PAYER_EMAIL') || user.email;

    const preapproval = await createPreapproval(
      requireEnv('MP_ACCESS_TOKEN'),
      buildPreapprovalBody({
        userId: user.id,
        email: payerEmail,
        interval,
        backUrl: backUrl.toString(),
        startDate: premiumEndsAt(current),
      }),
      crypto.randomUUID(),
    );

    // Si canceló antes y aún le queda periodo pagado, no se le quita Premium mientras paga de nuevo.
    // (Los días de la prueba o de un pase están en access_until y no se tocan.)
    const periodStillPaid =
      current?.status === 'cancelled' && current.current_period_end && new Date(current.current_period_end) > new Date();

    const { error: saveError } = await admin.from('subscriptions').upsert(
      {
        user_id: user.id,
        status: periodStillPaid ? 'cancelled' : 'pending',
        plan_interval: interval,
        provider: 'mercadopago',
        provider_subscription_id: preapproval.id,
        current_period_end: periodStillPaid ? current.current_period_end : null,
      },
      { onConflict: 'user_id' },
    );
    if (saveError) throw saveError;

    return json({ url: preapproval.init_point });
  } catch (err) {
    console.error('create-checkout', err);
    return json({ error: 'No se pudo crear el pago. Intenta de nuevo en unos minutos.' }, 500);
  }
});
