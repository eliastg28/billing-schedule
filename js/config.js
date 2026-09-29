/**
 * =============================================================================
 *  CICLO DE TARJETAS · js/config.js
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
  /** Cliente oficial de Supabase (solo se descarga si hay servidor configurado). */
  supabaseJsUrl: 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm',
});

export const hasBackend = () => Boolean(CONFIG.supabaseUrl && CONFIG.supabaseAnonKey);
