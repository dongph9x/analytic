/**
 * Hỏi đáp – gửi câu hỏi của người dùng lên ChatGPT.
 */
import OpenAI from 'openai';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

const SYSTEM_PROMPT =
  'Bạn là trợ lý hữu ích. Trả lời câu hỏi của người dùng bằng tiếng Việt, rõ ràng và súc tích. Nếu câu hỏi không rõ, hãy hỏi lại hoặc đưa ra gợi ý.';

export interface QaResult {
  ok: boolean;
  error?: string;
  answer?: string;
}

export async function askChatGPT(question: string): Promise<QaResult> {
  if (!OPENAI_API_KEY || !OPENAI_API_KEY.trim()) {
    return { ok: false, error: 'Chưa cấu hình OPENAI_API_KEY' };
  }
  const q = (question || '').trim();
  if (!q) {
    return { ok: false, error: 'Vui lòng nhập câu hỏi.' };
  }
  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: q }
      ],
      temperature: 0.5
    });
    const raw = completion.choices[0]?.message?.content;
    if (raw == null) return { ok: false, error: 'Không nhận được phản hồi.' };
    return { ok: true, answer: String(raw).trim() };
  } catch (err) {
    console.warn('QA service:', (err as Error).message);
    return { ok: false, error: (err as Error).message || 'Lỗi gọi ChatGPT' };
  }
}
