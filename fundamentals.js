const COMPANY_FACTS_URL = 'https://data.sec.gov/api/xbrl/companyfacts/CIK0001326801.json';
const PRESS_RELEASE_URL =
  'https://investor.atmeta.com/investor-news/press-release-details/2026/Meta-Reports-Second-Quarter-2026-Results/';
const FY2025_EARNINGS_URL =
  'https://investor.atmeta.com/investor-news/press-release-details/2026/Meta-Reports-Fourth-Quarter-and-Full-Year-2025-Results/default.aspx';
const SEC_DATA_URL =
  'https://www.sec.gov/Archives/edgar/data/1326801/000162828026050705/meta-20260630.htm';
const FINANCIALS_URL = 'https://investor.atmeta.com/financials/';
const SEC_USER_AGENT = 'META Stock Analysis research contact analyst@example.com';
const BILLION = 1_000_000_000;
const CACHE_TTL = 15 * 60 * 1000;

let secCache;

const parseXbrlValue = (value, scale, sign) => {
  const parsed = Number(String(value).replaceAll(',', '').replaceAll(' ', ''));
  if (!Number.isFinite(parsed)) return null;
  return parsed * 10 ** Number(scale || 0) * (sign === '-' ? -1 : 1);
};

const parseSegmentFacts = (html, checkedAt, filingDate, sourceUrl) => {
  const contexts = new Map();
  const contextPattern = /<xbrli:context\b[^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/xbrli:context>/gi;

  for (const match of html.matchAll(contextPattern)) {
    const context = match[2];
    const start = context.match(/<xbrli:startDate>([^<]+)<\/xbrli:startDate>/i)?.[1] ?? null;
    const end =
      context.match(/<xbrli:endDate>([^<]+)<\/xbrli:endDate>/i)?.[1] ??
      context.match(/<xbrli:instant>([^<]+)<\/xbrli:instant>/i)?.[1] ??
      null;
    const dimensions = [...context.matchAll(/<xbrldi:explicitMember\b[^>]*>([^<]+)<\/xbrldi:explicitMember>/gi)]
      .map((dimension) => dimension[1])
      .join(' ');
    contexts.set(match[1], { start, end, dimensions });
  }

  const facts = [];
  const factPattern = /<ix:nonfraction\b([^>]*)>([\s\S]*?)<\/ix:nonfraction>/gi;
  for (const match of html.matchAll(factPattern)) {
    const attributes = match[1];
    const name = attributes.match(/\bname=["']([^"']+)["']/i)?.[1];
    const contextRef = attributes.match(/\bcontextref=["']([^"']+)["']/i)?.[1];
    const context = contexts.get(contextRef);
    if (!name || !context) continue;

    const dimensions = context.dimensions;
    const isAdvertising =
      dimensions.includes('us-gaap:AdvertisingMember') &&
      dimensions.includes('meta:FamilyOfAppsMember');
    const isRealityLabs = dimensions.includes('meta:RealityLabsMember');
    if (!isAdvertising && !isRealityLabs) continue;

    const isRevenue = name === 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax';
    const isOperatingIncome = name === 'us-gaap:OperatingIncomeLoss';
    if (!isRevenue && !(isRealityLabs && isOperatingIncome)) continue;

    const value = parseXbrlValue(
      match[2].replace(/<[^>]+>/g, '').trim(),
      attributes.match(/\bscale=["']([^"']+)["']/i)?.[1],
      attributes.match(/\bsign=["']([^"']+)["']/i)?.[1],
    );
    if (value === null) continue;
    facts.push({
      kind: isAdvertising ? 'advertisingRevenue' : isRevenue ? 'realityLabsRevenue' : 'realityLabsOperatingIncome',
      value,
      unit: 'USD',
      periodStart: context.start,
      periodEnd: context.end,
      reportedDate: filingDate,
      source: sourceUrl,
      checkedAt,
      basis: 'sec-inline-xbrl',
    });
  }
  return facts;
};

const latestFact = (facts, tag, unit, start, end) => {
  const fact = facts[tag];
  if (!fact) return null;
  const candidates = (fact.units[unit] ?? [])
    .filter((item) => item.start === start && item.end === end)
    .sort((a, b) => b.filed.localeCompare(a.filed) || String(b.accn).localeCompare(String(a.accn)));
  return candidates[0] ?? null;
};

const makeMetric = (value, unit, start, end, filed, source, checkedAt, basis = 'sec-companyfacts') => ({
  value: value == null ? null : value,
  unit,
  period: `${start ? `${start} to ` : ''}${end ?? 'not disclosed'}`,
  periodStart: start,
  periodEnd: end,
  reportedDate: filed,
  source,
  checkedAt,
  basis,
});

const factMetric = (fact, unit, checkedAt) => {
  if (!fact) return null;
  const source = `https://www.sec.gov/Archives/edgar/data/1326801/${fact.accn.replaceAll('-', '')}/meta-${fact.end.replaceAll('-', '')}.htm`;
  return makeMetric(fact.val, unit, fact.start ?? null, fact.end, fact.filed, source, checkedAt);
};

const sourceForPeriod = (periodEnd, accession) =>
  accession
    ? `https://www.sec.gov/Archives/edgar/data/1326801/${accession.replaceAll('-', '')}/meta-${periodEnd.replaceAll('-', '')}.htm`
    : FINANCIALS_URL;

const periodDates = (year, quarter) => {
  const starts = ['01-01', '04-01', '07-01', '10-01'];
  const ends = ['03-31', '06-30', '09-30', '12-31'];
  return {
    start: `${year}-${starts[quarter - 1]}`,
    end: `${year}-${ends[quarter - 1]}`,
  };
};

const durationFactValue = (facts, tag, unit, start, end) => latestFact(facts, tag, unit, start, end);

const quarterValue = (facts, tag, unit, year, quarter, additive) => {
  const { start, end } = periodDates(year, quarter);
  const direct = durationFactValue(facts, tag, unit, start, end);
  if (direct) return direct;

  const ytdStart = `${year}-01-01`;
  const ytd = durationFactValue(facts, tag, unit, ytdStart, end);
  if (quarter === 1) return ytd;

  if (quarter === 4) {
    if (!additive) return null;
    const annual = durationFactValue(facts, tag, unit, ytdStart, end);
    const nineMonths = durationFactValue(facts, tag, unit, ytdStart, `${year}-09-30`);
    if (!annual || !nineMonths) return null;
    return { ...annual, val: annual.val - nineMonths.val, start, derivedFrom: [annual, nineMonths] };
  }

  if (!ytd) return null;
  const previousQuarterEnd = periodDates(year, quarter - 1).end;
  const previousYtd = durationFactValue(facts, tag, unit, ytdStart, previousQuarterEnd);
  if (!previousYtd) return null;
  return { ...ytd, val: ytd.val - previousYtd.val, start, derivedFrom: [ytd, previousYtd] };
};

const quarterlyMetric = (facts, tag, unit, year, quarter, checkedAt, additive) => {
  const item = quarterValue(facts, tag, unit, year, quarter, additive);
  if (!item) return makeMetric(null, unit, periodDates(year, quarter).start, periodDates(year, quarter).end, null, SEC_DATA_URL, checkedAt, 'unavailable');
  const source = sourceForPeriod(item.end, item.accn);
  const basis = item.derivedFrom ? 'sec-ytd-difference' : 'sec-companyfacts';
  return makeMetric(item.val, unit, periodDates(year, quarter).start, periodDates(year, quarter).end, item.filed, source, checkedAt, basis);
};

export const quarterlyDilutedEpsMetric = (facts, year, quarter, checkedAt) => {
  if (year === 2025 && quarter === 4) {
    return makeMetric(
      8.88,
      'USD/shares',
      '2025-10-01',
      '2025-12-31',
      '2026-01-28',
      FY2025_EARNINGS_URL,
      checkedAt,
      'verified-report-snapshot',
    );
  }
  return quarterlyMetric(facts, 'EarningsPerShareDiluted', 'USD/shares', year, quarter, checkedAt, false);
};

export const annualDilutedEpsMetric = (facts, year, checkedAt) => {
  if (year === 2025) {
    return makeMetric(
      23.49,
      'USD/shares',
      '2025-01-01',
      '2025-12-31',
      '2026-01-28',
      FY2025_EARNINGS_URL,
      checkedAt,
      'verified-report-snapshot',
    );
  }
  return annualMetric(facts, 'EarningsPerShareDiluted', 'USD/shares', year, checkedAt);
};

export const sumQuarterlyMetric = (rows, key) => {
  const latestFour = rows.slice(-4);
  if (latestFour.length !== 4) return null;
  const metrics = latestFour.map((row) => row.metrics[key]);
  if (metrics.some((metric, index) =>
    !metric ||
    metric.value == null ||
    !Number.isFinite(metric.value) ||
    !metric.periodStart ||
    !metric.periodEnd ||
    (index > 0 && (() => {
      const nextDay = new Date(`${metrics[index - 1].periodEnd}T00:00:00Z`);
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      return nextDay.toISOString().slice(0, 10) !== metric.periodStart;
    })()),
  )) return null;
  if (metrics.some((metric) => metric.unit !== metrics[0].unit)) return null;
  return metrics.reduce((sum, metric) => sum + metric.value, 0);
};

export const calculatePriceToEarnings = (price, dilutedEpsTtm) =>
  Number.isFinite(price) && Number.isFinite(dilutedEpsTtm) && dilutedEpsTtm > 0
    ? price / dilutedEpsTtm
    : null;

const annualMetric = (facts, tag, unit, year, checkedAt) => {
  const start = `${year}-01-01`;
  const end = `${year}-12-31`;
  const item = durationFactValue(facts, tag, unit, start, end);
  if (!item) return makeMetric(null, unit, start, end, null, FINANCIALS_URL, checkedAt, 'unavailable');
  return makeMetric(item.val, unit, start, end, item.filed, sourceForPeriod(end, item.accn), checkedAt);
};

const selectQuarterRows = (facts, checkedAt, latestPeriodEnd) => {
  const rows = [];
  const latestDate = new Date(`${latestPeriodEnd}T00:00:00Z`);
  const latestYear = latestDate.getUTCFullYear();
  const latestQuarter = Math.floor(latestDate.getUTCMonth() / 3) + 1;
  const latestQuarterIndex = latestYear * 4 + latestQuarter - 1;
  for (let index = latestQuarterIndex - 7; index <= latestQuarterIndex; index += 1) {
    const year = Math.floor(index / 4);
    const quarter = (index % 4) + 1;
    const end = periodDates(year, quarter).end;
    if (end > latestPeriodEnd) continue;
    rows.push({
      period: `Q${quarter} ${year}`,
      periodStart: periodDates(year, quarter).start,
      periodEnd: end,
      metrics: {
        revenue: quarterlyMetric(facts, 'RevenueFromContractWithCustomerExcludingAssessedTax', 'USD', year, quarter, checkedAt, true),
        netIncome: quarterlyMetric(facts, 'NetIncomeLoss', 'USD', year, quarter, checkedAt, true),
        dilutedEps: quarterlyDilutedEpsMetric(facts, year, quarter, checkedAt),
        operatingIncome: quarterlyMetric(facts, 'OperatingIncomeLoss', 'USD', year, quarter, checkedAt, true),
        operatingCashFlow: quarterlyMetric(facts, 'NetCashProvidedByUsedInOperatingActivities', 'USD', year, quarter, checkedAt, true),
        ppePurchases: quarterlyMetric(facts, 'PaymentsToAcquirePropertyPlantAndEquipment', 'USD', year, quarter, checkedAt, true),
        financeLeasePrincipal: quarterlyMetric(facts, 'FinanceLeasePrincipalPayments', 'USD', year, quarter, checkedAt, true),
      },
    });
  }
  return rows.slice(-4);
};

const addDerivedMetrics = (rows) =>
  rows.map((row) => {
    const metrics = { ...row.metrics };
    const revenue = metrics.revenue?.value;
    const operatingIncome = metrics.operatingIncome?.value;
    const netIncome = metrics.netIncome?.value;
    const operatingCashFlow = metrics.operatingCashFlow?.value;
    const ppe = metrics.ppePurchases?.value;
    const leasePrincipal = metrics.financeLeasePrincipal?.value;
    const shared = (value, unit, basis) => ({
      ...metrics.revenue,
      value,
      unit,
      basis,
    });

    metrics.operatingMargin =
      revenue != null && operatingIncome != null ? shared((operatingIncome / revenue) * 100, '%', 'calculated') : null;
    metrics.netMargin =
      revenue != null && netIncome != null ? shared((netIncome / revenue) * 100, '%', 'calculated') : null;
    metrics.freeCashFlow =
      operatingCashFlow != null && ppe != null && leasePrincipal != null
        ? shared(operatingCashFlow - ppe - leasePrincipal, 'USD', 'meta-definition-derived')
        : null;
    return { ...row, metrics };
  });

const getQuarterComparison = (facts, checkedAt) => {
  const year = 2025;
  const quarter = 2;
  const end = periodDates(year, quarter).end;
  return {
    period: 'Q2 2025',
    periodStart: periodDates(year, quarter).start,
    periodEnd: end,
    metrics: {
      revenue: quarterlyMetric(facts, 'RevenueFromContractWithCustomerExcludingAssessedTax', 'USD', year, quarter, checkedAt, true),
      netIncome: quarterlyMetric(facts, 'NetIncomeLoss', 'USD', year, quarter, checkedAt, true),
      dilutedEps: quarterlyDilutedEpsMetric(facts, year, quarter, checkedAt),
      operatingIncome: quarterlyMetric(facts, 'OperatingIncomeLoss', 'USD', year, quarter, checkedAt, true),
    },
  };
};

const getAnnualRows = (facts, checkedAt) =>
  [2023, 2024, 2025].map((year) => {
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;
    const metrics = {
      revenue: annualMetric(facts, 'RevenueFromContractWithCustomerExcludingAssessedTax', 'USD', year, checkedAt),
      netIncome: annualMetric(facts, 'NetIncomeLoss', 'USD', year, checkedAt),
      dilutedEps: annualDilutedEpsMetric(facts, year, checkedAt),
      operatingIncome: annualMetric(facts, 'OperatingIncomeLoss', 'USD', year, checkedAt),
      operatingCashFlow: annualMetric(facts, 'NetCashProvidedByUsedInOperatingActivities', 'USD', year, checkedAt),
      ppePurchases: annualMetric(facts, 'PaymentsToAcquirePropertyPlantAndEquipment', 'USD', year, checkedAt),
      financeLeasePrincipal: annualMetric(facts, 'FinanceLeasePrincipalPayments', 'USD', year, checkedAt),
    };
    const revenue = metrics.revenue.value;
    const operatingIncome = metrics.operatingIncome.value;
    const netIncome = metrics.netIncome.value;
    const operatingCashFlow = metrics.operatingCashFlow.value;
    const ppe = metrics.ppePurchases.value;
    const leases = metrics.financeLeasePrincipal.value;
    const derivedMetric = (value, unit, basis) => ({
      ...metrics.revenue,
      value,
      unit,
      basis,
    });
    metrics.operatingMargin =
      revenue != null && operatingIncome != null ? derivedMetric((operatingIncome / revenue) * 100, '%', 'calculated') : null;
    metrics.netMargin =
      revenue != null && netIncome != null ? derivedMetric((netIncome / revenue) * 100, '%', 'calculated') : null;
    metrics.freeCashFlow =
      operatingCashFlow != null && ppe != null && leases != null
        ? derivedMetric(operatingCashFlow - ppe - leases, 'USD', 'meta-definition-derived')
        : null;
    return { period: `${year}`, periodStart: start, periodEnd: end, metrics };
  });

const getSecData = async () => {
  if (secCache && secCache.expiresAt > Date.now()) return secCache.data;

  const response = await fetch(COMPANY_FACTS_URL, {
    headers: { 'User-Agent': SEC_USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`SEC Company Facts returned HTTP ${response.status}`);
  const company = await response.json();
  const facts = company.facts?.['us-gaap'];
  if (!facts) throw new Error('SEC Company Facts did not include US GAAP facts');

  const revenueRecords = facts.RevenueFromContractWithCustomerExcludingAssessedTax?.units?.USD ?? [];
  const latestQuarter = revenueRecords
    .filter((item) => item.form === '10-Q' && item.start && item.fp?.startsWith('Q'))
    .sort((a, b) => b.end.localeCompare(a.end) || b.filed.localeCompare(a.filed))[0];
  if (!latestQuarter?.accn) throw new Error('Latest SEC quarterly filing could not be identified');

  const accession = latestQuarter.accn.replaceAll('-', '');
  const documentName = `meta-${latestQuarter.end.replaceAll('-', '')}.htm`;
  const filingUrl = `https://www.sec.gov/Archives/edgar/data/1326801/${accession}/${documentName}`;
  const filingResponse = await fetch(filingUrl, {
    headers: { 'User-Agent': SEC_USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (!filingResponse.ok) throw new Error(`Latest SEC filing returned HTTP ${filingResponse.status}`);
  const filingHtml = await filingResponse.text();

  const data = {
    facts,
    filingUrl,
    filingDate: latestQuarter.filed,
    latestPeriodEnd: latestQuarter.end,
    segmentFacts: parseSegmentFacts(filingHtml, new Date().toISOString(), latestQuarter.filed, filingUrl),
  };
  secCache = { data, expiresAt: Date.now() + CACHE_TTL };
  return data;
};

const reportMetric = (value, unit, periodStart, periodEnd, reportedDate, checkedAt, source = PRESS_RELEASE_URL) =>
  makeMetric(value, unit, periodStart, periodEnd, reportedDate, source, checkedAt, 'verified-report-snapshot');

const sourceMetricForRange = (value, unit, periodStart, periodEnd, reportedDate, checkedAt, source, basis) =>
  makeMetric(value, unit, periodStart, periodEnd, reportedDate, source, checkedAt, basis);

const getSegmentMetric = (segmentFacts, kind, start, end, checkedAt) =>
  segmentFacts.find((item) => item.kind === kind && item.periodStart === start && item.periodEnd === end) ??
  makeMetric(null, 'USD', start, end, null, SEC_DATA_URL, checkedAt, 'unavailable');

const findFactEntry = (facts, tag, unit, end) => {
  const entries = facts[tag]?.units?.[unit] ?? [];
  return entries.filter((item) => !item.start && item.end === end).sort((a, b) => b.filed.localeCompare(a.filed))[0] ?? null;
};

const buildCurrentBalance = (facts, checkedAt) => {
  const end = '2026-06-30';
  const cash = findFactEntry(facts, 'CashAndCashEquivalentsAtCarryingValue', 'USD', end);
  const securities = findFactEntry(facts, 'MarketableSecuritiesCurrent', 'USD', end);
  const debt = findFactEntry(facts, 'LongTermDebtNoncurrent', 'USD', end);
  const reportedDate = cash?.filed ?? securities?.filed ?? debt?.filed ?? null;
  return {
    cashAndMarketableSecurities: sourceMetricForRange(
      cash && securities ? cash.val + securities.val : null,
      'USD',
      null,
      end,
      reportedDate,
      checkedAt,
      SEC_DATA_URL,
      'sec-companyfacts-calculated',
    ),
    longTermDebt: sourceMetricForRange(debt?.val ?? null, 'USD', null, end, debt?.filed ?? null, checkedAt, SEC_DATA_URL, 'sec-companyfacts'),
  };
};

const fetchQuote = async (apiKey) => {
  if (!apiKey) return { status: 'not-configured', quote: null, note: 'ยังไม่ได้ตั้งค่าแหล่งข้อมูลราคา' };
  const url = new URL('https://api.twelvedata.com/quote');
  url.searchParams.set('symbol', 'META');
  url.searchParams.set('exchange', 'NASDAQ');
  url.searchParams.set('apikey', apiKey);
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const payload = await response.json();
  if (!response.ok || payload?.code || !payload?.symbol) {
    const note = String(payload?.message ?? 'Quote request failed')
      .replaceAll(apiKey, '[REDACTED]')
      .replace(/([?&]apikey=)[^&\s]*/gi, '$1[REDACTED]');
    return { status: 'error', quote: null, providerCode: payload?.code ?? response.status, note };
  }
  const price = Number(payload.close);
  if (!Number.isFinite(price)) return { status: 'error', quote: null, note: 'ไม่พบราคาหุ้นในคำตอบจากผู้ให้บริการ' };
  return {
    status: 'connected',
    quote: makeMetric(
      price,
      'USD/share',
      payload.datetime ?? null,
      payload.datetime ?? null,
      payload.datetime ?? null,
      'https://twelvedata.com/docs',
      new Date().toISOString(),
      'live-price-quote',
    ),
  };
};

export const getFundamentals = async (apiKey) => {
  const checkedAt = new Date().toISOString();
  const quotePromise = fetchQuote(apiKey).catch(() => ({ status: 'error', quote: null, note: 'โหลดราคาหุ้นไม่สำเร็จ' }));
  let sec;
  let secError = null;
  try {
    sec = await getSecData();
  } catch (error) {
    secError = error instanceof Error ? error.message : 'โหลด SEC data ไม่สำเร็จ';
  }
  const price = await quotePromise;

  if (!sec) {
    return {
      status: 'error',
      provider: 'SEC Company Facts',
      checkedAt,
      note: secError,
      priceStatus: price.status,
      price: price.quote,
      priceNote: price.note ?? null,
      sourceUrl: FINANCIALS_URL,
      history: { annual: [], quarterly: [], comparison: null },
      latest: null,
      operational: null,
      valuation: { status: 'insufficient', missing: ['ข้อมูล SEC ล่าสุด'] },
    };
  }

  const annual = getAnnualRows(sec.facts, checkedAt);
  const quarterly = addDerivedMetrics(selectQuarterRows(sec.facts, checkedAt, sec.latestPeriodEnd));
  const comparison = addDerivedMetrics([getQuarterComparison(sec.facts, checkedAt)])[0];
  const currentQuarter = quarterly.find((row) => row.period === 'Q2 2026');
  const currentStart = '2026-04-01';
  const currentEnd = '2026-06-30';
  const priorStart = '2025-04-01';
  const priorEnd = '2025-06-30';
  const segments = sec.segmentFacts;
  const advertisingRevenue = getSegmentMetric(segments, 'advertisingRevenue', currentStart, currentEnd, checkedAt);
  const realityLabsRevenue = getSegmentMetric(segments, 'realityLabsRevenue', currentStart, currentEnd, checkedAt);
  const realityLabsOperatingIncome = getSegmentMetric(segments, 'realityLabsOperatingIncome', currentStart, currentEnd, checkedAt);
  const priorAdvertisingRevenue = getSegmentMetric(segments, 'advertisingRevenue', priorStart, priorEnd, checkedAt);
  const priorRealityLabsLoss = getSegmentMetric(segments, 'realityLabsOperatingIncome', priorStart, priorEnd, checkedAt);
  const balance = buildCurrentBalance(sec.facts, checkedAt);

  const operational = {
    dap: reportMetric(3.6, 'billion people', '2026-06-01', '2026-06-30', '2026-07-29', checkedAt),
    dapYoY: reportMetric(3, '% YoY', '2026-04-01', '2026-06-30', '2026-07-29', checkedAt),
    adImpressionsYoY: reportMetric(14, '% YoY', '2026-04-01', '2026-06-30', '2026-07-29', checkedAt),
    averagePricePerAdYoY: reportMetric(12, '% YoY', '2026-04-01', '2026-06-30', '2026-07-29', checkedAt),
    totalRevenue: currentQuarter?.metrics.revenue ?? null,
    costAndExpensesYoY: reportMetric(55, '% YoY', '2026-04-01', '2026-06-30', '2026-07-29', checkedAt),
    legalCharges: reportMetric(2.4 * BILLION, 'USD', '2026-04-01', '2026-06-30', '2026-07-29', checkedAt),
    severanceExpenses: reportMetric(1.18 * BILLION, 'USD', '2026-04-01', '2026-06-30', '2026-07-29', checkedAt),
    capexActual: reportMetric(31.08 * BILLION, 'USD', '2026-04-01', '2026-06-30', '2026-07-29', checkedAt),
    capexGuidanceLow: reportMetric(130 * BILLION, 'USD', '2026-01-01', '2026-12-31', '2026-07-29', checkedAt),
    capexGuidanceHigh: reportMetric(145 * BILLION, 'USD', '2026-01-01', '2026-12-31', '2026-07-29', checkedAt),
    advertisingRevenue,
    priorAdvertisingRevenue,
    realityLabsRevenue,
    realityLabsOperatingIncome,
    priorRealityLabsOperatingIncome: priorRealityLabsLoss,
    cashAndMarketableSecurities: balance.cashAndMarketableSecurities,
    longTermDebt: balance.longTermDebt,
    disclosureSource: PRESS_RELEASE_URL,
    segmentSource: sec.filingUrl,
    checkedAt,
  };

  const lastQuarterRows = quarterly.slice(-4);
  const ttmEps = sumQuarterlyMetric(quarterly, 'dilutedEps');
  const ttmOperatingCashFlow = sumQuarterlyMetric(quarterly, 'operatingCashFlow');
  const ttmFreeCashFlow = sumQuarterlyMetric(quarterly, 'freeCashFlow');
  const shares = findFactEntry(sec.facts, 'WeightedAverageNumberOfDilutedSharesOutstanding', 'shares', '2026-06-30');
  const priceValue = price.quote?.value ?? null;
  const priceMetadata = price.quote;
  const ttmSource = sec.filingUrl;
  const ttmStart = lastQuarterRows[0]?.periodStart ?? null;
  const ttmEnd = lastQuarterRows.at(-1)?.periodEnd ?? null;
  const pE = calculatePriceToEarnings(priceValue, ttmEps);
  const pOperatingCashFlow =
    priceValue != null && ttmOperatingCashFlow != null && shares?.val
      ? priceValue / (ttmOperatingCashFlow / shares.val)
      : null;
  const pFreeCashFlow =
    priceValue != null && ttmFreeCashFlow != null && shares?.val && ttmFreeCashFlow > 0
      ? priceValue / (ttmFreeCashFlow / shares.val)
      : null;
  const valuation = {
    status: pE != null && pOperatingCashFlow != null ? 'connected' : 'insufficient',
    price: priceMetadata,
    ttmDilutedEps: sourceMetricForRange(
      ttmEps,
      'USD/share',
      ttmStart,
      ttmEnd,
      lastQuarterRows.at(-1)?.metrics.dilutedEps?.reportedDate ?? sec.filingDate,
      checkedAt,
      lastQuarterRows.at(-1)?.metrics.dilutedEps?.source ?? ttmSource,
      'sum-of-four-quarters',
    ),
    ttmOperatingCashFlow: sourceMetricForRange(ttmOperatingCashFlow, 'USD', ttmStart, ttmEnd, sec.filingDate, checkedAt, ttmSource, 'sum-of-four-quarters'),
    ttmFreeCashFlow: sourceMetricForRange(ttmFreeCashFlow, 'USD', ttmStart, ttmEnd, sec.filingDate, checkedAt, ttmSource, 'sum-of-four-quarters'),
    dilutedShares: shares
      ? factMetric(shares, 'shares', checkedAt)
      : makeMetric(null, 'shares', null, ttmEnd, null, ttmSource, checkedAt, 'unavailable'),
    priceToEarnings: sourceMetricForRange(pE, 'x', ttmStart, ttmEnd, price.quote?.reportedDate ?? null, checkedAt, ttmSource, 'calculated'),
    priceToOperatingCashFlow: sourceMetricForRange(pOperatingCashFlow, 'x', ttmStart, ttmEnd, price.quote?.reportedDate ?? null, checkedAt, ttmSource, 'calculated-per-diluted-share'),
    priceToFreeCashFlow: sourceMetricForRange(pFreeCashFlow, 'x', ttmStart, ttmEnd, price.quote?.reportedDate ?? null, checkedAt, ttmSource, 'calculated-per-diluted-share'),
    missing: [
      ...(priceValue == null ? ['ราคาหุ้นพร้อมเวลาซื้อขาย'] : []),
      ...(ttmEps == null ? ['Diluted EPS ย้อนหลัง 12 เดือนครบ 4 ไตรมาส'] : []),
      ...(ttmOperatingCashFlow == null ? ['Operating cash flow ย้อนหลัง 12 เดือนครบ 4 ไตรมาส'] : []),
      ...(ttmFreeCashFlow == null ? ['Free cash flow ย้อนหลัง 12 เดือนครบ 4 ไตรมาส'] : []),
    ],
    limitation: 'อัตราส่วนกระแสเงินสดต่อราคาใช้จำนวนหุ้นถัวเฉลี่ยปรับลดล่าสุดที่รายงาน ไม่ใช่จำนวนหุ้นคงค้าง ณ วันราคา จึงเป็นค่าประมาณต่อหุ้น',
  };

  const latest = currentQuarter
    ? {
        ...currentQuarter,
        metrics: {
          ...currentQuarter.metrics,
          advertisingRevenue,
          realityLabsRevenue,
          realityLabsOperatingIncome,
          cashAndMarketableSecurities: balance.cashAndMarketableSecurities,
          longTermDebt: balance.longTermDebt,
          netMargin: currentQuarter.metrics.netMargin,
          operatingMargin: currentQuarter.metrics.operatingMargin,
        },
      }
    : null;

  return {
    status: 'connected',
    provider: 'SEC Company Facts + Meta Q2 2026 filing',
    checkedAt,
    note: null,
    priceStatus: price.status,
    price: price.quote,
    priceProviderCode: price.providerCode ?? null,
    priceNote: price.note ?? null,
    sourceUrl: sec.filingUrl,
    annualSourceUrl: FINANCIALS_URL,
    history: { annual, quarterly, comparison },
    latest,
    operational,
    valuation,
    risks: {
      competition: {
        text: 'Meta ระบุการแข่งขันในผลิตภัณฑ์และโฆษณาเป็นความเสี่ยง รวมถึงการพึ่งพาสัญญาณข้อมูล ระบบปฏิบัติการ และนโยบายแพลตฟอร์มภายนอก',
        source: PRESS_RELEASE_URL,
        periodEnd: currentEnd,
        reportedDate: '2026-07-29',
        checkedAt,
      },
      legal: {
        text: 'ผลจริงไตรมาสนี้รวมค่าใช้จ่ายเกี่ยวกับกระบวนการทางกฎหมาย ส่วนการพิจารณาคดี/กฎระเบียบในอนาคตเป็นความเสี่ยงที่ยังไม่ใช่ผลขาดทุนที่เกิดขึ้นแล้ว',
        source: PRESS_RELEASE_URL,
        periodEnd: currentEnd,
        reportedDate: '2026-07-29',
        checkedAt,
      },
      investment: {
        text: 'เงินลงทุนรายจ่ายลงทุนรวม (รวมเงินต้นสัญญาเช่าการเงิน) เป็นผลจริง ส่วนกรอบปี 2026 เป็น guidance; Meta ไม่แยกมูลค่า AI/ศูนย์ข้อมูลเป็นตัวเลขเฉพาะในแหล่งนี้',
        source: PRESS_RELEASE_URL,
        periodEnd: '2026-12-31',
        reportedDate: '2026-07-29',
        checkedAt,
      },
    },
  };
};
