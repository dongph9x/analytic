/**
 * Dùng ChatGPT (OpenAI) để tổng hợp báo cáo ra soát quy hoạch theo tọa độ đất.
 * Có thể tìm kiếm thực tế trên mạng (Serper API) để lấy quyết định quy hoạch liên quan, rồi ChatGPT tổng hợp.
 */
const OpenAI = require('openai');
const https = require('https');
const axios = require('axios');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;

/** Trích tên địa điểm từ URL Google Maps (phần /place/... trước /@ hoặc ?). Nếu là tọa độ dạng 11°... thì trả về null. */
function extractPlaceFromGoogleMapUrl(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const decoded = decodeURIComponent(url);
    const match = decoded.match(/\/place\/([^/@?]+)/);
    if (!match) return null;
    const place = match[1].trim().replace(/\+/g, ' ');
    if (!place) return null;
    if (/^\d+[°º]?\s*\d+['′]?\s*[\d."″]*\s*[NS]\s+\d+[°º]?\s*\d+['′]?\s*[\d."″]*\s*[EW]/i.test(place)) return null;
    if (/^-?\d+\.?\d*\s*,\s*-?\d+\.?\d*$/.test(place)) return null;
    return place;
  } catch (_) {
    return null;
  }
}

/** Reverse geocode (lat, lng) qua Nominatim. Trả về display_name hoặc chuỗi ghép từ address (xã, huyện, tỉnh). */
function reverseGeocode(lat, lng) {
  return new Promise((resolve) => {
    const path = `/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1`;
    const opts = {
      hostname: 'nominatim.openstreetmap.org',
      path,
      method: 'GET',
      headers: { 'User-Agent': 'AnalyticPlanningCheck/1.0 (Vietnam land planning)' }
    };
    const req = https.request(opts, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (!j) {
            resolve(null);
            return;
          }
          const addr = j.address;
          if (addr && (addr.state || addr.province || addr.county)) {
            const parts = [
              addr.village || addr.suburb || addr.hamlet || addr.neighbourhood,
              addr.county || addr.district || addr.municipality,
              addr.state || addr.province
            ].filter(Boolean);
            if (parts.length) resolve(parts.join(', '));
            else if (j.display_name) resolve(j.display_name);
            else resolve(null);
          } else if (j.display_name) {
            resolve(j.display_name);
          } else {
            resolve(null);
          }
        } catch (_) {
          resolve(null);
        }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(10000, () => { req.destroy(); resolve(null); });
    req.end();
  });
}

/** Vùng theo tọa độ Việt Nam (ưu tiên hơn reverse geocode vì OSM/Nominatim có thể sai). Trả về { authoritative: string } khi biết chắc tỉnh/vùng. */
function getVietnamAuthoritativeRegion(lat, lng) {
  if (lat < 8.2 || lat > 23.4 || lng < 102.2 || lng > 109.5) return null;
  if (lng >= 107.2 && lng <= 108.8 && lat >= 11.2 && lat <= 12.2) {
    return { authoritative: 'Lâm Đồng', detail: 'Lộc Tân, Bảo Lộc, Lâm Đồng (Tây Nguyên). Tọa độ 11.58°N 107.75°E thuộc tỉnh Lâm Đồng, KHÔNG phải Đồng Nai hay Bình Dương.' };
  }
  if (lng >= 107.5 && lng <= 108.2 && lat >= 10.8 && lat <= 11.8) {
    return { authoritative: 'Lâm Đồng hoặc Đắk Lắk', detail: 'Tây Nguyên. KHÔNG phải Bình Dương (kinh độ ~106°).' };
  }
  if (lng >= 106.4 && lng <= 106.9 && lat >= 10.8 && lat <= 11.5) {
    return { authoritative: 'Bình Dương / Đồng Nai', detail: 'Vùng phía nam.' };
  }
  return null;
}

/** Gọi Serper (Google Search API) trả về danh sách { title, link, snippet }. */
async function searchWeb(query, num = 10) {
  if (!SERPER_API_KEY || !SERPER_API_KEY.trim()) return [];
  try {
    const { data } = await axios.post(
      'https://google.serper.dev/search',
      { q: query, num },
      {
        headers: {
          'X-API-KEY': SERPER_API_KEY,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );
    const organic = data.organic || [];
    return organic.slice(0, num).map((o) => ({
      title: o.title || '',
      link: o.link || '',
      snippet: o.snippet || ''
    }));
  } catch (err) {
    console.warn('Serper search error:', err.message);
    return [];
  }
}

/** Tìm kiếm trên mạng các quyết định/quy hoạch đất đai, khoáng sản liên quan tới vùng. */
async function searchPlanningForLocation(authoritativeRegion) {
  if (!authoritativeRegion) return null;
  const province = authoritativeRegion.authoritative;
  const isLamDong = province.includes('Lâm Đồng');
  const queries = [
    `quyết định quy hoạch ${province} site:gov.vn`,
    `quy hoạch sử dụng đất ${province} site:gov.vn`,
    isLamDong ? 'quyết định quy hoạch đất đai khoáng sản Lộc Tân Bảo Lộc Lâm Đồng' : `quy hoạch đất đai ${province}`,
    `quy hoạch khoáng sản ${province}`,
    `cổng thông tin điện tử ${province} quy hoạch`
  ];
  const seen = new Set();
  const all = [];
  for (const q of queries) {
    const results = await searchWeb(q, 8);
    for (const r of results) {
      if (r.link && !seen.has(r.link)) {
        seen.add(r.link);
        all.push(r);
      }
    }
  }
  return all.length ? all : null;
}

function buildPlanningPrompt(lat, lng, mapLink, authoritativeRegion, searchResults) {
  const regionFact =
    authoritativeRegion &&
    `\n\n[SỰ THẬT ĐỊA LÝ – BẮT BUỘC TUÂN THỦ: Vị trí theo link bản đồ thuộc tỉnh ${authoritativeRegion.authoritative} (${authoritativeRegion.detail}). Trong toàn bộ báo cáo chỉ được nêu tỉnh "${authoritativeRegion.authoritative}" và các cơ quan/nguồn tra cứu của tỉnh đó. Cấm nêu Bà Rịa - Vũng Tàu, Đồng Nai, Bình Dương hay tỉnh nào khác.]`;

  let searchBlock = '';
  if (searchResults && searchResults.length > 0) {
    searchBlock = `

KẾT QUẢ TÌM KIẾM THỰC TẾ TRÊN MẠNG (các trang chính thống / quy hoạch):
${searchResults
  .map(
    (r, i) =>
      `[${i + 1}] Tiêu đề: ${r.title}\n    Link: ${r.link}\n    Mô tả: ${r.snippet}`
  )
  .join('\n\n')}

YÊU CẦU: Dựa TRỰC TIẾP trên kết quả tìm kiếm trên, rà soát và tổng hợp theo cấu trúc sau (trích từ nội dung tìm được, ghi rõ nguồn/link):
- Các quyết định quy hoạch có liên quan: nêu rõ SỐ QUYẾT ĐỊNH (ví dụ 866/QĐ-TTg, 1194/QĐ-UBND, 1899/QĐ-UBND), tên/quy mô (quy hoạch khoáng sản, quy hoạch sử dụng đất, quy hoạch chung đô thị...), PHẠM VI ẢNH HƯỞNG (địa bàn: xã, huyện, diện tích nếu có), HỆ LỤY PHÁP LÝ (ví dụ: vướng cấp phép xây dựng, tách thửa, chuyển mục đích sử dụng đất; vướng quy hoạch khoáng sản bô xít...). Mỗi quyết định gắn với link nguồn từ kết quả.
- Các dự án trọng điểm tác động tới quy hoạch (cao tốc, khai thác khoáng sản...) nếu có trong kết quả.
- Lưu ý thực tế: ví dụ tra cứu mã "866" trên ứng dụng tra cứu quy hoạch hoặc tại Văn phòng Đăng ký đất đai địa phương để biết thửa đất có nằm trong vùng quy hoạch hay không. Ghi rõ nguồn (link).
- Cổng thông tin chính thống có trong kết quả: liệt kê tên + URL (lamdong.gov.vn, Bộ Xây dựng, Sở TN&MT...).
Nếu trong kết quả không có thông tin cụ thể cho địa điểm, nêu rõ và vẫn liệt kê nguồn để người dùng tự tra.`;
  } else {
    searchBlock = `

Không có kết quả tìm kiếm thực tế (chưa cấu hình tìm kiếm hoặc không trả về). Đưa ra danh sách nguồn tra cứu chính thống và quy trình người dùng cần tự tra cứu trên các cổng đó.`;
  }

  return `Hãy kiểm tra mảnh đất tại vị trí theo link bản đồ sau có thuộc diện quy hoạch không. Dữ liệu quy hoạch cần tra soát từ các trang chính thống của Nhà nước.

Dữ liệu đầu vào:
- Link Google Map (vị trí cần kiểm tra): ${mapLink || 'Chưa cung cấp'}${regionFact || ''}${searchBlock}

Đưa ra báo cáo bằng tiếng Việt, có cấu trúc (trích nội dung từ kết quả tìm kiếm, ghi nguồn/link khi có):

1. Vùng hành chính: tỉnh/thành, huyện/quận, xã/phường của địa điểm (đúng theo sự thật địa lý đã cho).

2. Kết quả rà soát quy hoạch (từ kết quả tìm kiếm):
   - Từng quyết định/quy hoạch liên quan: SỐ QUYẾT ĐỊNH (vd 866/QĐ-TTg, 1194/QĐ-UBND, 1899/QĐ-UBND), tên/quy mô, PHẠM VI ẢNH HƯỞNG (địa bàn, diện tích nếu có), HỆ LỤY PHÁP LÝ (vướng cấp phép xây dựng, tách thửa, chuyển mục đích, quy hoạch khoáng sản...). Ghi link nguồn.
   - Các dự án trọng điểm ảnh hưởng (cao tốc, khai thác khoáng sản...) nếu có.
   - Lưu ý thực tế: tra cứu mã 866 hoặc tại VPĐKĐĐ địa phương để biết thửa đất có trong vùng quy hoạch hay không; ghi nguồn.
   - Nguồn chính thống: liệt kê cổng/trang (tên + URL) từ kết quả.
   Nếu không tìm thấy thông tin cụ thể trong kết quả thì nêu rõ và liệt kê nguồn để người dùng tự tra.

3. Các loại quy hoạch có thể liên quan: quy hoạch sử dụng đất, khoáng sản, xây dựng, đô thị, chi tiết... và ý nghĩa với mua bán/sử dụng đất.

4. Quy trình nên thực hiện: tra cứu trên cổng quy hoạch, liên hệ Sở TN&MT, VPĐKĐĐ, xin xác nhận chính thức.

5. Lưu ý pháp lý: chỉ cơ quan nhà nước mới xác nhận chính thức; báo cáo chỉ tham khảo.

Trả lời bằng văn bản thuần, đánh số 1., 2., ... không dùng markdown code block.`;
}

/**
 * Stream báo cáo quy hoạch từ OpenAI ra response (text/plain).
 * mapLink: optional Google Map URL để trích tên địa điểm; nếu không có hoặc không trích được thì dùng reverse geocode.
 */
async function streamPlanningReportToResponse(res, lat, lng, mapLink) {
  if (!OPENAI_API_KEY || OPENAI_API_KEY.trim() === '') {
    res.write('Lỗi: Chưa cấu hình OPENAI_API_KEY.');
    res.end();
    return;
  }
  const authoritativeRegion = getVietnamAuthoritativeRegion(lat, lng);
  let searchResults = null;
  if (SERPER_API_KEY && SERPER_API_KEY.trim()) {
    searchResults = await searchPlanningForLocation(authoritativeRegion);
  }

  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const prompt = buildPlanningPrompt(lat, lng, mapLink || null, authoritativeRegion, searchResults);
    const systemContent = authoritativeRegion
      ? `Bạn trả lời bằng tiếng Việt. Trong prompt có mục [SỰ THẬT ĐỊA LÝ – BẮT BUỘC TUÂN THỦ]: bạn PHẢI dùng đúng tỉnh "${authoritativeRegion.authoritative}" trong toàn bộ báo cáo (mục 1, 2, 4). Cấm nêu Bà Rịa - Vũng Tàu, Đồng Nai, Bình Dương hay tỉnh khác. Trả lời văn bản thuần, đánh số 1., 2., ...`
      : 'Bạn trả lời bằng tiếng Việt, văn bản thuần, đánh số 1., 2., ...';

    const stream = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: systemContent },
        { role: 'user', content: prompt }
      ],
      stream: true,
      temperature: 0.2
    });
    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text && typeof text === 'string') res.write(text);
    }
  } catch (err) {
    console.error('Planning report stream error:', err.message);
    res.write('\n\nLỗi: ' + err.message);
  }
  res.end();
}

function isConfigured() {
  return !!(OPENAI_API_KEY && OPENAI_API_KEY.trim());
}

module.exports = {
  streamPlanningReportToResponse,
  isConfigured
};
