const test = require('node:test');
const assert = require('node:assert/strict');
const { sourceLanguageFor, splitText } = require('../src/translation');

test('uses Brazilian Portuguese for Brazil and Portuguese tickets', () => {
  assert.equal(sourceLanguageFor({ country_code: 'BR', communication_language: 'Português' }), 'pt-BR');
  assert.equal(sourceLanguageFor({ country_code: 'UY', communication_language: 'Português' }), 'pt-BR');
});

test('uses Spanish for Spanish-language LATAM tickets', () => {
  assert.equal(sourceLanguageFor({ country_code: 'MX', communication_language: 'Español' }), 'es');
});

test('splits translation input without exceeding the configured limit', () => {
  const chunks = splitText('Primera oración. Segunda oración. Tercera oración.', 20);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every(chunk => chunk.length <= 20));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), 'Primera oración. Segunda oración. Tercera oración.');
});
