/**
 * =============================================================================
 *  CUÁLTOCA · js/config.js
 * -----------------------------------------------------------------------------
 *  Configuración del servidor (Supabase). Mientras `supabaseUrl` y
 *  `supabaseAnonKey` estén vacíos, la app funciona en MODO LOCAL:
 *    - Los datos se guardan solo en este navegador.
 *    - No hay cuentas ni cobros.
 *    - Si `devTools` es true, la pantalla Cuenta muestra un interruptor para
 *      simular el plan Premium y probar avisos, tarjetas ilimitadas y pagos.
 *
 *  Al conectar Supabase (ver README), el plan sale de la base de datos y el
 *  interruptor de prueba desaparece.
 *
 *  La clave "anon" es pública por diseño: la seguridad la dan las políticas
 *  RLS de la base de datos. NUNCA pongas aquí la clave "service_role".
 * =============================================================================
 */

export const CONFIG = Object.freeze({
  /** URL del proyecto, ej. 'https://abcd1234.supabase.co' */
  supabaseUrl: 'https://yeoeuijdhuwanbgsiasu.supabase.co',
  /** Clave pública del proyecto: publishable key o anon key (Project Settings > API Keys). */
  supabaseAnonKey: 'sb_publishable_JIfJ9BQhmNW6nMM8plRL1Q_IRU_r0Z7',
  /** URL pública de la app para los enlaces de acceso y el retorno del pago. Vacío = URL actual. */
  appUrl: '',
  /** Muestra el simulador de plan en modo local. No tiene efecto con Supabase conectado. */
  devTools: true,
  /**
   * Cobros con Mercado Pago. Mientras sea false, los planes se muestran como
   * "Muy pronto" y nadie puede pagar. Actívalo cuando las Edge Functions de
   * cobro estén desplegadas y probadas (ver README).
   */
  paymentsEnabled: false,
  /**
   * Prueba gratis de Premium (1 mes, sin medio de pago) para cuentas nuevas.
   * Es independiente de los cobros: se puede activar antes para probar
   * Premium. Requiere haber ejecutado el supabase/schema.sql actualizado.
   */
  trialEnabled: true,
  /**
   * Public Key de Mercado Pago (Tus integraciones > Credenciales). Es pública
   * por diseño y solo sirve para crear el token del pago con Yape. Vacía = el
   * pago con Yape no se muestra y solo queda la suscripción con tarjeta.
   * NUNCA pongas aquí el Access Token.
   */
  mercadoPagoPublicKey: '',
  /** SDK oficial de Mercado Pago (solo se descarga al pagar con Yape). */
  mercadoPagoJsUrl: 'https://sdk.mercadopago.com/js/v2',
  /** Cliente oficial de Supabase (solo se descarga si hay servidor configurado). */
  supabaseJsUrl: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
});

export const hasBackend = () => Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
