// Proyección de pagos y cuotas (función Premium).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitInstallments, purchaseSchedule, projectPayments, formatMoney, fromISO, toISO } from '../js/engine.js';

const BCP = { id: 'bcp', name: 'BCP', closingDay: 26, paymentDay: 20, color: '#ff7a00' };
const FALABELLA = { id: 'fal', name: 'Falabella', closingDay: 9, paymentDay: 5, color: '#9ccc3c' };

test('reparte el monto en cuotas sin perder céntimos', () => {
  assert.deepEqual(splitInstallments(100, 3), [3334, 3333, 3333]);
  assert.deepEqual(splitInstallments(0.1, 3), [4, 3, 3]);
  assert.equal(splitInstallments(1234.56, 7).reduce((a, b) => a + b, 0), 123456);
  assert.deepEqual(splitInstallments(50, 1), [5000]);
});

test('cada cuota cae en un estado de cuenta consecutivo (con salto de año)', () => {
  const schedule = purchaseSchedule(BCP, { amount: 300, installments: 3, date: '2026-11-30', currency: 'PEN' });
  assert.deepEqual(
    schedule.map((s) => [s.installment, toISO(s.closing), toISO(s.payment), s.cents]),
    [
      [1, '2026-12-26', '2027-01-20', 10000],
      [2, '2027-01-26', '2027-02-20', 10000],
      [3, '2027-02-26', '2027-03-20', 10000],
    ],
  );
});

test('agrupa por estado de cuenta, suma por moneda y omite lo ya vencido', () => {
  const purchases = [
    { id: 'p1', cardId: 'bcp', description: 'Laptop', amount: 3000, currency: 'PEN', date: '2026-09-27', installments: 3 },
    { id: 'p2', cardId: 'bcp', description: 'Libro', amount: 50.5, currency: 'PEN', date: '2026-10-01', installments: 1 },
    { id: 'p3', cardId: 'bcp', description: 'Curso', amount: 20, currency: 'USD', date: '2026-10-02', installments: 1 },
    { id: 'p4', cardId: 'fal', description: 'Zapatillas', amount: 250, currency: 'PEN', date: '2026-09-15', installments: 1 },
    { id: 'p5', cardId: 'bcp', description: 'Vieja', amount: 99, currency: 'PEN', date: '2026-08-01', installments: 1 }, // pagada el 20/08
    { id: 'p6', cardId: 'otra', description: 'Sin tarjeta', amount: 10, currency: 'PEN', date: '2026-09-28', installments: 1 },
  ];
  const statements = projectPayments([BCP, FALABELLA], purchases, fromISO('2026-09-28'));
  const summary = statements.map((s) => [s.card.name, toISO(s.payment), s.totals, s.items.length]);
  assert.deepEqual(summary, [
    ['Falabella', '2026-11-05', { PEN: 25000 }, 1],
    ['BCP', '2026-11-20', { PEN: 105050, USD: 2000 }, 3],
    ['BCP', '2026-12-20', { PEN: 100000 }, 1],
    ['BCP', '2027-01-20', { PEN: 100000 }, 1],
  ]);
});

test('formato de moneda peruano', () => {
  assert.equal(formatMoney(123456, 'PEN'), 'S/ 1,234.56');
  assert.equal(formatMoney(2000, 'USD'), 'US$ 20.00');
  assert.equal(formatMoney(0, 'PEN'), 'S/ 0.00');
});
