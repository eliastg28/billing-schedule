/**
 * =============================================================================
 *  CUÁLTOCA · js/inputs.js
 * -----------------------------------------------------------------------------
 *  Campos numéricos que solo aceptan valores posibles mientras se escribe:
 *    - Días del mes: solo dígitos y como máximo 31 (no deja escribir 66 ni -3).
 *    - Montos: solo positivos, con punto decimal y hasta 2 decimales. La coma se
 *      ignora porque en Perú es el separador de miles (1,500.50 = mil quinientos).
 *  Las funciones sanitize* son puras (se prueban en tests/inputs.test.mjs).
 *  El mínimo (ej. 0 no es un día válido) se valida al salir del campo y al guardar.
 * =============================================================================
 */

/** Deja solo dígitos, recorta a `maxLength` y quita cifras finales hasta no pasar de `max`. */
export function sanitizeInteger(text, { max, maxLength = String(max).length }) {
  let clean = String(text ?? '').replace(/\D/g, '').slice(0, maxLength);
  while (clean && Number(clean) > max) clean = clean.slice(0, -1);
  return clean;
}

/** Monto positivo: dígitos, un solo punto decimal y hasta `decimals` decimales. Las comas (miles) se ignoran. */
export function sanitizeDecimal(text, { max, decimals = 2 }) {
  let clean = String(text ?? '').replace(/[^\d.]/g, '');
  const dot = clean.indexOf('.');
  if (dot >= 0) {
    clean = clean.slice(0, dot + 1) + clean.slice(dot + 1).replace(/\./g, '').slice(0, decimals);
  }
  while (clean && Number(clean) > max) clean = clean.slice(0, -1);
  return clean;
}

/**
 * Protege un <input> con una función de limpieza:
 *  - Antes de escribir, bloquea la tecla si el resultado no sería válido.
 *  - Después de escribir (pegar, autocompletar, teclados móviles), limpia el valor.
 * @param replacements  caracteres que se convierten al escribir, ej. { ',': '.' }
 */
export function guardInput(input, sanitize, replacements = {}) {
  if (!input) return;

  input.addEventListener('beforeinput', (event) => {
    if (event.data == null || !event.inputType.startsWith('insert')) return; // borrar siempre se permite
    const data = [...event.data].map((ch) => replacements[ch] ?? ch).join('');
    const { value } = input;
    const start = input.selectionStart ?? value.length;
    const end = input.selectionEnd ?? value.length;
    const next = value.slice(0, start) + data + value.slice(end);

    if (sanitize(next) !== next) {
      event.preventDefault(); // valor imposible: la tecla no hace nada
      return;
    }
    if (data !== event.data) {
      // Ej. coma → punto: se inserta el carácter convertido.
      event.preventDefault();
      input.setRangeText(data, start, end, 'end');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
  });

  // Red de seguridad: si algo se coló (pegar, autocompletar), se limpia.
  input.addEventListener('input', () => {
    const clean = sanitize(input.value);
    if (clean !== input.value) input.value = clean;
  });
}
