import express from 'express';
import { getFundamentals } from './fundamentals.js';

const app = express();
const PORT = Number(process.env.PORT || 3001);
const DEFAULT_INTERVAL = '1day';
const allowedOrigins = new Set(
  (process.env.CORS_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
);

app.use((req, res, next) => {
  const origin = req.get('Origin');
  const isAllowed = !origin || allowedOrigins.has(origin);
  if (origin && isAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.vary('Origin');
  }
  if (req.method === 'OPTIONS') {
    if (!isAllowed) {
      res.sendStatus(403);
      return;
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
    return;
  }
  next();
});

const toNumber = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const calculateEma = (values, periods) => {
  if (!values.length || values.length < periods) {
    return values.map(() => null);
  }

  const alpha = 2 / (periods + 1);
  const result = [];
  let previous = null;

  values.forEach((value, index) => {
    if (index === 0) {
      previous = value;
      result.push(value);
      return;
    }

    previous = value * alpha + (previous ?? value) * (1 - alpha);
    result.push(previous);
  });

  return result;
};

const aggregateToWeekly = (rows) => {
  const buckets = new Map();

  rows.forEach((row) => {
    const date = new Date(row.date);
    const iso = new Date(date);
    iso.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    iso.setUTCHours(0, 0, 0, 0);
    const key = iso.toISOString();

    const bucket = buckets.get(key) || {
      date: key,
      open: row.open,
      high: row.high,
      low: row.low,
      close: row.close,
      volume: row.volume,
    };

    bucket.open = bucket.open ?? row.open;
    bucket.high = Math.max(bucket.high ?? row.high, row.high);
    bucket.low = Math.min(bucket.low ?? row.low, row.low);
    bucket.close = row.close;
    bucket.volume = (bucket.volume ?? 0) + row.volume;
    buckets.set(key, bucket);
  });

  return Array.from(buckets.values())
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime())
    .map((row) => ({
      date: row.date,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
    }));
};

const filterByRange = (series, range) => {
  if (range === 'all') return series;

  const days = range === '3M' ? 90 : range === '6M' ? 180 : 365;
  const latestDate = new Date(series.at(-1)?.date || Date.now());
  const start = new Date(latestDate);
  start.setUTCDate(latestDate.getUTCDate() - days);

  return series.filter((item) => new Date(item.date) >= start);
};

const formatDisplayDate = (date) => {
  if (!date) return 'ยังไม่มีข้อมูล';
  return new Date(date).toLocaleString('en-GB', {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/New_York',
  });
};

const createProviderError = (response, payload, fallback) => {
  const error = new Error(payload?.message || fallback);
  error.code = payload?.code ?? response.status;
  return error;
};

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/meta', async (req, res) => {
  const interval = req.query.interval === '1week' ? '1week' : '1day';
  const range = req.query.range || '1Y';
  const apiKey = process.env.TWELVEDATA_API_KEY;

  if (!apiKey) {
    res.json({
      status: 'not-configured',
      provider: 'Twelve Data',
      sourceUrl: 'https://twelvedata.com/docs',
      note: 'ยังไม่ได้ตั้งค่าการเชื่อมต่อ กรุณาเพิ่ม TWELVEDATA_API_KEY ในไฟล์ .env',
      chart: [],
      range,
      interval,
      summary: 'ข้อมูลยังไม่เพียงพอ เพื่อประเมิน META ได้ ต้องตั้งค่า API key ก่อน',
      quote: null,
      metadata: {
        symbol: 'META',
        exchange: 'NASDAQ',
        currency: 'USD',
        lastUpdated: null,
      },
    });
    return;
  }

  try {
    const quoteUrl = `https://api.twelvedata.com/quote?symbol=META&exchange=NASDAQ&apikey=${apiKey}`;
    const quoteResponse = await fetch(quoteUrl);
    const quoteJson = await quoteResponse.json();

    if (!quoteResponse.ok || quoteJson?.code || !quoteJson?.symbol) {
      throw createProviderError(quoteResponse, quoteJson, 'Quote request failed');
    }

    const seriesResponse = await fetch(
      `https://api.twelvedata.com/time_series?symbol=META&interval=1day&outputsize=5000&apikey=${apiKey}`,
    );
    const seriesJson = await seriesResponse.json();

    if (!seriesResponse.ok || seriesJson?.code || !Array.isArray(seriesJson.values)) {
      throw createProviderError(seriesResponse, seriesJson, 'Time series request failed');
    }

    const rawSeries = seriesJson.values
      .map((entry) => {
        const open = toNumber(entry.open);
        const high = toNumber(entry.high);
        const low = toNumber(entry.low);
        const close = toNumber(entry.close);
        const volume = toNumber(entry.volume);

        if ([open, high, low, close, volume].some((value) => value === null)) {
          return null;
        }

        return {
          date: entry.datetime || entry.date || entry.timestamp,
          open,
          high,
          low,
          close,
          volume,
        };
      })
      .filter(Boolean)
      .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

    const series = (interval === '1week' ? aggregateToWeekly(rawSeries) : rawSeries)
      .map((entry) => ({
        ...entry,
        datetime: entry.date,
      }));

    const closes = series.map((entry) => entry.close);
    const ema50 = calculateEma(closes, 50);
    const ema200 = calculateEma(closes, 200);
    const fullSeries = series.map((entry, index) => ({
      ...entry,
      ema50: ema50[index] ?? null,
      ema200: ema200[index] ?? null,
    }));

    const chart = filterByRange(fullSeries, range);
    const latest = fullSeries.at(-1);
    const previous = fullSeries.at(-2) || latest;
    const price = latest?.close ?? toNumber(quoteJson.close) ?? null;
    const previousClose = previous?.close ?? toNumber(quoteJson.previous_close) ?? price;
    const change = price && previousClose ? price - previousClose : null;
    const changePercent = price && previousClose ? (change / previousClose) * 100 : null;

    res.json({
      status: 'connected',
      provider: 'Twelve Data',
      sourceUrl: 'https://twelvedata.com/docs',
      symbol: quoteJson.symbol || 'META',
      exchange: quoteJson.exchange || 'NASDAQ',
      currency: quoteJson.currency || 'USD',
      lastUpdated: quoteJson.datetime || latest?.date || null,
      range,
      interval,
      priceLabel: 'ราคาปิดล่าสุด',
      quote: {
        price,
        previousClose,
        change,
        changePercent,
      },
      chart,
      allSeries: fullSeries,
      summary: `Meta Platforms (META) มีข้อมูลราคาและ EMA จาก ${series.length} แท่งที่โหลดได้แล้ว`,
      metadata: {
        source: 'Twelve Data API',
        interval,
        range,
        lastUpdated: quoteJson.datetime || latest?.date || null,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Request failed';
    const note = message
      .replaceAll(apiKey, '[REDACTED]')
      .replace(/([?&]apikey=)[^&\s]*/gi, '$1[REDACTED]');
    res.status(500).json({
      status: 'error',
      provider: 'Twelve Data',
      sourceUrl: 'https://twelvedata.com/docs',
      providerCode: error?.code ?? null,
      note: note || 'เชื่อมต่อ API ไม่สำเร็จ',
      chart: [],
      range,
      interval,
      summary: 'เชื่อมต่อไม่สำเร็จ กรุณาตรวจสอบ API key และเงื่อนไขการใช้บริการ',
      quote: null,
      metadata: {
        symbol: 'META',
        exchange: 'NASDAQ',
        currency: 'USD',
        lastUpdated: null,
      },
    });
  }
});

app.get('/api/fundamentals', async (_req, res) => {
  try {
    const data = await getFundamentals(process.env.TWELVEDATA_API_KEY);
    res.status(data.status === 'connected' ? 200 : 502).json(data);
  } catch (error) {
    res.status(502).json({
      status: 'error',
      provider: 'SEC Company Facts',
      note: error instanceof Error ? error.message : 'โหลดข้อมูลพื้นฐานไม่สำเร็จ',
      sourceUrl: 'https://investor.atmeta.com/financials/',
      history: { annual: [], quarterly: [], comparison: null },
      latest: null,
      operational: null,
      valuation: { status: 'insufficient', missing: ['ข้อมูลรายงาน SEC'] },
    });
  }
});

app.listen(PORT, () => {
  console.log('META stock API listening');
});
