/**
 * Tạo nội dung tin tức và nhận định xu hướng (vàng, xăng, dầu) bằng ChatGPT.
 * Hỗ trợ stream: trả về markdown từng phần để client hiển thị dần.
 */
const OpenAI = require('openai');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Prompt cho stream: trả về markdown (không JSON) để gửi từng chunk.
const NEWS_PROMPT_STREAM = `Bạn là chuyên gia thị trường hàng hóa. Tổng hợp các tin tức toàn cầu gần đây (1-2 tuần) có ảnh hưởng tới giá vàng, giá xăng và giá dầu. Bao gồm: chính sách lãi suất, lạm phát, xung đột địa chính trị, OPEC, Fed, USD, và các sự kiện kinh tế lớn.
Trả về bằng markdown: dùng ## cho tiêu đề nhóm tin, dùng dấu - cho từng mục. Không giải thích thêm, chỉ nội dung. Ngôn ngữ: tiếng Việt. Tối đa 5-7 nhóm tin, mỗi nhóm 2-4 mục.`;

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

const NEWS_PROMPT = `Bạn là chuyên gia thị trường hàng hóa. Tổng hợp các tin tức toàn cầu gần đây (1-2 tuần) có ảnh hưởng tới giá vàng, giá xăng và giá dầu. Bao gồm: chính sách lãi suất, lạm phát, xung đột địa chính trị, OPEC, Fed, USD, và các sự kiện kinh tế lớn. Trả về ĐÚNG MỘT JSON với cấu trúc:
{
  "sections": [
    { "title": "Tiêu đề nhóm tin", "items": ["Mô tả ngắn tin 1", "Mô tả tin 2", ...] }
  ]
}
Chỉ trả về JSON thuần, không markdown, không \`\`\`json. Tối đa 5-7 nhóm tin, mỗi nhóm 2-4 mục. Ngôn ngữ: tiếng Việt.`;

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
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'Bạn chỉ trả lời bằng JSON hợp lệ.' },
        { role: 'user', content: NEWS_PROMPT }
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
 * Stream tin tức (markdown) từ OpenAI ra response. Gọi từ route với res đã set header stream.
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
 * Stream nhận định (markdown) từ OpenAI ra response.
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
