import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateMacd, calculateRsi, detectMacdCrosses } from '../src/indicators.ts';

test('RSI requires 15 closing prices at period 14 and remains missing before then', () => {
  assert.deepEqual(calculateRsi(Array.from({ length: 14 }, (_, index) => index + 1)), Array(14).fill(null));
  const rsi = calculateRsi(Array.from({ length: 15 }, (_, index) => index + 1));
  assert.equal(rsi[13], null);
  assert.equal(rsi[14], 100);
});

test('RSI handles continuous gains, losses, and unchanged prices', () => {
  assert.equal(calculateRsi(Array.from({ length: 15 }, (_, index) => index + 1))[14], 100);
  assert.equal(calculateRsi(Array.from({ length: 15 }, (_, index) => 15 - index))[14], 0);
  assert.equal(calculateRsi(Array(15).fill(20))[14], 50);
});

test('RSI uses Wilder smoothing after the initial average', () => {
  const rsi = calculateRsi([10, 11, 10, 12, 11, 13, 12], 3);
  const initialGain = (1 + 0 + 2) / 3;
  const initialLoss = (0 + 1 + 0) / 3;
  assert.equal(rsi[3], 100 - 100 / (1 + initialGain / initialLoss));
  const nextGain = (initialGain * 2 + 0) / 3;
  const nextLoss = (initialLoss * 2 + 1) / 3;
  assert.equal(rsi[4], 100 - 100 / (1 + nextGain / nextLoss));
});

test('MACD preserves dates and starts Signal after nine complete MACD values', () => {
  const data = Array.from({ length: 10 }, (_, index) => ({
    date: `2026-01-${String(index + 1).padStart(2, '0')}`,
    close: 100 + index,
  }));
  const macd = calculateMacd(data, 2, 3, 3);
  assert.deepEqual(macd.map((item) => item.date), data.map((item) => item.date));
  assert.equal(macd[0].macd, 0);
  assert.equal(macd[1].signal, null);
  assert.notEqual(macd[2].signal, null);
  assert.equal(macd[2].histogram, macd[2].macd! - macd[2].signal!);
});

test('MACD and Signal use first-value EMA seeding then standard EMA recursion', () => {
  const macd = calculateMacd([
    { date: '1', close: 10 },
    { date: '2', close: 12 },
    { date: '3', close: 11 },
  ], 2, 3, 2);
  const fastAtSecond = 12 * (2 / 3) + 10 * (1 / 3);
  const slowAtSecond = 12 * 0.5 + 10 * 0.5;
  assert.ok(Math.abs(macd[1].macd! - (fastAtSecond - slowAtSecond)) < 1e-12);
  assert.ok(Math.abs(macd[1].signal! - (macd[0].macd! + macd[1].macd!) / 2) < 1e-12);
  const expectedNextSignal = macd[2].macd! * (2 / 3) + macd[1].signal! * (1 / 3);
  assert.ok(Math.abs(macd[2].signal! - expectedNextSignal) < 1e-12);
});

test('MACD cross events require two complete closed bars and describe actual crossings only', () => {
  const point = (date: string, macd: number | null, signal: number | null, closed = true) => ({
    date,
    macd,
    signal,
    closed,
  });
  assert.equal(detectMacdCrosses([point('1', 0, 0), point('2', 1, 0)])[0].direction, 'up');
  assert.equal(detectMacdCrosses([point('1', 0, 0), point('2', -1, 0)])[0].direction, 'down');
  assert.deepEqual(detectMacdCrosses([point('1', 1, 0), point('2', 2, 0)]), []);
  assert.deepEqual(detectMacdCrosses([point('1', 0, 0), point('2', 1, 0, false)]), []);
  assert.deepEqual(detectMacdCrosses([point('1', null, 0), point('2', 1, 0)]), []);
});
