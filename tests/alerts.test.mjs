// Avisos de pago y cierre (función Premium).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeAlerts, alertMessage, fromISO } from '../js/engine.js';

const BCP = { id: 'bcp', name: 'BCP', closingDay: 26, paymentDay: 20, color: '#ff7a00' };
const INTERBANK = { id: 'ibk', name: 'Interbank', closingDay: 24, paymentDay: 20, color: '#1e88e5' };
const CARDS = [BCP, INTERBANK];
const keys = (iso, opts) => computeAlerts(CARDS, fromISO(iso), opts).map((a) => a.key);

test('aviso de pago dentro de la anticipación elegida', () => {
  // Pagos de BCP e Interbank el 20/10/2026.
  assert.deepEqual(keys('2026-10-16', { daysBefore: 3 }), []);
  assert.deepEqual(keys('2026-10-17', { daysBefore: 3 }), ['payment:bcp:2026-10-20', 'payment:ibk:2026-10-20']);
  assert.deepEqual(keys('2026-10-20', { daysBefore: 3 }), ['payment_today:bcp:2026-10-20', 'payment_today:ibk:2026-10-20']);
  assert.deepEqual(keys('2026-10-17', { daysBefore: 0 }), []);
});

test('aviso de cierre solo el día anterior y el mismo día', () => {
  assert.deepEqual(keys('2026-10-22', { daysBefore: 0, includeClosing: true }), []);
  assert.deepEqual(keys('2026-10-23', { daysBefore: 0, includeClosing: true }), ['closing:ibk:2026-10-24']);
  assert.deepEqual(keys('2026-10-24', { daysBefore: 0, includeClosing: true }), ['closing:ibk:2026-10-24']);
  assert.deepEqual(keys('2026-10-24', { daysBefore: 0, includeClosing: false }), []);
});

test('textos de los avisos', () => {
  const [inThreeDays] = computeAlerts([BCP], fromISO('2026-10-17'), { daysBefore: 3 });
  assert.equal(alertMessage(inThreeDays).title, 'Pago de BCP en 3 días');
  assert.match(alertMessage(inThreeDays).body, /martes 20 de octubre/);

  const [today] = computeAlerts([BCP], fromISO('2026-10-20'), { daysBefore: 3 });
  assert.equal(alertMessage(today).title, 'Hoy vence el pago de BCP');

  // 20/12/2026 cae domingo: sugiere pagar el día hábil anterior.
  const [sunday] = computeAlerts([BCP], fromISO('2026-12-19'), { daysBefore: 3 });
  assert.match(alertMessage(sunday).body, /Cae domingo/);

  const closing = computeAlerts([INTERBANK], fromISO('2026-10-23'), { daysBefore: 0 })[0];
  assert.equal(alertMessage(closing).title, 'Interbank cierra su facturación mañana');
  assert.match(alertMessage(closing).body, /domingo 25 de octubre: tendrás 56 días/);
});
