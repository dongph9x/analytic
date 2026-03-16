/**
 * Phong thủy hướng nhà – dùng ChatGPT để phân tích theo họ tên và ngày sinh vợ/chồng.
 * Trả về hướng tốt/xấu và đánh giá tổng hợp.
 */
const OpenAI = require('openai');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT = `Bạn là chuyên gia phong thủy (Bát trạch, mệnh quái). Nhiệm vụ: nhận thông tin vợ và chồng (họ tên, ngày tháng năm sinh), sau đó đưa ra đánh giá hướng nhà đất phù hợp.

QUAN TRỌNG: Ngày sinh người dùng nhập vào luôn là DƯƠNG LỊCH (lịch Gregory, dd/mm/yyyy). Bạn phải dùng đúng ngày dương lịch đó để tính mệnh quái / Bát trạch (không chuyển sang âm lịch trừ khi trong phương pháp của bạn bắt buộc phải dùng âm lịch và bạn tự quy đổi).

Trả về ĐÚNG MỘT JSON theo cấu trúc sau, không thêm markdown hay \`\`\`json:
{
  "summary": "1-2 câu tóm tắt tổng quan về mệnh trạch hai vợ chồng (tiếng Việt)",
  "directions": [
    { "direction": "Tên hướng (VD: Bắc, Đông Bắc, Đông, Đông Nam, Nam, Tây Nam, Tây, Tây Bắc)", "rating": "Rất tốt | Tốt | Trung tính | Xấu | Rất xấu", "meaning": "Ý nghĩa ngắn (VD: Sinh khí, Thiên y, Tuyệt mệnh... hoặc giải thích ngắn)" }
  ],
  "recommendation": "2-4 câu gợi ý chọn hướng nhà/cửa chính phù hợp cho cả hai, tiếng Việt",
  "husbandNote": "1 câu ngắn về mệnh/quái chồng (nếu có)",
  "wifeNote": "1 câu ngắn về mệnh/quái vợ (nếu có)"
}
Yêu cầu:
- "directions" phải có đủ 8 hướng: Bắc, Đông Bắc, Đông, Đông Nam, Nam, Tây Nam, Tây, Tây Bắc. Sắp xếp theo thứ tự la bàn (Bắc, Đông Bắc, Đông, Đông Nam, Nam, Tây Nam, Tây, Tây Bắc).
- Bát trạch có đúng 8 sao: 4 cát (Sinh khí, Thiên y, Diên niên, Phục vị) và 4 hung (Tuyệt mệnh, Ngũ quỷ, Lục sát, Họa hại). Mỗi hướng được gán ĐÚNG MỘT sao theo quy tắc tính từ năm sinh dương lịch và giới tính (nam/chồng, nữ/vợ). CÙNG ngày sinh và giới tính thì PHẢI ra CÙNG bảng (hướng nào – sao đó, đánh giá đó). Rating: Sinh khí = Rất tốt, Thiên y / Diên niên / Phục vị = Tốt, Tuyệt mệnh / Ngũ quỷ / Lục sát / Họa hại = Xấu hoặc Rất xấu tùy mức.
- Ngôn ngữ toàn bộ: tiếng Việt.`;

function buildUserPrompt(husbandName, husbandDob, wifeName, wifeDob) {
  return `Vợ chồng với thông tin sau (ngày sinh là DƯƠNG LỊCH, định dạng dd/mm/yyyy):
- Chồng: Họ tên "${husbandName}", ngày sinh (dương lịch) ${husbandDob || 'chưa rõ'}.
- Vợ: Họ tên "${wifeName}", ngày sinh (dương lịch) ${wifeDob || 'chưa rõ'}.

Hãy phân tích phong thủy hướng nhà (Bát trạch / mệnh quái) dựa trên ngày dương lịch đã cho và trả về JSON đúng cấu trúc đã quy định.`;
}

/**
 * Gọi ChatGPT lấy kết quả phong thủy.
 * @param {string} husbandName
 * @param {string} husbandDob - dd/mm/yyyy
 * @param {string} wifeName
 * @param {string} wifeDob - dd/mm/yyyy
 * @returns {Promise<{ ok: boolean, error?: string, content?: object }>}
 */
async function getFengshuiRecommendation(husbandName, husbandDob, wifeName, wifeDob) {
  if (!OPENAI_API_KEY || !OPENAI_API_KEY.trim()) {
    return { ok: false, error: 'Chưa cấu hình OPENAI_API_KEY' };
  }
  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const userContent = buildUserPrompt(
      husbandName || 'Chồng',
      husbandDob || '',
      wifeName || 'Vợ',
      wifeDob || ''
    );
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userContent }
      ],
      response_format: { type: 'json_object' },
      temperature: 0
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return { ok: false, error: 'Phản hồi trống' };
    const parsed = JSON.parse(raw);
    if (!parsed.directions || !Array.isArray(parsed.directions)) {
      return { ok: false, error: 'Kết quả thiếu bảng hướng' };
    }
    return { ok: true, content: parsed };
  } catch (err) {
    console.warn('Fengshui service:', err.message);
    return { ok: false, error: err.message || 'Lỗi gọi ChatGPT' };
  }
}

module.exports = {
  getFengshuiRecommendation,
  isConfigured: () => !!(OPENAI_API_KEY && OPENAI_API_KEY.trim())
};
