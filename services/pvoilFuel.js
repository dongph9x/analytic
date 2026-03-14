/**
 * Đọc bảng giá xăng dầu từ PVOIL (nguồn chính thống).
 * https://www.pvoil.com.vn/tin-gia-xang-dau
 */
const axios = require('axios');
const cheerio = require('cheerio');

const PVOIL_URL = 'https://www.pvoil.com.vn/tin-gia-xang-dau';

/**
 * Fetch trang PVOIL và parse bảng giá. Trả về giá RON 95-III và Dầu DO (nghìn VND/lít).
 * @returns {Promise<{ ron95: number|null, do: number|null, tableText: string }>}
 */
async function fetchPvoilFuelTable() {
  const result = { ron95: null, do: null, tableText: '' };

  try {
    const res = await axios.get(PVOIL_URL, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; analytic-chart/1.0; +https://github.com)',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache'
      }
    });

    const $ = cheerio.load(res.data);
    const rows = [];
    $('table tr').each((_, tr) => {
      const cells = $(tr).find('td, th').map((__, cell) => $(cell).text().trim()).get();
      if (cells.length >= 3) rows.push(cells);
    });

    const lines = rows.map((cells) => cells.join(' | '));
    result.tableText = lines.length ? `Bảng giá PVOIL:\n${lines.join('\n')}` : '';

    rows.forEach((cells) => {
      const name = (cells[1] || cells[0] || '').toLowerCase();
      const rawPrice = (cells[2] || cells[1] || '').trim();
      const priceStr = rawPrice.replace(/\s/g, '').replace(/đ/g, '').replace(/\./g, '');
      const num = parseFloat(priceStr);
      if (Number.isNaN(num) || num < 100) return;
      const priceThousand = num >= 10000 ? num / 1000 : num;

      if (name.includes('ron') && name.includes('95') && !name.includes('e10') && !name.includes('e5')) {
        result.ron95 = parseFloat(priceThousand.toFixed(2));
      }
      if ((name.includes('dầu do') || name.includes('do 0')) && result.do == null) {
        result.do = parseFloat(priceThousand.toFixed(2));
      }
    });

    if (result.do == null) {
      rows.forEach((cells) => {
        const name = (cells[1] || cells[0] || '').toLowerCase();
        const priceStr = (cells[2] || cells[1] || '').replace(/\s/g, '').replace(/\./g, '').replace(/đ/g, '');
        const num = parseFloat(priceStr);
        if (Number.isNaN(num) || num < 1000) return;
        if (name.includes('do 0,05') || name.includes('do 0.05')) {
          result.do = num >= 10000 ? parseFloat((num / 1000).toFixed(2)) : parseFloat(num.toFixed(2));
        }
      });
    }
  } catch (err) {
    console.error('PVOIL fetch error:', err.message);
  }

  return result;
}

module.exports = {
  fetchPvoilFuelTable
};
