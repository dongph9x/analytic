/**
 * Tỷ giá Vietcombank – crawl từ https://webgia.com/ty-gia/vietcombank/
 */
import axios from 'axios';
import * as cheerio from 'cheerio';

const WEBGIA_VCB_URL = 'https://webgia.com/ty-gia/vietcombank/';

const OPTS = {
  timeout: 15000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (compatible; analytic-chart/1.0)',
    Accept: 'text/html,application/xhtml+xml'
  }
};

export interface ExchangeRateItem {
  code: string;
  name: string;
  buyCash?: number | null;
  buyTransfer?: number | null;
  sellCash?: number | null;
}

export interface WebgiaExchangeResult {
  ok: boolean;
  error?: string;
  updatedAt?: string | null;
  source?: string;
  sourceUrl?: string;
  rates?: ExchangeRateItem[];
}

function parsePriceCell(text: string | null | undefined): number | null {
  if (text == null) return null;
  const t = String(text).trim();
  if (!t || /webgia|web giá|xem tại/i.test(t)) return null;
  if (t === '-') return null;
  const normalized = t.replace(/\./g, '').replace(',', '.');
  const num = parseFloat(normalized);
  if (!Number.isNaN(num) && num > 0) return num;
  return null;
}

function parseCodeCell($: cheerio.CheerioAPI, cell: cheerio.Cheerio<cheerio.Element>): string | null {
  const link = $(cell).find('a[href*="ngoai-te"]').first();
  if (link.length) {
    const href = link.attr('href') || '';
    const match = href.match(/\/([a-z]{3})\/?$/i);
    if (match) return (match[1] || '').toUpperCase();
    const code = link.text().trim();
    if (code.length === 3) return code.toUpperCase();
  }
  const text = $(cell).text().trim();
  if (text.length === 3 && /^[A-Z]{3}$/i.test(text)) return text.toUpperCase();
  return text || null;
}

export async function fetchVietcombankRates(): Promise<WebgiaExchangeResult> {
  try {
    const res = await axios.get<string>(WEBGIA_VCB_URL, OPTS);
    const $ = cheerio.load(res.data);
    const rates: ExchangeRateItem[] = [];
    let updatedAt: string | null = null;

    let $table = $('table').filter(function (this: cheerio.Element) {
      const header = $(this).find('th').text();
      return /mua|bán|tiền mặt|chuyển khoản/i.test(header);
    }).first();
    if ($table.length === 0) $table = $('table').first();

    $table.find('tr').each(function (this: cheerio.Element, i: number) {
      const cells = $(this).find('td');
      if (cells.length < 4) return;

      const code = parseCodeCell($, cells.eq(0));
      const name = $(cells[1]).text().trim().replace(/\s+/g, ' ') || '';
      const buyCash = parsePriceCell($(cells[2]).text());
      const buyTransfer = parsePriceCell($(cells[3]).text());
      const sellCash = parsePriceCell($(cells[4]).text());

      if (!code || code.length > 4) return;
      if (/cập nhật|ngày|đơn vị|ngoại tệ/i.test(code) && !/^[A-Z]{3}$/i.test(code)) return;
      if (/cập nhật lúc/i.test(name)) return;

      rates.push({ code, name, buyCash, buyTransfer, sellCash });
    });

    const titleText = $('h1').first().text() || '';
    const dateMatch = titleText.match(/cập nhật.*?(\d{1,2}\/\d{1,2}\/\d{4})/i) || titleText.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
    if (dateMatch) updatedAt = dateMatch[1];
    const timeMatch = titleText.match(/(\d{1,2}:\d{2}:\d{2})/);
    if (timeMatch) updatedAt = (updatedAt ? updatedAt + ' ' : '') + timeMatch[1];

    return {
      ok: true,
      updatedAt: updatedAt || null,
      source: 'Webgia.com - Vietcombank',
      sourceUrl: WEBGIA_VCB_URL,
      rates
    };
  } catch (err) {
    console.warn('Webgia exchange crawl:', (err as Error).message);
    return { ok: false, error: (err as Error).message || 'Lỗi crawl tỷ giá' };
  }
}
