// Planes, límites y precios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PLANS, PRICING, FREE_CARD_LIMIT, isSubscriptionActive, partitionCards, canAddCard, yearlySavingsPercent } from '../js/plan.js';
import { PRICES } from '../supabase/functions/_shared/mercadopago.ts';

const now = new Date('2026-09-28T12:00:00Z');

test('estado de la suscripción → Premium (misma regla que la función SQL)', () => {
  assert.equal(isSubscriptionActive(null, now), false);
  assert.equal(isSubscriptionActive({ status: 'active' }, now), true);
  assert.equal(isSubscriptionActive({ status: 'pending' }, now), false);
  assert.equal(isSubscriptionActive({ status: 'paused' }, now), false);
  assert.equal(isSubscriptionActive({ status: 'cancelled', currentPeriodEnd: '2026-10-15T00:00:00Z' }, now), true);
  assert.equal(isSubscriptionActive({ status: 'cancelled', currentPeriodEnd: '2026-09-01T00:00:00Z' }, now), false);
  assert.equal(isSubscriptionActive({ status: 'cancelled', currentPeriodEnd: null }, now), false);
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
});
