/**
 * Clientes de Supabase para las Edge Functions.
 * SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY las inyecta Supabase automáticamente.
 */
import { createClient, type SupabaseClient, type User } from 'npm:@supabase/supabase-js@2';
import { requireEnv } from './http.ts';

let admin: SupabaseClient | null = null;

/** Cliente con permisos de administrador (ignora RLS). Nunca se expone al navegador. */
export function adminClient(): SupabaseClient {
  if (!admin) {
    // Supabase inyecta SUPABASE_SERVICE_ROLE_KEY. Si tu proyecto desactivó las claves
    // heredadas, guarda la "secret key" como secreto SERVICE_ROLE_KEY.
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SERVICE_ROLE_KEY');
    if (!serviceKey) throw new Error('Falta la clave de servicio (SUPABASE_SERVICE_ROLE_KEY o SERVICE_ROLE_KEY)');
    admin = createClient(requireEnv('SUPABASE_URL'), serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return admin;
}

/** Usuario dueño del token "Authorization: Bearer ..." de la petición (o null). */
export async function getUserFromRequest(req: Request): Promise<User | null> {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const { data, error } = await adminClient().auth.getUser(token);
  if (error) return null;
  return data.user;
}
