/**
 * Descarga la lista pública de dominios de correo temporal y genera
 * supabase/disposable-domains.sql para cargarla en Supabase.
 *
 *   node scripts/update-disposable-domains.mjs
 *
 * Fuente: https://github.com/disposable-email-domains/disposable-email-domains
 * Licencia de la lista: CC0 1.0 (dominio público).
 * Conviene regenerarla cada pocos meses: los servicios temporales crean dominios nuevos.
 */
import { writeFile } from 'node:fs/promises';

const SOURCE = 'https://raw.githubusercontent.com/disposable-email-domains/disposable-email-domains/main/disposable_email_blocklist.conf';
const OUTPUT = new URL('../supabase/disposable-domains.sql', import.meta.url);
const CHUNK = 1000;

// Proveedores reales que nunca se deben bloquear (por si la lista cambia).
const NEVER_BLOCK = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.es', 'icloud.com', 'me.com', 'proton.me', 'protonmail.com',
  'duck.com', 'zoho.com', 'aol.com', 'gmx.com',
]);

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`No se pudo descargar la lista (${response.status})`);

const domains = [...new Set(
  (await response.text())
    .split(/\r?\n/)
    .map((line) => line.trim().toLowerCase())
    .filter((d) => d && !d.startsWith('#') && /^[a-z0-9.-]+\.[a-z0-9-]+$/.test(d) && !NEVER_BLOCK.has(d)),
)].sort();

const chunks = [];
for (let i = 0; i < domains.length; i += CHUNK) {
  const values = domains.slice(i, i + CHUNK).map((d) => `'${d}'`).join(',\n');
  chunks.push(`insert into public.blocked_email_domains (domain, source)\nselect unnest(array[\n${values}\n]), 'disposable-email-domains'\non conflict (domain) do nothing;`);
}

const today = new Date().toISOString().slice(0, 10);
const sql = `-- =============================================================================
--  CICLO DE TARJETAS · supabase/disposable-domains.sql
-- -----------------------------------------------------------------------------
--  Generado por scripts/update-disposable-domains.mjs el ${today}.
--  ${domains.length} dominios de correo temporal.
--  Fuente: github.com/disposable-email-domains/disposable-email-domains (CC0 1.0).
--  Ejecutar DESPUÉS de supabase/auth-hooks.sql. Se puede ejecutar varias veces.
-- =============================================================================

${chunks.join('\n\n')}
`;

await writeFile(OUTPUT, sql);
console.log(`Listo: ${domains.length} dominios en supabase/disposable-domains.sql`);
