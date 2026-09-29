// Planes, límites y precios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PLANS, PRICING, FREE_CARD_LIMIT, PASS_LABELS, isSubscriptionActive, premiumStatus, canStartTrial,
  partitionCards, canAddCard, yearlySavingsPercent,
} from '../js/plan.js';
import { PRICES, PASS_LABELS as SERVER_PASS_LABELS } from '../supabase/functions/_shared/mercadopago.ts';

const now = new Date('2026-09-28T12:00:00Z');

test('estado de la suscripción → Premium (misma regla que la función SQL)', () => {
  assert.equal(isSubscriptionActive(null, now), false);
  assert.equal(isSubscriptionActive({ status: 'active' }, now), true);
  assert.equal(isSubscriptionActive({ status: 'pending' }, now), false);
  assert.equal(isSubscriptionActive({ status: 'paused' }, now), false);
  assert.equal(isSubscriptionActive({ status: 'cancelled', currentPeriodEnd: '2026-10-15T00:00:00Z' }, now), true);
  assert.equal(isSubscriptionActive({ status: 'cancelled', currentPeriodEnd: '2026-09-01T00:00:00Z' }, now), false);
  assert.equal(isSubscriptionActive({ status: 'cancelled', currentPeriodEnd: null }, now), false);
  // Prueba gratis o pase con Yape: Premium hasta accessUntil, sin importar el estado de la suscripción.
  assert.equal(isSubscriptionActive({ status: 'inactive', accessUntil: '2026-10-28T12:00:00Z' }, now), true);
  assert.equal(isSubscriptionActive({ status: 'pending', accessUntil: '2026-10-28T12:00:00Z' }, now), true);
  assert.equal(isSubscriptionActive({ status: 'inactive', accessUntil: '2026-09-27T12:00:00Z' }, now), false);
});

test('de dónde viene Premium: suscripción, prueba, pase o días pagados', () => {
  const trialEnd = '2026-10-28T12:00:00.000Z';
  assert.deepEqual(premiumStatus({ status: 'active', currentPeriodEnd: '2026-10-28T12:00:00Z' }, now),
    { kind: 'subscription', until: null, nextCharge: '2026-10-28T12:00:00Z' });
  assert.equal(premiumStatus({ status: 'inactive', accessUntil: trialEnd, trialEndsAt: trialEnd }, now).kind, 'trial');
  // Compró un pase durante la prueba: ya no es "prueba", es un pase hasta la nueva fecha.
  assert.deepEqual(premiumStatus({ status: 'inactive', accessUntil: '2026-11-28T12:00:00Z', trialEndsAt: trialEnd }, now),
    { kind: 'pass', until: '2026-11-28T12:00:00Z', nextCharge: null });
  assert.equal(premiumStatus({ status: 'inactive', accessUntil: '2026-11-28T12:00:00Z' }, now).kind, 'pass');
  // Cancelada con días pagados y un pase: se muestra la fecha más lejana.
  assert.equal(premiumStatus({ status: 'cancelled', currentPeriodEnd: '2026-10-10T00:00:00Z', accessUntil: '2026-11-10T00:00:00Z' }, now).until,
    '2026-11-10T00:00:00Z');
  assert.equal(premiumStatus({ status: 'cancelled', currentPeriodEnd: '2026-10-10T00:00:00Z' }, now).kind, 'cancelled');
  assert.equal(premiumStatus({ status: 'pending' }, now).kind, 'pending');
  assert.equal(premiumStatus({ status: 'inactive', accessUntil: '2026-09-01T00:00:00Z', trialEndsAt: '2026-09-01T00:00:00Z' }, now).kind, 'none');
  assert.equal(premiumStatus(null, now).kind, 'none');
});

test('la prueba gratis solo se ofrece a quien nunca tuvo Premium', () => {
  assert.equal(canStartTrial(null), true);
  assert.equal(canStartTrial({ status: 'inactive' }), true);
  assert.equal(canStartTrial({ status: 'pending' }), true); // abrió el checkout y no pagó
  assert.equal(canStartTrial({ status: 'inactive', trialEndsAt: '2026-09-01T00:00:00Z' }), false);
  assert.equal(canStartTrial({ status: 'inactive', accessUntil: '2026-09-01T00:00:00Z' }), false);
  assert.equal(canStartTrial({ status: 'active' }), false);
  assert.equal(canStartTrial({ status: 'cancelled' }), false);
  assert.equal(canStartTrial({ status: 'paused' }), false);
});

test('límite de tarjetas: Gratis usa 2, las demás quedan bloqueadas', () => {
  const cards = ['a', 'b', 'c'].map((id) => ({ id }));
  assert.equal(FREE_CARD_LIMIT, 2);
  assert.deepEqual(partitionCards(cards, 'free').active.map((c) => c.id), ['a', 'b']);
  assert.deepEqual(partitionCards(cards, 'free').locked.map((c) => c.id), ['c']);
  assert.equal(partitionCards(cards, 'premium').locked.length, 0);
  assert.equal(canAddCard(1, 'free'), true);
  assert.equal(canAddCard(2, 'free'), false);
  assert.equal(canAddCard(500, 'premium'), true);
  assert.equal(PLANS.free.alerts, false);
  assert.equal(PLANS.premium.alerts, true);
});

test('los precios de la app coinciden con los del cobro en Mercado Pago', () => {
  assert.equal(PRICES.monthly.amount, PRICING.monthly);
  assert.equal(PRICES.yearly.amount, PRICING.yearly);
  assert.equal(PRICES.yearly.frequency, 12);
  assert.equal(yearlySavingsPercent(), 38);
  assert.deepEqual({ ...PASS_LABELS }, SERVER_PASS_LABELS);
});
