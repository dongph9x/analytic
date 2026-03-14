/**
 * Lấy giá vàng thế giới (spot, USD/troy oz) từ nguồn chính thống.
 * Ưu tiên: Investing.com (vn) → Gold API → Kitco.
 */
const axios = require('axios');
const cheerio = require('cheerio');

const INVESTING_URL = 'https://vn.investing.com/currencies/xau-usd';
const GOLD_API_URL = 'https://api.gold-api.com/price/XAU';
const KITCO_URL = 'https://www.kitco.com/market/';

const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
  'Referer': 'https://vn.investing.com/',
  'Cache-Control': 'no-cache',
  'Pragma': 'no-cache'
};

/**
 * Crawl giá mua & bán XAU/USD từ vn.investing.com/currencies/xau-usd.
 * @returns {Promise<{ spotBuy: number|null, spotSell: number|null, unit: string, source: string }>}
 */
async function fetchFromInvesting() {
  try {
    const res = await axios.get(INVESTING_URL, {
      timeout: 15000,
      headers: BROWSER_HEADERS,
      maxRedirects: 5
    });
    const html = res.data;
    const $ = cheerio.load(html);
    let spotBuy = null;
    let spotSell = null;

    const parsePrice = (text) => {
      const n = parseFloat(String(text).replace(/\s/g, '').replace(/,/g, ''));
      if (typeof n === 'number' && !Number.isNaN(n) && n > 1000 && n < 10000) return Math.round(n * 100) / 100;
      return null;
    };

    const allPrices = [];
    $('[data-test="instrument-price-last"], [data-test="instrument-header-price"], [class*="instrument-price"], [class*="bid"], [class*="ask"]').each((_, el) => {
      const t = $(el).text().trim();
      const p = parsePrice(t);
      if (p != null) allPrices.push(p);
    });
    if (allPrices.length >= 2) {
      spotBuy = Math.min(allPrices[0], allPrices[1]);
      spotSell = Math.max(allPrices[0], allPrices[1]);
    } else if (allPrices.length === 1) {
      spotBuy = spotSell = allPrices[0];
    }

    if (spotBuy == null || spotSell == null) {
      const bodyText = $('body').html() || '';
      const matches = bodyText.match(/\b(\d{1,2}[,.]?\d{3}[.]\d{2})\b/g) || [];
      const valid = matches.map((m) => parseFloat(m.replace(/,/g, ''))).filter((n) => n > 1500 && n < 5000);
      if (valid.length >= 2) {
        spotBuy = Math.round(Math.min(...valid) * 100) / 100;
        spotSell = Math.round(Math.max(...valid) * 100) / 100;
      } else if (valid.length === 1) {
        spotBuy = spotSell = Math.round(valid[0] * 100) / 100;
      }
    }
    if (spotBuy == null && html) {
      const jsonLike = html.match(/"last":\s*(\d+\.?\d*)/) || html.match(/"close":\s*(\d+\.?\d*)/) || html.match(/"price":\s*(\d+\.?\d*)/);
      if (jsonLike) {
        const num = parseFloat(jsonLike[1]);
        if (num > 1500 && num < 5000) spotBuy = spotSell = Math.round(num * 100) / 100;
      }
    }

    let changePercent = null;
    const changeEl = $('[data-test="instrument-price-change-percent"]').first();
    if (changeEl.length) {
      const changeText = changeEl.text().replace(/\s/g, '').replace(/[()]/g, '');
      const changeMatch = changeText.match(/([+-]?\d+[.,]\d+)\s*%?/);
      if (changeMatch) {
        const pct = parseFloat(changeMatch[1].replace(/,/g, '.'));
        if (!Number.isNaN(pct) && pct >= -100 && pct <= 100) changePercent = Math.round(pct * 100) / 100;
      }
    }

    if (spotBuy != null || spotSell != null) {
      if (spotBuy == null) spotBuy = spotSell;
      if (spotSell == null) spotSell = spotBuy;
      return { spotBuy, spotSell, changePercent, unit: 'USD/oz', source: 'Investing.com (vn.investing.com)' };
    }
  } catch (err) {
    console.warn('World gold (Investing.com):', err.message);
  }
  return { spotBuy: null, spotSell: null, changePercent: null, unit: 'USD/oz', source: '' };
}

/**
 * Gọi Gold API (miễn phí, không key) lấy giá XAU. API trả 1 giá → dùng cho cả mua & bán.
 * @returns {Promise<{ spotBuy: number|null, spotSell: number|null, unit: string, source: string }>}
 */
async function fetchFromGoldApi() {
  try {
    const res = await axios.get(GOLD_API_URL, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; analytic-chart/1.0)' }
    });
    const data = res.data;
    const price = data?.price;
    if (typeof price === 'number' && price > 0 && price < 100000) {
      const p = Math.round(price * 100) / 100;
      return { spotBuy: p, spotSell: p, changePercent: null, unit: 'USD/oz', source: 'Gold API (gold-api.com)' };
    }
  } catch (err) {
    console.warn('World gold (Gold API):', err.message);
  }
  return { spotBuy: null, spotSell: null, changePercent: null, unit: 'USD/oz', source: '' };
}

/**
 * Crawl giá vàng spot từ Kitco (dự phòng). 1 giá → dùng cho cả mua & bán.
 * @returns {Promise<{ spotBuy: number|null, spotSell: number|null, unit: string, source: string }>}
 */
async function fetchFromKitco() {
  try {
    const res = await axios.get(KITCO_URL, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; analytic-chart/1.0)',
        'Accept-Language': 'en-US,en;q=0.9'
      }
    });
    const $ = cheerio.load(res.data);
    let spotUsd = null;
    $('*').each((_, el) => {
      const text = $(el).text();
      const match = text.match(/\$[\s]*(\d{1,3}(?:,\d{3})*(?:\.\d{2})?)\s*\/?\s*oz/i);
      if (match && !spotUsd) {
        const num = parseFloat(match[1].replace(/,/g, ''));
        if (num > 500 && num < 5000) spotUsd = num;
      }
    });
    if (spotUsd != null) {
      return { spotBuy: spotUsd, spotSell: spotUsd, changePercent: null, unit: 'USD/oz', source: 'Kitco' };
    }
  } catch (err) {
    console.warn('World gold (Kitco):', err.message);
  }
  return { spotBuy: null, spotSell: null, changePercent: null, unit: 'USD/oz', source: '' };
}

/**
 * Lấy giá vàng thế giới (spot USD/oz): giá mua & giá bán.
 * Ưu tiên: Investing.com (vn) → Gold API → Kitco.
 * @returns {Promise<{ currentBuy: number|null, currentSell: number|null, unit: string, source: string }>}
 */
async function fetchWorldGoldSpot() {
  const fromInvesting = await fetchFromInvesting();
  if (fromInvesting.spotBuy != null || fromInvesting.spotSell != null) {
    return { currentBuy: fromInvesting.spotBuy, currentSell: fromInvesting.spotSell, changePercent: fromInvesting.changePercent ?? null, unit: fromInvesting.unit, source: fromInvesting.source };
  }
  const fromApi = await fetchFromGoldApi();
  if (fromApi.spotBuy != null) {
    return { currentBuy: fromApi.spotBuy, currentSell: fromApi.spotSell, changePercent: null, unit: fromApi.unit, source: fromApi.source };
  }
  const fromKitco = await fetchFromKitco();
  return { currentBuy: fromKitco.spotBuy, currentSell: fromKitco.spotSell, changePercent: null, unit: fromKitco.unit, source: fromKitco.source };
}

module.exports = {
  fetchWorldGoldSpot,
  fetchFromInvesting,
  fetchFromGoldApi,
  fetchFromKitco
};
