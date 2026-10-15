import assert from 'node:assert/strict';
import test from 'node:test';
import { sumLatestFourQuarters, type SummaryQuarter } from '../src/fundamentalSummary.ts';

const quarter = (start: string, end: string, value: number | null): SummaryQuarter => ({
  periodStart: start,
  periodEnd: end,
  metrics: {
    dilutedEps: {
      value,
      unit: 'USD/share',
      period: `${start} to ${end}`,
      periodStart: start,
      periodEnd: end,
      reportedDate: end,
      source: 'https://sec.example/filing',
      checkedAt: '2026-10-15T00:00:00Z',
      basis: 'sec-companyfacts',
    },
  },
});

test('derives a TTM metric by summing four consecutive quarters', () => {
  const result = sumLatestFourQuarters([
    quarter('2025-07-01', '2025-09-30', 2),
    quarter('2025-10-01', '2025-12-31', 3),
    quarter('2026-01-01', '2026-03-31', 4),
    quarter('2026-04-01', '2026-06-30', 5),
  ], 'dilutedEps');
  assert.equal(result?.value, 14);
  assert.equal(result?.periodStart, '2025-07-01');
  assert.equal(result?.periodEnd, '2026-06-30');
  assert.equal(result?.basis, 'sum-of-four-quarters');
});

test('does not derive TTM when quarter values are missing or periods are not consecutive', () => {
  assert.equal(sumLatestFourQuarters([
    quarter('2025-07-01', '2025-09-30', 2),
    quarter('2025-10-01', '2025-12-31', 3),
    quarter('2026-01-01', '2026-03-31', null),
    quarter('2026-04-01', '2026-06-30', 5),
  ], 'dilutedEps'), null);
  assert.equal(sumLatestFourQuarters([
    quarter('2025-07-01', '2025-09-30', 2),
    quarter('2025-10-02', '2025-12-31', 3),
    quarter('2026-01-01', '2026-03-31', 4),
    quarter('2026-04-01', '2026-06-30', 5),
  ], 'dilutedEps'), null);
});
