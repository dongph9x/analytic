/**
 * Tạo nội dung tin tức và nhận định xu hướng (vàng, xăng, dầu) bằng ChatGPT.
 * Nếu có SERPER_API_KEY: tìm tin thật qua Serper News, ChatGPT tổng hợp và gắn nguồn (link bài đăng).
 * Nếu không: chỉ dựa vào kiến thức mô hình, không có link nguồn.
 */
const OpenAI = require('openai');
const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

/** System role cho từng loại nội dung – đảm bảo ChatGPT đúng vai khi gọi API. */
const NEWS_SYSTEM_ROLE = 'Bạn là chuyên gia thị trường hàng hóa và tin tức tài chính. Nhiệm vụ: tổng hợp tin ảnh hưởng giá vàng, xăng, dầu. Bạn chỉ trả lời bằng JSON hợp lệ.';
const NEWS_STREAM_SYSTEM_ROLE = 'Bạn là chuyên gia thị trường hàng hóa và tin tức tài chính. Tổng hợp tin ảnh hưởng giá vàng, xăng, dầu. Bạn chỉ trả lời bằng markdown, không giải thích thêm.';
const OUTLOOK_SYSTEM_ROLE = 'Bạn là chuyên gia kinh tế, tài chính và chính trị. Nhiệm vụ: đưa ra nhận định xu hướng giá vàng, xăng, dầu dựa trên phân tích kinh tế vĩ mô, thị trường và địa chính trị. Bạn chỉ trả lời bằng JSON hợp lệ.';
const OUTLOOK_STREAM_SYSTEM_ROLE = 'Bạn là chuyên gia kinh tế, tài chính và chính trị. Đưa ra nhận định xu hướng vàng, xăng, dầu. Bạn chỉ trả lời bằng markdown, không giải thích thêm.';
const SUMMARY_SYSTEM_ROLE = 'Bạn là chuyên gia biên tập tin kinh tế và chính trị (Việt Nam và thế giới). Nhiệm vụ: tổng hợp tin nổi bật trong ngày từ nguồn chính thống. Bạn chỉ trả lời bằng JSON hợp lệ.';

/** Ngày hiện tại theo múi giờ Việt Nam (UTC+7) để lọc tin "trong ngày". */
function getVietnamTodayContext() {
  const now = new Date();
  const dateStr = now.toLocaleDateString('vi-VN', {
    timeZone: 'Asia/Ho_Chi_Minh',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric'
  });
  const parts = dateStr.split('/');
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);
  const startOfDayVnMs = Date.UTC(year, month - 1, day) - 7 * 60 * 60 * 1000;
  const todayYMD = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  return {
    dateStr,
    todayYMD,
    startOfDayVnMs,
    instruction: `Ngày hiện tại theo múi giờ Việt Nam (UTC+7) là ${dateStr}. Chỉ chọn tin đăng hoặc xảy ra TRONG NGÀY NÀY (từ 0h00 đến 24h00 giờ Việt Nam). KHÔNG đưa tin từ ngày hôm trước.`
  };
}

/** Parse ngày từ Serper (vd: "14 Mar 2026", "1 day ago", "5 hours ago"). Trả về timestamp (ms) hoặc null. */
function parseSerperDate(dateStr, nowMs = Date.now()) {
  if (!dateStr || typeof dateStr !== 'string') return null;
  const s = dateStr.trim().toLowerCase();
  const hourMs = 60 * 60 * 1000;
  const dayMs = 24 * hourMs;
  const matchAgo = s.match(/^(\d+)\s*(minute|minutes|hour|hours|day|days|week|weeks)\s+ago$/);
  if (matchAgo) {
    const n = parseInt(matchAgo[1], 10);
    const unit = matchAgo[2];
    if (unit === 'minute' || unit === 'minutes') return nowMs - n * 60 * 1000;
    if (unit === 'hour' || unit === 'hours') return nowMs - n * hourMs;
    if (unit === 'day' || unit === 'days') return nowMs - n * dayMs;
    if (unit === 'week' || unit === 'weeks') return nowMs - n * 7 * dayMs;
  }
  const d = new Date(dateStr);
  if (!Number.isNaN(d.getTime())) return d.getTime();
  return null;
}

/** Lọc bài tổng hợp: chỉ giữ bài đăng từ ngày hôm nay (VN) trở đi. Bài không có ngày hoặc không parse được vẫn giữ. */
function filterSummaryArticlesByDate(articles) {
  const { startOfDayVnMs } = getVietnamTodayContext();
  const nowMs = Date.now();
  return articles.filter((a) => {
    const ts = parseSerperDate(a.date, nowMs);
    if (ts == null) return true;
    return ts >= startOfDayVnMs;
  });
}

/** Gọi Serper News API, trả về [{ title, link, snippet, source, date? }]. */
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
      source: n.source || '',
      date: n.date || n.publishedDate || ''
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

/** Tin tổng hợp: kinh tế, chính trị trong ngày từ các trang chính thống. Serper trả về [{ title, link, snippet, source, date }]. */
async function fetchSummarySources() {
  const { dateStr } = getVietnamTodayContext();
  const queries = [
    `kinh tế Việt Nam ${dateStr}`,
    `kinh tế Việt Nam hôm nay ${dateStr}`,
    'chính trị thế giới tin mới',
    'Fed lãi suất Mỹ',
    'lạm phát kinh tế',
    `VN economy news ${dateStr}`,
    'world politics news today'
  ];
  const seen = new Set();
  const all = [];
  for (const q of queries) {
    const results = await searchNews(q, 5);
    for (const r of results) {
      if (r.link && !seen.has(r.link)) {
        seen.add(r.link);
        all.push(r);
      }
    }
  }
  return filterSummaryArticlesByDate(all);
}

function buildSummaryPromptNoSources() {
  const { dateStr, instruction } = getVietnamTodayContext();
  return `Bạn là biên tập viên tin tức. Tổng hợp tin nổi bật MỚI NHẤT về kinh tế và chính trị (Việt Nam và thế giới) từ các nguồn chính thống (Reuters, Bloomberg, VnExpress, Thanh Niên, BBC, AFP...).

QUAN TRỌNG - THỜI GIAN: ${instruction}
HÔM NAY LÀ ${dateStr} (múi giờ Việt Nam). CHỈ đưa tin có ngày đăng đúng ngày ${dateStr}. Tin có ngày đăng trước ${dateStr} PHẢI LOẠI BỎ, không được đưa vào.

Trả về ĐÚNG MỘT JSON:
{
  "items": [
    {
      "title": "Tiêu đề bài viết (ngắn gọn)",
      "summary": "1-3 câu tóm tắt nội dung chính (tiếng Việt).",
      "sourceName": "Tên nguồn (vd: Reuters, VnExpress)"
    }
  ]
}

Yêu cầu: 8-15 mục, mỗi mục có title, summary, sourceName. Chỉ tin trong ngày theo giờ VN, ưu tiên tin nổi bật. Ngôn ngữ: tiếng Việt. Chỉ trả về JSON thuần, không markdown, không \`\`\`json.`;
}

function buildSummaryPromptWithSources(articles) {
  const { dateStr, instruction } = getVietnamTodayContext();
  const block = articles
    .map(
      (a, i) => {
        const datePart = a.date ? `   Ngày đăng (nếu có): ${a.date}` : '';
        return `[${i + 1}] Nguồn: ${a.source || 'Web'}\n   Tiêu đề: ${a.title}\n   Link: ${a.link}\n   Mô tả: ${a.snippet}${datePart ? '\n' + datePart : ''}`;
      }
    )
    .join('\n\n');
  return `Bạn là biên tập viên tin tức. Dưới đây là các bài báo/tin đã tìm được (từ Google News). Nhiệm vụ: chọn ra 8-15 tin NỔI BẬT NHẤT về kinh tế và chính trị (VN và thế giới), tóm tắt ngắn và BẮT BUỘC gắn đúng link từ danh sách.

QUAN TRỌNG - THỜI GIAN: ${instruction}
HÔM NAY LÀ ${dateStr} (múi giờ Việt Nam). CHỈ chọn bài có ngày đăng là ngày ${dateStr}. Bài có ngày đăng trước ${dateStr} PHẢI BỎ QUA, không đưa vào danh sách.

Các bài đã tìm được:
${block}

Trả về ĐÚNG MỘT JSON:
{
  "items": [
    {
      "title": "Tiêu đề bài (có thể rút gọn từ tiêu đề gốc)",
      "summary": "1-3 câu tóm tắt nội dung (tiếng Việt).",
      "link": "Link chính xác lấy từ danh sách trên",
      "sourceName": "Tên nguồn (lấy từ cột Nguồn trên)"
    }
  ]
}

Yêu cầu: MỖI item phải có title, summary, link (copy đúng từ danh sách), sourceName. Chỉ đưa tin trong ngày VN. 8-15 mục. Ngôn ngữ: tiếng Việt. Chỉ trả về JSON thuần, không markdown, không \`\`\`json.`;
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
let summaryCache = { data: null, timestamp: null, ttl: 60 * 60 * 1000 };

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
        { role: 'system', content: NEWS_SYSTEM_ROLE },
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
        { role: 'system', content: OUTLOOK_SYSTEM_ROLE },
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
        { role: 'system', content: NEWS_STREAM_SYSTEM_ROLE },
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
        { role: 'system', content: OUTLOOK_STREAM_SYSTEM_ROLE },
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

async function getSummaryContent(forceRefresh = false) {
  if (!isConfigured()) {
    return { ok: false, error: 'Chưa cấu hình OPENAI_API_KEY', content: null };
  }
  const now = Date.now();
  if (!forceRefresh && summaryCache.data && summaryCache.timestamp && now - summaryCache.timestamp < summaryCache.ttl) {
    return { ok: true, content: summaryCache.data };
  }
  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    let prompt = buildSummaryPromptNoSources();
    const articles = await fetchSummarySources();
    if (articles.length > 0) {
      prompt = buildSummaryPromptWithSources(articles);
    }
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_ROLE },
        { role: 'user', content: prompt }
      ],
      response_format: { type: 'json_object' },
      temperature: 0.4
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return { ok: false, error: 'Empty response', content: null };
    const parsed = JSON.parse(raw);
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const normalized = { items: items.map((it) => ({
      title: it.title || '',
      summary: it.summary || '',
      link: it.link || null,
      sourceName: it.sourceName || ''
    })) };
    summaryCache.data = normalized;
    summaryCache.timestamp = now;
    return { ok: true, content: normalized };
  } catch (err) {
    console.error('Content service summary error:', err.message);
    if (summaryCache.data) return { ok: true, content: summaryCache.data };
    return { ok: false, error: err.message, content: null };
  }
}

module.exports = {
  getNewsContent,
  getOutlookContent,
  getSummaryContent,
  streamNewsToResponse,
  streamOutlookToResponse,
  isContentConfigured: isConfigured
};
