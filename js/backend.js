/**
 * =============================================================================
 *  CUÁLTOCA · js/backend.js
 * -----------------------------------------------------------------------------
 *  Conexión con Supabase: sesión, inicio de sesión y llamadas a las Edge
 *  Functions de cobro. El cliente de Supabase se descarga solo si hay un
 *  servidor configurado en js/config.js.
 * =============================================================================
 */
import { CONFIG, hasBackend } from './config.js';

let clientPromise = null;

/** Cliente de Supabase (o null en modo local). */
export function getClient() {
  if (!hasBackend()) return Promise.resolve(null);
  if (!clientPromise) {
    clientPromise = import(CONFIG.supabaseJsUrl).then(({ createClient }) =>
      createClient(CONFIG.supabaseUrl, CONFIG.supabaseAnonKey, {
        auth: {
          // PKCE devuelve "?code=..." en la URL y no choca con el enrutador por "#".
          flowType: 'pkce',
          persistSession: true,
          autoRefreshToken: true,
          detectSessionInUrl: true,
        },
      }),
    );
  }
  return clientPromise;
}

/** URL a la que vuelven los enlaces de acceso y el pago. */
export const appUrl = () => CONFIG.appUrl || `${location.origin}${location.pathname}`;

/** Quita de la URL los parámetros que deja el inicio de sesión. */
function cleanAuthParams() {
  const url = new URL(location.href);
  const keys = ['code', 'error', 'error_code', 'error_description'];
  if (!keys.some((k) => url.searchParams.has(k))) return null;
  const errorText = url.searchParams.get('error_description');
  keys.forEach((k) => url.searchParams.delete(k));
  history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  return errorText;
}

/**
 * Usuario con sesión activa (o null). Si la URL trae un enlace de acceso,
 * supabase-js lo canjea al inicializarse; `getSession` espera a que termine.
 */
export async function getSessionUser(client) {
  const { data, error } = await client.auth.getSession();
  const urlError = cleanAuthParams();
  return { user: data?.session?.user ?? null, error: urlError || error?.message || null };
}

/**
 * Proveedores de acceso activos en Supabase (ej. { email: true, google: false }).
 * Sirve para no mostrar el botón de Google si no está configurado.
 */
export async function getAuthProviders() {
  if (!hasBackend()) return {};
  try {
    const response = await fetch(`${CONFIG.supabaseUrl}/auth/v1/settings`, {
      headers: { apikey: CONFIG.supabaseAnonKey },
    });
    if (!response.ok) return {};
    const settings = await response.json();
    return settings.external || {};
  } catch {
    return {};
  }
}

/** Traduce los errores más comunes del inicio de sesión. */
function authErrorMessage(error) {
  const message = error?.message || 'Error desconocido.';
  const wait = message.match(/after (\d+) seconds?/i);
  if (wait) return `Por seguridad, espera ${wait[1]} segundos antes de pedir otro enlace.`;
  if (/rate limit/i.test(message)) return 'Se enviaron demasiados correos. Espera unos minutos e intenta de nuevo.';
  if (/signups? not allowed/i.test(message)) return 'Por ahora no se aceptan cuentas nuevas.';
  if (/invalid|unable to validate email/i.test(message)) return 'Ese correo no es válido.';
  return message; // p. ej. el mensaje en español del bloqueo de correos temporales
}

export async function signInWithEmail(client, email) {
  const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: appUrl() } });
  if (error) throw new Error(authErrorMessage(error));
}

export async function signInWithGoogle(client) {
  const { error } = await client.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: appUrl() } });
  if (error) throw new Error(error.message);
}

export async function signOut(client) {
  const { error } = await client.auth.signOut();
  if (error) throw new Error(error.message);
}

/** Extrae el mensaje de error que devuelve una Edge Function. */
async function functionError(error) {
  try {
    const body = await error.context?.json();
    if (body?.error) return new Error(body.error);
  } catch {
    /* la respuesta no era JSON */
  }
  return new Error(error?.message || 'Error del servidor.');
}

/** Crea la suscripción en Mercado Pago y devuelve el enlace de pago. */
export async function startCheckout(client, interval) {
  const { data, error } = await client.functions.invoke('create-checkout', { body: { interval, returnUrl: appUrl() } });
  if (error) throw await functionError(error);
  if (!data?.url) throw new Error('No se recibió el enlace de pago.');
  return data.url;
}

/** Cancela la suscripción. Premium sigue activo hasta el fin del periodo pagado. */
export async function cancelSubscription(client) {
  const { data, error } = await client.functions.invoke('cancel-subscription', { body: {} });
  if (error) throw await functionError(error);
  return data;
}
