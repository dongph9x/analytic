require('dotenv').config();
const express = require('express');
const path = require('path');
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

const app = express();
const PORT = process.env.PORT || 3004;

app.use(express.json());

// API routes phải đăng ký trước express.static để POST/GET /api/* luôn do Express xử lý
// Cache: khởi động = null để không trả dữ liệu cũ (12 tháng MM/YYYY). Chuẩn luôn 30 ngày DD/MM.
let cache = {
  data: null,
  timestamp: null,
  ttl: 5 * 60 * 1000 // 5 phút
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
      lastUpdate: new Date().toISOString()
    };
  }
}

/** Chỉ crawl bảng giá (PVOIL + Kim Tài Ngọc), trả về nhanh để hiển thị bảng ngay. */
app.get('/api/prices/current', async (req, res) => {
  try {
    const data = await getCurrentPricesFromCrawl();
    res.json(data);
  } catch (error) {
    console.error('Error in /api/prices/current:', error);
    res.status(500).json({ error: 'Failed to fetch current prices' });
  }
});

app.get('/api/prices', async (req, res) => {
  try {
    const forceRefresh = req.query.refresh === '1' || req.query.refresh === 'true';
    const data = await getPricesData(forceRefresh);
    res.json(data);
  } catch (error) {
    console.error('Error in /api/prices:', error);
    res.status(500).json({ error: 'Failed to fetch prices data' });
  }
});

app.get('/api/news', async (req, res) => {
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

app.post('/api/planning-report', async (req, res) => {
  try {
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

app.get('/api/outlook', async (req, res) => {
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

// Static files (sau API để /api/* không bị serve file)
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

