require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
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

const API_AUTH_PASSWORD = process.env.API_AUTH_PASSWORD;
const SESSION_SECRET = process.env.SESSION_SECRET;
const DISCORD_WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL || '';

/** Lấy IP client (ưu tiên X-Forwarded-For khi đứng sau proxy). */
function getClientIp(req) {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    const first = typeof forwarded === 'string' ? forwarded.split(',')[0] : forwarded[0];
    if (first && first.trim()) return first.trim();
  }
  return req.ip || req.socket?.remoteAddress || '—';
}

/** Geolocation từ IP (ip-api.com, free). Trả về chuỗi "Thành phố, Quốc gia" hoặc "—" nếu lỗi/IP nội bộ. */
function getLocationFromIp(ip) {
  if (!ip || ip === '—' || /^127\.|^10\.|^172\.(1[6-9]|2\d|3[01])\.|^192\.168\.|^::1$/i.test(ip)) {
    return Promise.resolve('Nội bộ');
  }
  return axios
    .get(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=country,city,regionName`, { timeout: 4000 })
    .then((res) => {
      const d = res.data;
      if (d && (d.city || d.country)) {
        return [d.city, d.regionName, d.country].filter(Boolean).join(', ') || '—';
      }
      return '—';
    })
    .catch(() => '—');
}

/** Gửi thông báo lên Discord (fire-and-forget). Nếu chưa cấu hình webhook thì bỏ qua. */
function notifyDiscord(message) {
  if (!DISCORD_WEBHOOK_URL || !DISCORD_WEBHOOK_URL.trim()) return;
  axios
    .post(DISCORD_WEBHOOK_URL.trim(), { content: message }, { timeout: 5000 })
    .catch((err) => console.warn('Discord webhook:', err.message));
}

/** Gửi summary dữ liệu trang chủ lên Discord (job nền cập nhật). Fire-and-forget. */
function notifyDiscordPrices(data) {
  if (!DISCORD_WEBHOOK_URL || !DISCORD_WEBHOOK_URL.trim() || !data) return;
  try {
    const g = data.gold;
    const r95 = data.fuelRON95;
    const d = data.fuelDO;
    const ir = data.interestRates || {};
    const vn = ir.vn || {};
    const fed = ir.fed || {};
    const lastUpdate = data.lastUpdate ? new Date(data.lastUpdate).toLocaleString('vi-VN') : '—';

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
      .catch((err) => console.warn('Discord webhook (prices):', err.message));
  } catch (err) {
    console.warn('notifyDiscordPrices:', err.message);
  }
}

/** Gửi Discord với thông tin: chức năng, IP, location (gọi bất đồng bộ, không chặn response). */
function notifyDiscordUsage(featureName, ip) {
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
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: 5 * 60 * 1000 }
  })
);

/** Nếu đã cấu hình API_AUTH_PASSWORD thì yêu cầu session đã xác thực; không thì cho qua. */
function requireApiAuth(req, res, next) {
  if (!API_AUTH_PASSWORD || API_AUTH_PASSWORD.trim() === '') return next();
  if (req.session && req.session.authenticated) return next();
  res.status(401).json({ error: 'Yêu cầu xác thực', code: 'AUTH_REQUIRED' });
}

// API routes phải đăng ký trước express.static để POST/GET /api/* luôn do Express xử lý
// Cache: khởi động = null để không trả dữ liệu cũ (12 tháng MM/YYYY). Chuẩn luôn 30 ngày DD/MM.
let cache = {
  data: null,
  timestamp: null,
  ttl: 2 * 60 * 1000 // 2 phút – luôn ưu tiên dữ liệu mới nhất
};

const DAYS_COUNT = 30;

/** Kiểm tra data có đúng format (labels, gold.values) không. */
function isValidCache(data) {
  return data?.labels?.length >= DAYS_COUNT && data?.gold?.values?.length >= DAYS_COUNT;
}

/** Trả về 30 nhãn ngày "DD/MM" gần nhất: từ (hôm nay - 29) đến hôm nay (tính cả ngày hiện tại). */
function getLast30DayLabels() {
  const labels = [];
  const now = new Date();
  for (let i = DAYS_COUNT - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    labels.push(`${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return labels;
}

/** Tạo 30 giá trị: 29 ngày trước có biến động nhẹ từ base, ngày cuối = current. */
function build30Values(current, baseFallback, variation = 0.02) {
  const base = current != null && current > 0 ? current : baseFallback;
  const values = [];
  for (let i = 0; i < DAYS_COUNT - 1; i++) {
    const v = base * (1 + (Math.random() - 0.5) * variation);
    values.push(parseFloat(Math.max(0, v).toFixed(2)));
  }
  values.push(current != null && current > 0 ? parseFloat(Number(current).toFixed(2)) : parseFloat(Number(base).toFixed(2)));
  return values;
}

const minFuelValid = 5;

// --- Xác thực API (pass cấu hình trong env) ---
app.post('/api/auth', (req, res) => {
  if (!API_AUTH_PASSWORD || API_AUTH_PASSWORD.trim() === '') {
    return res.status(200).json({ ok: true });
  }
  const password = typeof req.body?.password === 'string' ? req.body.password.trim() : '';
  if (password === API_AUTH_PASSWORD) {
    req.session.authenticated = true;
    const ip = getClientIp(req);
    notifyDiscordUsage('Đăng nhập', ip);
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Mật khẩu không đúng', code: 'AUTH_REQUIRED' });
});

app.get('/api/auth/check', (req, res) => {
  if (!API_AUTH_PASSWORD || API_AUTH_PASSWORD.trim() === '') {
    return res.json({ ok: true, authenticated: true });
  }
  if (req.session && req.session.authenticated) {
    return res.json({ ok: true, authenticated: true });
  }
  res.status(401).json({ error: 'Yêu cầu xác thực', code: 'AUTH_REQUIRED' });
});

// --- API cần xác thực (khi đã cấu hình API_AUTH_PASSWORD) ---

/**
 * Chỉ crawl PVOIL + Kim Tài Ngọc, trả về ngay để hiển thị bảng giá (không đợi ChatGPT).
 * Format giống getPricesData() để frontend render bảng được ngay.
 */
async function getCurrentPricesFromCrawl() {
  const labels = getLast30DayLabels();
  const [pvoilData, kimTaiNgocGold] = await Promise.all([
    fetchPvoilFuelTable(),
    fetchKimTaiNgocGold()
  ]);
  const ron95 = pvoilData?.ron95 > minFuelValid ? pvoilData.ron95 : 25.0;
  const doPrice = pvoilData?.do > minFuelValid ? pvoilData.do : 21.5;
  const goldBuy = kimTaiNgocGold?.buy ?? null;
  const goldSell = kimTaiNgocGold?.sell ?? null;

  let interestRates = null;
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

/**
 * Lấy dữ liệu từ cache hoặc crawl mới. Luôn ưu tiên số liệu tại thời điểm hiện tại.
 * @param {boolean} [forceRefresh=false] - Nếu true thì bỏ qua cache, luôn fetch mới.
 */
async function getPricesData(forceRefresh = false) {
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
  if (forceRefresh) {
    console.log('Force refresh: fetching new data...');
  }

  try {
    const labels = getLast30DayLabels();

    if (isChatGPTConfigured()) {
      console.log('Fetching data from ChatGPT (website chính thống)...');
      const chatGPTData = await getChartDataFromChatGPT();
      if (chatGPTData) {
        chatGPTData.labels = labels;
        const n = DAYS_COUNT;
        ['gold', 'fuelRON95', 'fuelDO'].forEach((key) => {
          const arr = chatGPTData[key]?.values || [];
          const fallback = key === 'gold' ? 78 : key === 'fuelRON95' ? 25 : 21;
          if (arr.length < n) {
            const last = arr[arr.length - 1] ?? fallback;
            chatGPTData[key].values = [...arr, ...Array(n - arr.length).fill(last)].slice(0, n);
          } else {
            chatGPTData[key].values = arr.slice(0, n);
          }
        });
        try {
          chatGPTData.interestRates = await getInterestRates();
        } catch (_) {
          chatGPTData.interestRates = null;
        }
        cache.data = chatGPTData;
        cache.timestamp = now;
        return chatGPTData;
      }
      console.log('ChatGPT unavailable, falling back to crawl...');
    }

    const [currentGold, currentFuelRaw] = await Promise.all([
      crawlGoldPrice(),
      crawlFuelPrice()
    ]);
    const currentFuel = {
      ron95: currentFuelRaw?.ron95 > minFuelValid ? currentFuelRaw.ron95 : 25.0,
      do: currentFuelRaw?.do > minFuelValid ? currentFuelRaw.do : 21.5
    };

    const data = {
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

/** Chỉ crawl bảng giá (PVOIL + Kim Tài Ngọc), trả về nhanh để hiển thị bảng ngay. */
app.get('/api/prices/current', requireApiAuth, async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const data = await getCurrentPricesFromCrawl();
    res.json(data);
  } catch (error) {
    console.error('Error in /api/prices/current:', error);
    res.status(500).json({ error: 'Failed to fetch current prices' });
  }
});

app.get('/api/prices', requireApiAuth, async (req, res) => {
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

app.get('/api/news', requireApiAuth, async (req, res) => {
  const useStream = req.query.stream !== '0';
  if (useStream) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders && res.flushHeaders();
    try {
      await streamNewsToResponse(res);
    } catch (error) {
      console.error('Error streaming /api/news:', error);
      if (!res.headersSent) res.status(500).json({ ok: false, error: error.message });
    }
    return;
  }
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const result = await getNewsContent(forceRefresh);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/news:', error);
    res.status(500).json({ ok: false, error: error.message, content: null });
  }
});

app.post('/api/planning-report', requireApiAuth, async (req, res) => {
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

app.get('/api/outlook', requireApiAuth, async (req, res) => {
  const useStream = req.query.stream !== '0';
  if (useStream) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders && res.flushHeaders();
    try {
      await streamOutlookToResponse(res);
    } catch (error) {
      console.error('Error streaming /api/outlook:', error);
      if (!res.headersSent) res.status(500).json({ ok: false, error: error.message });
    }
    return;
  }
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const result = await getOutlookContent(forceRefresh);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/outlook:', error);
    res.status(500).json({ ok: false, error: error.message, content: null });
  }
});

app.post('/api/fengshui', requireApiAuth, async (req, res) => {
  try {
    const husbandName = typeof req.body?.husbandName === 'string' ? req.body.husbandName.trim() : '';
    const husbandDob = typeof req.body?.husbandDob === 'string' ? req.body.husbandDob.trim() : '';
    const wifeName = typeof req.body?.wifeName === 'string' ? req.body.wifeName.trim() : '';
    const wifeDob = typeof req.body?.wifeDob === 'string' ? req.body.wifeDob.trim() : '';
    const result = await getFengshuiRecommendation(husbandName, husbandDob, wifeName, wifeDob);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/fengshui:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/qa', requireApiAuth, async (req, res) => {
  try {
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    const result = await askChatGPT(question);
    res.json(result);
  } catch (error) {
    console.error('Error in /api/qa:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

const exchangeRateCache = { data: null, ts: 0, ttl: 5 * 60 * 1000 };
app.get('/api/exchange-rate', async (req, res) => {
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
    res.status(500).json({ ok: false, error: error.message });
  }
});

// PWA manifest – MIME type chuẩn
app.get('/manifest.webmanifest', (req, res) => {
  res.setHeader('Content-Type', 'application/manifest+json');
  res.sendFile(path.join(__dirname, 'public', 'manifest.webmanifest'));
});

// Static files (sau API để /api/* không bị serve file)
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  if (API_AUTH_PASSWORD && API_AUTH_PASSWORD.trim()) {
    console.log('API auth enabled: API_AUTH_PASSWORD is set. Gọi API sẽ yêu cầu nhập mật khẩu.');
  }
});

