// Motor de ciclos: fechas de cierre, pago, ranking y eventos.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getCycleInfo, rankCards, getEventsInRange, nextCycleStart, paysSameMonth,
  bestDayOfMonth, toISO, fromISO, fmtShort, todayInTimeZone,
} from '../js/engine.js';

const FALABELLA = { id: 'fal', name: 'Falabella', closingDay: 9, paymentDay: 5, color: '#9ccc3c' };
const BCP = { id: 'bcp', name: 'BCP', closingDay: 26, paymentDay: 20, color: '#ff7a00' };
const INTERBANK = { id: 'ibk', name: 'Interbank', closingDay: 24, paymentDay: 20, color: '#1e88e5' };
const CARDS = [FALABELLA, BCP, INTERBANK];

const d = (iso) => fromISO(iso);
const cycle = (card, iso) => {
  const i = getCycleInfo(card, d(iso));
  return [toISO(i.cycleStart), toISO(i.closing), toISO(i.payment), i.financingDays];
};

test('coincide con los estados de cuenta oficiales (cierre y pago)', () => {
  // BCP: cierre 26/07/26, pago 20/08/26 · Falabella: 10/08 al 09/09, pago 05/10 · Interbank: cierre 24/07, pago 20/08
  assert.deepEqual(cycle(BCP, '2026-07-10').slice(1, 3), ['2026-07-26', '2026-08-20']);
  assert.deepEqual(cycle(FALABELLA, '2026-08-20').slice(0, 3), ['2026-08-10', '2026-09-09', '2026-10-05']);
  assert.deepEqual(cycle(INTERBANK, '2026-07-10').slice(1, 3), ['2026-07-24', '2026-08-20']);
});

test('ejemplo del enunciado: cierre 26/09, compra 27/09, pago 20/11', () => {
  assert.deepEqual(cycle(BCP, '2026-09-27'), ['2026-09-27', '2026-10-26', '2026-11-20', 54]);
  assert.deepEqual(cycle(BCP, '2026-09-26'), ['2026-08-27', '2026-09-26', '2026-10-20', 24]);
});

test('saltos de año', () => {
  assert.deepEqual(cycle(BCP, '2026-12-27'), ['2026-12-27', '2027-01-26', '2027-02-20', 55]);
  assert.deepEqual(cycle(FALABELLA, '2026-12-15'), ['2026-12-10', '2027-01-09', '2027-02-05', 52]);
});

test('días 29-31 en meses cortos y años bisiestos', () => {
  const c31 = { id: 'x', name: 'C31', closingDay: 31, paymentDay: 25, color: '#ffffff' };
  assert.deepEqual(cycle(c31, '2027-02-10'), ['2027-02-01', '2027-02-28', '2027-03-25', 43]);
  assert.deepEqual(cycle(c31, '2027-03-01'), ['2027-03-01', '2027-03-31', '2027-04-25', 55]);
  assert.deepEqual(cycle(c31, '2028-02-29'), ['2028-02-01', '2028-02-29', '2028-03-25', 25]);
  const c30 = { id: 'y', name: 'C30', closingDay: 30, paymentDay: 30, color: '#ffffff' };
  assert.deepEqual(cycle(c30, '2027-01-31'), ['2027-01-31', '2027-02-28', '2027-03-30', 58]);
});

test('pago en el mismo mes del cierre cuando el día de pago es posterior', () => {
  const early = { id: 'z', name: 'Early', closingDay: 5, paymentDay: 25, color: '#ffffff' };
  assert.deepEqual(cycle(early, '2026-09-06'), ['2026-09-06', '2026-10-05', '2026-10-25', 49]);
  assert.equal(paysSameMonth(early), true);
  assert.equal(paysSameMonth(BCP), false);
  assert.equal(bestDayOfMonth(BCP), 27);
  assert.equal(bestDayOfMonth({ closingDay: 31 }), 1);
});

test('ranking por días de crédito (empate: la que cierra más tarde)', () => {
  const rank = (iso) => rankCards(CARDS, d(iso)).map((r) => `${r.card.name}:${r.info.financingDays}`);
  assert.deepEqual(rank('2026-09-26'), ['Interbank:55', 'Falabella:40', 'BCP:24']);
  assert.deepEqual(rank('2026-09-27'), ['BCP:54', 'Interbank:54', 'Falabella:39']);
  assert.deepEqual(rank('2026-10-10'), ['Falabella:56', 'BCP:41', 'Interbank:41']);
});

test('eventos del mes y siguiente inicio de ciclo', () => {
  const events = getEventsInRange(CARDS, d('2026-09-01'), d('2026-09-30')).map((e) => `${fmtShort(e.date)} ${e.type} ${e.card.name}`);
  assert.deepEqual(events, [
    '05/09 payment Falabella', '09/09 closing Falabella', '10/09 start Falabella',
    '20/09 payment BCP', '20/09 payment Interbank', '24/09 closing Interbank',
    '25/09 start Interbank', '26/09 closing BCP', '27/09 start BCP',
  ]);
  const next = nextCycleStart(CARDS, d('2026-09-26'));
  assert.equal(toISO(next.date), '2026-09-27');
  assert.equal(next.card.name, 'BCP');
});

test('invariantes para todas las combinaciones de días durante 3 años', () => {
  let broken = 0;
  for (let closingDay = 1; closingDay <= 31; closingDay++) {
    for (let paymentDay = 1; paymentDay <= 31; paymentDay++) {
      const card = { closingDay, paymentDay };
      for (let t = new Date(2026, 0, 1); t < new Date(2029, 0, 1); t.setDate(t.getDate() + 1)) {
        const i = getCycleInfo(card, t);
        const ok = i.daysSinceStart >= 0 && i.daysToClosing >= 0 &&
          i.cycleLength >= 28 && i.cycleLength <= 31 &&
          i.payment > i.closing && i.financingDays > 0 && i.financingDays <= 62;
        if (!ok) broken++;
      }
    }
  }
  assert.equal(broken, 0);
});

test('fromISO rechaza fechas inválidas y todayInTimeZone usa la zona de Lima', () => {
  assert.equal(fromISO('2026-02-30'), null);
  assert.equal(fromISO('hola'), null);
  // 2026-09-29 03:00 UTC todavía es 28 de septiembre en Lima (UTC-5).
  assert.equal(toISO(todayInTimeZone('America/Lima', new Date(Date.UTC(2026, 8, 29, 3, 0)))), '2026-09-28');
});
