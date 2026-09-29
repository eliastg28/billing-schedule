/**
 * Edge Function: pay-with-yape
 * Cobra un pase Premium con Yape (Checkout API de Mercado Pago): 1 mes o
 * 12 meses, pago único, sin renovación automática.
 *
 * La app genera un token de un solo uso con MercadoPago.js a partir del
 * celular y el código de aprobación de Yape; aquí se hace el cobro y, si se
 * aprueba, se acredita el pase en la base de datos.
 *
 * Petición (desde la app, con la sesión del usuario):
 *   POST { interval: 'monthly' | 'yearly', token }
 * Respuesta:
 *   { status: 'approved', accessUntil }  o  { error }
 *
 * Secretos: MP_ACCESS_TOKEN
 * Secreto opcional, SOLO para pruebas: MP_TEST_PAYER_EMAIL (ver create-checkout)
 *
 * Si algo falla después de aprobarse el cobro, el webhook (evento "Pagos")
 * acredita el pase igual: grant_premium_pass nunca lo acredita dos veces.
 */
import { corsHeaders, json, requireEnv } from '../_shared/http.ts';
import { adminClient, getUserFromRequest } from '../_shared/supabase.ts';
import {
  MercadoPagoError,
  buildYapePaymentBody,
  createPayment,
  isApprovedPass,
  isInterval,
  isYapeToken,
  yapeRejectionMessage,
} from '../_shared/mercadopago.ts';

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ error: 'Método no permitido.' }, 405);

  const user = await getUserFromRequest(req).catch(() => null);
  if (!user?.email) return json({ error: 'Inicia sesión para pagar.' }, 401);

  const { interval, token } = await req.json().catch(() => ({}));
  if (!isInterval(interval)) return json({ error: 'Plan no válido.' }, 400);
  if (!isYapeToken(token)) return json({ error: 'Falta el código de Yape. Intenta de nuevo.' }, 400);

  const admin = adminClient();
  let payment;
  try {
    const { data: current, error: readError } = await admin
      .from('subscriptions')
      .select('status')
      .eq('user_id', user.id)
      .maybeSingle();
    if (readError) throw readError;
    if (current?.status === 'active') {
      return json({ error: 'Ya tienes una suscripción con tarjeta que se renueva sola. No necesitas un pase.' }, 409);
    }

    // El token es de un solo uso: sirve también como clave de idempotencia (un reintento no cobra dos veces).
    payment = await createPayment(
      requireEnv('MP_ACCESS_TOKEN'),
      buildYapePaymentBody({
        userId: user.id,
        email: Deno.env.get('MP_TEST_PAYER_EMAIL') || user.email,
        interval,
        token,
      }),
      `yape-${token}`,
    );
  } catch (err) {
    console.error('pay-with-yape', err);
    if (err instanceof MercadoPagoError && err.status >= 400 && err.status < 500) {
      return json({ error: 'El código de Yape no es válido o ya venció. Genera uno nuevo e intenta otra vez.' }, 402);
    }
    return json({ error: 'No se pudo procesar el pago. Intenta de nuevo en unos minutos.' }, 500);
  }

  if (payment?.status !== 'approved') {
    return json({ error: yapeRejectionMessage(payment?.status_detail), statusDetail: payment?.status_detail ?? null }, 402);
  }
  if (!isApprovedPass(payment, interval)) {
    console.error('pay-with-yape: pago aprobado con datos inesperados', payment?.id);
    return json({ error: 'Tu pago se aprobó, pero no coincide con el plan. Escríbenos a cualtoca@gmail.com.' }, 500);
  }

  const { data: accessUntil, error: grantError } = await admin.rpc('grant_premium_pass', {
    p_user_id: user.id,
    p_payment_id: String(payment.id),
    p_interval: interval,
    p_amount: payment.transaction_amount,
    p_method: 'yape',
  });
  if (grantError) {
    console.error('pay-with-yape: no se pudo acreditar', payment.id, grantError);
    return json({ error: 'Tu pago se aprobó y Premium se activará en unos minutos. Si no, escríbenos a cualtoca@gmail.com.' }, 500);
  }

  return json({ status: 'approved', accessUntil });
});
