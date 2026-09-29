-- =============================================================================
--  CUÁLTOCA · supabase/auth-hooks.sql
-- -----------------------------------------------------------------------------
--  Bloquea el registro con correos temporales (yopmail, mailinator, temp-mail…).
--
--  Cómo activarlo:
--    1. SQL Editor: ejecuta este archivo.
--    2. SQL Editor: ejecuta supabase/disposable-domains.sql (carga la lista).
--    3. Authentication > Auth Hooks > Add hook > "Before User Created"
--       Tipo: Postgres · Esquema: public · Función: hook_before_user_created
--
--  Se aplica a cualquier forma de registro (correo o Google). Las cuentas que
--  ya existen no se ven afectadas. Se puede ejecutar varias veces.
-- =============================================================================

-- Dominios bloqueados. Se revisa el dominio exacto y sus dominios padre:
-- "x.mailinator.com" queda bloqueado si está "mailinator.com".
create table if not exists public.blocked_email_domains (
  domain     text primary key check (domain = lower(domain) and domain <> ''),
  source     text not null default 'manual',
  created_at timestamptz not null default now()
);

comment on table public.blocked_email_domains is
  'Dominios de correo no permitidos al registrarse (correos temporales).';

-- Nadie desde el navegador puede leer ni cambiar la lista.
alter table public.blocked_email_domains enable row level security;
revoke all on public.blocked_email_domains from anon, authenticated;
grant all on public.blocked_email_domains to service_role;

-- El servicio de Auth (supabase_auth_admin) ejecuta el hook y necesita leer la lista.
grant usage on schema public to supabase_auth_admin;
grant select on public.blocked_email_domains to supabase_auth_admin;
drop policy if exists "blocked_domains_read_auth" on public.blocked_email_domains;
create policy "blocked_domains_read_auth" on public.blocked_email_domains
  for select to supabase_auth_admin
  using (true);

-- Hook "Before User Created": rechaza el registro si el dominio está bloqueado.
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  email_domain text := lower(split_part(coalesce(event->'user'->>'email', ''), '@', 2));
  parts text[];
  candidates text[];
begin
  if email_domain = '' then
    return '{}'::jsonb; -- registro sin correo (no aplica)
  end if;

  -- "a.b.mailinator.com" → {a.b.mailinator.com, b.mailinator.com, mailinator.com, com}
  parts := string_to_array(email_domain, '.');
  select array_agg(array_to_string(parts[i:array_length(parts, 1)], '.'))
    into candidates
    from generate_series(1, array_length(parts, 1)) as i;

  if exists (select 1 from public.blocked_email_domains b where b.domain = any (candidates)) then
    return jsonb_build_object(
      'error', jsonb_build_object(
        'http_code', 403,
        'message', 'No se permiten correos temporales. Usa tu correo personal, por ejemplo Gmail u Outlook.'
      )
    );
  end if;

  return '{}'::jsonb;
end;
$$;

grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;
revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;

-- Para bloquear un dominio extra a mano:
--   insert into public.blocked_email_domains (domain) values ('dominio-temporal.com')
--   on conflict do nothing;
