/**
 * Edge Function: send-reminders
 * Envía cada mañana los avisos de pago y de cierre por correo, SOLO a usuarios
 * Premium con los avisos por correo activados. La programa supabase/cron.sql.
 *
 * - Usa el mismo motor de fechas que la app (../_shared/engine.js).
 * - No repite avisos: cada uno se registra en `reminder_log`.
 * - Protegida con la cabecera x-cron-secret (despliegue con --no-verify-jwt).
 *
 * Secretos: REMINDERS_CRON_SECRET, RESEND_API_KEY, REMINDERS_FROM, APP_URL
 */
import { chunk, json, requireEnv } from '../_shared/http.ts';
import { adminClient } from '../_shared/supabase.ts';
import { alertMessage, computeAlerts, fmtFull, todayInTimeZone, toISO } from '../_shared/engine.js';

type Card = { id: string; name: string; closingDay: number; paymentDay: number; color: string };
type Alert = ReturnType<typeof computeAlerts>[number];

const DEFAULT_SETTINGS = { email_enabled: true, days_before: 3, notify_closing: true, timezone: 'America/Lima' };
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (ch) => ESCAPES[ch]);

function emailSubject(alerts: Alert[]): string {
  if (alerts.length === 1) return `${alerts[0].kind === 'payment_today' ? '⚠️ ' : ''}${alertMessage(alerts[0]).title}`;
  const urgent = alerts.some((a) => a.kind === 'payment_today');
  return `${urgent ? '⚠️ ' : ''}Tienes ${alerts.length} avisos de tus tarjetas`;
}

function emailHtml(alerts: Alert[], today: Date, appUrl: string): string {
  const rows = alerts
    .map((alert) => {
      const { title, body } = alertMessage(alert);
      return `
        <tr><td style="padding:12px 16px;background:#f6f8fc;border-left:4px solid ${alert.card.color};border-radius:8px">
          <strong style="font-size:15px;color:#111827">${escapeHtml(title)}</strong><br>
          <span style="font-size:14px;color:#4f5b73">${escapeHtml(body)}</span>
        </td></tr>
        <tr><td style="height:8px;line-height:8px">&nbsp;</td></tr>`;
    })
    .join('');
  const button = appUrl
    ? `<tr><td style="padding-top:8px"><a href="${escapeHtml(appUrl)}" style="display:inline-block;background:#4f5fe0;color:#ffffff;text-decoration:none;padding:12px 18px;border-radius:10px;font-weight:700">Abrir CuálToca</a></td></tr>`
    : '';
  return `<!doctype html>
<html lang="es"><body style="margin:0;padding:24px;background:#f3f5fa;font-family:'Segoe UI',Roboto,Arial,sans-serif;color:#111827">
  <table role="presentation" width="100%" style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:24px">
    <tr><td>
      <p style="margin:0;color:#4f5fe0;font-weight:700;font-size:12px;letter-spacing:.08em;text-transform:uppercase">CuálToca</p>
      <h1 style="margin:4px 0 4px;font-size:20px">Tus avisos de hoy</h1>
      <p style="margin:0 0 16px;color:#4f5b73;font-size:14px">${escapeHtml(fmtFull(today))}</p>
    </td></tr>
    <tr><td><table role="presentation" width="100%" cellspacing="0" cellpadding="0">${rows}</table></td></tr>
    ${button}
    <tr><td style="padding-top:20px;color:#7d889e;font-size:12px">Recibes este correo porque activaste los avisos de Premium. Puedes desactivarlos en Cuenta &gt; Avisos. Las fechas son referenciales: confirma siempre con tu estado de cuenta.</td></tr>
  </table>
</body></html>`;
}

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${requireEnv('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: requireEnv('REMINDERS_FROM'), to: [to], subject, html }),
  });
  if (!response.ok) throw new Error(`Resend respondió ${response.status}: ${await response.text()}`);
}

Deno.serve(async (req) => {
  const secret = Deno.env.get('REMINDERS_CRON_SECRET');
  if (!secret || req.headers.get('x-cron-secret') !== secret) return json({ error: 'No autorizado.' }, 401);

  const admin = adminClient();
  const now = new Date();
  const appUrl = Deno.env.get('APP_URL') ?? '';
  const result = { premiumUsers: 0, emailsSent: 0, alertsSent: 0, failures: [] as string[] };

  try {
    // 1. Usuarios con Premium vigente (misma regla que public.user_is_premium).
    const { data: subs, error: subsError } = await admin
      .from('subscriptions')
      .select('user_id,status,current_period_end')
      .in('status', ['active', 'cancelled']);
    if (subsError) throw subsError;
    const premiumIds = (subs ?? [])
      .filter((s) => s.status === 'active' || (s.current_period_end && new Date(s.current_period_end) > now))
      .map((s) => s.user_id as string);
    result.premiumUsers = premiumIds.length;

    for (const ids of chunk(premiumIds, 200)) {
      // 2. Datos del grupo: correos, preferencias y tarjetas.
      const [profiles, settings, cards] = await Promise.all([
        admin.from('profiles').select('id,email').in('id', ids),
        admin.from('reminder_settings').select('user_id,email_enabled,days_before,notify_closing,timezone').in('user_id', ids),
        admin.from('cards').select('id,user_id,name,closing_day,payment_day,color,position').in('user_id', ids).order('position'),
      ]);
      for (const res of [profiles, settings, cards]) if (res.error) throw res.error;

      const emailById = new Map((profiles.data ?? []).map((p) => [p.id, p.email as string | null]));
      const settingsById = new Map((settings.data ?? []).map((s) => [s.user_id, s]));
      const cardsById = new Map<string, Card[]>();
      for (const row of cards.data ?? []) {
        const list = cardsById.get(row.user_id) ?? [];
        list.push({ id: row.id, name: row.name, closingDay: row.closing_day, paymentDay: row.payment_day, color: row.color });
        cardsById.set(row.user_id, list);
      }

      // 3. Avisos de cada usuario.
      for (const userId of ids) {
        const pref = { ...DEFAULT_SETTINGS, ...(settingsById.get(userId) ?? {}) };
        const email = emailById.get(userId);
        const userCards = cardsById.get(userId) ?? [];
        if (!pref.email_enabled || !email || !userCards.length) continue;

        const today = todayInTimeZone(pref.timezone || 'America/Lima', now);
        const alerts = computeAlerts(userCards, today, { daysBefore: pref.days_before, includeClosing: pref.notify_closing });
        if (!alerts.length) continue;

        // 4. Registra los avisos; solo se envían los que no se habían enviado antes.
        const logRows = alerts.map((a) => ({ user_id: userId, card_id: a.card.id, kind: a.kind, event_date: toISO(a.date) }));
        const { data: inserted, error: logError } = await admin
          .from('reminder_log')
          .upsert(logRows, { onConflict: 'user_id,card_id,kind,event_date', ignoreDuplicates: true })
          .select('card_id,kind,event_date');
        if (logError) throw logError;
        const fresh = alerts.filter((a) =>
          (inserted ?? []).some((r) => r.card_id === a.card.id && r.kind === a.kind && r.event_date === toISO(a.date)));
        if (!fresh.length) continue;

        try {
          await sendEmail(email, emailSubject(fresh), emailHtml(fresh, today, appUrl));
          result.emailsSent++;
          result.alertsSent += fresh.length;
        } catch (err) {
          // Si el correo falla, se borra el registro para reintentarlo en la próxima ejecución.
          console.error('send-reminders: correo fallido', userId, err);
          result.failures.push(userId);
          for (const a of fresh) {
            await admin.from('reminder_log').delete()
              .match({ user_id: userId, card_id: a.card.id, kind: a.kind, event_date: toISO(a.date) });
          }
        }
      }
    }

    return json(result);
  } catch (err) {
    console.error('send-reminders', err);
    return json({ ...result, error: 'Error al procesar los avisos.' }, 500);
  }
});
