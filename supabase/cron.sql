-- =============================================================================
--  CUÁLTOCA · supabase/cron.sql
-- -----------------------------------------------------------------------------
--  Programa el envío diario de avisos por correo (Edge Function send-reminders).
--
--  Antes de ejecutarlo:
--    1. Activa las extensiones pg_cron y pg_net (Database > Extensions).
--    2. Despliega la función send-reminders (ver README).
--    3. Reemplaza TU-PROYECTO y EL-MISMO-SECRETO-DE-LA-FUNCION abajo.
--       El secreto debe coincidir con REMINDERS_CRON_SECRET de la función.
--
--  Horario: 13:00 UTC = 08:00 en Lima (Perú no usa horario de verano).
-- =============================================================================

-- Guarda la URL del proyecto y el secreto en Vault (cifrados).
select vault.create_secret('https://TU-PROYECTO.supabase.co', 'project_url');
select vault.create_secret('EL-MISMO-SECRETO-DE-LA-FUNCION', 'reminders_cron_secret');

-- Si ya existía la tarea, se reemplaza.
select cron.unschedule('send-daily-reminders')
where exists (select 1 from cron.job where jobname = 'send-daily-reminders');

select cron.schedule(
  'send-daily-reminders',
  '0 13 * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'project_url')
           || '/functions/v1/send-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'reminders_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);
