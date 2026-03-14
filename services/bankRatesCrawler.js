/**
 * Crawl lãi suất tiết kiệm theo từng ngân hàng từ Webgia (VCB, MB, VPBank, ...).
 * Parse đoạn mô tả đầu trang: "kỳ hạn 1 tháng, 6 tháng và 1 năm lần lượt là X%, Y%, Z%/năm".
 */
const axios = require('axios');
const cheerio = require('cheerio');

const WEBGIA_BASE = 'https://webgia.com/lai-suat';

/** Cấu hình từng ngân hàng: slug URL, mã hiển thị, tên hiển thị */
const BANKS = [
  { slug: 'vietcombank', code: 'VCB', name: 'Vietcombank' },
  { slug: 'mbbank', code: 'MB', name: 'MB Bank' },
  { slug: 'vpbank', code: 'VPBank', name: 'VPBank' }
];

const OPTS = {
  timeout: 12000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; analytic-chart/1.0)',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache'
  }
};

/**
 * Parse đoạn văn đầu trang Webgia để lấy lãi suất 1 tháng, 6 tháng, 12 tháng (%/năm).
 * Mẫu: "kỳ hạn 1 tháng, 6 tháng và 1 năm lần lượt là 1,60%/năm, 2,90%/năm, 4,60%/năm"
 */
function parseRatesFromText(text) {
  const out = { rate1m: null, rate6m: null, rate12m: null };
  if (!text || typeof text !== 'string') return out;
  const norm = (s) => parseFloat(String(s).replace(/,/g, '.'));
  const m = text.match(/kỳ hạn\s+1 tháng,\s*6 tháng\s+và\s+1 năm\s+lần lượt là\s*(\d+[,.]\d+)\s*%\/năm,\s*(\d+[,.]\d+)\s*%\/năm,\s*(\d+[,.]\d+)\s*%\/năm/i);
  if (m) {
    out.rate1m = norm(m[1]);
    out.rate6m = norm(m[2]);
    out.rate12m = norm(m[3]);
  }
  return out;
}

/**
 * Lấy lãi suất một ngân hàng từ trang Webgia.
 * @returns {Promise<{ code: string, name: string, rate1m: number|null, rate6m: number|null, rate12m: number|null }>}
 */
async function fetchBankRates(bank) {
  const result = {
    code: bank.code,
    name: bank.name,
    rate1m: null,
    rate6m: null,
    rate12m: null
  };
  try {
    const url = `${WEBGIA_BASE}/${bank.slug}/`;
    const res = await axios.get(url, OPTS);
    const $ = cheerio.load(res.data);
    const main = $('article, main, .content, #content').first();
    const text = (main.length ? main : $('body')).text().slice(0, 3000);
    const parsed = parseRatesFromText(text);
    result.rate1m = parsed.rate1m;
    result.rate6m = parsed.rate6m;
    result.rate12m = parsed.rate12m;
  } catch (err) {
    console.warn(`Bank rates ${bank.code}:`, err.message);
  }
  return result;
}

/**
 * Lấy lãi suất tất cả ngân hàng đã cấu hình (song song).
 * @returns {Promise<Array<{ code: string, name: string, rate1m: number|null, rate6m: number|null, rate12m: number|null }>>}
 */
async function fetchAllBankRates() {
  const results = await Promise.all(BANKS.map((b) => fetchBankRates(b)));
  return results;
}

module.exports = {
  fetchAllBankRates,
  fetchBankRates,
  parseRatesFromText,
  BANKS
};
