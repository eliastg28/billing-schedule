// Almacenamiento local (sin cuenta) y validación de datos.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { LocalStore, sanitizeCard, sanitizePurchase, sanitizeSettings, toStoreError, KEYS } from '../js/store.js';

// LocalStorage en memoria para Node.
const memory = new Map();
globalThis.localStorage = {
  getItem: (k) => (memory.has(k) ? memory.get(k) : null),
  setItem: (k, v) => memory.set(k, String(v)),
  removeItem: (k) => memory.delete(k),
};

beforeEach(() => memory.clear());

test('valida tarjetas, compras y preferencias', () => {
  assert.equal(sanitizeCard({ name: '', closingDay: 1, paymentDay: 2 }), null);
  assert.equal(sanitizeCard({ name: 'X', closingDay: 32, paymentDay: 2 }), null);
  assert.equal(sanitizeCard({ name: 'X', closingDay: 1, paymentDay: 2, color: 'red' }).color, '#8b9bff');
  assert.equal(sanitizeCard({ name: '  BCP  ', closingDay: '26', paymentDay: 20, color: '#FF7A00' }).name, 'BCP');

  const ok = { cardId: 'bcp', description: 'Libro', amount: '50.555', currency: 'PEN', date: '2026-09-28', installments: 1 };
  assert.equal(sanitizePurchase(ok).amount, 50.56);
  assert.equal(sanitizePurchase({ ...ok, amount: 0 }), null);
  assert.equal(sanitizePurchase({ ...ok, installments: 40 }), null);
  assert.equal(sanitizePurchase({ ...ok, date: '2026-02-30' }), null);
  assert.equal(sanitizePurchase({ ...ok, currency: 'EUR' }).currency, 'PEN');

  assert.deepEqual(sanitizeSettings({ daysBefore: 9, notifyClosing: false }), { daysBefore: 3, notifyClosing: false, emailReminders: true });
});

test('LocalStore: CRUD de tarjetas y borrado en cascada de compras', async () => {
  const store = new LocalStore();
  assert.deepEqual(await store.getCards(), []); // un usuario nuevo empieza sin tarjetas

  const bcp = await store.addCard({ name: 'BCP', closingDay: 26, paymentDay: 20, color: '#ff7a00' });
  const ibk = await store.addCard({ name: 'Interbank', closingDay: 24, paymentDay: 20, color: '#1e88e5' });
  await store.updateCard(bcp.id, { name: 'BCP Visa', closingDay: 26, paymentDay: 20, color: '#ff7a00' });
  assert.deepEqual((await store.getCards()).map((c) => c.name), ['BCP Visa', 'Interbank']);

  await store.addPurchase({ cardId: bcp.id, description: 'Libro', amount: 50, currency: 'PEN', date: '2026-09-28', installments: 1 });
  await store.addPurchase({ cardId: ibk.id, description: 'Cena', amount: 80, currency: 'PEN', date: '2026-09-28', installments: 1 });
  await store.deleteCard(bcp.id);
  assert.deepEqual((await store.getPurchases()).map((p) => p.description), ['Cena']);

  await store.replaceCards([{ name: 'Falabella', closingDay: 9, paymentDay: 5, color: '#9ccc3c' }]);
  assert.deepEqual((await store.getCards()).map((c) => c.name), ['Falabella']);
  assert.deepEqual(await store.getPurchases(), []); // la compra de Interbank se fue con su tarjeta
});

test('LocalStore: preferencias y datos corruptos', async () => {
  const store = new LocalStore();
  assert.deepEqual(await store.saveSettings({ daysBefore: 5 }), { daysBefore: 5, notifyClosing: true, emailReminders: true });
  memory.set(KEYS.cards, '{no es json');
  assert.deepEqual(await store.getCards(), []);
});

test('traduce errores de Supabase a mensajes de la app', () => {
  assert.equal(toStoreError({ code: 'P0001', message: 'FREE_CARD_LIMIT' }).code, 'limit');
  assert.equal(toStoreError({ code: '23505', message: 'duplicate key' }).code, 'duplicate');
  assert.equal(toStoreError({ code: '42501', message: 'new row violates row-level security policy' }).code, 'premium');
  assert.equal(toStoreError({ message: 'Failed to fetch' }).code, 'network');
});
