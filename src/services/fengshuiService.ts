/**
 * Phong thủy hướng nhà – dùng ChatGPT phân tích theo họ tên và ngày sinh vợ/chồng.
 */
import OpenAI from 'openai';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT = `Bạn là chuyên gia phong thủy (Bát trạch, mệnh quái). Nhiệm vụ: nhận thông tin vợ và chồng (họ tên, ngày tháng năm sinh), sau đó đưa ra đánh giá hướng nhà đất phù hợp.
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
Yêu cầu: "directions" phải có đủ 8 hướng: Bắc, Đông Bắc, Đông, Đông Nam, Nam, Tây Nam, Tây, Tây Bắc. Sắp xếp theo thứ tự từ tốt đến xấu hoặc theo hướng la bàn. Ngôn ngữ toàn bộ: tiếng Việt.`;

function buildUserPrompt(
  husbandName: string,
  husbandDob: string,
  wifeName: string,
  wifeDob: string
): string {
  return `Vợ chồng với thông tin sau:
- Chồng: Họ tên "${husbandName}", ngày sinh ${husbandDob || 'chưa rõ'}.
- Vợ: Họ tên "${wifeName}", ngày sinh ${wifeDob || 'chưa rõ'}.

Hãy phân tích phong thủy hướng nhà (Bát trạch / mệnh quái) và trả về JSON đúng cấu trúc đã quy định.`;
}

export interface FengshuiContent {
  summary?: string;
  directions?: Array<{ direction?: string; rating?: string; meaning?: string }>;
  recommendation?: string;
  husbandNote?: string;
  wifeNote?: string;
}

export interface FengshuiResult {
  ok: boolean;
  error?: string;
  content?: FengshuiContent;
}

export async function getFengshuiRecommendation(
  husbandName: string,
  husbandDob: string,
  wifeName: string,
  wifeDob: string
): Promise<FengshuiResult> {
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
      temperature: 0.3
    });
    const raw = completion.choices[0]?.message?.content;
    if (!raw) return { ok: false, error: 'Phản hồi trống' };
    const parsed = JSON.parse(raw) as FengshuiContent;
    if (!parsed.directions || !Array.isArray(parsed.directions)) {
      return { ok: false, error: 'Kết quả thiếu bảng hướng' };
    }
    return { ok: true, content: parsed };
  } catch (err) {
    console.warn('Fengshui service:', (err as Error).message);
    return { ok: false, error: (err as Error).message || 'Lỗi gọi ChatGPT' };
  }
}

export function isConfigured(): boolean {
  return !!(OPENAI_API_KEY && OPENAI_API_KEY.trim());
}
