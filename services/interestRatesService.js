/**
 * Lấy lãi suất: Ngân hàng Nhà nước Việt Nam (SBV), FED, và lãi suất theo từng ngân hàng (VCB, MB, VPBank).
 * FED: Crawl từ Federal Reserve H.15. VN: SBV + CafeF. Theo ngân hàng: Webgia.
 */
const axios = require('axios');
const cheerio = require('cheerio');
const { fetchAllBankRates } = require('./bankRatesCrawler');
const { fetchBankLoanRates } = require('./bankLoanRatesCrawler');

const FED_H15_URL = 'https://www.federalreserve.gov/releases/h15/default.htm';
const CAFEF_RATES_URL = 'https://cafef.vn/du-lieu/lai-suat-ngan-hang.chn';
const CAFEF_INTERBANK_URL = 'https://www.cafef.vn/lai-suat-lien-ngan-hang/trang-1.html';
/** Trang thông cáo SBV về điều chỉnh lãi suất (có nội dung văn bản tĩnh). */
const SBV_RATES_URL = 'https://sbv.gov.vn/w/sbv569256';

/**
 * Lấy lãi suất Fed Funds (Effective) từ trang H.15 của Federal Reserve. Trả về % (vd 3.64) hoặc null.
 */
async function fetchFedFundsRateFromCrawl() {
  try {
    const res = await axios.get(FED_H15_URL, {
      timeout: 12000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; analytic-chart/1.0)',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache'
      }
    });
    const $ = cheerio.load(res.data);
    let lastRate = null;
    $('table tr').each((_, tr) => {
      const cells = $(tr).find('td, th').map((__, cell) => $(cell).text().trim()).get();
      const firstCell = (cells[0] || '').toLowerCase();
      if (!firstCell.includes('federal funds') || !firstCell.includes('effective')) return;
      for (let i = cells.length - 1; i >= 1; i--) {
        const raw = (cells[i] || '').replace(/n\.a\./gi, '').trim();
        const num = parseFloat(raw);
        if (!Number.isNaN(num) && num > 0 && num < 25) {
          lastRate = Math.round(num * 100) / 100;
          return false;
        }
      }
    });
    return lastRate;
  } catch (err) {
    console.warn('Fed H.15 crawl:', err.message);
  }
  return null;
}

/**
 * Parse đoạn văn bản từ trang SBV (thông cáo điều chỉnh lãi suất) để lấy lãi suất tái cấp vốn, qua đêm.
 * Mẫu: "... lãi suất tái cấp vốn giảm từ ... xuống 5,0%/năm ..." hoặc "... giữ nguyên ở mức 3,5%/năm".
 */
function parseSBVRatesFromText(text) {
  const out = { refinancingRate: null, overnightRate: null };
  if (!text || typeof text !== 'string') return out;
  const normalize = (s) => s.replace(/,/g, '.');
  // Lấy mức sau "xuống" hoặc "giữ nguyên ở mức" (mức hiện hành), lấy lần xuất hiện đầu tiên (đoạn quyết định chính).
  const refinancingMatch = text.match(/lãi suất\s+tái cấp vốn[\s\S]*?(?:xuống|giữ nguyên ở mức)\s*(\d+)[,.](\d+)\s*%\/năm/i);
  if (refinancingMatch) out.refinancingRate = parseFloat(normalize(`${refinancingMatch[1]}.${refinancingMatch[2]}`));
  const overnightMatch = text.match(/(?:lãi suất\s+)?(?:cho vay\s+)?qua đêm[\s\S]*?(?:xuống|giữ nguyên ở mức)\s*(\d+)[,.](\d+)\s*%\/năm/i);
  if (overnightMatch) out.overnightRate = parseFloat(normalize(`${overnightMatch[1]}.${overnightMatch[2]}`));
  return out;
}

/**
 * Lấy lãi suất VN từ trang thông cáo SBV (HTML tĩnh).
 */
async function fetchSBVRates() {
  try {
    const res = await axios.get(SBV_RATES_URL, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; analytic-chart/1.0)',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache'
      }
    });
    const $ = cheerio.load(res.data);
    const bodyText = $('article, .journal-content-article, [class*="content"]').text() || $('body').text();
    return parseSBVRatesFromText(bodyText);
  } catch (err) {
    console.warn('SBV rates crawl:', err.message);
  }
  return { refinancingRate: null, overnightRate: null };
}

/**
 * Parse trang cafef lãi suất ngân hàng / liên ngân hàng để lấy lãi suất cơ bản, tái cấp vốn, qua đêm (nếu có).
 */
async function fetchVietnamRates() {
  const result = { baseRate: null, refinancingRate: null, overnightRate: null };
  const opts = {
    timeout: 12000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; analytic-chart/1.0)',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache'
    }
  };

  try {
    // Ưu tiên SBV (trang thông cáo có văn bản tĩnh); CafeF có thể render bảng bằng JS nên không có số trong HTML.
    const sbv = await fetchSBVRates();
    if (sbv.refinancingRate != null) result.refinancingRate = sbv.refinancingRate;
    if (sbv.overnightRate != null) result.overnightRate = sbv.overnightRate;

    const [resRates, resInterbank] = await Promise.all([
      axios.get(CAFEF_RATES_URL, opts).catch(() => null),
      axios.get(CAFEF_INTERBANK_URL, opts).catch(() => null)
    ]);

    const tryParsePercent = (text) => {
      if (!text || typeof text !== 'string') return null;
      const m = text.replace(/,/g, '.').match(/(\d+[,.]?\d*)\s*%?/);
      return m ? parseFloat(m[1]) : null;
    };

    if (resRates?.data) {
      const $ = cheerio.load(resRates.data);
      $('table tr, .table tr, [class*="rate"]').each((_, tr) => {
        const cells = $(tr).find('td, th').map((__, cell) => $(cell).text().trim()).get();
        const line = cells.join(' ').toLowerCase();
        cells.forEach((cell, i) => {
          const next = cells[i + 1];
          const pct = tryParsePercent(next || cell);
          if (pct == null) return;
          if ((line.includes('cơ bản') || line.includes('lãi suất cơ bản')) && !result.baseRate) result.baseRate = pct;
          if ((line.includes('tái cấp') || line.includes('tái cấp vốn')) && !result.refinancingRate) result.refinancingRate = pct;
          if ((line.includes('qua đêm') || line.includes('overnight') || line.includes('liên ngân hàng')) && !result.overnightRate) result.overnightRate = pct;
        });
      });
    }

    if (resInterbank?.data && (!result.overnightRate || !result.baseRate)) {
      const $ = cheerio.load(resInterbank.data);
      $('table tr, .table tr').each((_, tr) => {
        const cells = $(tr).find('td, th').map((__, cell) => $(cell).text().trim()).get();
        const line = cells.join(' ').toLowerCase();
        if (line.includes('qua đêm') || line.includes('overnight')) {
          cells.forEach((c) => {
            const pct = tryParsePercent(c);
            if (pct != null && pct < 30 && pct > 0 && !result.overnightRate) result.overnightRate = pct;
          });
        }
      });
    }
  } catch (err) {
    console.warn('Vietnam rates crawl:', err.message);
  }
  return result;
}

/**
 * Trả về { fed, vn, banks }.
 * banks: mảng { code, name, rate1m, rate6m, rate12m } (lãi suất tiết kiệm %/năm, nguồn Webgia).
 */
async function getInterestRates() {
  const [fedRate, vnRates, banks, bankLoans] = await Promise.all([
    fetchFedFundsRateFromCrawl(),
    fetchVietnamRates(),
    fetchAllBankRates().catch(() => []),
    fetchBankLoanRates().catch(() => [])
  ]);
  return {
    fed: {
      rate: fedRate,
      label: 'Fed Funds Rate (Effective)'
    },
    vn: {
      baseRate: vnRates.baseRate,
      refinancingRate: vnRates.refinancingRate,
      overnightRate: vnRates.overnightRate
    },
    banks: Array.isArray(banks) ? banks : [],
    bankLoans: Array.isArray(bankLoans) ? bankLoans : []
  };
}

module.exports = {
  getInterestRates,
  fetchFedFundsRate: fetchFedFundsRateFromCrawl,
  fetchVietnamRates
};
