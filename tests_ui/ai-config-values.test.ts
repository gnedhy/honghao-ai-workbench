import test from 'node:test';
import assert from 'node:assert/strict';
import {aiAmountError, queueElapsed} from '../src/components/aiConfigValues.ts';

test('AI amount validation preserves decimal strings and enforces server bounds', () => {
  assert.equal(aiAmountError('', 1e9, true), '');
  assert.ok(aiAmountError('', 1e4, false));
  assert.equal(aiAmountError('25.123456789012', 1e9, true), '');
  assert.ok(aiAmountError('25.1234567890123', 1e9, true));
  assert.equal(aiAmountError('1e-12', 1e4, false), '');
  assert.equal(aiAmountError('.5', 1e4, false), '');
  assert.ok(aiAmountError('1e-13', 1e4, false));
  assert.ok(aiAmountError('10001', 1e4, false));
  assert.ok(aiAmountError('1000000001', 1e9, true));
  assert.ok(aiAmountError('-1', 1e9, true));
  assert.ok(aiAmountError('Infinity', 1e9, true));
});

test('queue elapsed uses the snapshot time and handles missing or future dates', () => {
  const readAt = Date.parse('2026-10-14T04:10:00Z');
  assert.equal(queueElapsed('2026-10-14T04:08:55Z', readAt), '1 分 5 秒');
  assert.equal(queueElapsed('2026-10-14T04:10:01Z', readAt), '0 秒');
  assert.equal(queueElapsed(null, readAt), '—');
  assert.equal(queueElapsed('invalid', readAt), '—');
});
