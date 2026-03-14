/**
 * Dùng ChatGPT (OpenAI API) để tổng hợp thông tin giá vàng, xăng dầu Việt Nam.
 * Giá xăng dầu lấy từ bảng chính thống PVOIL: https://www.pvoil.com.vn/tin-gia-xang-dau
 */
const OpenAI = require('openai');
const { fetchPvoilFuelTable } = require('./pvoilFuel');
const { fetchKimTaiNgocGold } = require('./kimTaiNgocGold');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const DAYS_COUNT = 30;

function getLast30DayLabels() {
  const labels = [];
  const now = new Date();
  for (let i = DAYS_COUNT - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    labels.push(`${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return labels;
}

function buildChartDataPrompt(pvoilData, kimTaiNgocGold) {
  const now = new Date();
  const today = `${String(now.getDate()).padStart(2, '0')}/${String(now.getMonth() + 1).padStart(2, '0')}`;

  let fuelBlock = '';
  if (pvoilData?.tableText) {
    fuelBlock = `

Giá xăng dầu BẮT BUỘC lấy từ bảng chính thống PVOIL (https://www.pvoil.com.vn/tin-gia-xang-dau):
${pvoilData.tableText}
- currentFuelRON95: lấy từ dòng "Xăng RON 95-III" (đổi từ đồng/lít sang nghìn VND/lít, ví dụ 25.570 đ = 25.57).
- currentFuelDO: lấy từ dòng "Dầu DO 0,001S-V" hoặc "Dầu DO 0,05S-II" (đổi sang nghìn VND/lít).`;
  } else {
    fuelBlock = `
- currentFuelRON95: giá xăng RON95 hiện tại (nghìn VND/lít) - tham chiếu PVOIL/Petrolimex.
- currentFuelDO: giá dầu DO hiện tại (nghìn VND/lít).`;
  }

  let goldBlock = '';
  if (kimTaiNgocGold?.buy != null && kimTaiNgocGold?.sell != null) {
    goldBlock = `

Giá vàng hiện tại BẮT BUỘC dùng từ Kim Tài Ngọc Diamond (https://kimtaingocdiamond.com/): mua ${kimTaiNgocGold.buy}, bán ${kimTaiNgocGold.sell} (triệu VND/lượng).
- currentGoldBuy: ${kimTaiNgocGold.buy}
- currentGoldSell: ${kimTaiNgocGold.sell}`;
  } else {
    goldBlock = `
- currentGoldBuy: giá vàng mua hiện tại (triệu VND/lượng) - tham chiếu SJC/PNJ/BTMC.
- currentGoldSell: giá vàng bán hiện tại (triệu VND/lượng).`;
  }

  return `Bạn là chuyên gia thị trường Việt Nam. Trả về ĐÚNG MỘT JSON (không giải thích thêm) với cấu trúc sau: giá 30 ngày gần nhất, kết thúc hôm nay (${today}).

Yêu cầu:
- labels: mảng 30 chuỗi "DD/MM" cho 30 ngày gần nhất, phần tử cuối là "${today}".
- goldPrices: mảng 30 số - giá vàng nhẫn trơn 9999 (triệu VND/lượng) - tham chiếu SJC/PNJ/BTMC/bieudogiavang.
- fuelRON95Prices: mảng 30 số - giá xăng RON95 (nghìn VND/lít).
- fuelDOPrices: mảng 30 số - giá dầu DO (nghìn VND/lít).${goldBlock}${fuelBlock}

Chỉ trả về JSON thuần, không markdown, không \`\`\`json.`;
}

/**
 * Gọi ChatGPT để lấy dữ liệu chart (giá vàng, xăng dầu VN).
 * @returns {Promise<object|null>} Cùng cấu trúc với getPricesData() hoặc null nếu lỗi.
 */
async function getChartDataFromChatGPT() {
  if (!OPENAI_API_KEY || OPENAI_API_KEY.trim() === '') {
    return null;
  }

  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

  try {
    const [pvoilData, kimTaiNgocGold] = await Promise.all([
      fetchPvoilFuelTable(),
      fetchKimTaiNgocGold()
    ]);
    if (pvoilData.ron95 != null || pvoilData.do != null) {
      console.log('PVOIL fuel table read:', { ron95: pvoilData.ron95, do: pvoilData.do });
    }
    if (kimTaiNgocGold.buy != null && kimTaiNgocGold.sell != null) {
      console.log('Kim Tài Ngọc gold read:', { buy: kimTaiNgocGold.buy, sell: kimTaiNgocGold.sell });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'Bạn chỉ trả lời bằng JSON hợp lệ, không thêm text nào khác. Các số phải là số thực (float), không chuỗi.'
        },
        { role: 'user', content: buildChartDataPrompt(pvoilData, kimTaiNgocGold) }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw || typeof raw !== 'string') return null;

    const parsed = JSON.parse(raw);

    const labels = Array.isArray(parsed.labels) && parsed.labels.length >= DAYS_COUNT
      ? parsed.labels.slice(0, DAYS_COUNT)
      : getLast30DayLabels();
    const goldValues = (parsed.goldPrices || []).map((v) => parseFloat(v)).filter((n) => !Number.isNaN(n));
    const ron95Values = (parsed.fuelRON95Prices || []).map((v) => parseFloat(v)).filter((n) => !Number.isNaN(n));
    const doValues = (parsed.fuelDOPrices || []).map((v) => parseFloat(v)).filter((n) => !Number.isNaN(n));

    const minFuelValid = 5;
    let currentGoldBuy = parsed.currentGoldBuy != null ? parseFloat(parsed.currentGoldBuy) : null;
    let currentGoldSell = parsed.currentGoldSell != null ? parseFloat(parsed.currentGoldSell) : null;
    if (kimTaiNgocGold.buy != null && kimTaiNgocGold.sell != null) {
      currentGoldBuy = kimTaiNgocGold.buy;
      currentGoldSell = kimTaiNgocGold.sell;
    }
    let currentRON95 =
      parsed.currentFuelRON95 != null && parseFloat(parsed.currentFuelRON95) > minFuelValid
        ? parseFloat(parsed.currentFuelRON95)
        : 25.0;
    let currentDO =
      parsed.currentFuelDO != null && parseFloat(parsed.currentFuelDO) > minFuelValid
        ? parseFloat(parsed.currentFuelDO)
        : 21.5;
    if (pvoilData.ron95 != null && pvoilData.ron95 > minFuelValid) currentRON95 = pvoilData.ron95;
    if (pvoilData.do != null && pvoilData.do > minFuelValid) currentDO = pvoilData.do;

    const n = DAYS_COUNT;
    const pad = (arr, len, fallback) => {
      const parsed = (arr || []).map((v) => parseFloat(v)).filter((num) => !Number.isNaN(num));
      if (parsed.length >= len) return parsed.slice(0, len).map((v) => parseFloat(Number(v).toFixed(2)));
      const last = parsed[parsed.length - 1] ?? fallback;
      return Array.from({ length: len }, (_, i) =>
        parseFloat((parsed[i] ?? last).toFixed(2))
      );
    };

    return {
      labels: labels.slice(0, n),
      gold: {
        label: 'Vàng nhẫn trơn 9999 (triệu VND/lượng)',
        unit: 'triệu VND/lượng',
        values: pad(goldValues, n, 78),
        current: currentGoldBuy,
        currentSell: currentGoldSell
      },
      fuelRON95: {
        label: 'Xăng RON 95 (nghìn VND/lít)',
        unit: 'nghìn VND/lít',
        values: pad(ron95Values, n, currentRON95),
        current: currentRON95
      },
      fuelDO: {
        label: 'Dầu (nghìn VND/lít)',
        unit: 'nghìn VND/lít',
        values: pad(doValues, n, currentDO),
        current: currentDO
      },
      lastUpdate: new Date().toISOString(),
      source: 'chatgpt'
    };
  } catch (err) {
    console.error('ChatGPT service error:', err.message);
    return null;
  }
}

/**
 * Kiểm tra đã cấu hình API key chưa.
 */
function isConfigured() {
  return !!(OPENAI_API_KEY && OPENAI_API_KEY.trim());
}

module.exports = {
  getChartDataFromChatGPT,
  isConfigured
};
