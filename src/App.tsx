import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import {
  CandlestickSeries,
  CrosshairMode,
  HistogramSeries,
  LineStyle,
  LineSeries,
  createChart,
  createSeriesMarkers,
  type BusinessDay,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type LineData,
  type SeriesMarker,
  type Time,
  type WhitespaceData,
} from 'lightweight-charts';
import { detectEmaCrosses, getEmaAlignment, isCandleClosed, type EmaCrossSignal } from './emaSignals';
import { sumLatestFourQuarters } from './fundamentalSummary';
import { calculateMacd, calculateRsi, detectMacdCrosses, type MacdCross, type MacdPoint } from './indicators';
import './App.css';

type RangeKey = '3M' | '6M' | '1Y' | 'all';
type IntervalKey = '1day' | '1week';
type TabKey = 'overview' | 'chart' | 'fundamentals' | 'summary';

type Candle = {
  date: string;
  datetime?: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number | null;
  ema50?: number | null;
  ema200?: number | null;
};

type ApiResponse = {
  status: string;
  provider: string;
  sourceUrl: string;
  symbol: string;
  exchange: string;
  currency: string;
  lastUpdated?: string | null;
  priceStatus?: string;
  providerDelay?: string | null;
  range: RangeKey;
  interval: IntervalKey;
  note?: string;
  providerCode?: number | string | null;
  quote?: {
    price: number | null;
    previousClose: number | null;
    change: number | null;
    changePercent: number | null;
  } | null;
  chart: Candle[];
  allSeries?: Candle[];
  summary?: string;
  metadata?: Record<string, string | null | number | undefined>;
};

type FundamentalMetric = {
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

type FundamentalPeriod = {
  period: string;
  periodStart: string;
  periodEnd: string;
  metrics: Record<string, FundamentalMetric | null>;
};

type FundamentalOperational = {
  dap: FundamentalMetric;
  dapYoY: FundamentalMetric;
  adImpressionsYoY: FundamentalMetric;
  averagePricePerAdYoY: FundamentalMetric;
  totalRevenue: FundamentalMetric | null;
  costAndExpensesYoY: FundamentalMetric;
  legalCharges: FundamentalMetric;
  severanceExpenses: FundamentalMetric;
  capexActual: FundamentalMetric;
  capexGuidanceLow: FundamentalMetric;
  capexGuidanceHigh: FundamentalMetric;
  advertisingRevenue: FundamentalMetric;
  priorAdvertisingRevenue: FundamentalMetric;
  realityLabsRevenue: FundamentalMetric;
  realityLabsOperatingIncome: FundamentalMetric;
  priorRealityLabsOperatingIncome: FundamentalMetric;
  cashAndMarketableSecurities: FundamentalMetric;
  longTermDebt: FundamentalMetric;
  disclosureSource: string;
  segmentSource: string;
  checkedAt: string;
};

type FundamentalsResponse = {
  status: string;
  provider: string;
  checkedAt: string;
  note?: string | null;
  priceStatus: string;
  price?: FundamentalMetric | null;
  priceNote?: string | null;
  sourceUrl: string;
  annualSourceUrl?: string;
  history: {
    annual: FundamentalPeriod[];
    quarterly: FundamentalPeriod[];
    comparison: FundamentalPeriod | null;
  };
  latest: FundamentalPeriod | null;
  operational: FundamentalOperational | null;
  valuation: {
    status: string;
    price?: FundamentalMetric | null;
    ttmDilutedEps?: FundamentalMetric | null;
    ttmOperatingCashFlow?: FundamentalMetric | null;
    ttmFreeCashFlow?: FundamentalMetric | null;
    dilutedShares?: FundamentalMetric | null;
    priceToEarnings?: FundamentalMetric | null;
    priceToOperatingCashFlow?: FundamentalMetric | null;
    priceToFreeCashFlow?: FundamentalMetric | null;
    missing?: string[];
    limitation?: string;
  };
  risks?: Record<string, { text: string; source: string; periodEnd: string; reportedDate: string; checkedAt: string }>;
};

type ChartActions = {
  resetView: () => void;
  fullscreen: () => void;
};

const EMPTY_CANDLES: Candle[] = [];
const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/+$/, '');
const apiUrl = (path: string) => `${API_BASE_URL}${path}`;

const tabs: Array<{ key: TabKey; label: string }> = [
  { key: 'overview', label: 'ภาพรวม' },
  { key: 'chart', label: 'กราฟและ EMA' },
  { key: 'fundamentals', label: 'พื้นฐานบริษัท' },
  { key: 'summary', label: 'สรุปการลงทุน' },
];

const fmtNumber = (value: number | null | undefined, digits = 2) => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 'ยังไม่มีข้อมูล';
  }

  return new Intl.NumberFormat('en-US', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
};

const fmtCurrency = (value: number | null | undefined) => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return 'ยังไม่มีข้อมูล';
  }

  return `$${value.toFixed(2)}`;
};

const formatFundamentalMetric = (metric: FundamentalMetric | null | undefined) => {
  if (!metric || metric.value === null || !Number.isFinite(metric.value)) return 'ไม่มีข้อมูล';
  const value = metric.value;
  if (metric.unit === 'USD' || metric.unit === 'USD/share') {
    const magnitude = Math.abs(value);
    const formatted =
      magnitude >= 1_000_000_000
        ? `$${(value / 1_000_000_000).toFixed(2)}B`
        : magnitude >= 1_000_000
          ? `$${(value / 1_000_000).toFixed(1)}M`
          : `$${value.toFixed(2)}`;
    return metric.unit === 'USD/share' ? `$${value.toFixed(2)}` : formatted;
  }
  if (metric.unit === 'USD/shares') return `$${value.toFixed(2)}`;
  if (metric.unit === 'shares') return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value);
  if (metric.unit.startsWith('%')) return `${value > 0 ? '+' : ''}${value.toFixed(1)}%`;
  if (metric.unit === 'billion people') return `${value.toFixed(2)} พันล้านคน`;
  if (metric.unit === 'x') return `${value.toFixed(1)}x`;
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value)} ${metric.unit}`;
};

const formatChange = (current: FundamentalMetric | null | undefined, previous: FundamentalMetric | null | undefined) => {
  if (current?.value == null || previous?.value == null || previous.value === 0) return 'ไม่มีช่วงเปรียบเทียบที่ครบถ้วน';
  const change = ((current.value - previous.value) / Math.abs(previous.value)) * 100;
  return `${change > 0 ? '+' : ''}${change.toFixed(1)}% YoY`;
};

const changeImplication = (
  label: string,
  current: FundamentalMetric | null | undefined,
  previous: FundamentalMetric | null | undefined,
) => {
  const change = formatChange(current, previous);
  if (change === 'ไม่มีช่วงเปรียบเทียบที่ครบถ้วน') return `${label}: ${change}; จึงยังสรุปทิศทาง YoY ไม่ได้`;
  const percent = current?.value != null && previous?.value != null
    ? ((current.value - previous.value) / Math.abs(previous.value)) * 100
    : null;
  if (percent === null) return `${label}: ${change}`;
  return percent > 0
    ? `${label}: ${change}; เป็นการเติบโตของตัวชี้วัดนี้ แต่ต้องพิจารณาความสามารถทำกำไรและเงินสดประกอบ`
    : percent < 0
      ? `${label}: ${change}; สะท้อนการอ่อนตัวของตัวชี้วัดนี้ในงวดเปรียบเทียบ`
      : `${label}: ${change}; ยังไม่เปลี่ยนจากงวดเปรียบเทียบ`;
};

const formattedMetricValue = (metric: FundamentalMetric | null | undefined) =>
  metric?.value == null || !Number.isFinite(metric.value) ? 'ไม่มีข้อมูล' : formatFundamentalMetric(metric);

const metricPeriodLabel = (metric: FundamentalMetric | null | undefined) =>
  metric?.period || (metric?.periodStart || metric?.periodEnd
    ? `${metric.periodStart ?? 'ไม่ระบุวันเริ่ม'} ถึง ${metric.periodEnd ?? 'ไม่ระบุวันสิ้นงวด'}`
    : 'ไม่มีข้อมูลงวด');

const dateLabel = (date: string | null | undefined) => (date ? new Date(`${date.slice(0, 10)}T00:00:00Z`).toLocaleDateString('th-TH', { dateStyle: 'medium', timeZone: 'UTC' }) : 'ไม่มีข้อมูล');

const dateKey = (date: string) => date.slice(0, 10);

const filterSeriesByRange = (series: Candle[], range: RangeKey) => {
  if (range === 'all' || !series.length) return series;
  const days = range === '3M' ? 90 : range === '6M' ? 180 : 365;
  const latest = new Date(`${dateKey(series.at(-1)!.date)}T00:00:00Z`);
  const start = new Date(latest);
  start.setUTCDate(start.getUTCDate() - days);
  return series.filter((item) => new Date(`${dateKey(item.date)}T00:00:00Z`) >= start);
};

const toChartTime = (date: string): BusinessDay => {
  const [year, month, day] = dateKey(date).split('-').map(Number);
  return { year, month, day };
};

const toDateKeyFromChartTime = (time: Time): string => {
  if (typeof time === 'string') return time;
  if (typeof time === 'number') return new Date(time * 1000).toISOString().slice(0, 10);
  return `${time.year}-${String(time.month).padStart(2, '0')}-${String(time.day).padStart(2, '0')}`;
};

const calculateEmaByDate = (series: Candle[], period: number, existingKey: 'ema50' | 'ema200') => {
  if (period === (existingKey === 'ema50' ? 50 : 200)) {
    return new Map(series.map((candle) => [dateKey(candle.date), candle[existingKey] ?? null]));
  }
  const values = new Map<string, number | null>();
  if (!series.length || series.length < period) {
    series.forEach((candle) => values.set(dateKey(candle.date), null));
    return values;
  }
  const alpha = 2 / (period + 1);
  let previous: number | null = null;
  series.forEach((candle, index) => {
    if (index === 0) previous = candle.close;
    else previous = candle.close * alpha + (previous ?? candle.close) * (1 - alpha);
    values.set(dateKey(candle.date), previous);
  });
  return values;
};

const compactVolume = (value: number) => {
  if (!Number.isFinite(value)) return '—';
  const millions = value / 1_000_000;
  return `${Number(millions.toFixed(1))}M`;
};

const fullVolume = (value: number | null) =>
  value == null || !Number.isFinite(value)
    ? '—'
    : `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)} หุ้น`;

const signalLabel = (kind: EmaCrossSignal['kind'], fastPeriod: number, slowPeriod: number) => {
  if (fastPeriod === 50 && slowPeriod === 200) return kind === 'golden' ? 'Golden Cross' : 'Death Cross';
  return `EMA ${fastPeriod}/${slowPeriod} ตัด${kind === 'golden' ? 'ขึ้น' : 'ลง'}`;
};

const statusText: Record<string, string> = {
  connected: 'เชื่อมต่อสำเร็จ',
  'not-configured': 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ',
  loading: 'กำลังโหลด',
  error: 'เชื่อมต่อไม่สำเร็จ',
  stale: 'ข้อมูลเก่า',
  insufficient: 'ข้อมูลไม่เพียงพอ',
  demo: 'โหมด Demo',
};

function App() {
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [interval, setInterval] = useState<IntervalKey>('1day');
  const [range, setRange] = useState<RangeKey>('1Y');
  const [source, setSource] = useState<ApiResponse | null>(null);
  const [fundamentals, setFundamentals] = useState<FundamentalsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [fundamentalsLoading, setFundamentalsLoading] = useState(true);
  const [hoverDate, setHoverDate] = useState<string | null>(null);
  const [emaConfig, setEmaConfig] = useState({ show50: true, show200: true, period50: 50, period200: 200 });
  const [showSignalMarkers, setShowSignalMarkers] = useState(true);
  const [showRsi, setShowRsi] = useState(true);
  const [showMacd, setShowMacd] = useState(true);
  const chartActionsRef = useRef<ChartActions | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    const load = async () => {
      setLoading(true);
      try {
        const response = await fetch(apiUrl(`/api/meta?interval=${interval}&range=all`), {
          signal: controller.signal,
        });
        const json = (await response.json()) as ApiResponse;
        setSource(json);
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          setSource({
            status: 'error',
            provider: 'Twelve Data',
            sourceUrl: 'https://twelvedata.com/docs',
            symbol: 'META',
            exchange: 'NASDAQ',
            currency: 'USD',
            range: 'all',
            interval,
            note: 'โหลดข้อมูลล้มเหลว',
            chart: [],
            quote: null,
          });
        }
      } finally {
        setLoading(false);
      }
    };

    void load();
    return () => controller.abort();
  }, [interval]);

  useEffect(() => {
    const controller = new AbortController();
    const loadFundamentals = async () => {
      setFundamentalsLoading(true);
      try {
        const response = await fetch(apiUrl('/api/fundamentals'), { signal: controller.signal });
        const json = (await response.json()) as FundamentalsResponse;
        setFundamentals(json);
      } catch (error) {
        if ((error as Error).name !== 'AbortError') {
          setFundamentals({
            status: 'error',
            provider: 'SEC Company Facts',
            checkedAt: new Date().toISOString(),
            note: 'โหลดข้อมูลพื้นฐานไม่สำเร็จ',
            priceStatus: 'error',
            sourceUrl: 'https://investor.atmeta.com/financials/',
            history: { annual: [], quarterly: [], comparison: null },
            latest: null,
            operational: null,
            valuation: {
              status: 'insufficient',
              price: null,
              ttmDilutedEps: { value: null, unit: 'USD/share', period: '', periodStart: null, periodEnd: null, reportedDate: null, source: '', checkedAt: '', basis: 'unavailable' },
              ttmOperatingCashFlow: { value: null, unit: 'USD', period: '', periodStart: null, periodEnd: null, reportedDate: null, source: '', checkedAt: '', basis: 'unavailable' },
              ttmFreeCashFlow: { value: null, unit: 'USD', period: '', periodStart: null, periodEnd: null, reportedDate: null, source: '', checkedAt: '', basis: 'unavailable' },
              dilutedShares: { value: null, unit: 'shares', period: '', periodStart: null, periodEnd: null, reportedDate: null, source: '', checkedAt: '', basis: 'unavailable' },
              priceToEarnings: { value: null, unit: 'x', period: '', periodStart: null, periodEnd: null, reportedDate: null, source: '', checkedAt: '', basis: 'unavailable' },
              priceToOperatingCashFlow: { value: null, unit: 'x', period: '', periodStart: null, periodEnd: null, reportedDate: null, source: '', checkedAt: '', basis: 'unavailable' },
              priceToFreeCashFlow: { value: null, unit: 'x', period: '', periodStart: null, periodEnd: null, reportedDate: null, source: '', checkedAt: '', basis: 'unavailable' },
              missing: ['ข้อมูลจาก SEC'],
              limitation: 'ยังโหลดข้อมูลสำหรับคำนวณไม่ได้',
            },
          });
        }
      } finally {
        setFundamentalsLoading(false);
      }
    };
    void loadFundamentals();
    return () => controller.abort();
  }, []);

  const fullChartData = source?.allSeries?.length ? source.allSeries : source?.chart ?? EMPTY_CANDLES;
  const chartData = useMemo(() => filterSeriesByRange(fullChartData, range), [fullChartData, range]);
  const selectedCandle = useMemo(() => {
    if (hoverDate) {
      const selected = fullChartData.find((candle) => dateKey(candle.date) === hoverDate);
      if (selected) return selected;
    }
    return chartData.at(-1);
  }, [chartData, fullChartData, hoverDate]);

  const latestPrice = selectedCandle?.close ?? source?.quote?.price ?? chartData.at(-1)?.close ?? null;
  const ema50Value = selectedCandle?.ema50 ?? null;
  const ema200Value = selectedCandle?.ema200 ?? null;
  const signalAnalysis = useMemo(() => {
    const fastValues = calculateEmaByDate(fullChartData, emaConfig.period50, 'ema50');
    const slowValues = calculateEmaByDate(fullChartData, emaConfig.period200, 'ema200');
    const points = fullChartData.map((candle) => ({
      date: dateKey(candle.date),
      fast: fastValues.get(dateKey(candle.date)),
      slow: slowValues.get(dateKey(candle.date)),
      closed: isCandleClosed(candle.date, interval),
    }));
    return {
      alignment: getEmaAlignment(points),
      signals: detectEmaCrosses(points),
      fastValues,
      slowValues,
    };
  }, [emaConfig.period50, emaConfig.period200, fullChartData, interval]);
  const latestSignal = signalAnalysis.signals.at(-1) ?? null;
  const indicators = useMemo(() => {
    const rsi = calculateRsi(fullChartData.map((candle) => candle.close), 14);
    const macd = calculateMacd(
      fullChartData.map((candle) => ({ date: dateKey(candle.date), close: candle.close })),
      12,
      26,
      9,
    );
    return {
      rsiByDate: new Map(fullChartData.map((candle, index) => [dateKey(candle.date), rsi[index]])),
      macdByDate: new Map(macd.map((point) => [point.date, point])),
      macd,
    };
  }, [fullChartData]);
  const macdCrosses = useMemo(
    () => detectMacdCrosses(indicators.macd.map((point) => ({
      date: point.date,
      macd: point.macd,
      signal: point.signal,
      closed: isCandleClosed(point.date, interval),
    }))),
    [indicators.macd, interval],
  );
  const latestMacdCross = macdCrosses.at(-1) ?? null;
  const latestClosedCandle = useMemo(
    () => [...fullChartData].reverse().find((candle) => isCandleClosed(candle.date, interval)) ?? null,
    [fullChartData, interval],
  );
  const summaryDate = latestClosedCandle ? dateKey(latestClosedCandle.date) : null;
  const summaryEma50 = summaryDate ? signalAnalysis.fastValues.get(summaryDate) ?? null : null;
  const summaryEma200 = summaryDate ? signalAnalysis.slowValues.get(summaryDate) ?? null : null;
  const summaryRsi = summaryDate ? indicators.rsiByDate.get(summaryDate) ?? null : null;
  const summaryMacd = summaryDate ? indicators.macdByDate.get(summaryDate) : undefined;

  const currentSignal = useMemo(() => {
    if (!latestPrice || !ema50Value || !ema200Value) {
      return 'ข้อมูลยังไม่เพียงพอ';
    }

    if (latestPrice > ema50Value && ema50Value > ema200Value) {
      return 'น่าสนใจศึกษาต่อ';
    }

    if (latestPrice > ema200Value && ema50Value >= ema200Value) {
      return 'รอจังหวะ';
    }

    if (latestPrice < ema50Value || latestPrice < ema200Value) {
      return 'ควรระวัง';
    }

    return 'ข้อมูลยังไม่เพียงพอ';
  }, [latestPrice, ema50Value, ema200Value]);

  const fundamentalMetrics = fundamentals?.latest?.metrics;
  const comparisonMetrics = fundamentals?.history.comparison?.metrics;
  const metricAvailable = (metric: FundamentalMetric | null | undefined) =>
    metric?.value != null && Number.isFinite(metric.value);
  const quarterTtmEps = sumLatestFourQuarters(fundamentals?.history.quarterly ?? [], 'dilutedEps');
  const missingEpsQuarters = (fundamentals?.history.quarterly ?? [])
    .filter((quarter) => !metricAvailable(quarter.metrics.dilutedEps))
    .map((quarter) => quarter.period);
  const quarterlyEpsAuditRows = (fundamentals?.history.quarterly ?? []).slice(-4);
  const ttmDilutedEps =
    fundamentals?.valuation.ttmDilutedEps?.value != null
      ? fundamentals.valuation.ttmDilutedEps
      : quarterTtmEps;
  const valuationPrice =
    fundamentals?.valuation.price ??
    fundamentals?.price ??
    (source?.quote?.price != null
      ? {
          value: source.quote.price,
          unit: 'USD/share',
          period: `Quote ณ ${source.lastUpdated ?? 'ไม่ระบุเวลา'}`,
          periodStart: null,
          periodEnd: source.lastUpdated?.slice(0, 10) ?? null,
          reportedDate: source.lastUpdated?.slice(0, 10) ?? null,
          source: source.sourceUrl,
          checkedAt: fundamentals?.checkedAt ?? '',
          basis: 'price-api-quote',
        }
      : null);
  const priceForValuation = valuationPrice?.value ?? source?.quote?.price ?? null;
  const priceToEarnings =
    fundamentals?.valuation.priceToEarnings?.value != null
      ? fundamentals.valuation.priceToEarnings
      : priceForValuation != null && ttmDilutedEps?.value != null && ttmDilutedEps.value > 0
        ? {
            ...ttmDilutedEps,
            value: priceForValuation / ttmDilutedEps.value,
            unit: 'x',
            reportedDate: valuationPrice?.reportedDate ?? null,
            source: valuationPrice?.source ?? fundamentals?.sourceUrl ?? '',
            basis: 'calculated',
          }
        : fundamentals?.valuation.priceToEarnings;
  const summaryCoverage = [
    {
      title: 'รายได้และกำไร',
      ready: [
        fundamentalMetrics?.revenue,
        fundamentalMetrics?.advertisingRevenue,
        fundamentalMetrics?.netIncome,
        fundamentalMetrics?.dilutedEps,
        fundamentalMetrics?.operatingMargin,
        fundamentalMetrics?.netMargin,
      ].every(metricAvailable),
    },
    {
      title: 'ผู้ใช้งานและโฆษณา',
      ready: [
        fundamentals?.operational?.dap,
        fundamentals?.operational?.dapYoY,
        fundamentals?.operational?.adImpressionsYoY,
        fundamentals?.operational?.averagePricePerAdYoY,
      ].every(metricAvailable),
    },
    {
      title: 'เงินสดและหนี้',
      ready: [
        fundamentalMetrics?.operatingCashFlow,
        fundamentalMetrics?.freeCashFlow,
        fundamentalMetrics?.cashAndMarketableSecurities,
        fundamentalMetrics?.longTermDebt,
        fundamentals?.valuation.ttmOperatingCashFlow,
        fundamentals?.valuation.ttmFreeCashFlow,
      ].every(metricAvailable),
    },
    {
      title: 'การลงทุนและความเสี่ยง',
      ready:
        metricAvailable(fundamentals?.operational?.capexActual) &&
        metricAvailable(fundamentals?.operational?.capexGuidanceLow) &&
        metricAvailable(fundamentals?.operational?.capexGuidanceHigh) &&
        metricAvailable(fundamentals?.operational?.realityLabsOperatingIncome) &&
        metricAvailable(fundamentals?.operational?.costAndExpensesYoY) &&
        metricAvailable(fundamentals?.operational?.legalCharges) &&
        metricAvailable(fundamentals?.operational?.severanceExpenses) &&
        Boolean(fundamentals?.risks?.competition?.source) &&
        Boolean(fundamentals?.risks?.legal?.source),
    },
    {
      title: 'มูลค่าหุ้น',
      ready:
        metricAvailable(valuationPrice) &&
        metricAvailable(ttmDilutedEps) &&
        metricAvailable(priceToEarnings) &&
        metricAvailable(fundamentals?.valuation.priceToOperatingCashFlow) &&
        metricAvailable(fundamentals?.valuation.priceToFreeCashFlow),
    },
  ];
  const summaryTechnicalReady =
    source?.status === 'connected' &&
    latestClosedCandle !== null &&
    summaryEma50 != null &&
    summaryEma200 != null &&
    summaryRsi != null &&
    summaryMacd?.macd != null &&
    summaryMacd.signal != null &&
    summaryMacd.histogram != null;
  const capexImpactText =
    fundamentals?.operational?.capexActual?.value != null &&
    fundamentalMetrics?.operatingCashFlow?.value != null &&
    fundamentalMetrics.freeCashFlow?.value != null &&
    fundamentals.operational.capexActual.periodEnd === fundamentalMetrics.operatingCashFlow.periodEnd &&
    fundamentalMetrics.operatingCashFlow.periodEnd === fundamentalMetrics.freeCashFlow.periodEnd
      ? `ในงวดเดียวกัน CapEx ที่รายงาน ${formattedMetricValue(fundamentals.operational.capexActual)} เทียบ OCF ${formattedMetricValue(fundamentalMetrics.operatingCashFlow)} และ FCF ${formattedMetricValue(fundamentalMetrics.freeCashFlow)}; ใช้ดูภาระลงทุนต่อเงินสดได้ โดย FCF ใช้นิยาม Meta`
      : 'ช่วงเวลาของ CapEx, OCF หรือ FCF ไม่ตรงกัน/ข้อมูลไม่ครบ จึงยังเทียบผลต่อเงินสดในงวดเดียวกันไม่ได้';
  const combinedReady =
    fundamentals?.status === 'connected' &&
    summaryCoverage.every((item) => item.ready) &&
    summaryTechnicalReady;
  const combinedSignal = combinedReady
    ? 'ข้อมูลหลักครบตามรายการที่แสดง; ไม่มีข้อสรุปซื้อหรือขายอัตโนมัติ'
    : 'ข้อมูลยังไม่เพียงพอสำหรับสรุปรวม';
  const combinedMissing = [
    ...(fundamentals?.status !== 'connected' ? ['ข้อมูลพื้นฐานจาก SEC ยังไม่เชื่อมต่อ'] : []),
    ...summaryCoverage.filter((item) => !item.ready && item.title !== 'มูลค่าหุ้น').map((item) => item.title),
    ...(!summaryTechnicalReady ? ['ข้อมูลราคา/EMA/RSI/MACD บนแท่งที่ปิดแล้ว'] : []),
    ...(!metricAvailable(ttmDilutedEps)
      ? [`Diluted EPS TTM: ต้องมี EPS รายไตรมาสครบ 4 งวดต่อเนื่อง${missingEpsQuarters.length ? ` (ขาด ${missingEpsQuarters.join(', ')})` : ''}`]
      : []),
    ...(fundamentals?.valuation.missing ?? []).filter((missing) => {
      const normalized = missing.toLowerCase();
      if (normalized.includes('ราคาหุ้น')) return !metricAvailable(valuationPrice);
      if (normalized.includes('diluted eps')) return false;
      return true;
    }),
  ];
  const summaryTechnicalSignal = summaryTechnicalReady && latestClosedCandle
    ? summaryEma50! > summaryEma200!
      ? `แท่งปิด ${dateLabel(summaryDate)}: EMA ${emaConfig.period50} อยู่เหนือ EMA ${emaConfig.period200}`
      : summaryEma50! < summaryEma200!
        ? `แท่งปิด ${dateLabel(summaryDate)}: EMA ${emaConfig.period50} อยู่ต่ำกว่า EMA ${emaConfig.period200}`
        : `แท่งปิด ${dateLabel(summaryDate)}: EMA ${emaConfig.period50} เท่ากับ EMA ${emaConfig.period200}`
    : 'ข้อมูลไม่เพียงพอสำหรับสรุปเทคนิค';

  const summaryLines = [
      `META Stock Analysis`,
      `กรอบเวลา: ${range} / ${interval === '1day' ? 'รายวัน' : 'รายสัปดาห์'}`,
      `แท่งปิดล่าสุด: ${summaryDate ? dateLabel(summaryDate) : 'ยังไม่มีข้อมูล'}`,
      `ราคาปิดแท่งอ้างอิง: ${fmtCurrency(latestClosedCandle?.close)}`,
      `EMA ${emaConfig.period50}: ${fmtCurrency(summaryEma50)}`,
      `EMA ${emaConfig.period200}: ${fmtCurrency(summaryEma200)}`,
      `RSI 14: ${summaryRsi == null ? 'ข้อมูลไม่เพียงพอ' : summaryRsi.toFixed(2)}`,
      `MACD 12/26/9: ${summaryMacd?.macd == null ? 'ข้อมูลไม่เพียงพอ' : summaryMacd.macd.toFixed(2)} / Signal ${summaryMacd?.signal == null ? 'ข้อมูลไม่เพียงพอ' : summaryMacd.signal.toFixed(2)} / Histogram ${summaryMacd?.histogram == null ? 'ข้อมูลไม่เพียงพอ' : summaryMacd.histogram.toFixed(2)}`,
      `สรุปเทคนิค: ${summaryTechnicalSignal}`,
      `รายได้รวม: ${formattedMetricValue(fundamentalMetrics?.revenue)} (${metricPeriodLabel(fundamentalMetrics?.revenue)}) · YoY ${formatChange(fundamentalMetrics?.revenue, comparisonMetrics?.revenue)}`,
      `กำไรสุทธิ: ${formattedMetricValue(fundamentalMetrics?.netIncome)} (${metricPeriodLabel(fundamentalMetrics?.netIncome)}) · YoY ${formatChange(fundamentalMetrics?.netIncome, comparisonMetrics?.netIncome)}`,
      `DAP: ${formattedMetricValue(fundamentals?.operational?.dap)} · รายได้โฆษณา ${formattedMetricValue(fundamentals?.operational?.advertisingRevenue)}`,
      `OCF/FCF: ${formattedMetricValue(fundamentalMetrics?.operatingCashFlow)} / ${formattedMetricValue(fundamentalMetrics?.freeCashFlow)} · เงินสด ${formattedMetricValue(fundamentalMetrics?.cashAndMarketableSecurities)} · หนี้ ${formattedMetricValue(fundamentalMetrics?.longTermDebt)}`,
      `P/E: ${formattedMetricValue(priceToEarnings)} · P/OCF ${formattedMetricValue(fundamentals?.valuation.priceToOperatingCashFlow)} · P/FCF ${formattedMetricValue(fundamentals?.valuation.priceToFreeCashFlow)}`,
      `สรุปรวมพื้นฐานและมูลค่า: ${combinedSignal}`,
      `ความครบถ้วนพื้นฐาน: ${summaryCoverage.filter((item) => item.ready).length}/5 · สิ่งที่ขาด: ${[...new Set(combinedMissing)].join(', ') || 'ไม่มี'}`,
      `วันที่อัปเดตข้อมูลราคา: ${source?.lastUpdated || 'ยังไม่มีข้อมูล'}`,
      `ตรวจข้อมูลพื้นฐาน: ${fundamentals?.checkedAt || 'ยังไม่มีข้อมูล'}`,
      `แหล่งข้อมูล: ${source?.provider || 'ยังไม่มีข้อมูล'} (${source?.sourceUrl || 'ยังไม่มี URL'})`,
  ].join('\n');

  const handleAnalyze = async () => {
    setLoading(true);
    setFundamentalsLoading(true);
    try {
      const [priceResponse, fundamentalResponse] = await Promise.all([
        fetch(apiUrl(`/api/meta?interval=${interval}&range=${range}`)),
        fetch(apiUrl('/api/fundamentals')),
      ]);
      const [priceJson, fundamentalJson] = (await Promise.all([
        priceResponse.json(),
        fundamentalResponse.json(),
      ])) as [ApiResponse, FundamentalsResponse];
      setSource(priceJson);
      setFundamentals(fundamentalJson);
    } finally {
      setLoading(false);
      setFundamentalsLoading(false);
    }
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;

    const text = await file.text();
    let importedSeries: Candle[] = [];

    try {
      if (file.name.toLowerCase().endsWith('.json')) {
        const parsed = JSON.parse(text) as { data?: Candle[]; values?: Candle[]; records?: Candle[] };
        importedSeries = (parsed.data ?? parsed.values ?? parsed.records ?? []) as Candle[];
      } else {
        const lines = text.trim().split(/\r?\n/).filter(Boolean);
        const headers = lines[0].split(',').map((item) => item.trim().toLowerCase());
        importedSeries = lines.slice(1).map((line) => {
          const columns = line.split(',');
          const tuple = Object.fromEntries(headers.map((header, idx) => [header, columns[idx]?.trim() ?? '']));
          return {
            date: tuple.date || tuple.datetime || '',
            open: Number(tuple.open),
            high: Number(tuple.high),
            low: Number(tuple.low),
            close: Number(tuple.close),
            volume: tuple.volume === '' || !Number.isFinite(Number(tuple.volume)) ? null : Number(tuple.volume),
          };
        });
      }

      setSource({
        status: 'demo',
        provider: 'Imported file',
        sourceUrl: file.name,
        symbol: 'META',
        exchange: 'NASDAQ',
        currency: 'USD',
        range,
        interval,
        note: 'ข้อมูลสำรองจากไฟล์ CSV/JSON ถูกนำเข้ามาแล้วเพื่อทดสอบรูปแบบข้อมูล',
        quote: {
          price: importedSeries.at(-1)?.close ?? null,
          previousClose: importedSeries.at(-2)?.close ?? importedSeries.at(-1)?.close ?? null,
          change: null,
          changePercent: null,
        },
        chart: importedSeries.filter((item) => item.date),
        summary: 'ข้อมูลสำรองได้ถูกนำเข้ามาแล้ว โดยไม่ได้เป็นราคาจริงจากแหล่งข้อมูลหลัก',
      });
    } catch {
      setSource({
        status: 'error',
        provider: 'Imported file',
        sourceUrl: file.name,
        symbol: 'META',
        exchange: 'NASDAQ',
        currency: 'USD',
        range,
        interval,
        note: 'นำเข้าข้อมูลไม่สำเร็จ กรุณาตรวจสอบรูปแบบไฟล์',
        chart: [],
        quote: null,
      });
    }

    event.target.value = '';
  };

  const handleCopySummary = async () => {
    try {
      await navigator.clipboard.writeText(summaryLines);
    } catch {
      window.alert('ไม่สามารถคัดลอกได้ในเบราว์เซอร์นี้');
    }
  };

  return (
    <div className="page-shell">
      <header className="topbar">
        <div>
          <div className="eyebrow">Meta Platforms • NASDAQ • USD</div>
          <h1>META Stock Analysis</h1>
        </div>

        <div className="header-actions">
          <span className={`status-badge ${source?.status ?? 'loading'}`}>
            ราคา: {loading ? 'กำลังโหลด' : statusText[source?.status ?? 'loading'] || 'กำลังโหลด'}
          </span>
          <span className={`status-badge ${fundamentalsLoading ? 'loading' : fundamentals?.status === 'connected' ? 'connected' : 'error'}`}>
            พื้นฐาน: {fundamentalsLoading ? 'กำลังโหลด' : fundamentals?.status === 'connected' ? 'เชื่อมต่อ SEC แล้ว' : 'ข้อมูลขัดข้อง'}
          </span>
          <button type="button" className="primary" onClick={handleAnalyze}>วิเคราะห์ข้อมูล</button>
          <button type="button" className="secondary" onClick={handleAnalyze}>รีเฟรชข้อมูล</button>
          <label className="secondary file-button">
            นำเข้าข้อมูล
            <input type="file" accept=".csv,.json" onChange={handleImport} />
          </label>
          <button type="button" className="secondary" onClick={handleCopySummary}>คัดลอกบทสรุป</button>
        </div>
      </header>

      {source?.status === 'error' && source.note && (
        <div className="error-details" role="alert">
          {source.providerCode != null && <strong>รหัสข้อผิดพลาด {source.providerCode}: </strong>}
          {source.note}
        </div>
      )}
      {fundamentals?.status === 'error' && fundamentals.note && (
        <div className="error-details" role="alert">ข้อมูลพื้นฐาน: {fundamentals.note}</div>
      )}

      <nav className="tabs" aria-label="Analysis tabs">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            className={tab.key === activeTab ? 'tab active' : 'tab'}
            onClick={() => setActiveTab(tab.key)}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      {activeTab === 'overview' && (
        <section className="panel-grid">
          <article className="panel hero-panel">
            <div className="company-header">
              <div>
                <p className="kicker">บริษัทที่ศึกษา</p>
                <h2>Meta Platforms, Inc. (META)</h2>
              </div>
              <span className="badge">Nasdaq • USD</span>
            </div>

            <div className="stat-grid">
              <StatCard label="ราคาปิดล่าสุด" value={fmtCurrency(latestPrice)} accent="green" />
              <StatCard label="Δ 1 วัน" value={source?.quote?.change != null ? `${fmtCurrency(source.quote.change)} (${fmtNumber(source.quote.changePercent, 2)}%)` : 'ยังไม่มีข้อมูล'} accent={source?.quote?.change != null && source.quote.change >= 0 ? 'green' : 'red'} />
              <StatCard label="EMA 50" value={fmtCurrency(ema50Value)} accent="blue" />
              <StatCard label="EMA 200" value={fmtCurrency(ema200Value)} accent="purple" />
            </div>

            <div className="ema-status-grid">
              <div>
                <span>การเรียงตัวปัจจุบัน · {interval === '1day' ? 'รายวัน' : 'รายสัปดาห์'}</span>
                <strong>
                  {signalAnalysis.alignment.state === 'above'
                    ? `EMA ${emaConfig.period50} อยู่เหนือ EMA ${emaConfig.period200}`
                    : signalAnalysis.alignment.state === 'below'
                      ? `EMA ${emaConfig.period50} อยู่ต่ำกว่า EMA ${emaConfig.period200}`
                      : signalAnalysis.alignment.state === 'equal'
                        ? `EMA ${emaConfig.period50} เท่ากับ EMA ${emaConfig.period200}`
                        : 'ข้อมูลไม่เพียงพอ'}
                </strong>
              </div>
              <div>
                <span>เหตุการณ์ตัดกันล่าสุด · {interval === '1day' ? 'รายวัน' : 'รายสัปดาห์'}</span>
                <strong>
                  {latestSignal
                    ? `${signalLabel(latestSignal.kind, emaConfig.period50, emaConfig.period200)} · ${dateLabel(latestSignal.date)}`
                    : fullChartData.length < 2 || signalAnalysis.alignment.state === 'insufficient'
                      ? 'ข้อมูลไม่เพียงพอ'
                      : 'ไม่พบการตัดกันในประวัติข้อมูลที่มี'}
                </strong>
              </div>
            </div>

            <div className="source-meter">
              <div>
                <label>สถานะข้อมูล</label>
                <strong>{source ? statusText[source.status] ?? 'กำลังโหลด' : 'กำลังโหลด'}</strong>
              </div>
              <div>
                <label>วันที่อัปเดต</label>
                <strong>{source?.lastUpdated || 'ยังไม่มีข้อมูล'}</strong>
              </div>
              <div>
                <label>แหล่งข้อมูล</label>
                <strong>{source?.provider || 'ยังไม่มีข้อมูล'}</strong>
              </div>
            </div>
          </article>

          <article className="panel">
            <h3>Fundamental Analysis คืออะไร</h3>
            <p>
              Fundamental Analysis คือการศึกษาธุรกิจ งบการเงิน ความสามารถในการทำกำไร การเติบโต ความเสี่ยง
              และมูลค่าหุ้น เพื่อประเมินความน่าสนใจในการลงทุน การวิเคราะห์นี้ต้องตรวจสอบด้วยข้อมูลจริง เช่น
              รายงาน SEC รายงานประจำปี และเอกสารประกาศผลประกอบการของบริษัท
            </p>
            <h3>Technical Analysis คืออะไร</h3>
            <p>
              Technical Analysis คือการศึกษาราคาและปริมาณซื้อขายในอดีตเพื่อประเมินแนวโน้มและจังหวะการลงทุน
            </p>
            <div className="indicator-explanation-card">
              <h4>EMA และ Golden Cross / Death Cross</h4>
              <h4>EMA คืออะไร?</h4>
              <p>EMA หรือค่าเฉลี่ยเคลื่อนที่แบบเอ็กซ์โพเนนเชียลให้น้ำหนักกับราคาล่าสุดมากกว่าราคาเก่า โดย EMA 50 และ EMA 200 ใช้ติดตามแนวโน้มตามกรอบเวลาที่เลือก เช่น 50/200 แท่งรายวันหรือรายสัปดาห์</p>
              <h4>Golden Cross คืออะไร?</h4>
              <p>ในแอปนี้ Golden Cross หมายถึง EMA 50 ตัดขึ้นเหนือ EMA 200 เป็นเหตุการณ์จากค่า EMA ของแท่งที่ปิดแล้ว</p>
              <h4>Death Cross คืออะไร?</h4>
              <p>ในแอปนี้ Death Cross หมายถึง EMA 50 ตัดลงต่ำกว่า EMA 200 เป็นเหตุการณ์จากค่า EMA ของแท่งที่ปิดแล้ว</p>
              <p className="muted">สัญญาณคำนวณจากราคาในอดีตจึงอาจล่าช้ากว่าการเคลื่อนไหวของราคา และตลาดที่แกว่งตัวอาจเกิดสัญญาณหลอก ควรพิจารณาร่วมกับราคา ปริมาณซื้อขาย RSI, MACD และพื้นฐานบริษัท ไม่ใช่คำสั่งซื้อหรือขายโดยอัตโนมัติ</p>
            </div>
            <div className="indicator-explanation-card">
              <h4>RSI คืออะไร?</h4>
              <p>RSI หรือ Relative Strength Index ใช้วัดความแรงของการเคลื่อนไหวราคาจากราคาปิด โดยมีค่าระหว่าง 0–100 แอปใช้ค่าเริ่มต้น 14 คาบ ระดับมากกว่า 70 และต่ำกว่า 30 เป็นเกณฑ์ภาวะซื้อมากและขายมากตามลำดับ แต่ไม่ได้หมายความว่าต้องขายหรือซื้อทันที และไม่ได้บอกว่าหุ้นมีมูลค่าถูกหรือแพง</p>
              <h4>MACD คืออะไร?</h4>
              <p>MACD ใช้ดูความสัมพันธ์ระหว่างค่าเฉลี่ยราคาและการเปลี่ยนแปลงของแรงส่ง ประกอบด้วย MACD Line, Signal Line และ Histogram เมื่อ Histogram เป็นบวก หมายถึง MACD อยู่เหนือ Signal และเมื่อเป็นลบหมายถึงอยู่ต่ำกว่า การเปลี่ยนจาก −3 เป็น −1 หมายถึงค่าติดลบน้อยลง ยังไม่ได้กลายเป็นบวก</p>
              <p className="muted">คาบหมายถึงจำนวนแท่งตามกรอบเวลาที่เลือก RSI ใช้ Wilder/RMA โดยเฉลี่ย Gain/Loss ของ 14 ช่วงแรกเป็นค่าเริ่มต้น; หาก Gain และ Loss เป็นศูนย์ทั้งคู่ แอปกำหนด RSI = 50 ส่วน MACD EMA 12/26 เริ่มจากราคาปิดแรกแล้วคำนวณแบบ recursive; Signal ใช้ค่าเฉลี่ย 9 ค่า MACD แรกก่อนเริ่ม EMA 9</p>
              <p className="muted">
                เหตุการณ์ MACD ล่าสุด ({interval === '1day' ? 'รายวัน' : 'รายสัปดาห์'}):{' '}
                {latestMacdCross
                  ? `MACD ตัด Signal ${latestMacdCross.direction === 'up' ? 'ขึ้น' : 'ลง'} · ${dateLabel(latestMacdCross.date)}`
                  : 'ไม่พบการตัดกันในประวัติข้อมูลที่มี'}
              </p>
            </div>
          </article>
        </section>
      )}

      {activeTab === 'chart' && (
        <section className="panel chart-panel">
          <div className="toolbar">
            <div className="chart-toolbar-group" aria-label="กรอบเวลา">
              {(['1day', '1week'] as IntervalKey[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={interval === item ? 'segment active' : 'segment'}
                  onClick={() => setInterval(item)}
                >
                  {item === '1day' ? 'รายวัน' : 'รายสัปดาห์'}
                </button>
              ))}
            </div>

            <div className="chart-toolbar-group" aria-label="ช่วงข้อมูล">
              {(['3M', '6M', '1Y', 'all'] as RangeKey[]).map((item) => (
                <button
                  key={item}
                  type="button"
                  className={range === item ? 'segment active' : 'segment'}
                  onClick={() => setRange(item)}
                >
                  {item === 'all' ? 'ทั้งหมด' : item}
                </button>
              ))}
            </div>

            <label className="ema-toggle">
              <input
                type="checkbox"
                checked={emaConfig.show50}
                onChange={(event) =>
                  setEmaConfig((current) => ({ ...current, show50: event.target.checked }))
                }
              />
              <span className="ema-key ema-key-50" /> EMA {emaConfig.period50}
            </label>
            <label className="ema-toggle">
              <input
                type="checkbox"
                checked={emaConfig.show200}
                onChange={(event) =>
                  setEmaConfig((current) => ({ ...current, show200: event.target.checked }))
                }
              />
              <span className="ema-key ema-key-200" /> EMA {emaConfig.period200}
            </label>
            <label className="ema-toggle signal-toggle">
              <input type="checkbox" checked={showSignalMarkers} onChange={(event) => setShowSignalMarkers(event.target.checked)} />
              เครื่องหมายสัญญาณ
            </label>
            <label className="ema-toggle indicator-toggle">
              <input type="checkbox" checked={showRsi} onChange={(event) => setShowRsi(event.target.checked)} />
              <span className="indicator-key rsi-key" /> RSI 14
            </label>
            <label className="ema-toggle indicator-toggle">
              <input type="checkbox" checked={showMacd} onChange={(event) => setShowMacd(event.target.checked)} />
              <span className="indicator-key macd-key" /> MACD 12/26/9
            </label>
            <details className="ema-settings">
              <summary>ตั้งค่าคาบ</summary>
              <label>
                EMA 50 <input type="number" min={5} max={200} value={emaConfig.period50}
                  onChange={(event) => setEmaConfig((current) => ({ ...current, period50: Number(event.target.value) || 50 }))} />
              </label>
              <label>
                EMA 200 <input type="number" min={10} max={400} value={emaConfig.period200}
                  onChange={(event) => setEmaConfig((current) => ({ ...current, period200: Number(event.target.value) || 200 }))} />
              </label>
            </details>

            <button type="button" className="chart-action" onClick={() => chartActionsRef.current?.resetView()}>
              รีเซ็ตมุมมอง
            </button>
            <button type="button" className="chart-action" onClick={() => chartActionsRef.current?.fullscreen()}>
              เต็มหน้าจอ
            </button>
          </div>

          <CandlestickChart
            data={fullChartData}
            range={range}
            interval={interval}
            selectedDate={hoverDate}
            onSelectDate={setHoverDate}
            show50={emaConfig.show50}
            show200={emaConfig.show200}
            period50={emaConfig.period50}
            period200={emaConfig.period200}
            status={source?.status ?? 'loading'}
            provider={source?.provider ?? 'Twelve Data'}
            lastUpdated={source?.lastUpdated ?? null}
            quoteDate={source?.lastUpdated ?? null}
            actionsRef={chartActionsRef}
            signals={signalAnalysis.signals}
            showSignalMarkers={showSignalMarkers}
            fastPeriod={emaConfig.period50}
            slowPeriod={emaConfig.period200}
            showRsi={showRsi}
            showMacd={showMacd}
            rsiValues={indicators.rsiByDate}
            macdValues={indicators.macdByDate}
            macdCrosses={macdCrosses}
          />
          <div className="chart-footer">
            <strong>สัญญาณ EMA: {currentSignal}</strong>
            <span>{source?.provider ?? 'ยังไม่มีข้อมูลราคา'} · ข้อมูลล่าสุด {source?.lastUpdated ?? 'ไม่มีเวลาอ้างอิง'}</span>
          </div>
        </section>
      )}

      {activeTab === 'fundamentals' && (
        <section className="panel-grid">
          <article className="panel fundamental-panel">
            <div className="fundamental-heading">
              <div>
                <h3>ข้อมูลพื้นฐานและผลประกอบการ</h3>
                <p className="muted">
                  สถานะพื้นฐาน: {fundamentalsLoading ? 'กำลังโหลด' : fundamentals?.status === 'connected' ? 'เชื่อมต่อ SEC แล้ว' : 'ดึงข้อมูลไม่สำเร็จ'}
                  {' · '}ตรวจสอบล่าสุด {fundamentals?.checkedAt ? new Date(fundamentals.checkedAt).toLocaleString('th-TH') : 'ยังไม่มีข้อมูล'}
                </p>
              </div>
              {fundamentals?.sourceUrl && <a href={fundamentals.sourceUrl} target="_blank" rel="noreferrer">SEC filing</a>}
            </div>
            <p className="explain-text">
              ข้อมูลงบการเงินและมูลค่าหุ้นดึงจาก SEC Company Facts และ SEC 10-Q โดยอัตโนมัติทุกครั้งที่โหลด/กดรีเฟรช
              ตัวชี้วัด DAP และการเปลี่ยนแปลงโฆษณาเป็น snapshot ที่ตรวจสอบจากรายงาน Meta Q2 2026 ไม่ใช่ feed อัตโนมัติ
              ราคากับพื้นฐานมีสถานะแยกกัน
            </p>
          </article>

          <article className="panel fundamental-panel">
            <h3>1. รายได้และกำไร</h3>
            <p className="fundamental-what">ตัวเลขคืออะไร: ยอดขายรวมและรายได้โฆษณาเทียบกับกำไรสุทธิ, diluted EPS และอัตรากำไร</p>
            <MetricDetail label="รายได้รวม" metric={fundamentalMetrics?.revenue} />
            <MetricDetail label="รายได้โฆษณา (Family of Apps)" metric={fundamentalMetrics?.advertisingRevenue} />
            <MetricDetail label="กำไรสุทธิ" metric={fundamentalMetrics?.netIncome} />
            <MetricDetail label="Diluted EPS" metric={fundamentalMetrics?.dilutedEps} />
            <MetricDetail label="Operating margin" metric={fundamentalMetrics?.operatingMargin} />
            <MetricDetail label="Net margin" metric={fundamentalMetrics?.netMargin} />
            <p><strong>เปลี่ยนแปลง:</strong> รายได้ {formatChange(fundamentalMetrics?.revenue, comparisonMetrics?.revenue)}; กำไรสุทธิ {formatChange(fundamentalMetrics?.netIncome, comparisonMetrics?.netIncome)}; diluted EPS {formatChange(fundamentalMetrics?.dilutedEps, comparisonMetrics?.dilutedEps)} เทียบ Q2 ปีก่อน</p>
            <p><strong>มุมมอง:</strong> รายได้เพิ่ม 28% แต่กำไรสุทธิลด 14% และต้นทุน/ค่าใช้จ่ายเพิ่ม 55% ตามรายงาน จึงไม่ควรสรุปว่ากำไรพื้นฐานดีขึ้นจากยอดขายเพียงอย่างเดียว</p>
            <p><strong>ข้อจำกัด:</strong> งบรวมตาม GAAP; อัตรากำไรคำนวณจากกำไรและรายได้ในงวดเดียวกัน ส่วนเปอร์เซ็นต์รายได้โฆษณาคำนวณจาก segment XBRL ไม่ใช่ตัวเลข estimate</p>
            <SourceLink href={fundamentals?.operational?.disclosureSource} label="Meta Q2 2026 earnings release" />
          </article>

          <article className="panel fundamental-panel">
            <h3>2. ผู้ใช้งานและโฆษณา</h3>
            <p className="fundamental-what">ตัวเลขคืออะไร: ผู้ใช้เฉลี่ยรายวันใน Family, ปริมาณโฆษณา และราคาเฉลี่ยต่อโฆษณา</p>
            <MetricDetail label="DAP เฉลี่ยเดือนมิถุนายน 2026" metric={fundamentals?.operational?.dap} />
            <MetricDetail label="DAP เปลี่ยนแปลง YoY" metric={fundamentals?.operational?.dapYoY} />
            <MetricDetail label="จำนวน ad impressions เปลี่ยนแปลง YoY" metric={fundamentals?.operational?.adImpressionsYoY} />
            <MetricDetail label="ราคาเฉลี่ยต่อโฆษณาเปลี่ยนแปลง YoY" metric={fundamentals?.operational?.averagePricePerAdYoY} />
            <MetricDetail label="รายได้โฆษณาไตรมาส" metric={fundamentals?.operational?.advertisingRevenue} />
            <p><strong>มุมมอง:</strong> รายงานระบุทั้งปริมาณโฆษณา (+14%) และราคาเฉลี่ย (+12%) เพิ่มขึ้น; รายได้โฆษณาเป็นตัวเลขจาก segment ใน SEC filing</p>
            <p><strong>ข้อจำกัด:</strong> Meta รายงาน DAP เป็นค่าเฉลี่ยรายวันของเดือนมิถุนายน ไม่ใช่จำนวนบัญชีเฉพาะบุคคล; ad impressions และราคาเฉลี่ยเปิดเผยเป็นอัตราเติบโต YoY โดยไม่ได้ระบุจำนวน/ราคาต่อชิ้น</p>
            <SourceLink href={fundamentals?.operational?.disclosureSource} label="Meta Q2 2026 earnings release" />
            <SourceLink href={fundamentals?.operational?.segmentSource} label="SEC Q2 2026 10-Q segment facts" />
          </article>

          <article className="panel fundamental-panel">
            <h3>3. เงินสดและหนี้</h3>
            <p className="fundamental-what">ตัวเลขคืออะไร: เงินสดจากการดำเนินงานและ FCF ตามนิยามของ Meta พร้อมสภาพคล่องและหนี้ระยะยาว</p>
            <MetricDetail label="Operating cash flow (ไตรมาส)" metric={fundamentalMetrics?.operatingCashFlow} />
            <MetricDetail label="Free Cash Flow (ไตรมาส)" metric={fundamentalMetrics?.freeCashFlow} />
            <MetricDetail label="เงินสดและหลักทรัพย์ที่เปลี่ยนเป็นเงินสดได้" metric={fundamentalMetrics?.cashAndMarketableSecurities} />
            <MetricDetail label="หนี้ระยะยาว" metric={fundamentalMetrics?.longTermDebt} />
            <p><strong>มุมมอง:</strong> FCF คำนวณเป็น OCF ลบเงินซื้อ PPE และเงินต้นสัญญาเช่าการเงิน ตามนิยาม Meta; ใช้ดูเงินสดหลังลงทุนได้ แต่ไม่ใช่เงินสดที่เหลือเพื่อจ่ายอย่างอิสระ</p>
            <p><strong>ข้อจำกัด:</strong> FCF เป็น non-GAAP; ยอดเงินสดและหนี้เป็นยอด ณ วันสิ้นงวด ไม่ใช่ค่าเฉลี่ย</p>
            <SourceLink href={fundamentals?.sourceUrl} label="SEC Q2 2026 10-Q" />
            <SourceLink href={fundamentals?.operational?.disclosureSource} label="คำอธิบาย FCF ของ Meta" />
          </article>

          <article className="panel fundamental-panel">
            <h3>4. การลงทุนและความเสี่ยง</h3>
            <p className="fundamental-what">แยกผลจริงในงวดออกจากแนวทางคาดการณ์และความเสี่ยงที่อาจเกิดในอนาคต</p>
            <MetricDetail label="CapEx รวม Q2 (ผลจริง รวมเงินต้น finance lease)" metric={fundamentals?.operational?.capexActual} />
            <MetricDetail label="CapEx guidance ปี 2026 ต่ำสุด (คาดการณ์)" metric={fundamentals?.operational?.capexGuidanceLow} />
            <MetricDetail label="CapEx guidance ปี 2026 สูงสุด (คาดการณ์)" metric={fundamentals?.operational?.capexGuidanceHigh} />
            <MetricDetail label="Reality Labs operating income (ค่าติดลบ = ขาดทุน)" metric={fundamentals?.operational?.realityLabsOperatingIncome} />
            <MetricDetail label="ค่าใช้จ่ายทางกฎหมาย Q2 (ผลจริง)" metric={fundamentals?.operational?.legalCharges} />
            <MetricDetail label="ค่าใช้จ่าย severance Q2 (ผลจริง)" metric={fundamentals?.operational?.severanceExpenses} />
            <p><strong>มุมมอง:</strong> CapEx เป็นยอดรวม ไม่ได้ระบุว่าใช้กับ AI/ศูนย์ข้อมูลทั้งหมด; ผลขาดทุน Reality Labs และค่าใช้จ่ายทางกฎหมายเป็นผลจริง ส่วนกรอบ CapEx ทั้งปีเป็น guidance เท่านั้น</p>
            <p><strong>ข้อจำกัด/ความเสี่ยง:</strong> Meta ไม่แยกจำนวนเงินลงทุน AI/ศูนย์ข้อมูลในแหล่งนี้; การแข่งขัน พึ่งพาแพลตฟอร์ม/สัญญาณข้อมูล และคดีเยาวชน/กฎระเบียบเป็นความเสี่ยง ไม่ใช่ผลขาดทุนอนาคตที่ยืนยันแล้ว</p>
            <SourceLink href={fundamentals?.operational?.disclosureSource} label="Meta Q2 2026 earnings release and outlook" />
            <SourceLink href={fundamentals?.operational?.segmentSource} label="SEC Q2 2026 segment facts" />
          </article>

          <article className="panel fundamental-panel">
            <h3>5. มูลค่าหุ้น</h3>
            <p className="fundamental-what">คำนวณจากราคาที่มีเวลาอ้างอิง และข้อมูล TTM จากสี่ไตรมาสที่ไม่ซ้ำยอดสะสม</p>
            <MetricDetail label="ราคาหุ้นที่ใช้" metric={valuationPrice} />
            <MetricDetail label="TTM diluted EPS" metric={ttmDilutedEps} />
            <MetricDetail label="P/E (ราคา ÷ diluted EPS TTM)" metric={priceToEarnings} />
            <MetricDetail label="P/Operating Cash Flow (ต่อ diluted share)" metric={fundamentals?.valuation.priceToOperatingCashFlow} />
            <MetricDetail label="P/Free Cash Flow (ต่อ diluted share)" metric={fundamentals?.valuation.priceToFreeCashFlow} />
            <p><strong>มุมมอง:</strong> {priceToEarnings?.value != null
              ? `P/E ที่คำนวณได้ ${formatFundamentalMetric(priceToEarnings)} โดยใช้ราคาที่อ้างอิง ณ ${dateLabel(priceToEarnings.reportedDate)} และ diluted EPS TTM; ควรพิจารณาร่วมกับ P/OCF, P/FCF และแนวโน้มกำไร ไม่สรุปว่าหุ้นถูกหรือแพงจาก P/E เพียงรายการเดียว`
              : 'ยังประเมิน P/E ไม่ได้เพราะราคาอ้างอิงหรือ EPS TTM ยังไม่ครบ; การมีตัวคูณอื่นเพียงอย่างเดียวไม่ได้แปลว่าหุ้นถูกหรือแพง'}</p>
            <p><strong>ข้อจำกัด:</strong> P/OCF และ P/FCF ใช้ diluted weighted-average shares ล่าสุดเป็นตัวหารต่อหุ้น ไม่ใช่จำนวนหุ้นคงค้าง ณ เวลาราคา; ดูข้อความข้อจำกัดด้านล่าง</p>
            {fundamentals?.valuation.limitation && <p className="muted">{fundamentals.valuation.limitation}</p>}
            {fundamentals?.valuation.missing?.filter((missing) =>
              !missing.toLowerCase().includes('diluted eps') || !metricAvailable(ttmDilutedEps),
            ).length ? (
              <p><strong>ข้อมูลที่ยังขาด:</strong> {fundamentals.valuation.missing.filter((missing) =>
                !missing.toLowerCase().includes('diluted eps') || !metricAvailable(ttmDilutedEps),
              ).join(', ')}</p>
            ) : null}
            <SourceLink href={fundamentals?.valuation.price?.source} label="Twelve Data quote" />
            <SourceLink href={fundamentals?.sourceUrl} label="SEC filing สำหรับ EPS/กระแสเงินสด" />
          </article>

          <article className="panel fundamental-panel history-panel">
            <h3>ประวัติผลประกอบการ (แยกงวด ไม่รวมยอดสะสมซ้ำ)</h3>
            <p>งบรายปีและสี่ไตรมาสล่าสุดมาจาก SEC Company Facts; รายการ Q4 diluted EPS ปี 2025 ใช้ตัวเลขรายไตรมาสที่ Meta เปิดเผยโดยตรง เพราะ EPS ไม่สามารถคำนวณจากยอดสะสมได้โดยไม่เสี่ยงเปลี่ยนฐานหุ้นถัวเฉลี่ย และแสดงแหล่งที่มากับวันประกาศในรายละเอียด</p>
            <h4>รายปี — 3 ปีล่าสุด</h4>
            <FundamentalHistoryTable rows={fundamentals?.history.annual ?? []} />
            <h4>รายไตรมาส — 4 ไตรมาสล่าสุด</h4>
            <FundamentalHistoryTable rows={fundamentals?.history.quarterly ?? []} />
            <p className="muted">ตัวเลขรายไตรมาสเป็น flow ของไตรมาสนั้น ไม่ใช่ยอด YTD; YoY ใช้ Q2 2026 เทียบ Q2 2025 แยกจากช่วง TTM สำหรับมูลค่าหุ้น</p>
            <SourceLink href={fundamentals?.annualSourceUrl} label="Meta financial reports archive" />
            <SourceLink href={fundamentals?.sourceUrl} label="SEC filing ล่าสุด" />
          </article>
        </section>
      )}

      {activeTab === 'summary' && (
        <section className="investment-summary">
          <article className="panel summary-overview-panel">
            <div className="summary-heading">
              <div>
                <p className="kicker">META · {interval === '1day' ? 'รายวัน' : 'รายสัปดาห์'}</p>
                <h3>สรุปการลงทุนจากข้อมูลที่โหลดจริง</h3>
              </div>
              <div className={`summary-state ${combinedReady ? 'neutral' : 'warning'}`}>{combinedSignal}</div>
            </div>
            <div className="summary-source-status">
              <span>ข้อมูลราคา: <strong>{source?.status === 'connected' ? 'เชื่อมต่อแล้ว' : 'ยังไม่เชื่อมต่อ'}</strong> · {source?.provider ?? 'ไม่มีผู้ให้บริการ'}</span>
              <span>ข้อมูลพื้นฐาน: <strong>{fundamentals?.status === 'connected' ? 'เชื่อมต่อ SEC แล้ว' : 'ยังไม่เชื่อมต่อ'}</strong> · ตรวจ {fundamentals?.checkedAt ? new Date(fundamentals.checkedAt).toLocaleString('th-TH') : 'ไม่มีเวลาอ้างอิง'}</span>
              <span>ความครบถ้วน: <strong>{summaryCoverage.filter((item) => item.ready).length}/5 ด้านพื้นฐาน</strong> · เทคนิค {summaryTechnicalReady ? 'เพียงพอ' : 'ยังไม่เพียงพอ'}</span>
            </div>
            <div className="summary-price-reference">
              <div>
                <span>ราคาปิดแท่งที่ใช้วิเคราะห์</span>
                <strong>{latestClosedCandle ? fmtCurrency(latestClosedCandle.close) : 'ไม่มีแท่งที่ปิดแล้ว'}</strong>
                <small>{latestClosedCandle ? `${dateLabel(latestClosedCandle.date)} · ${interval === '1day' ? 'รายวัน' : 'รายสัปดาห์'}` : 'ข้อมูลราคาไม่พอ'}</small>
              </div>
              <div>
                <span>ราคา quote จากแหล่งข้อมูล</span>
                <strong>{fmtCurrency(source?.quote?.price ?? fundamentals?.price?.value ?? fundamentals?.valuation.price?.value ?? null)}</strong>
                <small>
                  อัปเดต {source?.lastUpdated ?? fundamentals?.price?.reportedDate ?? fundamentals?.valuation.price?.reportedDate ?? 'ไม่มีเวลาอ้างอิง'} ·{' '}
                  {source?.priceStatus ?? source?.providerDelay ?? fundamentals?.priceStatus ?? 'ผู้ให้บริการไม่ระบุว่าเป็นราคาปัจจุบันหรือล่าช้า'}
                </small>
              </div>
              <div>
                <span>ข้อมูลแท่ง/ตัวชี้วัด</span>
                <strong>{summaryDate ? dateLabel(summaryDate) : 'ข้อมูลไม่เพียงพอ'}</strong>
                <small>คำนวณจากประวัติเต็มก่อนเลือกช่วงแสดง · สถานะแท่งประเมินจากเวลาตลาด ไม่ได้มาจาก flag ของ provider</small>
              </div>
            </div>
            {!combinedReady && (
              <p className="summary-missing">
                <strong>ข้อมูลที่ยังขาด:</strong> {[...new Set(combinedMissing)].join(' · ') || 'ข้อมูลหลักบางส่วนยังไม่พร้อม'}
              </p>
            )}
          </article>

          <article className="panel summary-technical-panel">
            <div className="summary-heading">
              <h3>Technical · ข้อมูลแท่งปิดล่าสุด</h3>
              <span>{summaryDate ? dateLabel(summaryDate) : 'ไม่มีข้อมูลแท่งปิด'}</span>
            </div>
            <div className="summary-tech-grid">
              <div>
                <span>แนวโน้ม EMA {emaConfig.period50}/{emaConfig.period200}</span>
                <strong>{summaryTechnicalSignal}</strong>
                <small>
                  {latestSignal
                    ? `ตัดกันล่าสุด: ${signalLabel(latestSignal.kind, emaConfig.period50, emaConfig.period200)} · ${dateLabel(latestSignal.date)}`
                    : signalAnalysis.alignment.state === 'insufficient'
                      ? 'ข้อมูลไม่เพียงพอสำหรับตรวจ EMA'
                      : 'ไม่พบการตัดกันในประวัติข้อมูลที่มี'}
                </small>
              </div>
              <div>
                <span>RSI 14 · Wilder/RMA</span>
                <strong>{summaryRsi == null ? 'ข้อมูลไม่เพียงพอ' : summaryRsi.toFixed(2)}</strong>
                <small>
                  {summaryRsi == null
                    ? 'ต้องมีราคาเปลี่ยนแปลงครบ 14 ช่วง'
                    : summaryRsi > 70
                      ? 'อยู่เหนือระดับ 70 ตามเกณฑ์ซื้อมาก ไม่ใช่คำสั่งขาย'
                      : summaryRsi < 30
                        ? 'อยู่ต่ำกว่าระดับ 30 ตามเกณฑ์ขายมาก ไม่ใช่คำสั่งซื้อ'
                        : 'อยู่ระหว่างระดับ 30–70'}
                </small>
              </div>
              <div>
                <span>MACD 12/26/9 · ค่าผลต่าง</span>
                <strong>{summaryMacd?.macd == null ? 'ข้อมูลไม่เพียงพอ' : summaryMacd.macd.toFixed(2)}</strong>
                <small>
                  Signal {summaryMacd?.signal == null ? '—' : summaryMacd.signal.toFixed(2)}
                  {' · '}Histogram {summaryMacd?.histogram == null ? '—' : summaryMacd.histogram.toFixed(2)}
                  {summaryMacd?.histogram != null &&
                    ` · MACD ${summaryMacd.histogram > 0 ? 'อยู่เหนือ' : summaryMacd.histogram < 0 ? 'อยู่ต่ำกว่า' : 'เท่ากับ'} Signal`}
                </small>
                <small>
                  {latestMacdCross
                    ? `MACD ตัด Signal ${latestMacdCross.direction === 'up' ? 'ขึ้น' : 'ลง'} ล่าสุด ${dateLabel(latestMacdCross.date)}`
                    : 'ไม่พบเหตุการณ์ MACD ตัด Signal ในประวัติแท่งปิด'}
                </small>
              </div>
            </div>
            <p className="muted">ผล RSI/MACD และเหตุการณ์ cross คำนวณจากกรอบเวลานี้ ไม่ได้อนุมานว่าเป็นสัญญาณซื้อหรือขายโดยอัตโนมัติ</p>
          </article>

          <div className="summary-fundamental-grid">
            <article className="panel summary-fundamental-card">
              <SummarySectionHeading title="1. รายได้และกำไร" ready={summaryCoverage[0].ready} period={fundamentals?.latest?.period} />
              <MetricDetail label="รายได้รวม" metric={fundamentalMetrics?.revenue} />
              <MetricDetail label="รายได้โฆษณา" metric={fundamentalMetrics?.advertisingRevenue} />
              <MetricDetail label="กำไรสุทธิ" metric={fundamentalMetrics?.netIncome} />
              <MetricDetail label="Diluted EPS" metric={fundamentalMetrics?.dilutedEps} />
              <MetricDetail label="Operating margin" metric={fundamentalMetrics?.operatingMargin} />
              <MetricDetail label="Net margin" metric={fundamentalMetrics?.netMargin} />
              <p>{changeImplication('รายได้รวม', fundamentalMetrics?.revenue, comparisonMetrics?.revenue)}</p>
              <p>{changeImplication('กำไรสุทธิ', fundamentalMetrics?.netIncome, comparisonMetrics?.netIncome)}</p>
              <p>{changeImplication('Diluted EPS', fundamentalMetrics?.dilutedEps, comparisonMetrics?.dilutedEps)}</p>
              {fundamentalMetrics?.revenue?.value != null &&
                fundamentalMetrics.netIncome?.value != null &&
                comparisonMetrics?.revenue?.value != null &&
                comparisonMetrics.netIncome?.value != null &&
                ((fundamentalMetrics.revenue.value > comparisonMetrics.revenue.value &&
                  fundamentalMetrics.netIncome.value < comparisonMetrics.netIncome.value) ||
                  (fundamentalMetrics.revenue.value < comparisonMetrics.revenue.value &&
                    fundamentalMetrics.netIncome.value > comparisonMetrics.netIncome.value)) && (
                  <p className="summary-caution">รายได้และกำไรสุทธิเคลื่อนไหวคนละทิศ จึงไม่สรุปว่าความสามารถทำกำไรดีขึ้นจากรายได้เพียงอย่างเดียว</p>
                )}
              <SourceLink href={fundamentals?.sourceUrl} label="SEC filing และตัวเลขรายไตรมาส" />
              <SourceLink href={fundamentals?.operational?.disclosureSource} label="Meta earnings release" />
            </article>

            <article className="panel summary-fundamental-card">
              <SummarySectionHeading title="2. ผู้ใช้งานและโฆษณา" ready={summaryCoverage[1].ready} period={fundamentals?.operational?.dap.period} />
              <MetricDetail label="DAP" metric={fundamentals?.operational?.dap} />
              <MetricDetail label="DAP เปลี่ยนแปลง YoY" metric={fundamentals?.operational?.dapYoY} />
              <MetricDetail label="Ad impressions เปลี่ยนแปลง YoY" metric={fundamentals?.operational?.adImpressionsYoY} />
              <MetricDetail label="ราคาเฉลี่ยต่อโฆษณาเปลี่ยนแปลง YoY" metric={fundamentals?.operational?.averagePricePerAdYoY} />
              <MetricDetail label="รายได้โฆษณา" metric={fundamentals?.operational?.advertisingRevenue} />
              <p>
                {fundamentals?.operational?.dap.value != null &&
                fundamentals.operational.adImpressionsYoY.value != null &&
                fundamentals.operational.averagePricePerAdYoY.value != null
                  ? `ข้อมูลที่รายงานระบุ DAP ${formattedMetricValue(fundamentals.operational.dap)} และการเปลี่ยนแปลงของ impressions ${formattedMetricValue(fundamentals.operational.adImpressionsYoY)} กับราคาเฉลี่ย ${formattedMetricValue(fundamentals.operational.averagePricePerAdYoY)}; เป็นองค์ประกอบรายได้โฆษณาที่ควรพิจารณาร่วมกัน`
                  : 'ข้อมูลผู้ใช้งานหรืออัตราโฆษณายังไม่ครบ จึงยังสรุปแนวโน้มทั้งกลุ่มไม่ได้'}
              </p>
              <p className="muted">DAP เป็นค่าเฉลี่ยผู้ใช้งานรายวันในช่วงที่รายงาน ไม่ใช่จำนวนบัญชีบุคคลเฉพาะ ส่วน impressions และราคาต่อโฆษณาเป็นอัตรา YoY เมื่อแหล่งรายงานไม่เปิดเผยค่าจำนวนจริง</p>
              <SourceLink href={fundamentals?.operational?.disclosureSource} label="Meta earnings release" />
              <SourceLink href={fundamentals?.operational?.segmentSource} label="SEC segment facts" />
            </article>

            <article className="panel summary-fundamental-card">
              <SummarySectionHeading title="3. เงินสดและหนี้" ready={summaryCoverage[2].ready} period={fundamentals?.latest?.period} />
              <MetricDetail label="Operating cash flow ในงวดล่าสุด" metric={fundamentalMetrics?.operatingCashFlow} />
              <MetricDetail label="Free Cash Flow ในงวดล่าสุด" metric={fundamentalMetrics?.freeCashFlow} />
              <MetricDetail label="Operating cash flow TTM" metric={fundamentals?.valuation.ttmOperatingCashFlow} />
              <MetricDetail label="Free Cash Flow TTM" metric={fundamentals?.valuation.ttmFreeCashFlow} />
              <MetricDetail label="เงินสดและ marketable securities" metric={fundamentalMetrics?.cashAndMarketableSecurities} />
              <MetricDetail label="หนี้ระยะยาวที่รายงาน" metric={fundamentalMetrics?.longTermDebt} />
              <p>
                {fundamentalMetrics?.operatingCashFlow?.value != null && fundamentalMetrics.freeCashFlow?.value != null
                  ? `งวด ${fundamentalMetrics.operatingCashFlow.period}: OCF ${formattedMetricValue(fundamentalMetrics.operatingCashFlow)} และ FCF ${formattedMetricValue(fundamentalMetrics.freeCashFlow)} หลังหักรายการตามนิยาม Meta; ต้องพิจารณาร่วมกับเงินลงทุนและยอดเงินสด ณ วันสิ้นงวด`
                  : 'ไม่มีตัวเลข OCF/FCF ของงวดล่าสุดครบพอสำหรับประเมินเงินสดหลังลงทุน'}
              </p>
              <p className="muted">ยอดเงินสดและหนี้เป็นยอด ณ วันสิ้นงวด ไม่ใช่ค่าเฉลี่ย; FCF เป็น non-GAAP และคำนวณตามนิยามที่ระบุในรายละเอียดตัวเลข</p>
              <SourceLink href={fundamentals?.sourceUrl} label="SEC filing: cash flow และ balance sheet" />
            </article>

            <article className="panel summary-fundamental-card">
              <SummarySectionHeading title="4. การลงทุนและความเสี่ยง" ready={summaryCoverage[3].ready} period={fundamentals?.operational?.capexActual.period} />
              <MetricDetail label="CapEx ที่เกิดขึ้นจริง" metric={fundamentals?.operational?.capexActual} />
              <MetricDetail label="CapEx guidance ต่ำสุด (คาดการณ์)" metric={fundamentals?.operational?.capexGuidanceLow} />
              <MetricDetail label="CapEx guidance สูงสุด (คาดการณ์)" metric={fundamentals?.operational?.capexGuidanceHigh} />
              <MetricDetail label="Reality Labs operating income (ค่าติดลบคือขาดทุน)" metric={fundamentals?.operational?.realityLabsOperatingIncome} />
              <MetricDetail label="ค่าใช้จ่ายทางกฎหมาย" metric={fundamentals?.operational?.legalCharges} />
              <MetricDetail label="ค่าใช้จ่าย severance" metric={fundamentals?.operational?.severanceExpenses} />
              <MetricDetail label="ต้นทุนและค่าใช้จ่ายเปลี่ยนแปลง YoY" metric={fundamentals?.operational?.costAndExpensesYoY} />
              <MetricDetail label="Reality Labs operating income งวดปีก่อน" metric={fundamentals?.operational?.priorRealityLabsOperatingIncome} />
              <p>{capexImpactText}</p>
              <p>
                {fundamentals?.operational?.costAndExpensesYoY?.value != null
                  ? `ต้นทุนและค่าใช้จ่ายรวมเปลี่ยน ${formattedMetricValue(fundamentals.operational.costAndExpensesYoY)} ตามรายงาน ซึ่งเป็นแรงกดดันด้านค่าใช้จ่ายที่ต้องชั่งกับรายได้และกำไรในงวดเดียวกัน`
                  : 'ไม่มีข้อมูลเปรียบเทียบต้นทุนและค่าใช้จ่าย YoY'}
                {fundamentals?.operational?.realityLabsOperatingIncome?.value != null
                  ? ` Reality Labs มี operating income ${formattedMetricValue(fundamentals.operational.realityLabsOperatingIncome)} ในงวด ${fundamentals.operational.realityLabsOperatingIncome.period}; ค่าติดลบหมายถึงผลขาดทุน`
                  : ' ไม่มีข้อมูล operating income ของ Reality Labs'}
              </p>
              {fundamentals?.risks && Object.entries(fundamentals.risks).map(([key, risk]) => (
                <div className="summary-risk" key={key}>
                  <strong>{key === 'competition' ? 'การแข่งขัน' : key === 'legal' ? 'กฎหมาย/กฎระเบียบ' : key === 'investment' ? 'การลงทุน' : key}</strong>
                  <span>{risk.text} · งวดสิ้นสุด {dateLabel(risk.periodEnd)} · ประกาศ {dateLabel(risk.reportedDate)}</span>
                  <a href={risk.source} target="_blank" rel="noreferrer">แหล่งอ้างอิง</a>
                </div>
              ))}
              <p className="muted">CapEx เป็นตัวเลขรวม รายงานไม่ได้แยกสัดส่วนที่ใช้กับ AI/ศูนย์ข้อมูลทั้งหมด; guidance เป็นความคาดหวัง ไม่ใช่ผลจริง ส่วนรายการค่าใช้จ่ายและ Reality Labs แสดงตามงวดที่ระบุ</p>
              <SourceLink href={fundamentals?.operational?.disclosureSource} label="Meta earnings release และ outlook" />
              <SourceLink href={fundamentals?.operational?.segmentSource} label="SEC segment facts" />
            </article>

            <article className="panel summary-fundamental-card">
              <SummarySectionHeading title="5. มูลค่าหุ้น" ready={summaryCoverage[4].ready} period={ttmDilutedEps?.period} />
              <MetricDetail label="ราคาหุ้นที่ใช้คำนวณ" metric={valuationPrice} />
              <MetricDetail label="Diluted EPS TTM" metric={ttmDilutedEps} />
              <MetricDetail label="P/E จาก EPS TTM" metric={priceToEarnings} />
              <MetricDetail label="P/Operating Cash Flow" metric={fundamentals?.valuation.priceToOperatingCashFlow} />
              <MetricDetail label="P/Free Cash Flow" metric={fundamentals?.valuation.priceToFreeCashFlow} />
              {ttmDilutedEps?.basis === 'sum-of-four-quarters' && (
                <p>EPS TTM คำนวณจากผลรวม EPS diluted รายไตรมาส 4 งวดต่อเนื่องที่ประกาศแล้ว ไม่ใช้ EPS ทั้งปีแทนไตรมาส; ผลรวมอาจต่างจาก EPS รายปีเนื่องจากจำนวนหุ้นถัวเฉลี่ยปรับลดเปลี่ยนไปในแต่ละงวด</p>
              )}
              <h4>ตรวจสอบ EPS ที่ใช้คำนวณ TTM</h4>
              {quarterlyEpsAuditRows.length ? (
                <div className="table-scroll">
                  <table className="fundamental-table eps-audit-table">
                    <thead>
                      <tr>
                        <th>ไตรมาส</th>
                        <th>วันเริ่มงวด</th>
                        <th>วันสิ้นงวด</th>
                        <th>Diluted EPS</th>
                        <th>ประกาศเมื่อ</th>
                        <th>แหล่งที่มา</th>
                      </tr>
                    </thead>
                    <tbody>
                      {quarterlyEpsAuditRows.map((quarter) => {
                        const metric = quarter.metrics.dilutedEps;
                        return (
                          <tr key={`${quarter.periodStart}-${quarter.periodEnd}`}>
                            <th>{quarter.period}</th>
                            <td>{quarter.periodStart}</td>
                            <td>{quarter.periodEnd}</td>
                            <td>{formatFundamentalMetric(metric)}</td>
                            <td>{metric?.reportedDate ?? 'ไม่มีข้อมูล'}</td>
                            <td>{metric?.source ? <a href={metric.source} target="_blank" rel="noreferrer">รายงาน/SEC</a> : 'ไม่มีข้อมูล'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              ) : <p>ไม่มีข้อมูลไตรมาสสำหรับตรวจสอบ</p>}
              <p>P/E เทียบราคากับกำไรต่อหุ้นย้อนหลัง 12 เดือน ส่วน P/OCF และ P/FCF เทียบราคากับกระแสเงินสดต่อ diluted share; ตัวคูณเหล่านี้ไม่มีค่าเดียวที่สรุปว่าหุ้นถูกหรือแพงได้โดยลำพัง</p>
              <p className="muted">{fundamentals?.valuation.limitation ?? 'ข้อจำกัดเรื่องราคาหรือช่วง TTM ยังไม่มีข้อมูล'}</p>
              {fundamentals?.valuation.missing?.length ? <p><strong>ยังขาด:</strong> {fundamentals.valuation.missing.join(', ')}</p> : null}
              <SourceLink href={valuationPrice?.source} label="แหล่งราคาอ้างอิง" />
              <SourceLink href={fundamentals?.sourceUrl} label="SEC filing สำหรับข้อมูล TTM" />
            </article>
          </div>
          <article className="panel summary-disclaimer">
            <p>ข้อมูลพื้นฐานตรวจล่าสุด {fundamentals?.checkedAt ? new Date(fundamentals.checkedAt).toLocaleString('th-TH') : 'ไม่มีข้อมูล'} · ราคาอ้างอิงจาก {source?.provider ?? 'แหล่งข้อมูลที่ยังไม่พร้อม'} · ใช้กรอบเวลา {range} / {interval === '1day' ? 'รายวัน' : 'รายสัปดาห์'} และช่วง fundamental ตามงวด/วันประกาศที่แสดงในแต่ละตัวเลข</p>
            <p>ตัวชี้วัดมีความเก่าตามวันตรวจและวันประกาศ ไม่ใช่ข้อมูล real-time ทั้งหมด; ข้อความนี้เป็นการสังเคราะห์ตัวเลข ไม่ใช่คำแนะนำซื้อขายหรือการรับประกันผลตอบแทน</p>
            <SourceLink href={source?.sourceUrl} label="Twelve Data documentation" />
            <SourceLink href={fundamentals?.sourceUrl} label="SEC filing ล่าสุด" />
            <SourceLink href={fundamentals?.annualSourceUrl} label="Meta financial reports" />
          </article>
        </section>
      )}
    </div>
  );
}

type StatCardProps = {
  label: string;
  value: string;
  accent?: 'green' | 'red' | 'blue' | 'purple' | 'amber';
};

function StatCard({ label, value, accent = 'blue' }: StatCardProps) {
  return (
    <div className={`stat-card ${accent}`}>
      <div className="label">{label}</div>
      <strong>{value}</strong>
    </div>
  );
}

function SummarySectionHeading({
  title,
  ready,
  period,
}: {
  title: string;
  ready: boolean;
  period?: string;
}) {
  return (
    <div className="summary-section-heading">
      <div>
        <h3>{title}</h3>
        <small>{period ? `งวด ${period}` : 'งวดข้อมูลยังไม่ครบ'}</small>
      </div>
      <span className={ready ? 'summary-coverage ready' : 'summary-coverage'}>
        {ready ? 'ข้อมูลพอวิเคราะห์' : 'ข้อมูลไม่ครบ'}
      </span>
    </div>
  );
}

function MetricDetail({ label, metric }: { label: string; metric: FundamentalMetric | null | undefined }) {
  const basisLabels: Record<string, string> = {
    'sec-companyfacts': 'SEC Company Facts',
    'sec-ytd-difference': 'คำนวณจากผลต่างยอดสะสม SEC',
    calculated: 'คำนวณจากตัวเลข SEC ในงวดเดียวกัน',
    'meta-definition-derived': 'คำนวณตามนิยาม Free Cash Flow ของ Meta',
    'verified-report-snapshot': 'snapshot ตรวจสอบกับรายงาน Meta',
    'sec-inline-xbrl': 'SEC inline XBRL',
    'sec-companyfacts-calculated': 'รวมข้อมูล SEC Company Facts',
    'calculated-per-diluted-share': 'คำนวณต่อ diluted share',
    'sum-of-four-quarters': 'รวมสี่ไตรมาสไม่ซ้ำกัน',
    unavailable: 'ไม่มีตัวเลขที่เปิดเผยสำหรับงวดนี้',
  };
  return (
    <div className="metric-detail">
      <span>{label}</span>
      <strong>{formatFundamentalMetric(metric)}</strong>
      <small>
        งวด {metric?.period || 'ไม่มีข้อมูล'} · สิ้นงวด {dateLabel(metric?.periodEnd)} · ประกาศ {dateLabel(metric?.reportedDate)} · ตรวจ {metric?.checkedAt ? new Date(metric.checkedAt).toLocaleString('th-TH') : 'ไม่มีข้อมูล'}
        {' · '}{basisLabels[metric?.basis ?? ''] ?? metric?.basis ?? 'ไม่มีข้อมูล'}
      </small>
      {metric?.source && <a href={metric.source} target="_blank" rel="noreferrer">แหล่งอ้างอิง</a>}
    </div>
  );
}

function SourceLink({ href, label }: { href: string | null | undefined; label: string }) {
  if (!href) return null;
  return <a className="source-link" href={href} target="_blank" rel="noreferrer">{label}</a>;
}

function FundamentalHistoryTable({ rows }: { rows: FundamentalPeriod[] }) {
  const columns = [
    ['revenue', 'รายได้'],
    ['netIncome', 'กำไรสุทธิ'],
    ['dilutedEps', 'Diluted EPS'],
    ['operatingMargin', 'Operating margin'],
    ['operatingCashFlow', 'OCF'],
    ['freeCashFlow', 'FCF'],
    ['ppePurchases', 'PPE'],
  ] as const;

  if (!rows.length) return <p>ยังไม่มีประวัติ SEC ที่โหลดได้</p>;
  return (
    <div className="table-scroll">
      <table className="fundamental-table">
        <thead>
          <tr>
            <th>งวด</th>
            {columns.map(([, title]) => <th key={title}>{title}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.period}>
              <th>{row.period}</th>
              {columns.map(([key]) => {
                const metric = row.metrics[key];
                return (
                  <td key={key}>
                    <span>{formatFundamentalMetric(metric)}</span>
                    <details>
                      <summary>ที่มา/เวลา</summary>
                      <MetricDetail label={key} metric={metric} />
                    </details>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

type CandlestickChartProps = {
  data: Candle[];
  range: RangeKey;
  interval: IntervalKey;
  selectedDate: string | null;
  onSelectDate: (value: string | null) => void;
  show50: boolean;
  show200: boolean;
  period50: number;
  period200: number;
  status: string;
  provider: string;
  lastUpdated: string | null;
  quoteDate: string | null;
  actionsRef: React.MutableRefObject<ChartActions | null>;
  signals: EmaCrossSignal[];
  showSignalMarkers: boolean;
  fastPeriod: number;
  slowPeriod: number;
  showRsi: boolean;
  showMacd: boolean;
  rsiValues: Map<string, number | null | undefined>;
  macdValues: Map<string, MacdPoint>;
  macdCrosses: MacdCross[];
};

function CandlestickChart({
  data,
  range,
  interval,
  selectedDate,
  onSelectDate,
  show50,
  show200,
  period50,
  period200,
  status,
  provider,
  lastUpdated,
  quoteDate,
  actionsRef,
  signals,
  showSignalMarkers,
  fastPeriod,
  slowPeriod,
  showRsi,
  showMacd,
  rsiValues,
  macdValues,
  macdCrosses,
}: CandlestickChartProps) {
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const ema50SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ema200SeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const volumeSeriesRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const rsiSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const macdSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const macdSignalSeriesRef = useRef<ISeriesApi<'Line'> | null>(null);
  const macdHistogramRef = useRef<ISeriesApi<'Histogram'> | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const markerSignatureRef = useRef('');
  const hasUserRangeRef = useRef(false);
  const appliedViewRef = useRef<{ range: RangeKey; interval: IntervalKey } | null>(null);
  const dataByDateRef = useRef(new Map<string, Candle>());
  const rangeRef = useRef(range);

  useEffect(() => {
    rangeRef.current = range;
  }, [range]);

  const visibleData = useMemo(() => filterSeriesByRange(data, range), [data, range]);
  const ema50ByDate = useMemo(() => calculateEmaByDate(data, period50, 'ema50'), [data, period50]);
  const ema200ByDate = useMemo(() => calculateEmaByDate(data, period200, 'ema200'), [data, period200]);
  const candleData = useMemo<CandlestickData<Time>[]>(
    () =>
      data.map((candle) => ({
        time: toChartTime(candle.date),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
    [data],
  );
  const ema50Data = useMemo<(LineData<Time> | WhitespaceData<Time>)[]>(
    () =>
      data.map((candle) => {
        const time = toChartTime(candle.date);
        const value = ema50ByDate.get(dateKey(candle.date));
        return value == null ? { time } : { time, value };
      }),
    [data, ema50ByDate],
  );
  const ema200Data = useMemo<(LineData<Time> | WhitespaceData<Time>)[]>(
    () =>
      data.map((candle) => {
        const time = toChartTime(candle.date);
        const value = ema200ByDate.get(dateKey(candle.date));
        return value == null ? { time } : { time, value };
      }),
    [data, ema200ByDate],
  );
  const volumeData = useMemo<HistogramData<Time>[]>(
    () =>
      data.flatMap((candle) =>
        candle.volume == null || !Number.isFinite(candle.volume)
          ? []
          : [{
              time: toChartTime(candle.date),
              value: candle.volume,
              color: candle.close >= candle.open ? 'rgba(38, 166, 154, 0.55)' : 'rgba(239, 83, 80, 0.55)',
            }],
      ),
    [data],
  );
  const rsiData = useMemo<LineData<Time>[]>(
    () => data.flatMap((candle) => {
      const value = rsiValues.get(dateKey(candle.date));
      return value == null ? [] : [{ time: toChartTime(candle.date), value }];
    }),
    [data, rsiValues],
  );
  const macdLineData = useMemo<LineData<Time>[]>(
    () => data.flatMap((candle) => {
      const value = macdValues.get(dateKey(candle.date))?.macd;
      return value == null ? [] : [{ time: toChartTime(candle.date), value }];
    }),
    [data, macdValues],
  );
  const macdSignalData = useMemo<LineData<Time>[]>(
    () => data.flatMap((candle) => {
      const value = macdValues.get(dateKey(candle.date))?.signal;
      return value == null ? [] : [{ time: toChartTime(candle.date), value }];
    }),
    [data, macdValues],
  );
  const macdHistogramData = useMemo<HistogramData<Time>[]>(
    () => data.flatMap((candle) => {
      const value = macdValues.get(dateKey(candle.date))?.histogram;
      return value == null
        ? []
        : [{
            time: toChartTime(candle.date),
            value,
            color: value >= 0 ? '#16a34a' : '#dc2626',
          }];
    }),
    [data, macdValues],
  );
  const selectedCandle = useMemo(() => {
    const visibleByDate = new Map(visibleData.map((candle) => [dateKey(candle.date), candle]));
    return (selectedDate ? visibleByDate.get(selectedDate) : null) ?? visibleData.at(-1) ?? null;
  }, [selectedDate, visibleData]);
  const selectedEma50 = selectedCandle ? ema50ByDate.get(dateKey(selectedCandle.date)) ?? null : null;
  const selectedEma200 = selectedCandle ? ema200ByDate.get(dateKey(selectedCandle.date)) ?? null : null;
  const selectedRsi = selectedCandle ? rsiValues.get(dateKey(selectedCandle.date)) ?? null : null;
  const selectedMacd = selectedCandle ? macdValues.get(dateKey(selectedCandle.date)) : undefined;
  const selectedMacdCross = selectedCandle
    ? macdCrosses.find((cross) => cross.date === dateKey(selectedCandle.date)) ?? null
    : null;

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;

    const chart = createChart(surface, {
      autoSize: true,
      height: 900,
      layout: {
        background: { color: '#ffffff' },
        textColor: '#1f2937',
        fontFamily: 'Inter, ui-sans-serif, system-ui, sans-serif',
        fontSize: 12,
        attributionLogo: true,
      },
      grid: {
        vertLines: { color: '#edf0f3' },
        horzLines: { color: '#edf0f3' },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: '#64748b', width: 1, style: 2, labelBackgroundColor: '#475569' },
        horzLine: { color: '#64748b', width: 1, style: 2, labelBackgroundColor: '#475569' },
      },
      rightPriceScale: {
        visible: true,
        borderColor: '#e2e8f0',
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      leftPriceScale: {
        visible: false,
      },
      timeScale: {
        borderColor: '#e2e8f0',
        timeVisible: false,
        rightOffset: 6,
        barSpacing: 8,
        minBarSpacing: 2,
        fixLeftEdge: false,
        fixRightEdge: false,
      },
      handleScroll: {
        mouseWheel: true,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: true,
        axisDoubleClickReset: true,
      },
      localization: { locale: 'en-US' },
    });
    chart.addPane(true);
    chart.addPane(true);
    chart.addPane(true);
    const [pricePane, volumePane, rsiPane, macdPane] = chart.panes();
    pricePane.setStretchFactor(6.5);
    volumePane.setStretchFactor(1.3);
    rsiPane.setStretchFactor(1.4);
    macdPane.setStretchFactor(1.5);
    const candles = chart.addSeries(CandlestickSeries, {
      upColor: '#26a69a',
      downColor: '#ef5350',
      borderUpColor: '#26a69a',
      borderDownColor: '#ef5350',
      wickUpColor: '#26a69a',
      wickDownColor: '#ef5350',
      borderVisible: true,
      wickVisible: true,
      lastValueVisible: true,
      priceLineVisible: true,
      priceLineWidth: 1,
      priceLineStyle: 2,
      priceLineColor: '#64748b',
      priceFormat: { type: 'custom', minMove: 0.01, formatter: (price: number) => `$${price.toFixed(2)}` },
    });
    const ema50 = chart.addSeries(LineSeries, {
      color: '#2563eb',
      lineWidth: 2,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      title: 'EMA 50',
      priceFormat: { type: 'custom', minMove: 0.01, formatter: (price: number) => `$${price.toFixed(2)}` },
    });
    const ema200 = chart.addSeries(LineSeries, {
      color: '#7c3aed',
      lineWidth: 2,
      lastValueVisible: false,
      priceLineVisible: false,
      crosshairMarkerVisible: false,
      title: 'EMA 200',
      priceFormat: { type: 'custom', minMove: 0.01, formatter: (price: number) => `$${price.toFixed(2)}` },
    });
    const volume = chart.addSeries(HistogramSeries, {
      priceScaleId: 'left',
      priceFormat: {
        type: 'custom',
        minMove: 1,
        formatter: (value: number) => compactVolume(value),
      },
      lastValueVisible: false,
      priceLineVisible: false,
      base: 0,
    }, 1);
    const rsi = chart.addSeries(LineSeries, {
      color: '#6d28d9',
      lineWidth: 2,
      title: 'RSI 14',
      lastValueVisible: true,
      priceLineVisible: false,
      crosshairMarkerVisible: true,
      priceFormat: { type: 'custom', minMove: 0.01, formatter: (value: number) => value.toFixed(2) },
      autoscaleInfoProvider: () => ({ priceRange: { minValue: 0, maxValue: 100 } }),
    }, 2);
    [30, 50, 70].forEach((price) => {
      rsi.createPriceLine({
        price,
        color: price === 50 ? '#cbd5e1' : '#94a3b8',
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: String(price),
      });
    });
    const macd = chart.addSeries(LineSeries, {
      color: '#2563eb',
      lineWidth: 2,
      title: 'MACD',
      lastValueVisible: true,
      priceLineVisible: false,
      crosshairMarkerVisible: true,
      priceFormat: { type: 'custom', minMove: 0.01, formatter: (value: number) => value.toFixed(2) },
    }, 3);
    const macdSignal = chart.addSeries(LineSeries, {
      color: '#f97316',
      lineWidth: 2,
      title: 'Signal',
      lastValueVisible: true,
      priceLineVisible: false,
      crosshairMarkerVisible: true,
      priceFormat: { type: 'custom', minMove: 0.01, formatter: (value: number) => value.toFixed(2) },
    }, 3);
    const macdHistogram = chart.addSeries(HistogramSeries, {
      priceFormat: { type: 'custom', minMove: 0.01, formatter: (value: number) => value.toFixed(2) },
      lastValueVisible: false,
      priceLineVisible: false,
      base: 0,
    }, 3);
    macd.createPriceLine({
      price: 0,
      color: '#94a3b8',
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      axisLabelVisible: true,
      title: '0',
    });
    volumePane.priceScale('left').applyOptions({
      visible: true,
      borderColor: '#e2e8f0',
      scaleMargins: { top: 0.08, bottom: 0.02 },
    });
    rsiPane.priceScale('right').applyOptions({ visible: true, borderColor: '#e2e8f0' });
    macdPane.priceScale('right').applyOptions({ visible: true, borderColor: '#e2e8f0' });
    const markers = createSeriesMarkers(candles, [], { zOrder: 'aboveSeries' });
    const handleCrosshairMove = (event: { time?: Time; point?: { x: number; y: number } | null }) => {
      if (!event.time || !event.point) {
        onSelectDate(null);
        return;
      }
      const key = toDateKeyFromChartTime(event.time);
      onSelectDate(dataByDateRef.current.has(key) ? key : null);
    };
    const handleVisibleRange = () => {
      hasUserRangeRef.current = true;
    };
    chart.subscribeCrosshairMove(handleCrosshairMove);
    chart.timeScale().subscribeVisibleLogicalRangeChange(handleVisibleRange);

    chartRef.current = chart;
    candleSeriesRef.current = candles;
    ema50SeriesRef.current = ema50;
    ema200SeriesRef.current = ema200;
    volumeSeriesRef.current = volume;
    rsiSeriesRef.current = rsi;
    macdSeriesRef.current = macd;
    macdSignalSeriesRef.current = macdSignal;
    macdHistogramRef.current = macdHistogram;
    markersRef.current = markers;

    const resetView = () => {
      hasUserRangeRef.current = false;
      const current = dataByDateRef.current;
      if (current.size) {
        const items = [...current.values()];
        const ranged = filterSeriesByRange(items, rangeRef.current);
        chart.timeScale().setVisibleRange({
          from: toChartTime(ranged[0]?.date ?? items[0].date),
          to: toChartTime(ranged.at(-1)?.date ?? items.at(-1)!.date),
        });
      } else {
        chart.timeScale().fitContent();
      }
    };
    const fullscreen = () => {
      void surface.closest('.chart-panel')?.requestFullscreen?.();
    };
    actionsRef.current = { resetView, fullscreen };

    return () => {
      actionsRef.current = null;
      chart.unsubscribeCrosshairMove(handleCrosshairMove);
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(handleVisibleRange);
      markers.detach();
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      ema50SeriesRef.current = null;
      ema200SeriesRef.current = null;
      volumeSeriesRef.current = null;
      rsiSeriesRef.current = null;
      macdSeriesRef.current = null;
      macdSignalSeriesRef.current = null;
      macdHistogramRef.current = null;
      markersRef.current = null;
      markerSignatureRef.current = '';
    };
  }, [actionsRef, onSelectDate]);

  useEffect(() => {
    const chart = chartRef.current;
    const candles = candleSeriesRef.current;
    const ema50 = ema50SeriesRef.current;
    const ema200 = ema200SeriesRef.current;
    const volume = volumeSeriesRef.current;
    const rsi = rsiSeriesRef.current;
    const macd = macdSeriesRef.current;
    const macdSignal = macdSignalSeriesRef.current;
    const macdHistogram = macdHistogramRef.current;
    if (!chart || !candles || !ema50 || !ema200 || !volume || !rsi || !macd || !macdSignal || !macdHistogram) return;

    const previousVisibleRange = chart.timeScale().getVisibleLogicalRange();
    const priorConfig = appliedViewRef.current;
    const configChanged = !priorConfig || priorConfig.range !== range || priorConfig.interval !== interval;
    dataByDateRef.current = new Map(data.map((candle) => [dateKey(candle.date), candle]));
    candles.setData(candleData);
    ema50.setData(ema50Data);
    ema200.setData(ema200Data);
    volume.setData(volumeData);
    rsi.setData(rsiData);
    macd.setData(macdLineData);
    macdSignal.setData(macdSignalData);
    macdHistogram.setData(macdHistogramData);

    if (!data.length) {
      appliedViewRef.current = { range, interval };
      return;
    }
    if (previousVisibleRange && !configChanged && hasUserRangeRef.current) {
      chart.timeScale().setVisibleLogicalRange(previousVisibleRange);
    } else {
      const ranged = filterSeriesByRange(data, range);
      chart.timeScale().setVisibleRange({
        from: toChartTime(ranged[0]?.date ?? data[0].date),
        to: toChartTime(ranged.at(-1)?.date ?? data.at(-1)!.date),
      });
    }
    appliedViewRef.current = { range, interval };
  }, [
    candleData,
    data,
    ema50Data,
    ema200Data,
    interval,
    macdHistogramData,
    macdLineData,
    macdSignalData,
    range,
    rsiData,
    volumeData,
  ]);

  useEffect(() => {
    ema50SeriesRef.current?.applyOptions({ visible: show50, title: `EMA ${period50}` });
    ema200SeriesRef.current?.applyOptions({ visible: show200, title: `EMA ${period200}` });
  }, [period50, period200, show50, show200]);

  useEffect(() => {
    const chart = chartRef.current;
    const [pricePane, volumePane, rsiPane, macdPane] = chart?.panes() ?? [];
    if (!pricePane || !volumePane || !rsiPane || !macdPane) return;
    rsiSeriesRef.current?.applyOptions({ visible: showRsi });
    macdSeriesRef.current?.applyOptions({ visible: showMacd });
    macdSignalSeriesRef.current?.applyOptions({ visible: showMacd });
    macdHistogramRef.current?.applyOptions({ visible: showMacd });
    rsiPane.setStretchFactor(showRsi ? 1.4 : 0.001);
    macdPane.setStretchFactor(showMacd ? 1.5 : 0.001);
    rsiPane.priceScale('right').applyOptions({ visible: showRsi });
    macdPane.priceScale('right').applyOptions({ visible: showMacd });
  }, [showMacd, showRsi]);

  useEffect(() => {
    const markersApi = markersRef.current;
    if (!markersApi) return;
    const visibleDates = new Set(visibleData.map((candle) => dateKey(candle.date)));
    const activeSignals = showSignalMarkers ? signals.filter((signal) => visibleDates.has(signal.date)) : [];
    const signature = activeSignals.map((signal) => `${signal.kind}:${signal.date}`).join('|');
    if (signature === markerSignatureRef.current) return;
    const markers: SeriesMarker<Time>[] = activeSignals.map((signal) => ({
      id: `${signal.kind}-${signal.date}`,
      time: toChartTime(signal.date),
      position: signal.kind === 'golden' ? 'belowBar' : 'aboveBar',
      shape: signal.kind === 'golden' ? 'arrowUp' : 'arrowDown',
      color: signal.kind === 'golden' ? '#15803d' : '#dc2626',
      text: signal.kind === 'golden' ? 'GC' : 'DC',
      size: 1,
    }));
    markersApi.setMarkers(markers);
    markerSignatureRef.current = signature;
  }, [range, signals, showSignalMarkers, visibleData]);

  const statusLabel =
    status !== 'connected'
      ? statusText[status] ?? 'ข้อมูลราคาไม่พร้อม'
      : 'ข้อมูลแท่งย้อนหลัง · ผู้ให้บริการไม่ระบุสถานะ delayed/current หรือเวลาปิดแท่ง';
  const selectedSignal = selectedCandle
    ? signals.find((signal) => signal.date === dateKey(selectedCandle.date)) ?? null
    : null;

  return (
    <div className="chart-card">
      <div className="chart-data-strip">
        <div className="chart-data-row chart-identity-row">
          <div className="chart-identity">
            <strong className="chart-symbol">META</strong>
            <span>NASDAQ</span>
            <span>{interval === '1day' ? 'รายวัน' : 'รายสัปดาห์'}</span>
            <span>USD</span>
          </div>
          <ChartValue
            label="วันที่"
            value={selectedCandle ? dateLabel(selectedCandle.date) : 'ไม่มีแท่งที่เลือก'}
            className="chart-selected-date"
          />
        </div>
        <div className="chart-data-row chart-ohlc-row">
          <ChartValue label="Open" value={selectedCandle ? selectedCandle.open.toFixed(2) : '—'} />
          <ChartValue label="High" value={selectedCandle ? selectedCandle.high.toFixed(2) : '—'} />
          <ChartValue label="Low" value={selectedCandle ? selectedCandle.low.toFixed(2) : '—'} />
          <ChartValue label="Close" value={selectedCandle ? selectedCandle.close.toFixed(2) : '—'} />
          <ChartValue label="Volume" value={selectedCandle ? fullVolume(selectedCandle.volume) : '—'} />
        </div>
        <div className="chart-data-row chart-ema-row">
          <ChartValue label={`EMA ${period50}`} value={selectedEma50 == null ? '—' : selectedEma50.toFixed(2)} color="ema-blue" />
          <ChartValue label={`EMA ${period200}`} value={selectedEma200 == null ? '—' : selectedEma200.toFixed(2)} color="ema-purple" />
        </div>
        <div className="chart-data-row chart-indicator-row">
          <ChartValue label="RSI 14" value={selectedRsi == null ? 'ข้อมูลไม่พอ' : selectedRsi.toFixed(2)} color="rsi-value" />
          <ChartValue label="MACD" value={selectedMacd?.macd == null ? 'ข้อมูลไม่พอ' : selectedMacd.macd.toFixed(2)} color="macd-value" />
          <ChartValue label="Signal" value={selectedMacd?.signal == null ? 'ข้อมูลไม่พอ' : selectedMacd.signal.toFixed(2)} color="signal-value" />
          <ChartValue label="Histogram" value={selectedMacd?.histogram == null ? 'ข้อมูลไม่พอ' : selectedMacd.histogram.toFixed(2)} color="histogram-value" />
        </div>
      </div>

      <div className="chart-series-legend">
        {show50 && <span><i className="ema-key ema-key-50" /> EMA {period50}</span>}
        {show200 && <span><i className="ema-key ema-key-200" /> EMA {period200}</span>}
        <span className="volume-legend">▥ ปริมาณซื้อขาย (ล้านหุ้น)</span>
        {showRsi && <span><i className="indicator-key rsi-key" /> RSI 14 · 30 / 50 / 70</span>}
        {showMacd && <span><i className="indicator-key macd-key" /> MACD</span>}
        {showMacd && <span><i className="indicator-key signal-key" /> Signal</span>}
        {showMacd && <span><i className="indicator-key histogram-key" /> Histogram</span>}
        <span className="signal-legend"><b className="gc-legend">↑ GC</b> Golden Cross · <b className="dc-legend">↓ DC</b> Death Cross</span>
      </div>

      <div
        className={`chart-surface${showRsi ? ' has-rsi' : ''}${showMacd ? ' has-macd' : ''}`}
        ref={surfaceRef}
        aria-label="META candlestick chart with volume, EMA, RSI and MACD"
      />
      <div className="chart-status-row">
        <span className={`chart-status-dot ${status}`} />
        <span>{statusLabel}</span>
        <span>{provider}</span>
        <span>อัปเดต {lastUpdated ?? 'ไม่มีเวลาอ้างอิง'}</span>
        <span>{selectedCandle && isCandleClosed(selectedCandle.date, interval) ? 'แท่งปิดแล้ว' : 'แท่งยังไม่ปิด'}</span>
        {quoteDate && quoteDate !== selectedCandle?.date && <span>Quote {quoteDate}</span>}
      </div>
      {selectedSignal && (
        <div className={`chart-signal-detail ${selectedSignal.kind}`} aria-live="polite">
          <strong>{signalLabel(selectedSignal.kind, fastPeriod, slowPeriod)}</strong>
          <span>{interval === '1day' ? 'รายวัน' : 'รายสัปดาห์'} · {dateLabel(selectedSignal.date)}</span>
          <span>แท่งก่อน ({dateLabel(selectedSignal.previousDate)}): EMA {fastPeriod} {fmtCurrency(selectedSignal.previousFast)} / EMA {slowPeriod} {fmtCurrency(selectedSignal.previousSlow)}</span>
          <span>แท่งยืนยัน: EMA {fastPeriod} {fmtCurrency(selectedSignal.fast)} / EMA {slowPeriod} {fmtCurrency(selectedSignal.slow)}</span>
        </div>
      )}
      {selectedMacdCross && (
        <div className={`chart-signal-detail macd-${selectedMacdCross.direction}`} aria-live="polite">
          <strong>MACD ตัด Signal {selectedMacdCross.direction === 'up' ? 'ขึ้น' : 'ลง'}</strong>
          <span>{interval === '1day' ? 'รายวัน' : 'รายสัปดาห์'} · {dateLabel(selectedMacdCross.date)}</span>
          <span>แท่งก่อน ({dateLabel(selectedMacdCross.previousDate)}): MACD {selectedMacdCross.previousMacd.toFixed(2)} / Signal {selectedMacdCross.previousSignal.toFixed(2)}</span>
          <span>แท่งยืนยัน: MACD {selectedMacdCross.macd.toFixed(2)} / Signal {selectedMacdCross.signal.toFixed(2)}</span>
        </div>
      )}
      <div className="chart-attribution">
        TradingView Lightweight Charts™ · Copyright (c) 2025 TradingView, Inc. ·{' '}
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer">TradingView</a>
      </div>
    </div>
  );
}

function ChartValue({
  label,
  value,
  color,
  className = '',
}: {
  label: string;
  value: string;
  color?: string;
  className?: string;
}) {
  return (
    <span className={`chart-value ${color ?? ''} ${className}`}>
      <small>{label}</small>
      <strong>{value}</strong>
    </span>
  );
}

export default App;
