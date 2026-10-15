export type MacdPoint = {
  date: string;
  macd: number | null;
  signal: number | null;
  histogram: number | null;
};

export type MacdCross = {
  direction: 'up' | 'down';
  previousDate: string;
  date: string;
  previousMacd: number;
  previousSignal: number;
  macd: number;
  signal: number;
};

export type MacdCrossPoint = {
  date: string;
  macd: number | null;
  signal: number | null;
  closed: boolean;
};

export const calculateRsi = (closes: number[], period = 14): Array<number | null> => {
  const result: Array<number | null> = Array(closes.length).fill(null);
  if (!Number.isInteger(period) || period < 1) return result;

  let previousClose: number | null = null;
  let changes = 0;
  let gainTotal = 0;
  let lossTotal = 0;
  let averageGain: number | null = null;
  let averageLoss: number | null = null;

  closes.forEach((close, index) => {
    if (!Number.isFinite(close)) {
      previousClose = null;
      changes = 0;
      gainTotal = 0;
      lossTotal = 0;
      averageGain = null;
      averageLoss = null;
      return;
    }
    if (previousClose === null) {
      previousClose = close;
      return;
    }

    const change = close - previousClose;
    previousClose = close;
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    changes += 1;

    if (averageGain === null || averageLoss === null) {
      gainTotal += gain;
      lossTotal += loss;
      if (changes < period) return;
      averageGain = gainTotal / period;
      averageLoss = lossTotal / period;
    } else {
      averageGain = (averageGain * (period - 1) + gain) / period;
      averageLoss = (averageLoss * (period - 1) + loss) / period;
    }

    result[index] = averageGain === 0 && averageLoss === 0
      ? 50
      : averageLoss === 0
        ? 100
        : averageGain === 0
          ? 0
          : 100 - 100 / (1 + averageGain / averageLoss);
  });

  return result;
};

export const calculateMacd = (
  candles: Array<{ date: string; close: number }>,
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdPoint[] => {
  const result: MacdPoint[] = candles.map(({ date }) => ({
    date,
    macd: null,
    signal: null,
    histogram: null,
  }));
  if (
    !Number.isInteger(fastPeriod) ||
    !Number.isInteger(slowPeriod) ||
    !Number.isInteger(signalPeriod) ||
    fastPeriod < 1 ||
    slowPeriod < 1 ||
    signalPeriod < 1
  ) {
    return result;
  }

  const fastAlpha = 2 / (fastPeriod + 1);
  const slowAlpha = 2 / (slowPeriod + 1);
  let fastEma: number | null = null;
  let slowEma: number | null = null;
  const macdValues: number[] = [];
  let signalEma: number | null = null;

  candles.forEach((candle, index) => {
    if (!Number.isFinite(candle.close)) {
      fastEma = null;
      slowEma = null;
      macdValues.length = 0;
      signalEma = null;
      return;
    }

    fastEma = fastEma === null
      ? candle.close
      : candle.close * fastAlpha + fastEma * (1 - fastAlpha);
    slowEma = slowEma === null
      ? candle.close
      : candle.close * slowAlpha + slowEma * (1 - slowAlpha);
    const macd = fastEma - slowEma;
    result[index].macd = macd;
    macdValues.push(macd);

    if (macdValues.length < signalPeriod) return;
    if (signalEma === null) {
      signalEma = macdValues.slice(-signalPeriod).reduce((sum, value) => sum + value, 0) / signalPeriod;
    } else {
      signalEma = macd * (2 / (signalPeriod + 1)) + signalEma * (1 - 2 / (signalPeriod + 1));
    }
    result[index].signal = signalEma;
    result[index].histogram = macd - signalEma;
  });

  return result;
};

export const detectMacdCrosses = (points: MacdCrossPoint[]): MacdCross[] => {
  const crosses: MacdCross[] = [];
  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (
      !previous.closed ||
      !current.closed ||
      previous.macd === null ||
      previous.signal === null ||
      current.macd === null ||
      current.signal === null ||
      !Number.isFinite(previous.macd) ||
      !Number.isFinite(previous.signal) ||
      !Number.isFinite(current.macd) ||
      !Number.isFinite(current.signal)
    ) continue;

    if (previous.macd <= previous.signal && current.macd > current.signal) {
      crosses.push({
        direction: 'up',
        previousDate: previous.date,
        date: current.date,
        previousMacd: previous.macd,
        previousSignal: previous.signal,
        macd: current.macd,
        signal: current.signal,
      });
    } else if (previous.macd >= previous.signal && current.macd < current.signal) {
      crosses.push({
        direction: 'down',
        previousDate: previous.date,
        date: current.date,
        previousMacd: previous.macd,
        previousSignal: previous.signal,
        macd: current.macd,
        signal: current.signal,
      });
    }
  }
  return crosses;
};
