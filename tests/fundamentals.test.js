import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annualDilutedEpsMetric,
  calculatePriceToEarnings,
  quarterlyDilutedEpsMetric,
  sumQuarterlyMetric,
} from '../fundamentals.js';

const checkedAt = '2026-10-15T00:00:00.000Z';
const earningsUrl =
  'https://investor.atmeta.com/investor-news/press-release-details/2026/Meta-Reports-Fourth-Quarter-and-Full-Year-2025-Results/default.aspx';

const epsQuarter = (start, end, value, source = earningsUrl, basis = 'sec-companyfacts') => ({
  periodStart: start,
  periodEnd: end,
  metrics: {
    dilutedEps: {
      value,
      unit: 'USD/shares',
      period: `${start} to ${end}`,
      periodStart: start,
      periodEnd: end,
      reportedDate: '2026-07-30',
      source,
      checkedAt,
      basis,
    },
  },
});

test('uses Meta-reported Q4 diluted EPS and does not derive it from full-year EPS', () => {
  const facts = {
    EarningsPerShareDiluted: {
      units: {
        'USD/shares': [
          { start: '2025-01-01', end: '2025-12-31', val: 23.49, filed: '2026-01-29', accn: 'annual' },
          { start: '2025-01-01', end: '2025-09-30', val: 14.61, filed: '2025-10-30', accn: 'nine-months' },
        ],
      },
    },
  };
  const metric = quarterlyDilutedEpsMetric(facts, 2025, 4, checkedAt);

  assert.equal(metric.value, 8.88);
  assert.equal(metric.unit, 'USD/shares');
  assert.equal(metric.periodStart, '2025-10-01');
  assert.equal(metric.periodEnd, '2025-12-31');
  assert.equal(metric.reportedDate, '2026-01-28');
  assert.equal(metric.source, earningsUrl);
  assert.equal(metric.checkedAt, checkedAt);
  assert.equal(metric.basis, 'verified-report-snapshot');
});

test('keeps reported full-year EPS separate from the Q4 EPS metric', () => {
  const annual = annualDilutedEpsMetric({}, 2025, checkedAt);
  const quarter = quarterlyDilutedEpsMetric({}, 2025, 4, checkedAt);
  assert.equal(annual.value, 23.49);
  assert.equal(annual.periodStart, '2025-01-01');
  assert.equal(annual.periodEnd, '2025-12-31');
  assert.equal(quarter.value, 8.88);
  assert.notEqual(annual.value, quarter.value);
});

test('selects the latest SEC filing revision for an exact quarter period', () => {
  const facts = {
    EarningsPerShareDiluted: {
      units: {
        'USD/shares': [
          { start: '2026-01-01', end: '2026-03-31', val: 10.44, filed: '2026-04-30', accn: '0001' },
          { start: '2026-01-01', end: '2026-03-31', val: 10.45, filed: '2026-05-02', accn: '0002' },
          { start: '2026-01-01', end: '2026-06-30', val: 16.62, filed: '2026-07-30', accn: '0003' },
        ],
      },
    },
  };
  const metric = quarterlyDilutedEpsMetric(facts, 2026, 1, checkedAt);

  assert.equal(metric.value, 10.45);
  assert.equal(metric.periodStart, '2026-01-01');
  assert.equal(metric.periodEnd, '2026-03-31');
  assert.match(metric.source, /0002/);
});

test('sums four consecutive reported EPS quarters for TTM', () => {
  const q4 = quarterlyDilutedEpsMetric({}, 2025, 4, checkedAt);
  const ttm = sumQuarterlyMetric([
    epsQuarter('2025-07-01', '2025-09-30', 1.05),
    { ...epsQuarter('2025-10-01', '2025-12-31', q4.value, q4.source, q4.basis), metrics: { dilutedEps: q4 } },
    epsQuarter('2026-01-01', '2026-03-31', 10.44),
    epsQuarter('2026-04-01', '2026-06-30', 6.18),
  ], 'dilutedEps');

  assert.equal(ttm, 26.55);
});

test('refuses TTM when a quarter is missing or duplicated', () => {
  const complete = [
    epsQuarter('2025-07-01', '2025-09-30', 1.05),
    epsQuarter('2025-10-01', '2025-12-31', 8.88),
    epsQuarter('2026-01-01', '2026-03-31', 10.44),
    epsQuarter('2026-04-01', '2026-06-30', 6.18),
  ];
  assert.equal(sumQuarterlyMetric(complete.slice(0, 2).concat(
    epsQuarter('2026-04-01', '2026-06-30', 6.18),
  ), 'dilutedEps'), null);
  assert.equal(sumQuarterlyMetric([
    ...complete.slice(0, 2),
    complete[1],
    complete[3],
  ], 'dilutedEps'), null);
});

test('calculates P/E only with a valid price and positive complete TTM EPS', () => {
  assert.equal(calculatePriceToEarnings(732.65, 26.55), 732.65 / 26.55);
  assert.equal(calculatePriceToEarnings(732.65, null), null);
  assert.equal(calculatePriceToEarnings(732.65, 0), null);
  assert.equal(calculatePriceToEarnings(null, 26.55), null);
});
