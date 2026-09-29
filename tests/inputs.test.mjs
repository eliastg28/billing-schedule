// Campos numéricos: solo aceptan valores posibles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeInteger, sanitizeDecimal } from '../js/inputs.js';

const day = (text) => sanitizeInteger(text, { max: 31, maxLength: 2 });
const installments = (text) => sanitizeInteger(text, { max: 36, maxLength: 2 });
const amount = (text) => sanitizeDecimal(text, { max: 1000000, decimals: 2 });

test('días del mes: del 1 al 31, sin letras, signos ni decimales', () => {
  assert.equal(day('26'), '26');
  assert.equal(day('31'), '31');
  assert.equal(day('66'), '6'); // el segundo 6 no se acepta
  assert.equal(day('32'), '3');
  assert.equal(day('-5'), '5');
  assert.equal(day('9.5'), '9'); // "9.5" → "95" → 95 > 31 → "9"
  assert.equal(day('1e2'), '12');
  assert.equal(day('abc'), '');
  assert.equal(day('123'), '12');
  assert.equal(day('09'), '09'); // se acepta el cero inicial mientras se escribe
});

test('cuotas: del 1 al 36', () => {
  assert.equal(installments('12'), '12');
  assert.equal(installments('36'), '36');
  assert.equal(installments('37'), '3');
  assert.equal(installments('99'), '9');
});

test('montos: positivos, un punto decimal y máximo 2 decimales', () => {
  assert.equal(amount('1500'), '1500');
  assert.equal(amount('1500.5'), '1500.5');
  assert.equal(amount('1500.567'), '1500.56');
  assert.equal(amount('1,500.55'), '1500.55'); // la coma de miles se ignora
  assert.equal(amount('12,50'), '1250');
  assert.equal(amount('-30'), '30');
  assert.equal(amount('1.2.3'), '1.23');
  assert.equal(amount('2e5'), '25');
  assert.equal(amount('2000000'), '200000'); // supera el máximo
});
