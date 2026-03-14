/**
 * Tỷ giá Vietcombank – crawl từ https://webgia.com/ty-gia/vietcombank/
 * Nguồn: Web Giá (webgia.com)
 */
const axios = require('axios');
const cheerio = require('cheerio');

const WEBGIA_VCB_URL = 'https://webgia.com/ty-gia/vietcombank/';

const OPTS = {
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; analytic-chart/1.0)',
    'Accept': 'text/html,application/xhtml+xml'
  }
};

/** Chuẩn hóa ô giá: "26.048,00" -> số hoặc giữ text nếu không phải số. Ô chứa "webgia" -> null */
function parsePriceCell(text) {
  if (text == null) return null;
  var t = String(text).trim();
  if (!t || /webgia|web giá|xem tại/i.test(t)) return null;
  if (t === '-') return null;
  var normalized = t.replace(/\./g, '').replace(',', '.');
  var num = parseFloat(normalized);
  if (!Number.isNaN(num) && num > 0) return num;
  return null;
}

/** Lấy mã ngoại tệ từ cột đầu (có thể là link hoặc text) */
function parseCodeCell($, cell) {
  var link = $(cell).find('a[href*="ngoai-te"]').first();
  if (link.length) {
    var href = link.attr('href') || '';
    var match = href.match(/\/([a-z]{3})\/?$/i);
    if (match) return (match[1] || '').toUpperCase();
    var code = link.text().trim();
    if (code.length === 3) return code.toUpperCase();
  }
  var text = $(cell).text().trim();
  if (text.length === 3 && /^[A-Z]{3}$/i.test(text)) return text.toUpperCase();
  return text || null;
}

/**
 * Crawl bảng tỷ giá Vietcombank từ Webgia.
 * @returns {Promise<{ ok: boolean, error?: string, updatedAt?: string, source?: string, rates?: Array<{ code: string, name: string, buyCash?: number, buyTransfer?: number, sellCash?: number }> }>}
 */
async function fetchVietcombankRates() {
  try {
    var res = await axios.get(WEBGIA_VCB_URL, OPTS);
    var $ = cheerio.load(res.data);
    var rates = [];
    var updatedAt = null;

    var $table = $('table').filter(function () {
      var header = $(this).find('th').text();
      return /mua|bán|tiền mặt|chuyển khoản/i.test(header);
    }).first();
    if ($table.length === 0) $table = $('table').first();

    $table.find('tr').each(function (i, tr) {
      var cells = $(tr).find('td');
      if (cells.length < 4) return;

      var code = parseCodeCell($, cells.eq(0));
      var name = $(cells[1]).text().trim().replace(/\s+/g, ' ') || '';
      var buyCash = parsePriceCell($(cells[2]).text());
      var buyTransfer = parsePriceCell($(cells[3]).text());
      var sellCash = parsePriceCell($(cells[4]).text());

      if (!code || code.length > 4) return;
      if (/cập nhật|ngày|đơn vị|ngoại tệ/i.test(code) && !/^[A-Z]{3}$/i.test(code)) return;
      if (/cập nhật lúc/i.test(name)) return;

      rates.push({
        code: code,
        name: name,
        buyCash: buyCash,
        buyTransfer: buyTransfer,
        sellCash: sellCash
      });
    });

    var titleText = $('h1').first().text() || '';
    var dateMatch = titleText.match(/cập nhật.*?(\d{1,2}\/\d{1,2}\/\d{4})/i) || titleText.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (dateMatch) updatedAt = dateMatch[1];
    var timeMatch = titleText.match(/(\d{1,2}:\d{2}:\d{2})/);
    if (timeMatch) updatedAt = (updatedAt ? updatedAt + ' ' : '') + timeMatch[1];

    return {
      ok: true,
      updatedAt: updatedAt || null,
      source: 'Webgia.com - Vietcombank',
      sourceUrl: WEBGIA_VCB_URL,
      rates: rates
    };
  } catch (err) {
    console.warn('Webgia exchange crawl:', err.message);
    return { ok: false, error: err.message || 'Lỗi crawl tỷ giá' };
  }
}

module.exports = { fetchVietcombankRates };
