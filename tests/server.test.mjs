// Piezas del servidor que se pueden probar sin Supabase ni Mercado Pago.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import {
  verifyWebhookSignature, mapPreapprovalStatus, buildPreapprovalBody,
  intervalFromPreapproval, periodEndFromPreapproval,
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
