export type SummaryMetric = {
  value: number | null;
  unit: string;
  period: string;
  periodStart: string | null;
  periodEnd: string | null;
  reportedDate: string | null;
  source: string;
  checkedAt: string;
  basis: string;
};

export type SummaryQuarter = {
  periodStart: string;
  periodEnd: string;
  metrics: Record<string, SummaryMetric | null>;
};

const isNextDay = (previousEnd: string, nextStart: string) => {
  const next = new Date(`${previousEnd}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10) === nextStart;
};

export const sumLatestFourQuarters = (
  quarters: SummaryQuarter[],
  metricKey: string,
): SummaryMetric | null => {
  const latestFour = quarters.slice(-4);
  if (
    latestFour.length !== 4 ||
    latestFour.some((quarter, index) => {
      const metric = quarter.metrics[metricKey];
      if (!metric || metric.value === null || !Number.isFinite(metric.value)) return true;
      return index > 0 && !isNextDay(latestFour[index - 1].periodEnd, quarter.periodStart);
    })
  ) return null;

  const metrics = latestFour.map((quarter) => quarter.metrics[metricKey]!);
  const latest = metrics.at(-1)!;
  if (metrics.some((metric) => metric.unit !== latest.unit)) return null;

  return {
    ...latest,
    value: metrics.reduce((total, metric) => total + metric.value!, 0),
    period: `${latestFour[0].periodStart} to ${latestFour.at(-1)!.periodEnd}`,
    periodStart: latestFour[0].periodStart,
    periodEnd: latestFour.at(-1)!.periodEnd,
    reportedDate: latest.reportedDate,
    basis: 'sum-of-four-quarters',
  };
};
