/**
 * =============================================================================
 *  CUÁLTOCA · js/store.js
 * -----------------------------------------------------------------------------
 *  Capa de datos. Dos implementaciones con la MISMA interfaz asíncrona:
 *    - LocalStore:  LocalStorage del navegador (sin cuenta).
 *    - RemoteStore: base de datos de Supabase (con cuenta). Las políticas RLS
 *                   y los triggers del servidor aplican los límites del plan.
 *
 *  Interfaz común:
 *    getCards, addCard, updateCard, deleteCard, replaceCards,
 *    getPurchases, addPurchase, deletePurchase,
 *    getSettings, saveSettings, getSubscription
 * =============================================================================
 */
import { isValidDay, fromISO, CURRENCIES, MAX_INSTALLMENTS } from './engine.js';
import { FREE_CARD_LIMIT } from './plan.js';

// Prefijo heredado de la primera versión: no cambiarlo, o los usuarios perderían sus datos guardados.
export const KEYS = Object.freeze({
  cards: 'ciclo-tarjetas:cards:v1',
  purchases: 'ciclo-tarjetas:purchases:v1',
  settings: 'ciclo-tarjetas:settings:v1',
});

export const HEX_COLOR = /^#[0-9a-f]{6}$/i;
export const DEFAULT_COLOR = '#8b9bff';
export const MAX_CARD_NAME = 24;
export const MAX_DESCRIPTION = 60;
export const MAX_AMOUNT = 1000000;

/** Preferencias de avisos que se sincronizan con la cuenta. */
export const DEFAULT_SETTINGS = Object.freeze({
  daysBefore: 3, // días de anticipación del aviso de pago (0-7)
  notifyClosing: true, // avisar el día antes y el día del cierre
  emailReminders: true, // enviar avisos por correo (requiere cuenta)
});

/** Error con un código que la interfaz sabe interpretar. */
export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code; // 'limit' | 'duplicate' | 'premium' | 'invalid' | 'not_found' | 'storage' | 'network'
  }
}

/* ---------------------------------------------------------------------------
 * LocalStorage seguro (puede fallar en modo privado o con el almacenamiento bloqueado)
 * ------------------------------------------------------------------------- */

export function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function storageRemove(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* sin acceso al almacenamiento: no hay nada que borrar */
  }
}

function readJSON(key, fallback) {
  const raw = storageGet(key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJSON(key, value) {
  if (!storageSet(key, JSON.stringify(value))) {
    throw new StoreError('storage', 'No se pudo guardar: el almacenamiento del navegador está bloqueado.');
  }
}

/* ---------------------------------------------------------------------------
 * Validación y normalización
 * ------------------------------------------------------------------------- */

const VALID_ID = /^[\w-]{1,64}$/;

export const uid = () =>
  globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** Valida y normaliza una tarjeta (datos guardados o importados). */
export function sanitizeCard(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const name = String(raw.name ?? '').trim().slice(0, MAX_CARD_NAME);
  const closingDay = Number(raw.closingDay);
  const paymentDay = Number(raw.paymentDay);
  if (!name || !isValidDay(closingDay) || !isValidDay(paymentDay)) return null;
  const color = HEX_COLOR.test(String(raw.color)) ? String(raw.color).toLowerCase() : DEFAULT_COLOR;
  const id = typeof raw.id === 'string' && VALID_ID.test(raw.id) ? raw.id : uid();
  return { id, name, closingDay, paymentDay, color };
}

/** Sanea una lista de tarjetas y garantiza ids únicos. */
export function normalizeCards(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .map(sanitizeCard)
    .filter(Boolean)
    .map((card) => {
      if (seen.has(card.id)) card.id = uid();
      seen.add(card.id);
      return card;
    });
}

/** Valida y normaliza una compra. */
export function sanitizePurchase(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const description = String(raw.description ?? '').trim().slice(0, MAX_DESCRIPTION);
  const amount = Math.round(Number(raw.amount) * 100) / 100;
  const currency = CURRENCIES.includes(raw.currency) ? raw.currency : 'PEN';
  const installments = Number(raw.installments ?? 1);
  const cardId = typeof raw.cardId === 'string' && VALID_ID.test(raw.cardId) ? raw.cardId : null;
  const date = fromISO(raw.date) ? raw.date : null;
  if (
    !description || !cardId || !date ||
    !(amount > 0) || amount > MAX_AMOUNT ||
    !Number.isInteger(installments) || installments < 1 || installments > MAX_INSTALLMENTS
  ) {
    return null;
  }
  const id = typeof raw.id === 'string' && VALID_ID.test(raw.id) ? raw.id : uid();
  return { id, cardId, description, amount, currency, date, installments };
}

/** Completa las preferencias de avisos con valores por defecto. */
export function sanitizeSettings(raw) {
  const settings = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === 'object') {
    const days = Number(raw.daysBefore);
    if (Number.isInteger(days) && days >= 0 && days <= 7) settings.daysBefore = days;
    if (typeof raw.notifyClosing === 'boolean') settings.notifyClosing = raw.notifyClosing;
    if (typeof raw.emailReminders === 'boolean') settings.emailReminders = raw.emailReminders;
  }
  return settings;
}

const invalid = (what) => new StoreError('invalid', `Los datos de la ${what} no son válidos.`);

/* ---------------------------------------------------------------------------
 * LocalStore · datos en este navegador
 * ------------------------------------------------------------------------- */

export class LocalStore {
  constructor() {
    this.kind = 'local';
  }

  async getCards() {
    return normalizeCards(readJSON(KEYS.cards, []));
  }

  async addCard(data) {
    const card = sanitizeCard({ ...data, id: uid() });
    if (!card) throw invalid('tarjeta');
    writeJSON(KEYS.cards, [...(await this.getCards()), card]);
    return card;
  }

  async updateCard(id, data) {
    const cards = await this.getCards();
    const index = cards.findIndex((c) => c.id === id);
    if (index < 0) throw new StoreError('not_found', 'La tarjeta ya no existe.');
    const card = sanitizeCard({ ...cards[index], ...data, id });
    if (!card) throw invalid('tarjeta');
    cards[index] = card;
    writeJSON(KEYS.cards, cards);
    return card;
  }

  async deleteCard(id) {
    writeJSON(KEYS.cards, (await this.getCards()).filter((c) => c.id !== id));
    // Igual que en la base de datos: al borrar la tarjeta se borran sus compras.
    writeJSON(KEYS.purchases, (await this.getPurchases()).filter((p) => p.cardId !== id));
  }

  async replaceCards(list) {
    const cards = normalizeCards(list);
    writeJSON(KEYS.cards, cards);
    const ids = new Set(cards.map((c) => c.id));
    writeJSON(KEYS.purchases, (await this.getPurchases()).filter((p) => ids.has(p.cardId)));
    return cards;
  }

  async getPurchases() {
    const list = readJSON(KEYS.purchases, []);
    return Array.isArray(list) ? list.map(sanitizePurchase).filter(Boolean) : [];
  }

  async addPurchase(data) {
    const purchase = sanitizePurchase({ ...data, id: uid() });
    if (!purchase) throw invalid('compra');
    writeJSON(KEYS.purchases, [...(await this.getPurchases()), purchase]);
    return purchase;
  }

  async deletePurchase(id) {
    writeJSON(KEYS.purchases, (await this.getPurchases()).filter((p) => p.id !== id));
  }

  async getSettings() {
    return sanitizeSettings(readJSON(KEYS.settings, null));
  }

  async saveSettings(settings) {
    const clean = sanitizeSettings(settings);
    writeJSON(KEYS.settings, clean);
    return clean;
  }

  async getSubscription() {
    return null; // Sin servidor no hay suscripción real.
  }
}

/* ---------------------------------------------------------------------------
 * RemoteStore · base de datos de Supabase
 * ------------------------------------------------------------------------- */

const CARD_COLUMNS = 'id,name,closing_day,payment_day,color,position,created_at';
const PURCHASE_COLUMNS = 'id,card_id,description,amount,currency,purchase_date,installments,created_at';

const fromCardRow = (r) => ({ id: r.id, name: r.name, closingDay: r.closing_day, paymentDay: r.payment_day, color: r.color });
const toCardRow = (c) => ({ name: c.name, closing_day: c.closingDay, payment_day: c.paymentDay, color: String(c.color).toLowerCase() });

const fromPurchaseRow = (r) => ({
  id: r.id,
  cardId: r.card_id,
  description: r.description,
  amount: Number(r.amount),
  currency: r.currency,
  date: r.purchase_date,
  installments: r.installments,
});
const toPurchaseRow = (p) => ({
  card_id: p.cardId,
  description: p.description,
  amount: p.amount,
  currency: p.currency,
  purchase_date: p.date,
  installments: p.installments,
});

/** Traduce los errores de Supabase/PostgreSQL a errores que la interfaz entiende. */
export function toStoreError(error) {
  const text = `${error?.message || ''} ${error?.hint || ''}`;
  if (text.includes('FREE_CARD_LIMIT')) {
    return new StoreError('limit', `El plan gratis permite hasta ${FREE_CARD_LIMIT} tarjetas.`);
  }
  if (error?.code === '23505') return new StoreError('duplicate', 'Ya tienes una tarjeta con ese nombre.');
  if (error?.code === '42501') {
    // RLS rechazó la fila (p. ej. compras sin Premium) o faltan permisos en la tabla.
    return /row-level security/i.test(error.message || '')
      ? new StoreError('premium', 'Esta función es parte del plan Premium.')
      : new StoreError('config', 'El servidor no tiene los permisos configurados. Vuelve a ejecutar supabase/schema.sql.');
  }
  if (error?.code === '23514' || error?.code === '22P02') return new StoreError('invalid', 'Algún dato no es válido.');
  return new StoreError('network', error?.message ? `Error del servidor: ${error.message}` : 'No se pudo conectar con el servidor.');
}

export class RemoteStore {
  constructor(client, userId) {
    this.kind = 'remote';
    this.client = client;
    this.userId = userId;
  }

  async run(query) {
    const { data, error } = await query;
    if (error) throw toStoreError(error);
    return data;
  }

  async getCards() {
    const rows = await this.run(this.client.from('cards').select(CARD_COLUMNS).order('position').order('created_at'));
    return rows.map(fromCardRow);
  }

  async addCard(data) {
    const last = await this.run(
      this.client.from('cards').select('position').order('position', { ascending: false }).limit(1),
    );
    const position = last.length ? last[0].position + 1 : 0;
    const row = await this.run(
      this.client.from('cards').insert({ ...toCardRow(data), user_id: this.userId, position }).select(CARD_COLUMNS).single(),
    );
    return fromCardRow(row);
  }

  async updateCard(id, data) {
    const row = await this.run(
      this.client.from('cards').update(toCardRow(data)).eq('id', id).select(CARD_COLUMNS).single(),
    );
    return fromCardRow(row);
  }

  async deleteCard(id) {
    await this.run(this.client.from('cards').delete().eq('id', id)); // las compras se borran en cascada
  }

  async replaceCards(list) {
    await this.run(this.client.from('cards').delete().eq('user_id', this.userId));
    if (!list.length) return [];
    const rows = list.map((c, position) => ({ ...toCardRow(c), user_id: this.userId, position }));
    const inserted = await this.run(this.client.from('cards').insert(rows).select(CARD_COLUMNS));
    return inserted.map(fromCardRow);
  }

  async getPurchases() {
    const rows = await this.run(
      this.client.from('purchases').select(PURCHASE_COLUMNS).order('purchase_date', { ascending: false }).order('created_at', { ascending: false }),
    );
    return rows.map(fromPurchaseRow);
  }

  async addPurchase(data) {
    const row = await this.run(
      this.client.from('purchases').insert({ ...toPurchaseRow(data), user_id: this.userId }).select(PURCHASE_COLUMNS).single(),
    );
    return fromPurchaseRow(row);
  }

  async deletePurchase(id) {
    await this.run(this.client.from('purchases').delete().eq('id', id));
  }

  async getSettings() {
    const row = await this.run(
      this.client.from('reminder_settings').select('days_before,notify_closing,email_enabled').maybeSingle(),
    );
    if (!row) return { ...DEFAULT_SETTINGS };
    return sanitizeSettings({ daysBefore: row.days_before, notifyClosing: row.notify_closing, emailReminders: row.email_enabled });
  }

  async saveSettings(settings) {
    const clean = sanitizeSettings(settings);
    await this.run(
      this.client.from('reminder_settings').upsert(
        {
          user_id: this.userId,
          days_before: clean.daysBefore,
          notify_closing: clean.notifyClosing,
          email_enabled: clean.emailReminders,
          updated_at: new Date().toISOString(),
        },
        { onConflict: 'user_id' },
      ),
    );
    return clean;
  }

  async getSubscription() {
    const row = await this.run(
      this.client.from('subscriptions').select('status,plan_interval,current_period_end,provider').maybeSingle(),
    );
    if (!row) return null;
    return { status: row.status, interval: row.plan_interval, currentPeriodEnd: row.current_period_end, provider: row.provider };
  }
}
