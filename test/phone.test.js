// Unit tests for lib/phone.js's normalizePhone() — pure, no I/O. Added alongside the retroactive
// guest-appointment-linking feature (src/functions/auth/auth.js) once it became clear that matching
// phone numbers by raw string equality silently fails whenever the same real number is typed in a
// different shape at two different points in the app (booking form vs. sign-in form vs. admin search
// box) — see lib/phone.js's header comment for the full reasoning.
//
// Run with: node test/phone.test.js
'use strict';

const assert = require('assert');
const { normalizePhone } = require('../lib/phone');

async function run() {
  let passed = 0;
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
      console.log(`ok - ${name}`);
    } catch (err) {
      console.error(`FAIL - ${name}`);
      console.error(err);
      process.exitCode = 1;
    }
  };

  await test('a handful of realistic same-number variations all normalize to the same canonical form', () => {
    const variants = [
      '(267) 481-4058',
      '267-481-4058',
      '267.481.4058',
      '2674814058',
      ' 267 481 4058 ',
      '+12674814058',
      '1-267-481-4058',
      '1 (267) 481-4058',
    ];
    variants.forEach((v) => {
      assert.strictEqual(normalizePhone(v), '+12674814058', `expected "${v}" to normalize to +12674814058`);
    });
  });

  await test('bare 10 digits gets a US "+1" prefix', () => {
    assert.strictEqual(normalizePhone('2675550100'), '+12675550100');
  });

  await test('11 digits already starting with 1 gets a bare "+" prefix, not a second "+1"', () => {
    assert.strictEqual(normalizePhone('12675550100'), '+12675550100');
  });

  await test('already-E.164 input is idempotent', () => {
    assert.strictEqual(normalizePhone('+12675550100'), '+12675550100');
    assert.strictEqual(normalizePhone(normalizePhone('(267) 555-0100')), normalizePhone('(267) 555-0100'));
  });

  await test('an unrecognized digit count (too short) falls back to the bare digit string, no guessing', () => {
    assert.strictEqual(normalizePhone('12345'), '12345');
  });

  await test('an unrecognized digit count (too long, and not "1"-prefixed at 11) falls back to the bare digit string', () => {
    assert.strictEqual(normalizePhone('987654321012'), '987654321012');
  });

  await test('null/undefined/empty input normalizes to an empty string, never throws', () => {
    assert.strictEqual(normalizePhone(null), '');
    assert.strictEqual(normalizePhone(undefined), '');
    assert.strictEqual(normalizePhone(''), '');
    assert.strictEqual(normalizePhone('   '), '');
  });

  await test('non-digit garbage mixed with a valid 10-digit number is stripped correctly', () => {
    assert.strictEqual(normalizePhone('call me at (267) 481-4058 please!'), '+12674814058');
  });

  console.log(`\n${passed} test(s) passed.`);
  if (process.exitCode) {
    console.error('Some tests FAILED.');
  }
}

run();
