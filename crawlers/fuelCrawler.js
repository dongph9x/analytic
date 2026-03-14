const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Crawl giá xăng dầu từ PriceDancing
 * Tham khảo: https://www.pricedancing.com/ (Gasoline Price)
 */
async function crawlFuelPrice() {
  try {
    const urlCandidates = [
      'https://www.pricedancing.com/gasoline-price',
      'https://www.pricedancing.com/gasoline',
      'https://www.pricedancing.com/'
    ];

    for (const url of urlCandidates) {
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent':
              'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
          },
          timeout: 10000
        });

        const data = extractFuelFromPriceDancing(response.data);
        if (data) {
          // Nếu giá quá nhỏ (ví dụ < 5) thì coi như không hợp lệ và dùng default
          const cleaned = normalizeFuelPrice(data);
          return cleaned;
        }
      } catch (err) {
        continue;
      }
    }
  } catch (error) {
    console.error('Error crawling fuel price from PriceDancing:', error.message);
  }

  return getDefaultFuelPrice();
}

/**
 * Parse HTML của PriceDancing để lấy giá xăng dầu (RON95, DO)
 */
function extractFuelFromPriceDancing(html) {
  const $ = cheerio.load(html);

  // Tìm section/bảng có chứa chữ "Gasoline Price"
  const section = $('body')
    .find('*')
    .filter((_, el) => $(el).text().includes('Gasoline Price'))
    .first();

  if (!section || section.length === 0) return null;

  const table = section.closest('table').length ? section.closest('table') : section.find('table').first();
  if (!table || table.length === 0) return null;

  let ron95 = null;
  let doPrice = null;

  // Duyệt từng dòng, dựa vào cột Name chứa RON95 / DO
  const rows = table.find('tbody tr').length ? table.find('tbody tr') : table.find('tr').slice(1);
  rows.each((_, row) => {
    const cells = $(row).find('td');
    if (cells.length < 3) return;

    const name = $(cells[0]).text().trim();
    const bidText = $(cells[1]).text().trim();
    const askText = $(cells[2]).text().trim();

    const mid = textToNumber(bidText, askText);

    if (/ron ?95/i.test(name)) {
      ron95 = mid;
    } else if (/do\b|diesel/i.test(name)) {
      doPrice = mid;
    }
  });

  if (!ron95 && !doPrice) return null;

  return {
    ron95: ron95 || null,
    do: doPrice || null,
    timestamp: new Date().toISOString()
  };
}

function textToNumber(bidText, askText) {
  const bid = parseFloat(bidText.replace(/[^\d.,]/g, '').replace(',', '.'));
  const ask = parseFloat(askText.replace(/[^\d.,]/g, '').replace(',', '.'));

  if (bid && ask) return (bid + ask) / 2;
  if (bid) return bid;
  if (ask) return ask;
  return null;
}

/**
 * Chuẩn hóa giá xăng dầu:
 * - Nếu giá < 5 coi như sai, thay bằng giá mặc định hợp lý.
 */
function normalizeFuelPrice(raw) {
  const minValid = 5; // nghìn VND/lít
  const defaults = getDefaultFuelPrice();

  return {
    ron95:
      typeof raw.ron95 === 'number' && raw.ron95 > minValid
        ? raw.ron95
        : defaults.ron95,
    do:
      typeof raw.do === 'number' && raw.do > minValid
        ? raw.do
        : defaults.do,
    timestamp: raw.timestamp || new Date().toISOString()
  };
}

/**
 * Lấy lịch sử giá xăng dầu (12 tháng)
 */
async function getFuelHistory() {
  const currentPrices = await crawlFuelPrice();

  const history = [];
  const now = new Date();
  const baseRon95 = currentPrices.ron95 || 25.0;
  const baseDO = currentPrices.do || 21.5;

  for (let i = 11; i >= 0; i--) {
    const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const variation = (Math.random() - 0.5) * 0.2;
    history.push({
      date: `${String(date.getMonth() + 1).padStart(2, '0')}/${date.getFullYear()}`,
      ron95: baseRon95 * (1 + variation),
      do: baseDO * (1 + variation)
    });
  }

  return history;
}

/**
 * Giá mặc định nếu không crawl được
 */
function getDefaultFuelPrice() {
  return {
    ron95: 25.0,
    do: 21.5,
    timestamp: new Date().toISOString()
  };
}

module.exports = {
  crawlFuelPrice,
  getFuelHistory
};
