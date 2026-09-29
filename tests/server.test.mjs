// Piezas del servidor que se pueden probar sin Supabase ni Mercado Pago.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import {
  verifyWebhookSignature, mapPreapprovalStatus, buildPreapprovalBody,
  intervalFromPreapproval, periodEndFromPreapproval, premiumEndsAt,
  buildYapePaymentBody, passReference, parsePassReference, isApprovedPass, isYapeToken, yapeRejectionMessage,
} from '../supabase/functions/_shared/mercadopago.ts';

test('el motor del servidor es una copia exacta del de la app', async () => {
  const app = await readFile(new URL('../js/engine.js', import.meta.url), 'utf8');
  const server = await readFile(new URL('../supabase/functions/_shared/engine.js', import.meta.url), 'utf8');
  assert.equal(server, app, 'Ejecuta: cp js/engine.js supabase/functions/_shared/engine.js');
});

test('valida la firma de los webhooks de Mercado Pago', async () => {
  const secret = 'clave-secreta';
  const ts = '1759060000';
  const manifest = `id:abc123;request-id:req-1;ts:${ts};`;
  const v1 = createHmac('sha256', secret).update(manifest).digest('hex');
  const base = { secret, xRequestId: 'req-1', dataId: 'ABC123' }; // el id se firma en minúsculas

  assert.equal(await verifyWebhookSignature({ ...base, xSignature: `ts=${ts},v1=${v1}` }), true);
  assert.equal(await verifyWebhookSignature({ ...base, xSignature: `ts=${ts},v1=${'0'.repeat(64)}` }), false);
  assert.equal(await verifyWebhookSignature({ ...base, secret: 'otra', xSignature: `ts=${ts},v1=${v1}` }), false);
  assert.equal(await verifyWebhookSignature({ ...base, xSignature: null }), false);
});

test('estados, cuerpo del cobro y fin de periodo', () => {
  assert.equal(mapPreapprovalStatus('authorized'), 'active');
  assert.equal(mapPreapprovalStatus('cancelled'), 'cancelled');
  assert.equal(mapPreapprovalStatus('algo-raro'), 'inactive');

  const body = buildPreapprovalBody({ userId: 'u1', email: 'a@b.pe', interval: 'yearly', backUrl: 'https://app.pe/?checkout=1#cuenta' });
  assert.deepEqual(body.auto_recurring, { frequency: 12, frequency_type: 'months', transaction_amount: 59, currency_id: 'PEN' });
  assert.equal(body.external_reference, 'u1');
  assert.equal(intervalFromPreapproval(body), 'yearly');

  const now = new Date('2026-09-28T00:00:00Z');
  assert.equal(periodEndFromPreapproval({ next_payment_date: '2026-10-28T10:00:00.000-04:00' }, now), '2026-10-28T14:00:00.000Z');
  assert.equal(periodEndFromPreapproval({ next_payment_date: '2026-09-01T00:00:00Z' }, now), null);
  assert.equal(periodEndFromPreapproval({}, now), null);
});

test('suscripción durante la prueba o un pase: el primer cobro llega cuando termina', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  // Prueba o pase vigente → se difiere el primer cobro.
  assert.equal(premiumEndsAt({ status: 'inactive', access_until: '2026-10-29T12:00:00Z' }, now), '2026-10-29T12:00:00.000Z');
  // Cancelada con días pagados y un pase: la fecha más lejana.
  assert.equal(
    premiumEndsAt({ status: 'cancelled', current_period_end: '2026-11-15T00:00:00Z', access_until: '2026-10-29T12:00:00Z' }, now),
    '2026-11-15T00:00:00.000Z',
  );
  // Con menos de 1 día restante, o sin Premium, el cobro es inmediato.
  assert.equal(premiumEndsAt({ status: 'inactive', access_until: '2026-09-29T20:00:00Z' }, now), null);
  assert.equal(premiumEndsAt({ status: 'pending', current_period_end: '2026-11-15T00:00:00Z' }, now), null);
  assert.equal(premiumEndsAt(null, now), null);

  const deferred = buildPreapprovalBody({ userId: 'u1', email: 'a@b.pe', interval: 'monthly', backUrl: 'https://app.pe', startDate: '2026-10-29T12:00:00.000Z' });
  assert.equal(deferred.auto_recurring.start_date, '2026-10-29T12:00:00.000Z');
  const now2 = buildPreapprovalBody({ userId: 'u1', email: 'a@b.pe', interval: 'monthly', backUrl: 'https://app.pe', startDate: null });
  assert.equal('start_date' in now2.auto_recurring, false);
});

test('pase con Yape: cuerpo del cobro, referencia y validación', () => {
  const userId = '0f8fad5b-d9cb-469f-a165-70867728950e';
  const body = buildYapePaymentBody({ userId, email: 'a@b.pe', interval: 'yearly', token: 'tok_123456789' });
  assert.deepEqual(body, {
    token: 'tok_123456789',
    transaction_amount: 59,
    description: 'CuálToca Premium · 12 meses',
    installments: 1,
    payment_method_id: 'yape',
    payer: { email: 'a@b.pe' },
    external_reference: `pass:yearly:${userId}`,
  });

  assert.deepEqual(parsePassReference(passReference(userId, 'monthly')), { interval: 'monthly', userId });
  assert.equal(parsePassReference(userId), null); // cobros de la suscripción: no son pases
  assert.equal(parsePassReference('pass:weekly:' + userId), null);
  assert.equal(parsePassReference(undefined), null);

  assert.equal(isApprovedPass({ status: 'approved', currency_id: 'PEN', transaction_amount: 7.9 }, 'monthly'), true);
  assert.equal(isApprovedPass({ status: 'approved', currency_id: 'PEN', transaction_amount: 7.9 }, 'yearly'), false);
  assert.equal(isApprovedPass({ status: 'rejected', currency_id: 'PEN', transaction_amount: 7.9 }, 'monthly'), false);
  assert.equal(isApprovedPass({ status: 'approved', currency_id: 'USD', transaction_amount: 7.9 }, 'monthly'), false);

  assert.equal(isYapeToken('ff8080814c11e237014c1ff593b57b4d'), true);
  assert.equal(isYapeToken(''), false);
  assert.equal(isYapeToken('a b'), false);
  assert.equal(isYapeToken(123), false);

  assert.match(yapeRejectionMessage('cc_rejected_insufficient_amount'), /saldo/);
  assert.match(yapeRejectionMessage('cc_rejected_bad_filled_security_code'), /código/);
  assert.match(yapeRejectionMessage('algo_nuevo'), /Yape rechazó/);
});
