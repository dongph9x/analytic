/**
 * Tạo nội dung tin tức và nhận định xu hướng (vàng, xăng, dầu) bằng ChatGPT.
 * Nếu có SERPER_API_KEY: tìm tin thật qua Serper News, ChatGPT tổng hợp và gắn nguồn (link bài đăng).
 * Nếu không: chỉ dựa vào kiến thức mô hình, không có link nguồn.
 */
const OpenAI = require('openai');
const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

/** Gọi Serper News API, trả về [{ title, link, snippet, source }]. */
async function searchNews(query, num = 8) {
  if (!SERPER_API_KEY || !SERPER_API_KEY.trim()) return [];
  try {
    const { data } = await axios.post(
      'https://google.serper.dev/news',
      { q: query, num },
      {
        headers: {
          'X-API-KEY': SERPER_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 12000
      }
    );
    const list = data.news || [];
    return list.slice(0, num).map((n) => ({
      title: n.title || '',
      link: n.link || n.url || '',
      snippet: n.snippet || n.description || '',
      source: n.source || ''
    }));
  } catch (err) {
    console.warn('Serper news search error:', err.message);
    return [];
  }
}

/** Thu thập tin tức thật theo các chủ đề (Fed, lạm phát, OPEC, vàng, USD). */
async function fetchNewsSources() {
  const queries = [
    'Fed interest rate decision',
    'US inflation CPI',
    'OPEC oil production',
    'gold price news',
    'USD dollar exchange rate'
  ];
  const seen = new Set();
  const all = [];
  for (const q of queries) {
    const results = await searchNews(q, 6);
    for (const r of results) {
      if (r.link && !seen.has(r.link)) {
        seen.add(r.link);
        all.push(r);
      }
    }
  }
  return all;
}

const NEWS_PROMPT_STREAM = `Bạn là chuyên gia thị trường hàng hóa. Tổng hợp các tin tức toàn cầu mới nhất trong ngày (24h qua) có ảnh hưởng tới giá vàng, giá xăng và giá dầu. Chỉ nhận định theo tin trong ngày, không dùng tin cũ. Bao gồm: chính sách lãi suất, lạm phát, xung đột địa chính trị, OPEC, Fed, USD, và các sự kiện kinh tế lớn.
Trả về bằng markdown: dùng ## cho tiêu đề nhóm tin, dùng dấu - cho từng mục. Không giải thích thêm, chỉ nội dung. Ngôn ngữ: tiếng Việt. Tối đa 5-7 nhóm tin, mỗi nhóm 2-4 mục.`;

const NEWS_PROMPT_NO_SOURCES = `Bạn là chuyên gia thị trường hàng hóa. Tổng hợp các tin tức toàn cầu mới nhất trong ngày (24h qua) có ảnh hưởng tới giá vàng, giá xăng và giá dầu. Bao gồm: chính sách lãi suất, lạm phát, xung đột địa chính trị, OPEC, Fed, USD, và các sự kiện kinh tế lớn.

Với MỖI mục tin, bắt buộc gắn tên nguồn tham khảo (báo/ trang tin thật, ví dụ: Reuters, Bloomberg, CNBC, Financial Times, BBC, VnExpress, CafeF, Thanh Niên, VietnamPlus...). Trả về ĐÚNG MỘT JSON với cấu trúc:
{
  "sections": [
    {
      "title": "Tiêu đề nhóm tin (vd: Chính sách lãi suất)",
      "items": [
        {
          "text": "1-2 câu tóm tắt nội dung tin (tiếng Việt).",
          "sourceName": "Tên nguồn (vd: Reuters, Bloomberg, VnExpress)"
        }
      ]
    }
  ]
}

Yêu cầu: MỖI item phải có "text" và "sourceName". sourceName là tên báo/ trang tin uy tín phù hợp với nội dung tin đó. Tối đa 5-7 nhóm tin, mỗi nhóm 2-4 mục. Ngôn ngữ nội dung: tiếng Việt. Chỉ trả về JSON thuần, không markdown, không \`\`\`json.`;

function buildNewsPromptWithSources(articles) {
  const block = articles
    .map(
      (a, i) =>
        `[${i + 1}] Nguồn: ${a.source || 'Web'}\n   Tiêu đề: ${a.title}\n   Link: ${a.link}\n   Mô tả: ${a.snippet}`
    )
    .join('\n\n');
  return `Bạn là chuyên gia thị trường hàng hóa. Dưới đây là các bài báo/tin tức thật đã tìm được (từ Google News). Nhiệm vụ: tổng hợp theo nhóm chủ đề (Chính sách lãi suất, Lạm phát, Xung đột địa chính trị, OPEC, Tình hình USD, v.v.) và với MỖI mục tin, BẮT BUỘC gắn đúng MỘT nguồn từ danh sách dưới (dùng đúng link và tên nguồn có sẵn).

Các bài đã tìm được:
${block}

Trả về ĐÚNG MỘT JSON với cấu trúc:
{
  "sections": [
    {
      "title": "Tiêu đề nhóm tin (vd: Chính sách lãi suất)",
      "items": [
        {
          "text": "1-2 câu tóm tắt nội dung tin (tiếng Việt).",
          "sourceName": "Tên nguồn (lấy từ Nguồn trong danh sách trên)",
          "sourceUrl": "Link chính xác lấy từ danh sách trên"
        }
      ]
    }
  ]
}

Yêu cầu: MỖI item phải có sourceName và sourceUrl là MỘT trong các bài đã cho (copy đúng link). Không bịa link. Tối đa 5-7 nhóm, mỗi nhóm 2-4 mục. Ngôn ngữ nội dung: tiếng Việt. Chỉ trả về JSON thuần, không markdown, không \`\`\`json.`;
}

const OUTLOOK_PROMPT_STREAM = `Bạn là chuyên gia phân tích xu hướng giá vàng, xăng, dầu. Đưa ra nhận định ngắn gọn (tiếng Việt) theo hai khung thời gian.
Trả về bằng markdown với cấu trúc:
## Ngắn hạn (1–3 tháng)
### Vàng
(nhận định 1-2 câu)
### Xăng, dầu
(nhận định 1-2 câu)
## Dài hạn (6–12 tháng)
### Vàng
(nhận định 1-2 câu)
### Xăng, dầu
(nhận định 1-2 câu)
Chỉ nội dung markdown, không giải thích thêm.`;

const OUTLOOK_PROMPT = `Bạn là chuyên gia phân tích xu hướng giá vàng, xăng, dầu. Đưa ra nhận định ngắn gọn (tiếng Việt) theo hai khung thời gian:

1) Ngắn hạn (1-3 tháng): Xu hướng tăng/giảm/đi ngang cho vàng, xăng, dầu; các yếu tố chính tác động.
2) Dài hạn (6-12 tháng): Triển vọng vàng, xăng, dầu; rủi ro và kịch bản có thể xảy ra.

Trả về ĐÚNG MỘT JSON:
{
  "shortTerm": {
    "gold": "1-2 câu nhận định vàng ngắn hạn",
    "oil": "1-2 câu nhận định dầu/xăng ngắn hạn"
  },
  "longTerm": {
    "gold": "1-2 câu nhận định vàng dài hạn",
    "oil": "1-2 câu nhận định dầu/xăng dài hạn"
  }
}
Chỉ trả về JSON thuần, không markdown, không \`\`\`json.`;

let newsCache = { data: null, timestamp: null, ttl: 60 * 60 * 1000 }; // 1 giờ
let outlookCache = { data: null, timestamp: null, ttl: 60 * 60 * 1000 };

function isConfigured() {
  return !!(OPENAI_API_KEY && OPENAI_API_KEY.trim());
}

async function getNewsContent(forceRefresh = false) {
  if (!isConfigured()) {
    return { ok: false, error: 'Chưa cấu hình OPENAI_API_KEY', content: null };
  }
  const now = Date.now();
  if (!forceRefresh && newsCache.data && newsCache.timestamp && now - newsCache.timestamp < newsCache.ttl) {
    return { ok: true, content: newsCache.data };
  }
  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    let prompt = NEWS_PROMPT_NO_SOURCES;
    const articles = await fetchNewsSources();
    if (articles.length > 0) {
      prompt = buildNewsPromptWithSources(articles);
    }
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Bạn chỉ trả lời bằng JSON hợp lệ.' },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.4
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return { ok: false, error: 'Empty response', content: null };
    const parsed = JSON.parse(raw);
    newsCache.data = parsed;
    newsCache.timestamp = now;
    return { ok: true, content: parsed };
  } catch (err) {
    console.error('Content service news error:', err.message);
    if (newsCache.data) return { ok: true, content: newsCache.data };
    return { ok: false, error: err.message, content: null };
  }
}

async function getOutlookContent(forceRefresh = false) {
  if (!isConfigured()) {
    return { ok: false, error: 'Chưa cấu hình OPENAI_API_KEY', content: null };
  }
  const now = Date.now();
  if (!forceRefresh && outlookCache.data && outlookCache.timestamp && now - outlookCache.timestamp < outlookCache.ttl) {
    return { ok: true, content: outlookCache.data };
  }
  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Bạn chỉ trả lời bằng JSON hợp lệ.' },
        { role: 'user', content: OUTLOOK_PROMPT }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return { ok: false, error: 'Empty response', content: null };
    const parsed = JSON.parse(raw);
    outlookCache.data = parsed;
    outlookCache.timestamp = now;
    return { ok: true, content: parsed };
  } catch (err) {
    console.error('Content service outlook error:', err.message);
    if (outlookCache.data) return { ok: true, content: outlookCache.data };
    return { ok: false, error: err.message, content: null };
  }
}

/**
 * Stream tin tức (markdown) từ OpenAI. Ưu tiên tin trong ngày từ tìm kiếm (qdr:d) nếu có Serper.
 */
async function streamNewsToResponse(res) {
  if (!isConfigured()) {
    res.write(JSON.stringify({ error: 'Chưa cấu hình OPENAI_API_KEY' }));
    res.end();
    return;
  }
  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Bạn chỉ trả lời bằng markdown, không giải thích thêm.' },
        { role: 'user', content: NEWS_PROMPT_STREAM }
      ],
      stream: true,
      temperature: 0.4
    });
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text && typeof text === 'string') res.write(text);
    }
  } catch (err) {
    console.error('Stream news error:', err.message);
    res.write('\n\n_Lỗi: ' + err.message + '_');
  }
  res.end();
}

/**
 * Stream nhận định (markdown) từ OpenAI ra response. Có thể kèm nguồn tin tức/diễn đàn và link.
 */
async function streamOutlookToResponse(res) {
  if (!isConfigured()) {
    res.write(JSON.stringify({ error: 'Chưa cấu hình OPENAI_API_KEY' }));
    res.end();
    return;
  }
  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Bạn chỉ trả lời bằng markdown, không giải thích thêm.' },
        { role: 'user', content: OUTLOOK_PROMPT_STREAM }
      ],
      stream: true,
      temperature: 0.3
    });
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text && typeof text === 'string') res.write(text);
    }
  } catch (err) {
    console.error('Stream outlook error:', err.message);
    res.write('\n\n_Lỗi: ' + err.message + '_');
  }
  res.end();
}

module.exports = {
  getNewsContent,
  getOutlookContent,
  streamNewsToResponse,
  streamOutlookToResponse,
  isContentConfigured: isConfigured
};
