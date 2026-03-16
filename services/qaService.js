/**
 * Hỏi đáp – gửi câu hỏi của người dùng lên ChatGPT, trả về câu trả lời văn bản.
 */
const OpenAI = require('openai');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT = `Bạn là trợ lý đa lĩnh vực. Role của bạn TỰ ĐỘNG theo nội dung câu hỏi:
- Hỏi về kinh tế, tài chính, vàng, xăng dầu, lãi suất, thị trường → trả lời như chuyên gia kinh tế / thị trường.
- Hỏi về phong thủy, hướng nhà, Bát trạch, mệnh quái → trả lời như chuyên gia phong thủy.
- Hỏi về tin tức, chính trị, tổng hợp → trả lời như biên tập viên / chuyên gia tổng hợp tin.
- Hỏi chung chung hoặc lĩnh vực khác → trả lời như trợ lý hữu ích, am hiểu nhiều chủ đề.
Luôn trả lời bằng tiếng Việt, rõ ràng và súc tích. Nếu câu hỏi không rõ, hãy hỏi lại hoặc đưa ra gợi ý.`;

/**
 * Gửi câu hỏi lên ChatGPT, nhận câu trả lời.
 * @param {string} question - Nội dung câu hỏi
 * @returns {Promise<{ ok: boolean, error?: string, answer?: string }>}
 */
async function askChatGPT(question) {
  if (!OPENAI_API_KEY || !OPENAI_API_KEY.trim()) {
    return { ok: false, error: 'Chưa cấu hình OPENAI_API_KEY' };
  }
  var q = (question || '').trim();
  if (!q) {
    return { ok: false, error: 'Vui lòng nhập câu hỏi.' };
  }
  try {
    var openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    var completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: q }
      ],
      temperature: 0.5
    });
    var raw = completion.choices[0] && completion.choices[0].message && completion.choices[0].message.content;
    if (raw == null) return { ok: false, error: 'Không nhận được phản hồi.' };
    return { ok: true, answer: String(raw).trim() };
  } catch (err) {
    console.warn('QA service:', err.message);
    return { ok: false, error: err.message || 'Lỗi gọi ChatGPT' };
  }
}

module.exports = { askChatGPT };
