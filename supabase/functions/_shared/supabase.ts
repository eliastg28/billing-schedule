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
    admin = createClient(requireEnv('SUPABASE_URL'), requireEnv('SUPABASE_SERVICE_ROLE_KEY'), {
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
