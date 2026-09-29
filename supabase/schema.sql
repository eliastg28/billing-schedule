-- =============================================================================
--  CUÁLTOCA · supabase/schema.sql
-- -----------------------------------------------------------------------------
--  Esquema de la base de datos (Supabase / PostgreSQL).
--  Cómo usarlo: Supabase > SQL Editor > pega este archivo completo > Run.
--  Se puede ejecutar varias veces: no borra datos.
--
--  Seguridad:
--    - RLS (Row Level Security) en todas las tablas: cada usuario solo ve y
--      modifica sus propias filas.
--    - El plan NO se puede cambiar desde el navegador: la tabla
--      `subscriptions` solo la escriben las Edge Functions con la clave
--      service_role (webhook de Mercado Pago).
--    - Los límites del plan Gratis se aplican aquí, no solo en la interfaz:
--        * máximo 2 tarjetas (trigger enforce_card_limit)
--        * compras registradas solo con Premium (políticas de purchases)
--    - Premium se obtiene de tres formas: suscripción con tarjeta (se renueva
--      sola), pase pagado con Yape (1 o 12 meses, no se renueva) o la prueba
--      gratis de 1 mes (una sola vez por persona, sin medio de pago).
--    - Nunca se guardan números de tarjeta: solo nombre, días y color.
--    - Los permisos de cada tabla se declaran al final (sección 8), así que
--      funciona con la opción "Automatically expose new tables" desactivada,
--      como recomienda Supabase.
-- =============================================================================


-- 1. SUSCRIPCIONES ------------------------------------------------------------

create table if not exists public.subscriptions (
  user_id                  uuid primary key references auth.users (id) on delete cascade,
  status                   text not null default 'inactive'
                           check (status in ('inactive', 'pending', 'active', 'paused', 'cancelled')),
  plan_interval            text check (plan_interval in ('monthly', 'yearly')),
  provider                 text not null default 'mercadopago',
  provider_subscription_id text unique,
  -- Hasta cuándo sigue activo Premium después de cancelar (fin del periodo pagado).
  current_period_end       timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);

comment on table public.subscriptions is
  'Estado de la suscripción Premium. Solo la escriben las Edge Functions (service_role).';

-- Columnas agregadas después (con "if not exists" para bases ya creadas).
alter table public.subscriptions add column if not exists access_until  timestamptz;
alter table public.subscriptions add column if not exists trial_ends_at timestamptz;

comment on column public.subscriptions.current_period_end is
  'Suscripción con tarjeta: próximo cobro mientras está activa; fin del periodo pagado si se canceló.';
comment on column public.subscriptions.access_until is
  'Premium sin renovación automática (prueba gratis o pases con Yape): vigente hasta esta fecha.';
comment on column public.subscriptions.trial_ends_at is
  'Fin de la prueba gratis. Si no es null, la persona ya usó su prueba.';

-- ¿El usuario tiene Premium? Misma regla que isSubscriptionActive() en js/plan.js.
-- Uso interno (triggers y otras funciones): no se expone a los clientes.
create or replace function public.user_is_premium(uid uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.subscriptions s
    where s.user_id = uid
      and (
        s.status = 'active'
        or (s.status = 'cancelled' and s.current_period_end > now())
        or s.access_until > now()
      )
  );
$$;

revoke all on function public.user_is_premium(uuid) from public, anon, authenticated;

-- Versión para el usuario actual (la usan las políticas RLS y la app vía RPC).
create or replace function public.is_premium()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.user_is_premium(auth.uid());
$$;


-- 1b. PRUEBA GRATIS Y PASES CON YAPE ------------------------------------------

-- Huella del correo de quienes ya usaron la prueba gratis. Se guarda un hash
-- (no el correo) y se conserva aunque borren la cuenta, para que la prueba
-- no se repita creando cuentas nuevas. Solo service_role.
create table if not exists public.trial_claims (
  email_hash text primary key,
  claimed_at timestamptz not null default now()
);

-- Correo "canónico": en Gmail, juan.perez+x@gmail.com es el mismo buzón que juanperez@gmail.com.
create or replace function public.normalize_email(email text)
returns text
language sql
immutable
as $$
  select case
    when split_part(e, '@', 2) in ('gmail.com', 'googlemail.com')
      then replace(split_part(split_part(e, '@', 1), '+', 1), '.', '') || '@gmail.com'
    else split_part(split_part(e, '@', 1), '+', 1) || '@' || split_part(e, '@', 2)
  end
  from (select lower(btrim(email)) as e) as t;
$$;

-- Activa 1 mes de Premium gratis, sin medio de pago. Solo para cuentas que
-- nunca tuvieron Premium ni usaron la prueba. La app la llama con rpc('start_trial').
create or replace function public.start_trial()
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  uid        uuid := auth.uid();
  user_email text;
  sub        public.subscriptions%rowtype;
  claimed    integer;
  ends       timestamptz := now() + interval '1 month';
begin
  if uid is null then
    raise exception using errcode = '42501', message = 'NOT_AUTHENTICATED';
  end if;
  perform pg_advisory_xact_lock(hashtext('premium:' || uid::text));

  select * into sub from public.subscriptions where user_id = uid;
  if found and (
    sub.trial_ends_at is not null
    or sub.access_until is not null
    or sub.status in ('active', 'paused', 'cancelled')
  ) then
    raise exception using errcode = 'P0001', message = 'TRIAL_NOT_AVAILABLE';
  end if;

  select email into user_email from auth.users where id = uid;
  if coalesce(user_email, '') = '' then
    raise exception using errcode = 'P0001', message = 'TRIAL_NOT_AVAILABLE';
  end if;

  insert into public.trial_claims (email_hash)
  values (encode(sha256(convert_to(public.normalize_email(user_email), 'UTF8')), 'hex'))
  on conflict do nothing;
  get diagnostics claimed = row_count;
  if claimed = 0 then
    raise exception using errcode = 'P0001', message = 'TRIAL_NOT_AVAILABLE';
  end if;

  insert into public.subscriptions (user_id, trial_ends_at, access_until)
  values (uid, ends, ends)
  on conflict (user_id) do update
    set trial_ends_at = excluded.trial_ends_at, access_until = excluded.access_until;
  return ends;
end;
$$;

-- Pagos únicos de pases Premium (Yape). Se conservan aunque se borre la cuenta
-- (comprobantes). Solo service_role.
create table if not exists public.premium_payments (
  provider_payment_id text primary key,
  user_id             uuid references auth.users (id) on delete set null,
  plan_interval       text not null check (plan_interval in ('monthly', 'yearly')),
  amount              numeric(10, 2) not null,
  currency            text not null default 'PEN',
  method              text,
  access_until        timestamptz not null,
  created_at          timestamptz not null default now()
);

create index if not exists premium_payments_user_idx on public.premium_payments (user_id);

-- Acredita un pase pagado: 1 mes (monthly) o 12 meses (yearly). Los días se
-- suman al Premium que ya tenga (prueba, otro pase o suscripción cancelada).
-- Es idempotente: el mismo pago nunca se acredita dos veces, aunque lleguen
-- la respuesta del cobro y el webhook. Solo lo ejecutan las Edge Functions.
create or replace function public.grant_premium_pass(
  p_user_id    uuid,
  p_payment_id text,
  p_interval   text,
  p_amount     numeric,
  p_method     text default null
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  months  integer := case p_interval when 'monthly' then 1 when 'yearly' then 12 end;
  already timestamptz;
  starts  timestamptz;
  ends    timestamptz;
begin
  if months is null then
    raise exception using errcode = '22023', message = 'INVALID_INTERVAL';
  end if;
  perform pg_advisory_xact_lock(hashtext('premium:' || p_user_id::text));

  select access_until into already from public.premium_payments where provider_payment_id = p_payment_id;
  if found then
    return already;
  end if;

  select greatest(now(), s.access_until, case when s.status = 'cancelled' then s.current_period_end end)
    into starts
    from public.subscriptions s
   where s.user_id = p_user_id;
  ends := coalesce(starts, now()) + make_interval(months => months);

  insert into public.premium_payments (provider_payment_id, user_id, plan_interval, amount, method, access_until)
  values (p_payment_id, p_user_id, p_interval, p_amount, p_method, ends);

  insert into public.subscriptions (user_id, access_until)
  values (p_user_id, ends)
  on conflict (user_id) do update set access_until = excluded.access_until;
  return ends;
end;
$$;


-- 2. PERFILES (correo para los avisos) ----------------------------------------

create table if not exists public.profiles (
  id         uuid primary key references auth.users (id) on delete cascade,
  email      text,
  created_at timestamptz not null default now()
);

-- Crea / actualiza el perfil cuando alguien se registra o cambia de correo.
create or replace function public.handle_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, email)
  values (new.id, new.email)
  on conflict (id) do update set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_saved on auth.users;
create trigger on_auth_user_saved
  after insert or update of email on auth.users
  for each row execute function public.handle_auth_user();


-- 3. TARJETAS -----------------------------------------------------------------

create table if not exists public.cards (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name        text not null check (char_length(btrim(name)) between 1 and 24),
  closing_day smallint not null check (closing_day between 1 and 31),
  payment_day smallint not null check (payment_day between 1 and 31),
  color       text not null default '#8b9bff' check (color ~ '^#[0-9a-f]{6}$'),
  position    integer not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- Permite que las compras exijan que la tarjeta sea del mismo usuario.
  constraint cards_id_user_key unique (id, user_id)
);

create unique index if not exists cards_user_name_key on public.cards (user_id, lower(name));
create index if not exists cards_user_position_idx on public.cards (user_id, position);

-- Límite del plan Gratis: 2 tarjetas. Premium: ilimitadas.
create or replace function public.enforce_card_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  card_count integer;
begin
  -- Serializa las altas del mismo usuario para evitar que dos inserciones
  -- simultáneas superen el límite.
  perform pg_advisory_xact_lock(hashtext('cards:' || new.user_id::text));

  if public.user_is_premium(new.user_id) then
    return new;
  end if;

  select count(*) into card_count from public.cards where user_id = new.user_id;
  if card_count >= 2 then
    raise exception using
      errcode = 'P0001',
      message = 'FREE_CARD_LIMIT',
      hint    = 'El plan Gratis permite hasta 2 tarjetas. Hazte Premium para tarjetas ilimitadas.';
  end if;
  return new;
end;
$$;

drop trigger if exists cards_enforce_limit on public.cards;
create trigger cards_enforce_limit
  before insert on public.cards
  for each row execute function public.enforce_card_limit();


-- 4. COMPRAS (proyección de pagos, Premium) ----------------------------------

create table if not exists public.purchases (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null default auth.uid() references auth.users (id) on delete cascade,
  card_id       uuid not null,
  description   text not null check (char_length(btrim(description)) between 1 and 60),
  amount        numeric(12, 2) not null check (amount > 0 and amount <= 1000000),
  currency      text not null default 'PEN' check (currency in ('PEN', 'USD')),
  purchase_date date not null,
  installments  smallint not null default 1 check (installments between 1 and 36),
  created_at    timestamptz not null default now(),
  -- La tarjeta debe pertenecer al mismo usuario; si se borra, se borran sus compras.
  constraint purchases_card_fkey foreign key (card_id, user_id)
    references public.cards (id, user_id) on delete cascade
);

create index if not exists purchases_user_date_idx on public.purchases (user_id, purchase_date desc);


-- 5. PREFERENCIAS DE AVISOS ---------------------------------------------------

create table if not exists public.reminder_settings (
  user_id        uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  email_enabled  boolean not null default true,
  days_before    smallint not null default 3 check (days_before between 0 and 7),
  notify_closing boolean not null default true,
  timezone       text not null default 'America/Lima',
  updated_at     timestamptz not null default now()
);

-- Registro de avisos enviados por correo (evita duplicados). Solo service_role.
create table if not exists public.reminder_log (
  user_id    uuid not null references auth.users (id) on delete cascade,
  card_id    uuid not null,
  kind       text not null check (kind in ('payment', 'payment_today', 'closing')),
  event_date date not null,
  sent_at    timestamptz not null default now(),
  primary key (user_id, card_id, kind, event_date)
);


-- 6. updated_at automático ----------------------------------------------------

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists cards_set_updated_at on public.cards;
create trigger cards_set_updated_at before update on public.cards
  for each row execute function public.set_updated_at();

drop trigger if exists subscriptions_set_updated_at on public.subscriptions;
create trigger subscriptions_set_updated_at before update on public.subscriptions
  for each row execute function public.set_updated_at();

drop trigger if exists reminder_settings_set_updated_at on public.reminder_settings;
create trigger reminder_settings_set_updated_at before update on public.reminder_settings
  for each row execute function public.set_updated_at();


-- 7. ROW LEVEL SECURITY -------------------------------------------------------

alter table public.subscriptions     enable row level security;
alter table public.profiles          enable row level security;
alter table public.cards             enable row level security;
alter table public.purchases         enable row level security;
alter table public.reminder_settings enable row level security;
alter table public.reminder_log      enable row level security; -- sin políticas: solo service_role
alter table public.trial_claims      enable row level security; -- sin políticas: solo service_role
alter table public.premium_payments  enable row level security; -- sin políticas: solo service_role

-- Suscripción: el usuario solo puede LEER la suya.
drop policy if exists "subscriptions_select_own" on public.subscriptions;
create policy "subscriptions_select_own" on public.subscriptions
  for select to authenticated
  using (user_id = (select auth.uid()));

-- Perfil: solo lectura del propio.
drop policy if exists "profiles_select_own" on public.profiles;
create policy "profiles_select_own" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

-- Tarjetas: CRUD de las propias (el límite lo aplica el trigger).
drop policy if exists "cards_select_own" on public.cards;
create policy "cards_select_own" on public.cards
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "cards_insert_own" on public.cards;
create policy "cards_insert_own" on public.cards
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "cards_update_own" on public.cards;
create policy "cards_update_own" on public.cards
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "cards_delete_own" on public.cards;
create policy "cards_delete_own" on public.cards
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- Compras: leer y borrar las propias siempre; crear y editar solo con Premium.
drop policy if exists "purchases_select_own" on public.purchases;
create policy "purchases_select_own" on public.purchases
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "purchases_insert_premium" on public.purchases;
create policy "purchases_insert_premium" on public.purchases
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_premium()));

drop policy if exists "purchases_update_premium" on public.purchases;
create policy "purchases_update_premium" on public.purchases
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()) and (select public.is_premium()));

drop policy if exists "purchases_delete_own" on public.purchases;
create policy "purchases_delete_own" on public.purchases
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- Preferencias de avisos: el usuario administra las suyas.
-- (Los correos solo se envían a Premium: lo controla la Edge Function.)
drop policy if exists "reminder_settings_select_own" on public.reminder_settings;
create policy "reminder_settings_select_own" on public.reminder_settings
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "reminder_settings_insert_own" on public.reminder_settings;
create policy "reminder_settings_insert_own" on public.reminder_settings
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists "reminder_settings_update_own" on public.reminder_settings;
create policy "reminder_settings_update_own" on public.reminder_settings
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));


-- 8. PERMISOS DE LA DATA API --------------------------------------------------
-- Declarados explícitamente para no depender de "Automatically expose new tables".
--   anon (sin sesión): sin acceso a ninguna tabla.
--   authenticated:     solo lo que usa la app; RLS limita las filas a las propias.
--   service_role:      Edge Functions (webhook y avisos); ignora RLS.

revoke all on public.subscriptions, public.profiles, public.cards, public.purchases,
  public.reminder_settings, public.reminder_log, public.trial_claims, public.premium_payments
  from anon, authenticated;

grant select on public.subscriptions, public.profiles to authenticated;
grant select, insert, update, delete on public.cards, public.purchases to authenticated;
grant select, insert, update on public.reminder_settings to authenticated;

grant all on public.subscriptions, public.profiles, public.cards, public.purchases,
  public.reminder_settings, public.reminder_log, public.trial_claims, public.premium_payments
  to service_role;

revoke all on function public.is_premium() from public, anon;
grant execute on function public.is_premium() to authenticated, service_role;

-- La prueba la inicia la propia persona; los pases solo los acreditan las Edge Functions.
revoke all on function public.start_trial() from public, anon;
grant execute on function public.start_trial() to authenticated;

revoke all on function public.grant_premium_pass(uuid, text, text, numeric, text) from public, anon, authenticated;
grant execute on function public.grant_premium_pass(uuid, text, text, numeric, text) to service_role;
