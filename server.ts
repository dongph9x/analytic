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
  getSummaryContent,
  streamNewsToResponse,
  streamOutlookToResponse
} = require('./services/contentService');
const { streamPlanningReportToResponse, isConfigured: isPlanningConfigured } = require('./services/planningService');
const { getInterestRates } = require('./services/interestRatesService');
const { getFengshuiRecommendation } = require('./services/fengshuiService');
const { askChatGPT } = require('./services/qaService');
const { fetchVietcombankRates } = require('./services/webgiaExchangeService');
const { fetchWorldGoldSpot } = require('./services/worldGoldService');

const app = express();
const PORT = process.env.PORT || 3004;
app.set('trust proxy', 1);

const API_AUTH_PASSWORD = process.env.API_AUTH_PASSWORD as string | undefined;
const SESSION_SECRET = process.env.SESSION_SECRET;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';
/** Secret cho webhook (n8n, cron bên ngoài). Nếu set thì POST /api/webhook/trigger bắt buộc gửi đúng secret. */
const N8N_WEBHOOK_SECRET = process.env.N8N_WEBHOOK_SECRET as string | undefined;

/** Khi chạy từ dist/server.js thì public ở ../public; khi chạy server.ts ở root thì public ở ./public. */
const isRunningFromDist = path.basename(__dirname) === 'dist';
const publicDir = isRunningFromDist ? path.join(__dirname, '..', 'public') : path.join(__dirname, 'public');
const dataDir = isRunningFromDist ? path.join(__dirname, '..', 'data') : path.join(__dirname, 'data');
const NEWS_FILE = path.join(dataDir, 'news.json');
const SUMMARY_FILE = path.join(dataDir, 'summary.json');
const OUTLOOK_FILE = path.join(dataDir, 'outlook.json');
const PRICES_FILE = path.join(dataDir, 'prices.json');
const NEWS_JOB_INTERVAL_MS = 10 * 60 * 1000; // 10 phút

/** Client SSE (Server-Sent Events): khi n8n cập nhật xong, server push event → web refetch và render lại. */
const sseClients = new Set<Response>();

function broadcastSSE(type: string): void {
  const payload = JSON.stringify({ event: 'data-updated', type });
  const line = `data: ${payload}\n\n`;
  let sent = 0;
  sseClients.forEach((res) => {
    try {
      res.write(line);
      if (typeof (res as Response & { flush?: () => void }).flush === 'function') {
        (res as Response & { flush: () => void }).flush();
      }
      sent++;
    } catch {
      sseClients.delete(res);
    }
  });
  if (sent > 0) console.log('SSE broadcast:', type, '→', sent, 'client(s)');
}

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

const DISCORD_HEADERS = { 'Content-Type': 'application/json' };

const NEWS_MAX_AGE_MS = 10 * 60 * 1000; // 10 phút

/** Đọc tin tức từ file. Trả về { ok, content, latest_time } hoặc null. */
function readNewsFromFile(): { ok: boolean; content: unknown; latest_time?: string } | null {
  try {
    if (!fs.existsSync(NEWS_FILE)) return null;
    const raw = fs.readFileSync(NEWS_FILE, 'utf8');
    const data = JSON.parse(raw) as { ok?: boolean; content?: unknown; latest_time?: string };
    if (data && typeof data.ok === 'boolean' && data.content != null) {
      return { ok: data.ok, content: data.content, latest_time: data.latest_time };
    }
    return null;
  } catch {
    return null;
  }
}

/** Kiểm tra dữ liệu tin tức đã quá 10 phút chưa (hoặc thiếu latest_time). */
function isNewsStale(data: { latest_time?: string } | null, maxAgeMs = NEWS_MAX_AGE_MS): boolean {
  if (!data || !data.latest_time) return true;
  const t = new Date(data.latest_time).getTime();
  if (Number.isNaN(t)) return true;
  return Date.now() - t > maxAgeMs;
}

/** Ghi kết quả tin tức ra file (kèm latest_time). */
function writeNewsToFile(result: { ok: boolean; content: unknown }): void {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const toWrite = { ...result, latest_time: new Date().toISOString() };
    fs.writeFileSync(NEWS_FILE, JSON.stringify(toWrite, null, 2), 'utf8');
    console.log('Tin tức đã lưu vào file:', NEWS_FILE);
  } catch (err) {
    console.warn('Ghi file tin tức lỗi:', (err as Error).message);
  }
}

/** Job nền: gọi ChatGPT lấy tin mới, nếu có dữ liệu thì ghi đè file và broadcast SSE. */
async function runNewsJob(): Promise<void> {
  try {
    const result = await getNewsContent(true);
    if (result && result.ok && result.content) {
      writeNewsToFile(result);
      broadcastSSE('news');
    }
  } catch (err) {
    console.warn('Job tin tức lỗi:', (err as Error).message);
  }
}

/** Đọc tổng hợp từ file. Trả về { ok, content, latest_time } hoặc null. */
function readSummaryFromFile(): { ok: boolean; content: unknown; latest_time?: string } | null {
  try {
    if (!fs.existsSync(SUMMARY_FILE)) return null;
    const raw = fs.readFileSync(SUMMARY_FILE, 'utf8');
    const data = JSON.parse(raw) as { ok?: boolean; content?: unknown; latest_time?: string };
    if (data && typeof data.ok === 'boolean' && data.content != null) {
      return { ok: data.ok, content: data.content, latest_time: data.latest_time };
    }
    return null;
  } catch {
    return null;
  }
}

/** Ghi kết quả tổng hợp ra file. */
function writeSummaryToFile(result: { ok: boolean; content: unknown }): void {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const toWrite = { ...result, latest_time: new Date().toISOString() };
    fs.writeFileSync(SUMMARY_FILE, JSON.stringify(toWrite, null, 2), 'utf8');
    console.log('Tổng hợp đã lưu vào file:', SUMMARY_FILE);
  } catch (err) {
    console.warn('Ghi file tổng hợp lỗi:', (err as Error).message);
  }
}

async function runSummaryJob(): Promise<void> {
  try {
    const result = await getSummaryContent(true);
    if (result && result.ok && result.content) {
      writeSummaryToFile(result);
      broadcastSSE('summary');
    }
  } catch (err) {
    console.warn('Job tổng hợp lỗi:', (err as Error).message);
  }
}

/** Đọc nhận định từ file. Trả về { ok, content, latest_time } hoặc null. */
function readOutlookFromFile(): { ok: boolean; content: unknown; latest_time?: string } | null {
  try {
    if (!fs.existsSync(OUTLOOK_FILE)) return null;
    const raw = fs.readFileSync(OUTLOOK_FILE, 'utf8');
    const data = JSON.parse(raw) as { ok?: boolean; content?: unknown; latest_time?: string };
    if (data && typeof data.ok === 'boolean' && data.content != null) {
      return { ok: data.ok, content: data.content, latest_time: data.latest_time };
    }
    return null;
  } catch {
    return null;
  }
}

/** Ghi nhận định ra file. */
function writeOutlookToFile(result: { ok: boolean; content: unknown }): void {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    const toWrite = { ...result, latest_time: new Date().toISOString() };
    fs.writeFileSync(OUTLOOK_FILE, JSON.stringify(toWrite, null, 2), 'utf8');
    console.log('Nhận định đã lưu vào file:', OUTLOOK_FILE);
  } catch (err) {
    console.warn('Ghi file nhận định lỗi:', (err as Error).message);
  }
}

async function runOutlookJob(): Promise<void> {
  try {
    const result = await getOutlookContent(true);
    if (result && result.ok && result.content) {
      writeOutlookToFile(result);
      broadcastSSE('outlook');
    }
  } catch (err) {
    console.warn('Job nhận định lỗi:', (err as Error).message);
  }
}

/** Đọc giá từ file (n8n webhook ghi khi cập nhật). */
function readPricesFromFile(): PricesData | null {
  try {
    if (!fs.existsSync(PRICES_FILE)) return null;
    const raw = fs.readFileSync(PRICES_FILE, 'utf8');
    const data = JSON.parse(raw) as PricesData;
    if (data && isValidCache(data)) {
      data.labels = getLast30DayLabels();
      return data;
    }
    return null;
  } catch {
    return null;
  }
}

/** Ghi giá ra file (gọi sau khi getPricesData cập nhật cache). */
function writePricesToFile(data: PricesData): void {
  try {
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(PRICES_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.warn('Ghi file giá lỗi:', (err as Error).message);
  }
}

function onDiscordFail(err: Error & { response?: { status?: number } }): void {
  const status = err.response?.status;
  if (status === 401) {
    console.warn('Discord webhook thất bại (401). Tạo webhook mới trong Discord (Cài đặt kênh → Tích hợp → Webhook) và cập nhật DISCORD_WEBHOOK_URL trong .env');
  } else if (status) {
    console.warn('Discord webhook thất bại:', status, err.message);
  }
}

function notifyDiscord(message: string): void {
  if (!DISCORD_WEBHOOK_URL || !DISCORD_WEBHOOK_URL.trim()) return;
  const url = DISCORD_WEBHOOK_URL.trim();
  console.log('Discord webhook: gửi tin');
  axios
    .post(url, { content: message }, { timeout: 5000, headers: DISCORD_HEADERS })
    .catch(onDiscordFail);
}

interface PricesData {
  labels: string[];
  gold: { label: string; unit: string; values: number[]; current: number | null; currentSell?: number | null };
  gold980?: { label: string; unit: string; values: number[]; current: number | null; currentSell?: number | null };
  fuelRON95: { label: string; unit: string; values: number[]; current: number | null };
  fuelDO: { label: string; unit: string; values: number[]; current: number | null };
  worldGold?: { currentBuy: number | null; currentSell: number | null; changePercent?: number | null; unit: string; source?: string };
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
    console.log('Discord webhook: gửi tin giá/lãi suất');
    axios
      .post(DISCORD_WEBHOOK_URL.trim(), { content: msg.slice(0, 2000) }, { timeout: 5000, headers: DISCORD_HEADERS })
      .catch(onDiscordFail);
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
  const [pvoilData, kimTaiNgocGold, worldGold] = await Promise.all([
    fetchPvoilFuelTable(),
    fetchKimTaiNgocGold(),
    fetchWorldGoldSpot()
  ]);
  const ron95 = (pvoilData?.ron95 ?? 0) > minFuelValid ? (pvoilData?.ron95 ?? 25) : 25.0;
  const doPrice = (pvoilData?.do ?? 0) > minFuelValid ? (pvoilData?.do ?? 21.5) : 21.5;
  const goldBuy = kimTaiNgocGold?.buy ?? null;
  const goldSell = kimTaiNgocGold?.sell ?? null;
  const gold980Buy = kimTaiNgocGold?.buy980 ?? null;
  const gold980Sell = kimTaiNgocGold?.sell980 ?? null;
  let interestRates: unknown = null;
  try {
    interestRates = await getInterestRates();
  } catch (_) {}
  const out: PricesData = {
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
    worldGold: worldGold && (worldGold.currentBuy != null || worldGold.currentSell != null) ? { currentBuy: worldGold.currentBuy ?? null, currentSell: worldGold.currentSell ?? null, changePercent: worldGold.changePercent ?? null, unit: worldGold.unit || 'USD/oz', source: worldGold.source } : undefined,
    interestRates: interestRates || null,
    lastUpdate: new Date().toISOString(),
    source: 'crawl'
  };
  if (gold980Buy != null || gold980Sell != null) {
    out.gold980 = {
      label: 'Vàng 980 (triệu VND/lượng)',
      unit: 'triệu VND/lượng',
      values: build30Values(gold980Buy, 76),
      current: gold980Buy,
      currentSell: gold980Sell
    };
  }
  return out;
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
        try {
          const wg = await fetchWorldGoldSpot();
          if (wg && (wg.currentBuy != null || wg.currentSell != null)) (chatGPTData as PricesData).worldGold = { currentBuy: wg.currentBuy ?? null, currentSell: wg.currentSell ?? null, changePercent: wg.changePercent ?? null, unit: wg.unit || 'USD/oz', source: wg.source };
        } catch (_) {}
        try {
          const ktng = await fetchKimTaiNgocGold();
          if (ktng?.buy980 != null || ktng?.sell980 != null) {
            (chatGPTData as PricesData).gold980 = {
              label: 'Vàng 980 (triệu VND/lượng)',
              unit: 'triệu VND/lượng',
              values: build30Values(ktng.buy980 ?? null, 76),
              current: ktng.buy980 ?? null,
              currentSell: ktng.sell980 ?? null
            };
          }
        } catch (_) {}
    cache.data = chatGPTData as PricesData;
    cache.timestamp = now;
    writePricesToFile(cache.data);
    broadcastSSE('prices');
    return chatGPTData as PricesData;
      }
      console.log('ChatGPT unavailable, falling back to crawl...');
    }

    const [currentGold, currentFuelRaw, worldGold] = await Promise.all([
      crawlGoldPrice(),
      crawlFuelPrice(),
      fetchWorldGoldSpot()
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
      worldGold: worldGold && (worldGold.currentBuy != null || worldGold.currentSell != null) ? { currentBuy: worldGold.currentBuy ?? null, currentSell: worldGold.currentSell ?? null, changePercent: worldGold.changePercent ?? null, unit: worldGold.unit || 'USD/oz', source: worldGold.source } : undefined,
      lastUpdate: new Date().toISOString()
    };
    try {
      data.interestRates = await getInterestRates();
    } catch (_) {
      data.interestRates = null;
    }
    cache.data = data;
    cache.timestamp = now;
    writePricesToFile(data);
    broadcastSSE('prices');
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

/** Dữ liệu giá cho web: chỉ đọc cache hoặc file (n8n webhook cập nhật). Không gọi crawl/ChatGPT. */
function getPricesForWeb(): PricesData | null {
  if (cache.data && isValidCache(cache.data)) {
    cache.data.labels = getLast30DayLabels();
    return cache.data;
  }
  return readPricesFromFile();
}

/** API giá (trang chủ): chỉ đọc cache/file. n8n webhook cập nhật theo lịch. */
app.get('/api/prices/current', requireApiAuth, async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const data = getPricesForWeb();
    if (data) return res.json(data);
    res.status(503).json({
      error: 'Chưa có dữ liệu giá. n8n cập nhật theo lịch.',
      labels: getLast30DayLabels(),
      gold: { label: '', unit: 'triệu VND/lượng', values: [], current: null, currentSell: null },
      fuelRON95: { label: '', unit: 'nghìn VND/lít', values: [], current: null },
      fuelDO: { label: '', unit: 'nghìn VND/lít', values: [], current: null },
      lastUpdate: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in /api/prices/current:', error);
    res.status(500).json({ error: 'Failed to fetch current prices' });
  }
});

app.get('/api/prices', requireApiAuth, async (req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const data = getPricesForWeb();
    if (data) return res.json(data);
    res.status(503).json({
      error: 'Chưa có dữ liệu giá. n8n cập nhật theo lịch.',
      labels: getLast30DayLabels(),
      gold: { label: '', unit: 'triệu VND/lượng', values: [], current: null, currentSell: null },
      fuelRON95: { label: '', unit: 'nghìn VND/lít', values: [], current: null },
      fuelDO: { label: '', unit: 'nghìn VND/lít', values: [], current: null },
      lastUpdate: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error in /api/prices:', error);
    res.status(500).json({ error: 'Failed to fetch prices data' });
  }
});

/** API tin tức: chỉ đọc từ file (n8n webhook cập nhật theo lịch). Không chạy job. */
app.get('/api/news', requireApiAuth, async (req: Request, res: Response) => {
  const useStream = req.query.stream === '1';
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
    const fromFile = readNewsFromFile();
    if (fromFile) return res.json(fromFile);
    res.json({ ok: false, error: 'Chưa có dữ liệu tin tức. n8n cập nhật theo lịch.', content: null });
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

/** API nhận định: chỉ đọc từ file (n8n webhook cập nhật theo lịch, cùng lịch tin tức). Không chạy job. */
app.get('/api/outlook', requireApiAuth, async (req: Request, res: Response) => {
  const useStream = req.query.stream === '1';
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
    const fromFile = readOutlookFromFile();
    if (fromFile) return res.json(fromFile);
    res.json({ ok: false, error: 'Chưa có dữ liệu nhận định. n8n cập nhật theo lịch.', content: null });
  } catch (error) {
    console.error('Error in /api/outlook:', error);
    res.status(500).json({ ok: false, error: (error as Error).message, content: null });
  }
});

/** API tổng hợp: chỉ đọc từ file (n8n webhook cập nhật theo lịch). Không chạy job. */
app.get('/api/summary', requireApiAuth, async (req: Request, res: Response) => {
  try {
    const fromFile = readSummaryFromFile();
    if (fromFile) return res.json(fromFile);
    res.json({ ok: false, error: 'Chưa có dữ liệu tổng hợp. n8n cập nhật theo lịch.', content: null });
  } catch (error) {
    console.error('Error in /api/summary:', error);
    res.status(500).json({ ok: false, error: (error as Error).message, content: null });
  }
});

/** Kiểm tra app có sống không (GET, dùng test kết nối từ n8n hoặc browser). */
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'analytic-chart', time: new Date().toISOString() });
});

/** SSE: client subscribe, khi n8n cập nhật (webhook) server gửi event → client refetch và render lại. Không cần setInterval. */
app.get('/api/events', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  sseClients.add(res);
  try {
    res.write(': ok\n\n');
    if (typeof (res as Response & { flush?: () => void }).flush === 'function') {
      (res as Response & { flush: () => void }).flush();
    }
  } catch (_) {}
  const heartbeat = setInterval(() => {
    try {
      res.write(': keepalive\n\n');
    } catch {
      clearInterval(heartbeat);
      sseClients.delete(res);
    }
  }, 30000);
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
});

/** Webhook cho n8n / cron: kích hoạt job tin tức, tổng hợp hoặc làm mới cache giá. Trả về ngay, chạy job nền (tránh timeout n8n). Xác thực bằng N8N_WEBHOOK_SECRET. */
app.post('/api/webhook/trigger', async (req: Request, res: Response) => {
  const secret =
    (req.headers['x-webhook-secret'] as string)?.trim() ||
    (typeof req.body?.secret === 'string' ? req.body.secret.trim() : '');
  if (N8N_WEBHOOK_SECRET && N8N_WEBHOOK_SECRET.trim() && secret !== N8N_WEBHOOK_SECRET.trim()) {
    return res.status(401).json({ ok: false, error: 'Webhook secret không hợp lệ' });
  }
  const job = (req.body?.job ?? req.query?.job ?? 'all') as string;
  const normalized = String(job).toLowerCase().trim();
  if (normalized !== 'news' && normalized !== 'summary' && normalized !== 'outlook' && normalized !== 'prices' && normalized !== 'all' && normalized !== '') {
    return res.status(400).json({ ok: false, error: 'job phải là news, summary, outlook, prices hoặc all' });
  }
  // Chạy job ở background, trả về ngay để n8n không bị timeout
  const run = (): void => {
    if (normalized === 'news') {
      runNewsJob().catch((err) => console.error('Webhook job news:', err));
    } else if (normalized === 'summary') {
      runSummaryJob().catch((err) => console.error('Webhook job summary:', err));
    } else if (normalized === 'outlook') {
      runOutlookJob().catch((err) => console.error('Webhook job outlook:', err));
    } else if (normalized === 'prices') {
      getPricesData(true).catch((err) => console.error('Webhook job prices:', err));
    } else {
      runNewsJob().catch((err) => console.error('Webhook job news:', err));
      runSummaryJob().catch((err) => console.error('Webhook job summary:', err));
      runOutlookJob().catch((err) => console.error('Webhook job outlook:', err));
      getPricesData(true).catch((err) => console.error('Webhook job prices:', err));
    }
  };
  setImmediate(run);
  return res.status(202).json({ ok: true, job: normalized || 'all', message: 'Đã đưa job vào hàng đợi, đang chạy nền' });
});

/** GET /api/webhook/trigger trả 405 để test đúng path (webhook chỉ nhận POST). */
app.get('/api/webhook/trigger', (_req: Request, res: Response) => {
  res.status(405).json({
    ok: false,
    error: 'Method Not Allowed',
    message: 'Webhook chỉ chấp nhận POST. Dùng: POST /api/webhook/trigger với body JSON { "job": "news" | "summary" | "outlook" | "prices" | "all" }'
  });
});

/** Webhook riêng từng job (n8n: mỗi chức năng một URL, không cần body). */
function registerWebhookJobRoute(job: 'news' | 'summary' | 'outlook' | 'prices' | 'all'): void {
  app.post(`/api/webhook/trigger/${job}`, async (req: Request, res: Response) => {
    const secret =
      (req.headers['x-webhook-secret'] as string)?.trim() ||
      (typeof req.body?.secret === 'string' ? req.body.secret.trim() : '');
    if (N8N_WEBHOOK_SECRET && N8N_WEBHOOK_SECRET.trim() && secret !== N8N_WEBHOOK_SECRET.trim()) {
      return res.status(401).json({ ok: false, error: 'Webhook secret không hợp lệ' });
    }
    const run = (): void => {
      if (job === 'news') runNewsJob().catch((err) => console.error('Webhook job news:', err));
      else if (job === 'summary') runSummaryJob().catch((err) => console.error('Webhook job summary:', err));
      else if (job === 'outlook') runOutlookJob().catch((err) => console.error('Webhook job outlook:', err));
      else if (job === 'prices') getPricesData(true).catch((err) => console.error('Webhook job prices:', err));
      else {
        runNewsJob().catch((err) => console.error('Webhook job news:', err));
        runSummaryJob().catch((err) => console.error('Webhook job summary:', err));
        runOutlookJob().catch((err) => console.error('Webhook job outlook:', err));
        getPricesData(true).catch((err) => console.error('Webhook job prices:', err));
      }
    };
    setImmediate(run);
    return res.status(202).json({ ok: true, job, message: 'Đã đưa job vào hàng đợi, đang chạy nền' });
  });
}
registerWebhookJobRoute('news');
registerWebhookJobRoute('summary');
registerWebhookJobRoute('outlook');
registerWebhookJobRoute('prices');
registerWebhookJobRoute('all');

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

// Service Worker: luôn revalidate để trình duyệt nhận bản mới khi deploy (đổi CACHE_NAME trong sw.js).
app.get('/sw.js', (_req: Request, res: Response) => {
  res.setHeader('Cache-Control', 'no-cache, max-age=0');
  res.sendFile(path.join(publicDir, 'sw.js'));
});
app.use(express.static(publicDir));

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  if (API_AUTH_PASSWORD && API_AUTH_PASSWORD.trim()) {
    console.log('API auth enabled: API_AUTH_PASSWORD is set. Gọi API sẽ yêu cầu nhập mật khẩu.');
  }
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  const pricesFromFile = readPricesFromFile();
  if (pricesFromFile) {
    cache.data = pricesFromFile;
    cache.timestamp = Date.now();
    console.log('Đã nạp giá từ file (n8n cập nhật). Web chỉ đọc cache/file.');
  }
  console.log('Cập nhật dữ liệu: dùng n8n webhook POST /api/webhook/trigger/news, /summary, /prices hoặc /all.');
});
