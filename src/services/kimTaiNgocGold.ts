/**
 * Crawl giá vàng từ Kim Tài Ngọc Diamond.
 * https://kimtaingocdiamond.com/
 * Bảng giá: VNĐ/chỉ → đổi sang triệu VND/lượng (1 lượng = 10 chỉ).
 */
import axios from 'axios';
import * as cheerio from 'cheerio';

const KIM_TAI_NGOC_URL = 'https://kimtaingocdiamond.com/';

function parseVnd(text: string | null | undefined): number | null {
  if (!text || typeof text !== 'string') return null;
  const numStr = text.replace(/\s/g, '').replace(/\./g, '').replace(/,/g, '').replace(/đ/g, '');
  const n = parseFloat(numStr);
  return Number.isNaN(n) ? null : n;
}

export interface KimTaiNgocGoldResult {
  buy: number | null;
  sell: number | null;
}

function parseTable(
  table: cheerio.Cheerio<cheerio.Element>,
  $: cheerio.CheerioAPI,
  result: KimTaiNgocGoldResult
): void {
  const rows = table.find('tr');
  rows.each((_, tr) => {
    const cells = $(tr).find('td, th');
    if (cells.length < 3) return;
    const typeCell = $(cells[0]).text().trim().replace(/\s/g, '');
    if (!/9999|24k/i.test(typeCell) && typeCell !== '9999') return;
    const buyVnd = parseVnd($(cells[1]).text());
    const sellVnd = parseVnd($(cells[2]).text());
    if (buyVnd != null && buyVnd > 0) {
      result.buy = parseFloat(((buyVnd * 10) / 1e6).toFixed(2));
    }
    if (sellVnd != null && sellVnd > 0) {
      result.sell = parseFloat(((sellVnd * 10) / 1e6).toFixed(2));
    }
  });
}

export async function fetchKimTaiNgocGold(): Promise<KimTaiNgocGoldResult> {
  const result: KimTaiNgocGoldResult = { buy: null, sell: null };

  try {
    const res = await axios.get<string>(KIM_TAI_NGOC_URL, {
      timeout: 15000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; analytic-chart/1.0)',
        'Cache-Control': 'no-cache',
        Pragma: 'no-cache'
      }
    });

    const $ = cheerio.load(res.data);
    const block = $('.gold-card-content').first();
    if (!block.length) {
      const tables = $('table');
      tables.each((_, tbl) => {
        const text = $(tbl).text();
        if (text.includes('9999') && text.includes('Mua vào') && text.includes('Bán ra')) {
          parseTable($(tbl), $, result);
          return false;
        }
      });
      return result;
    }

    const table = block.find('table').first();
    if (table.length) {
      parseTable(table, $, result);
    }
  } catch (err) {
    console.error('Kim Tài Ngọc gold fetch error:', (err as Error).message);
  }

  return result;
}
