import assert from 'node:assert/strict';
import test from 'node:test';
import { detectEmaCrosses, getEmaAlignment, isCandleClosed, type EmaSignalPoint } from '../src/emaSignals.ts';

const point = (date: string, fast: number | null, slow: number | null, closed = true): EmaSignalPoint => ({
  date,
  fast,
  slow,
  closed,
});

test('detects a golden cross only when the prior EMA values are at or below and current fast is above', () => {
  const signals = detectEmaCrosses([
    point('2026-01-01', 10, 10),
    point('2026-01-02', 11, 10),
  ]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, 'golden');
  assert.equal(signals[0].date, '2026-01-02');
});

test('detects a death cross only when the prior EMA values are at or above and current fast is below', () => {
  const signals = detectEmaCrosses([
    point('2026-01-01', 10, 10),
    point('2026-01-02', 9, 10),
  ]);
  assert.equal(signals.length, 1);
  assert.equal(signals[0].kind, 'death');
});

test('does not report an event for persistent above/below alignment', () => {
  assert.deepEqual(detectEmaCrosses([point('1', 11, 10), point('2', 12, 10)]), []);
  assert.deepEqual(detectEmaCrosses([point('1', 9, 10), point('2', 8, 10)]), []);
});

test('accepts equality only on the previous bar, not on the confirming bar', () => {
  assert.equal(detectEmaCrosses([point('1', 10, 10), point('2', 11, 10)])[0]?.kind, 'golden');
  assert.deepEqual(detectEmaCrosses([point('1', 9, 10), point('2', 10, 10)]), []);
});

test('skips incomplete and invalid EMA pairs without bridging a missing bar', () => {
  assert.deepEqual(detectEmaCrosses([point('1', null, 10), point('2', 11, 10)]), []);
  assert.deepEqual(detectEmaCrosses([point('1', Number.NaN, 10), point('2', 11, 10)]), []);
  assert.deepEqual(
    detectEmaCrosses([point('1', 10, 10), point('2', null, 10), point('3', 11, 10)]),
    [],
  );
});

test('does not confirm a cross on an unclosed bar', () => {
  assert.deepEqual(detectEmaCrosses([point('1', 10, 10), point('2', 11, 10, false)]), []);
  assert.equal(getEmaAlignment([point('1', 10, 11), point('2', 11, 10, false)]).state, 'below');
});

test('reports latest alignment independently of whether a cross just occurred', () => {
  assert.equal(getEmaAlignment([point('1', 11, 10), point('2', 12, 10)]).state, 'above');
  assert.equal(getEmaAlignment([point('1', 9, 10), point('2', 8, 10)]).state, 'below');
  assert.equal(getEmaAlignment([point('1', 10, 10)]).state, 'equal');
  assert.equal(getEmaAlignment([point('1', null, 10)]).state, 'insufficient');
});

test('treats the current daily/weekly candle as unclosed until the relevant session ends', () => {
  assert.equal(isCandleClosed('2026-10-15', '1day', new Date('2026-10-15T19:59:00Z')), false);
  assert.equal(isCandleClosed('2026-10-15', '1day', new Date('2026-10-15T20:01:00Z')), true);
  assert.equal(isCandleClosed('2026-10-12', '1week', new Date('2026-10-16T19:59:00Z')), false);
  assert.equal(isCandleClosed('2026-10-12', '1week', new Date('2026-10-16T20:01:00Z')), true);
  assert.equal(isCandleClosed('2026-10-12', '1week', new Date('2026-10-17T12:00:00Z')), true);
});
