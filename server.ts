require('dotenv').config();
import type { Request, Response, NextFunction } from 'express';
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { crawlGoldPrice } = require('./crawlers/goldCrawler');
const { crawlFuelPrice } = require('./crawlers/fuelCrawler');
const { getChartDataFromChatGPT, isConfigured: isChatGPTConfigured } = require('./services/chatgptService');
const { fetchPvoilFuelTable } = require('./services/pvoilFuel');
const { fetchKimTaiNgocGold } = require('./services/kimTaiNgocGold');
const {
  getNewsContent,
  getOutlookContent,
  streamNewsToResponse,
  streamOutlookToResponse
} = require('./services/contentService');
const { streamPlanningReportToResponse, isConfigured: isPlanningConfigured } = require('./services/planningService');
const { getInterestRates } = require('./services/interestRatesService');
const { getFengshuiRecommendation } = require('./services/fengshuiService');
const { askChatGPT } = require('./services/qaService');
const { fetchVietcombankRates } = require('./services/webgiaExchangeService');

const app = express();
const PORT = process.env.PORT || 3004;
app.set('trust proxy', 1);

const API_AUTH_PASSWORD = process.env.API_AUTH_PASSWORD as string | undefined;
const SESSION_SECRET = process.env.SESSION_SECRET;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

/** Khi chạy từ dist/server.js thì public ở ../public; khi chạy server.ts ở root thì public ở ./public. */
const isRunningFromDist = path.basename(__dirname) === 'dist';
const publicDir = isRunningFromDist ? path.join(__dirname, '..', 'public') : path.join(__dirname, 'public');

/** Lấy IP client (ưu tiên X-Forwarded-For khi đứng sau proxy). */
function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0];
    if (first && (first as string).trim()) return (first as string).trim();
  }
  return req.ip || req.socket?.remoteAddress || '—';
}

/** Geolocation từ IP (ip-api.com, free). */
function getLocationFromIp(ip: string): Promise<string> {
  if (!ip || ip === '—' || /^127\.|^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|^::1$/i.test(ip)) {
    return Promise.resolve('Nội bộ');
  }
  return axios
    .get(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=country,city,regionName`, { timeout: 4000 })
    .then((res: { data: { city?: string; country?: string; regionName?: string } }) => {
      const d = res.data;
      if (d && (d.city || d.country)) {
        return [d.city, d.regionName, d.country].filter(Boolean).join(', ') || '—';
      }
      return '—';
    })
    .catch(() => '—');
}

function notifyDiscord(message: string): void {
  if (!DISCORD_WEBHOOK_URL || !DISCORD_WEBHOOK_URL.trim()) return;
  axios
    .post(DISCORD_WEBHOOK_URL.trim(), { content: message }, { timeout: 5000 })
    .catch((err: Error) => console.warn('Discord webhook:', err.message));
}

interface PricesData {
  labels: string[];
  gold: { label: string; unit: string; values: number[]; current: number | null; currentSell?: number | null };
  fuelRON95: { label: string; unit: string; values: number[]; current: number | null };
  fuelDO: { label: string; unit: string; values: number[]; current: number | null };
  interestRates?: unknown;
  lastUpdate: string;
  source?: string;
}

function notifyDiscordPrices(data: PricesData): void {
  if (!DISCORD_WEBHOOK_URL || !DISCORD_WEBHOOK_URL.trim() || !data) return;
  try {
    const g = data.gold;
    const r95 = data.fuelRON95;
    const d = data.fuelDO;
    const ir = (data.interestRates || {}) as { vn?: { refinancingRate?: number; overnightRate?: number }; fed?: { rate?: number }; banks?: Array<{ name: string; rate12m?: number }>; bankLoans?: Array<{ name: string; loanUnsecured?: string; loanSecured?: string }> };
    const lastUpdate = data.lastUpdate ? new Date(data.lastUpdate).toLocaleString('vi-VN') : '—';
    const vn = ir.vn || {};
    const fed = ir.fed || {};
    const lines = [
      '📊 **Job cập nhật trang chủ**',
      `🕐 ${lastUpdate}`,
      '',
      '**Vàng (triệu VND/lượng)**',
      `Mua: ${g?.current != null ? g.current : '—'} | Bán: ${g?.currentSell != null ? g.currentSell : '—'}`,
      '',
      '**Xăng dầu (nghìn VND/lít)**',
      `RON 95: ${r95?.current != null ? r95.current : '—'} | Dầu DO: ${d?.current != null ? d.current : '—'}`,
      '',
      '**Lãi suất**',
      `VN tái cấp: ${vn.refinancingRate != null ? vn.refinancingRate + '%' : '—'} | Qua đêm: ${vn.overnightRate != null ? vn.overnightRate + '%' : '—'} | FED: ${fed.rate != null ? fed.rate + '%' : '—'}`
    ];
    if (Array.isArray(ir.banks) && ir.banks.length > 0) {
      lines.push('', '**Tiết kiệm (12 tháng)**');
      ir.banks.forEach((b) => {
        lines.push(`${b.name}: ${b.rate12m != null ? b.rate12m + '%' : '—'}`);
      });
    }
    if (Array.isArray(ir.bankLoans) && ir.bankLoans.length > 0) {
      lines.push('', '**Vay (tín chấp / thế chấp)**');
      ir.bankLoans.forEach((b) => {
        lines.push(`${b.name}: ${b.loanUnsecured || '—'} / ${b.loanSecured || '—'}`);
      });
    }
    const msg = lines.join('\n');
    axios
      .post(DISCORD_WEBHOOK_URL.trim(), { content: msg.slice(0, 2000) }, { timeout: 5000 })
      .catch((err: Error) => console.warn('Discord webhook (prices):', err.message));
  } catch (err) {
    console.warn('notifyDiscordPrices:', (err as Error).message);
  }
}

function notifyDiscordUsage(featureName: string, ip: string): void {
  if (!DISCORD_WEBHOOK_URL || !DISCORD_WEBHOOK_URL.trim()) return;
  getLocationFromIp(ip).then((location) => {
    const at = new Date().toLocaleString('vi-VN');
    const msg = [
      '🔐 **Có người đang sử dụng**',
      `**Chức năng:** ${featureName}`,
      `**IP:** ${ip}`,
      `**Vị trí (ước lượng):** ${location}`,
      `**Thời gian:** ${at}`
    ].join('\n');
    notifyDiscord(msg);
  });
}

app.use(express.json());
app.use(
  session({
    secret: SESSION_SECRET as string,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 5 * 60 * 1000 }
  })
);

function requireApiAuth(req: Request, res: Response, next: NextFunction): void {
  if (!API_AUTH_PASSWORD || API_AUTH_PASSWORD.trim() === '') return next();
  if (req.session && (req.session as { authenticated?: boolean }).authenticated) return next();
  res.status(401).json({ error: 'Yêu cầu xác thực', code: 'AUTH_REQUIRED' });
}

const DAYS_COUNT = 30;
const cache: { data: PricesData | null; timestamp: number | null; ttl: number } = {
  data: null,
  timestamp: null,
  ttl: 2 * 60 * 1000
};

function isValidCache(data: unknown): data is PricesData {
  const d = data as PricesData | null;
  return !!(d && (d.labels?.length ?? 0) >= DAYS_COUNT && (d.gold?.values?.length ?? 0) >= DAYS_COUNT);
}

function getLast30DayLabels(): string[] {
  const labels: string[] = [];
  const now = new Date();
  for (let i = DAYS_COUNT - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    labels.push(`${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return labels;
}

function build30Values(current: number | null, baseFallback: number, variation = 0.02): number[] {
  const base = current != null && current > 0 ? current : baseFallback;
  const values: number[] = [];
  for (let i = 0; i < DAYS_COUNT - 1; i++) {
    const v = base * (1 + (Math.random() - 0.5) * variation);
    values.push(parseFloat(Math.max(0, v).toFixed(2)));
  }
  values.push(current != null && current > 0 ? parseFloat(Number(current).toFixed(2)) : parseFloat(Number(base).toFixed(2)));
  return values;
}

const minFuelValid = 5;

app.post('/api/auth', (req: Request, res: Response) => {
  if (!API_AUTH_PASSWORD || API_AUTH_PASSWORD.trim() === '') {
    return res.status(200).json({ ok: true });
  }
  const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';
  if (password === API_AUTH_PASSWORD) {
    (req.session as { authenticated?: boolean }).authenticated = true;
    const ip = getClientIp(req);
    notifyDiscordUsage('Đăng nhập', ip);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Mật khẩu không đúng', code: 'AUTH_REQUIRED' });
});

app.get('/api/auth/check', (req: Request, res: Response) => {
  if (!API_AUTH_PASSWORD || API_AUTH_PASSWORD.trim() === '') {
    return res.json({ ok: true, authenticated: true });
  }
  if (req.session && (req.session as { authenticated?: boolean }).authenticated) {
    return res.json({ ok: true, authenticated: true });
  }
  res.status(401).json({ error: 'Yêu cầu xác thực', code: 'AUTH_REQUIRED' });
});

async function getCurrentPricesFromCrawl(): Promise<PricesData> {
  const labels = getLast30DayLabels();
  const [pvoilData, kimTaiNgocGold] = await Promise.all([
    fetchPvoilFuelTable(),
    fetchKimTaiNgocGold()
  ]);
  const ron95 = (pvoilData?.ron95 ?? 0) > minFuelValid ? (pvoilData?.ron95 ?? 25) : 25.0;
  const doPrice = (pvoilData?.do ?? 0) > minFuelValid ? (pvoilData?.do ?? 21.5) : 21.5;
  const goldBuy = kimTaiNgocGold?.buy ?? null;
  const goldSell = kimTaiNgocGold?.sell ?? null;
  let interestRates: unknown = null;
  try {
    interestRates = await getInterestRates();
  } catch (_) {}
  return {
    labels,
    gold: {
      label: 'Vàng nhẫn trơn 9999 (triệu VND/lượng)',
      unit: 'triệu VND/lượng',
      values: build30Values(goldBuy, 78.5),
      current: goldBuy,
      currentSell: goldSell
    },
    fuelRON95: {
      label: 'Xăng RON 95 (nghìn VND/lít)',
      unit: 'nghìn VND/lít',
      values: build30Values(ron95, 25.0),
      current: ron95
    },
    fuelDO: {
      label: 'Dầu (nghìn VND/lít)',
      unit: 'nghìn VND/lít',
      values: build30Values(doPrice, 21.5),
      current: doPrice
    },
    interestRates: interestRates || null,
    lastUpdate: new Date().toISOString(),
    source: 'crawl'
  };
}

async function getPricesData(forceRefresh = false): Promise<PricesData> {
  const now = Date.now();
  if (!forceRefresh && cache.data && cache.timestamp && now - cache.timestamp < cache.ttl) {
    if (isValidCache(cache.data)) {
      cache.data.labels = getLast30DayLabels();
      console.log('Returning cached data');
      return cache.data;
    }
    cache.data = null;
    cache.timestamp = null;
    console.log('Cache invalid, refetching...');
  }
  if (forceRefresh) console.log('Force refresh: fetching new data...');

  try {
    const labels = getLast30DayLabels();
    if (isChatGPTConfigured()) {
      console.log('Fetching data from ChatGPT (website chính thống)...');
      const chatGPTData = await getChartDataFromChatGPT();
      if (chatGPTData) {
        chatGPTData.labels = labels;
        const n = DAYS_COUNT;
        (['gold', 'fuelRON95', 'fuelDO'] as const).forEach((key) => {
          const arr = chatGPTData[key]?.values || [];
          const fallback = key === 'gold' ? 78 : key === 'fuelRON95' ? 25 : 21;
          if (arr.length < n) {
            const last = arr[arr.length - 1] ?? fallback;
            (chatGPTData as PricesData)[key].values = [...arr, ...Array(n - arr.length).fill(last)].slice(0, n) as number[];
          } else {
            (chatGPTData as PricesData)[key].values = arr.slice(0, n);
          }
        });
        try {
          (chatGPTData as PricesData).interestRates = await getInterestRates();
        } catch (_) {
          (chatGPTData as PricesData).interestRates = null;
        }
        cache.data = chatGPTData as PricesData;
        cache.timestamp = now;
        return chatGPTData as PricesData;
      }
      console.log('ChatGPT unavailable, falling back to crawl...');
    }

    const [currentGold, currentFuelRaw] = await Promise.all([
      crawlGoldPrice(),
      crawlFuelPrice()
    ]);
    const currentFuel = {
      ron95: (currentFuelRaw?.ron95 ?? 0) > minFuelValid ? (currentFuelRaw?.ron95 ?? 25) : 25.0,
      do: (currentFuelRaw?.do ?? 0) > minFuelValid ? (currentFuelRaw?.do ?? 21.5) : 21.5
    };
    const data: PricesData = {
      labels,
      gold: {
        label: 'Vàng nhẫn trơn 9999 (triệu VND/lượng)',
        unit: 'triệu VND/lượng',
        values: build30Values(currentGold?.buy ?? null, 78.5),
        current: currentGold?.buy ?? null,
        currentSell: currentGold?.sell ?? null
      },
      fuelRON95: {
        label: 'Xăng RON 95 (nghìn VND/lít)',
        unit: 'nghìn VND/lít',
        values: build30Values(currentFuel.ron95, 25.0),
        current: currentFuel.ron95
      },
      fuelDO: {
        label: 'Dầu (nghìn VND/lít)',
        unit: 'nghìn VND/lít',
        values: build30Values(currentFuel.do, 21.5),
        current: currentFuel.do
      },
      lastUpdate: new Date().toISOString()
    };
    try {
      data.interestRates = await getInterestRates();
    } catch (_) {
      data.interestRates = null;
    }
    cache.data = data;
    cache.timestamp = now;
    return data;
  } catch (error) {
    console.error('Error getting prices data:', error);
    if (cache.data) {
      console.log('Returning stale cache due to error');
      return cache.data;
    }
    const labels = getLast30DayLabels();
    return {
      labels,
      gold: {
        label: 'Vàng nhẫn trơn 9999 (triệu VND/lượng)',
        unit: 'triệu VND/lượng',
        values: build30Values(null, 78.5),
        current: null
      },
      fuelRON95: {
        label: 'Xăng RON 95 (nghìn VND/lít)',
        unit: 'nghìn VND/lít',
        values: build30Values(null, 25.0),
        current: null
      },
      fuelDO: {
        label: 'Dầu (nghìn VND/lít)',
        unit: 'nghìn VND/lít',
        values: build30Values(null, 21.5),
        current: null
      },
      interestRates: null,
      lastUpdate: new Date().toISOString()
    };
  }
}

app.get('/api/prices/current', requireApiAuth, async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const data = await getCurrentPricesFromCrawl();
    res.json(data);
  } catch (error) {
    console.error('Error in /api/prices/current:', error);
    res.status(500).json({ error: 'Failed to fetch current prices' });
  }
});

app.get('/api/prices', requireApiAuth, async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const notifyDiscord = req.query.notify_discord === '1' || req.query.notify_discord === 'true';
    const data = await getPricesData(forceRefresh);
    if (notifyDiscord) notifyDiscordPrices(data);
    res.json(data);
  } catch (error) {
    console.error('Error in /api/prices:', error);
    res.status(500).json({ error: 'Failed to fetch prices data' });
  }
});

app.get('/api/news', requireApiAuth, async (req: Request, res: Response) => {
  const useStream = req.query.stream !== '0';
  if (useStream) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();
    try {
      await streamNewsToResponse(res);
    } catch (error) {
      console.error('Error streaming /api/news:', error);
      if (!res.headersSent) res.status(500).json({ ok: false, error: (error as Error).message });
    }
    return;
  }
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const result = await getNewsContent(forceRefresh);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/news:', error);
    res.status(500).json({ ok: false, error: (error as Error).message, content: null });
  }
});

app.post('/api/planning-report', requireApiAuth, async (req: Request, res: Response) => {
  try {
    notifyDiscordUsage('Kiểm tra quy hoạch', getClientIp(req));
    const lat = parseFloat(req.body?.lat);
    const lng = parseFloat(req.body?.lng);
    const mapLink = typeof req.body?.mapLink === 'string' ? req.body.mapLink.trim() || null : null;
    if (Number.isNaN(lat) || Number.isNaN(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
      return res.status(400).json({ error: 'Tọa độ không hợp lệ (cần lat, lng)' });
    }
    if (!isPlanningConfigured()) {
      return res.status(503).json({ error: 'Chưa cấu hình OpenAI API key. Không thể tạo báo cáo.' });
    }
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();
    await streamPlanningReportToResponse(res, lat, lng, mapLink);
  } catch (error) {
    console.error('Error in /api/planning-report:', error);
    if (!res.headersSent) res.status(500).json({ error: 'Lỗi server khi tạo báo cáo quy hoạch.' });
  }
});

app.get('/api/outlook', requireApiAuth, async (req: Request, res: Response) => {
  const useStream = req.query.stream !== '0';
  if (useStream) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    if (res.flushHeaders) res.flushHeaders();
    try {
      await streamOutlookToResponse(res);
    } catch (error) {
      console.error('Error streaming /api/outlook:', error);
      if (!res.headersSent) res.status(500).json({ ok: false, error: (error as Error).message });
    }
    return;
  }
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const result = await getOutlookContent(forceRefresh);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/outlook:', error);
    res.status(500).json({ ok: false, error: (error as Error).message, content: null });
  }
});

app.post('/api/fengshui', requireApiAuth, async (req: Request, res: Response) => {
  try {
    const husbandName = typeof req.body?.husbandName === 'string' ? req.body.husbandName.trim() : '';
    const husbandDob = typeof req.body?.husbandDob === 'string' ? req.body.husbandDob.trim() : '';
    const wifeName = typeof req.body?.wifeName === 'string' ? req.body.wifeName.trim() : '';
    const wifeDob = typeof req.body?.wifeDob === 'string' ? req.body.wifeDob.trim() : '';
    const result = await getFengshuiRecommendation(husbandName, husbandDob, wifeName, wifeDob);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/fengshui:', error);
    res.status(500).json({ ok: false, error: (error as Error).message });
  }
});

app.post('/api/qa', requireApiAuth, async (req: Request, res: Response) => {
  try {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    const result = await askChatGPT(question);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/qa:', error);
    res.status(500).json({ ok: false, error: (error as Error).message });
  }
});

const exchangeRateCache: { data: unknown | null; ts: number; ttl: number } = { data: null, ts: 0, ttl: 5 * 60 * 1000 };
app.get('/api/exchange-rate', async (req: Request, res: Response) => {
  try {
    const now = Date.now();
    if (req.query.refresh === '1' || !exchangeRateCache.data || now - exchangeRateCache.ts > exchangeRateCache.ttl) {
      const result = await fetchVietcombankRates();
      if (result.ok) {
        exchangeRateCache.data = result;
        exchangeRateCache.ts = now;
      }
      return res.json(result);
    }
    res.json(exchangeRateCache.data);
  } catch (error) {
    console.error('Error in /api/exchange-rate:', error);
    res.status(500).json({ ok: false, error: (error as Error).message });
  }
});

app.get('/manifest.webmanifest', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(publicDir, 'manifest.webmanifest'));
});

/** Trang HTML không đuôi .html: / → index, /news → news.html, ... */
app.get('/', (req: Request, res: Response) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});
app.get('/:page', (req: Request, res: Response, next: NextFunction) => {
  const page = req.params.page;
  if (page.includes('.') || page === 'api') return next();
  const htmlPath = path.join(publicDir, page + '.html');
  if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
  next();
});

app.use(express.static(publicDir));

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  if (API_AUTH_PASSWORD && API_AUTH_PASSWORD.trim()) {
    console.log('API auth enabled: API_AUTH_PASSWORD is set. Gọi API sẽ yêu cầu nhập mật khẩu.');
  }
});
