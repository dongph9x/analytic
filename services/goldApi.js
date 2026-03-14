/**
 * Lấy giá vàng từ API vang.today (miễn phí, không cần key).
 * Vàng nhẫn SJC 9999: type=SJ9999. Giá trả về VND/lượng, đổi sang triệu VND khi dùng.
 */
const axios = require('axios');

const VANG_TODAY_URL = 'https://www.vang.today/api/prices';
const GOLD_TYPE = 'SJ9999'; // Nhẫn SJC 9999

/**
 * Gọi API vang.today lấy giá hiện tại + lịch sử n ngày.
 * @param {number} days - Số ngày lịch sử (1-30)
 * @returns {Promise<{ currentBuy: number|null, currentSell: number|null, history: Array<{date:string, price:number}> }|null>}
 *   price đã đổi sang triệu VND/lượng.
 */
async function fetchGoldFromVangToday(days = 30) {
  try {
    const res = await axios.get(VANG_TODAY_URL, {
      params: { type: GOLD_TYPE, days: Math.min(30, Math.max(1, days)) },
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; analytic-chart/1.0)' }
    });

    const data = res.data;
    if (!data?.success || !Array.isArray(data.history) || data.history.length === 0) {
      return null;
    }

    const history = data.history.map((item) => {
      const key = GOLD_TYPE;
      const buy = item?.prices?.[key]?.buy;
      const price = typeof buy === 'number' ? buy / 1e6 : null;
      const date = item?.date || '';
      return { date, price: price != null ? parseFloat(price.toFixed(2)) : null };
    }).filter((item) => item.price != null);

    const newest = data.history[0];
    const currentBuy = newest?.prices?.[GOLD_TYPE]?.buy;
    const currentSell = newest?.prices?.[GOLD_TYPE]?.sell;

    return {
      currentBuy: typeof currentBuy === 'number' ? parseFloat((currentBuy / 1e6).toFixed(2)) : null,
      currentSell: typeof currentSell === 'number' ? parseFloat((currentSell / 1e6).toFixed(2)) : null,
      history
    };
  } catch (err) {
    console.error('Gold API (vang.today) error:', err.message);
    return null;
  }
}

/**
 * Trả về dữ liệu vàng phù hợp chart: 30 values (triệu VND). Trả null nếu API lỗi để server fallback crawl.
 * @param {string[]} labels - 30 nhãn ngày DD/MM (từ getLast30DayLabels)
 * @returns {Promise<{ values: number[], current: number|null, currentSell: number|null }|null>}
 */
async function getGoldChartData(labels) {
  const raw = await fetchGoldFromVangToday(30);
  if (!raw) return null;

  const current = raw.currentBuy ?? null;
  const currentSell = raw.currentSell ?? null;
  const fallback = 78.5;

  if (!raw.history?.length) {
    const values = build30Values(current, fallback);
    return { values, current, currentSell };
  }

  const labelToDate = (ddmm) => {
    const [d, m] = ddmm.split('/').map(Number);
    return { d, m };
  };
  const dateStrToDDMM = (ymd) => {
    if (!ymd || ymd.length < 10) return null;
    const [y, mo, day] = ymd.split('-');
    return `${day.padStart(2, '0')}/${mo.padStart(2, '0')}`;
  };

  const byDDMM = {};
  raw.history.forEach((item) => {
    const ddmm = dateStrToDDMM(item.date);
    if (ddmm != null && item.price != null) byDDMM[ddmm] = item.price;
  });

  const values = labels.map((ddmm) => {
    if (byDDMM[ddmm] != null) return byDDMM[ddmm];
    return null;
  });

  const lastPrice = values[values.length - 1] ?? raw.history[0]?.price ?? current ?? fallback;
  for (let i = 0; i < values.length; i++) {
    if (values[i] == null) values[i] = lastPrice;
  }

  const filled = values.map((v) => parseFloat(Number(v).toFixed(2)));
  if (current != null && filled.length > 0) filled[filled.length - 1] = current;

  return { values: filled, current, currentSell };
}

function build30Values(current, baseFallback, variation = 0.02) {
  const base = current != null && current > 0 ? current : baseFallback;
  const DAYS_COUNT = 30;
  const values = [];
  for (let i = 0; i < DAYS_COUNT - 1; i++) {
    const v = base * (1 + (Math.random() - 0.5) * variation);
    values.push(parseFloat(Math.max(0, v).toFixed(2)));
  }
  values.push(current != null && current > 0 ? parseFloat(Number(current).toFixed(2)) : parseFloat(Number(base).toFixed(2)));
  return values;
}

module.exports = {
  fetchGoldFromVangToday,
  getGoldChartData
};
