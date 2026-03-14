/**
 * Crawl lãi suất vay vốn (tín chấp, thế chấp) theo ngân hàng từ Tima.vn.
 * Trang: https://tima.vn/tin-tuc/lai-suat-vay-ngan-hang-2727.html
 */
const axios = require('axios');
const cheerio = require('cheerio');

const TIMA_LOAN_URL = 'https://tima.vn/tin-tuc/lai-suat-vay-ngan-hang-2727.html';

/** Ánh xạ tên ngân hàng trên Tima -> code + tên hiển thị (trùng với bảng tiết kiệm) */
const BANK_MAP = [
  { pattern: /vietcombank/i, code: 'VCB', name: 'Vietcombank' },
  { pattern: /^mb\s*bank|mbbank/i, code: 'MB', name: 'MB Bank' },
  { pattern: /vpbank/i, code: 'VPBank', name: 'VPBank' }
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
 * Chuẩn hóa chuỗi lãi suất từ ô bảng (giữ nguyên dạng "X - Y" hoặc "~Z").
 */
function normalizeRateCell(text) {
  if (!text || typeof text !== 'string') return null;
  const t = text.trim().replace(/\s+/g, ' ');
  return t.length > 0 ? t : null;
}

/**
 * Lấy bảng lãi suất vay từ Tima: vay tín chấp, vay thế chấp.
 * @returns {Promise<Array<{ code: string, name: string, loanUnsecured: string|null, loanSecured: string|null }>>}
 */
async function fetchBankLoanRates() {
  const results = [];
  try {
    const res = await axios.get(TIMA_LOAN_URL, OPTS);
    const $ = cheerio.load(res.data);
    let colUnsecured = -1;
    let colSecured = -1;

    $('table tr').each((_, tr) => {
      const cells = $(tr).find('td, th').map((__, cell) => $(cell).text().trim()).get();
      if (cells.length < 2) return;

      const first = (cells[0] || '').toLowerCase();
      const rowText = cells.join(' ').toLowerCase();
      if (rowText.includes('tín chấp') && rowText.includes('thế chấp')) {
        cells.forEach((c, i) => {
          const lower = (c || '').toLowerCase();
          if (lower.includes('tín chấp')) colUnsecured = i;
          if (lower.includes('thế chấp')) colSecured = i;
        });
        return;
      }

      if (colUnsecured < 0 || colSecured < 0) return;

      const bankName = (cells[0] || '').trim();
      for (const { pattern, code, name } of BANK_MAP) {
        if (pattern.test(bankName)) {
          const loanUnsecured = normalizeRateCell(cells[colUnsecured]);
          const loanSecured = normalizeRateCell(cells[colSecured]);
          results.push({
            code,
            name,
            loanUnsecured: loanUnsecured || null,
            loanSecured: loanSecured || null
          });
          return;
        }
      }
    });
  } catch (err) {
    console.warn('Bank loan rates crawl:', err.message);
  }
  return results;
}

module.exports = {
  fetchBankLoanRates
};
