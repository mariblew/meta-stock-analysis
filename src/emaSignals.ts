export type EmaSignalPoint = {
  date: string;
  fast: number | null | undefined;
  slow: number | null | undefined;
  closed: boolean;
};

export type EmaCrossSignal = {
  kind: 'golden' | 'death';
  previousDate: string;
  date: string;
  previousFast: number;
  previousSlow: number;
  fast: number;
  slow: number;
};

export type EmaAlignment = {
  state: 'above' | 'below' | 'equal' | 'insufficient';
  date: string | null;
  fast: number | null;
  slow: number | null;
};

const isValidEma = (value: number | null | undefined): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0;

export const detectEmaCrosses = (points: EmaSignalPoint[]): EmaCrossSignal[] => {
  const signals: EmaCrossSignal[] = [];

  for (let index = 1; index < points.length; index += 1) {
    const previous = points[index - 1];
    const current = points[index];
    if (
      !previous.closed ||
      !current.closed ||
      !isValidEma(previous.fast) ||
      !isValidEma(previous.slow) ||
      !isValidEma(current.fast) ||
      !isValidEma(current.slow)
    ) {
      continue;
    }

    if (previous.fast <= previous.slow && current.fast > current.slow) {
      signals.push({
        kind: 'golden',
        previousDate: previous.date,
        date: current.date,
        previousFast: previous.fast,
        previousSlow: previous.slow,
        fast: current.fast,
        slow: current.slow,
      });
    } else if (previous.fast >= previous.slow && current.fast < current.slow) {
      signals.push({
        kind: 'death',
        previousDate: previous.date,
        date: current.date,
        previousFast: previous.fast,
        previousSlow: previous.slow,
        fast: current.fast,
        slow: current.slow,
      });
    }
  }
  return signals;
};

export const getEmaAlignment = (points: EmaSignalPoint[]): EmaAlignment => {
  const latest = [...points].reverse().find((point) => point.closed);
  if (!latest || !isValidEma(latest.fast) || !isValidEma(latest.slow)) {
    return { state: 'insufficient', date: latest?.date ?? null, fast: null, slow: null };
  }
  return {
    state: latest.fast > latest.slow ? 'above' : latest.fast < latest.slow ? 'below' : 'equal',
    date: latest.date,
    fast: latest.fast,
    slow: latest.slow,
  };
};

const getNewYorkParts = (instant: Date) => {
  const values = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => values.find((value) => value.type === type)?.value ?? '';
  return {
    date: `${part('year')}-${part('month')}-${part('day')}`,
    weekday: part('weekday'),
    hour: Number(part('hour')),
    minute: Number(part('minute')),
  };
};

const mondayOf = (date: string) => {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.toISOString().slice(0, 10);
};

export const isCandleClosed = (date: string, interval: '1day' | '1week', instant = new Date()): boolean => {
  const key = date.slice(0, 10);
  const current = getNewYorkParts(instant);
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(current.weekday);
  const sessionEnded = current.hour >= 16;

  if (interval === '1week' && mondayOf(key) === mondayOf(current.date)) {
    return weekdayIndex === 6 || weekdayIndex === 0 || (weekdayIndex === 5 && sessionEnded);
  }
  if (key < current.date) {
    if (interval === '1week') return mondayOf(key) < mondayOf(current.date);
    return true;
  }
  if (key > current.date) return false;

  if (interval === '1day') return weekdayIndex >= 1 && weekdayIndex <= 5 && sessionEnded;
  return weekdayIndex === 6 || weekdayIndex === 0 || (weekdayIndex === 5 && sessionEnded);
};
