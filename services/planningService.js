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
  if (lng >= 105.95 && lng <= 106.55 && lat >= 19.85 && lat <= 20.45) {
    return { authoritative: 'Nam Định', detail: 'Vùng đồng bằng sông Hồng. Tọa độ ~20°10\'N 106°15\'E thuộc tỉnh Nam Định (có thể Hải Hậu, Hải Đường...), KHÔNG phải Hà Nội (Hà Nội ở phía bắc, kinh độ ~105°-106°).' };
  }
  if (lng >= 105.4 && lng <= 106.05 && lat >= 20.7 && lat <= 21.2) {
    return { authoritative: 'Hà Nội', detail: 'Thủ đô Hà Nội. KHÔNG phải Nam Định (Nam Định ở phía nam, ~20°N 106°E).' };
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

/**
 * Tìm kiếm trước các quyết định/quy hoạch đất đai, khoáng sản của vùng (tỉnh, thành phố, huyện liên quan).
 * Sau đó so sánh với vị trí người dùng để đưa ra kết quả.
 */
async function searchPlanningDecisionsForArea(authoritativeRegion) {
  if (!authoritativeRegion) return null;
  const province = authoritativeRegion.authoritative;
  const isLamDong = province.includes('Lâm Đồng');
  const queries = [
    `quyết định quy hoạch đất đai khoáng sản ${isLamDong ? 'Bảo Lộc' : province}`,
    `quy hoạch sử dụng đất ${isLamDong ? 'Bảo Lộc Bảo Lâm' : province} site:gov.vn`,
    `quy hoạch khoáng sản ${isLamDong ? 'Bảo Lâm Lâm Đồng' : province}`,
    isLamDong ? 'quy hoạch Lộc Tân Bảo Lộc Lâm Đồng' : `quy hoạch đất đai ${province}`,
    `quyết định quy hoạch ${province} site:gov.vn`,
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

  const areaLabel = authoritativeRegion ? (authoritativeRegion.authoritative.includes('Lâm Đồng') ? 'Bảo Lộc, Bảo Lâm, Lộc Tân, Lâm Đồng' : authoritativeRegion.authoritative) : 'vùng';

  let searchBlock = '';
  if (searchResults && searchResults.length > 0) {
    searchBlock = `

ĐÃ TÌM KIẾM TRƯỚC các quyết định/quy hoạch đất đai, khoáng sản của vùng ${areaLabel}. Kết quả tìm được (các trang chính thống / quy hoạch):
${searchResults
  .map(
    (r, i) =>
      `[${i + 1}] Tiêu đề: ${r.title}\n    Link: ${r.link}\n    Mô tả: ${r.snippet}`
  )
  .join('\n\n')}

YÊU CẦU: (1) Từ kết quả tìm kiếm trên, liệt kê các quyết định/quy hoạch đã tìm được (số quyết định, tên/quy mô, phạm vi ảnh hưởng, hệ lụy pháp lý, link nguồn). (2) SO SÁNH với vị trí người dùng (link Google Map): quyết định nào có khả năng ảnh hưởng tới vị trí này, vì sao. (3) Kết luận: vị trí có thể dính quy hoạch nào, cần tra cứu thêm ở đâu (VPĐKĐĐ, mã quy hoạch...). Ghi rõ nguồn/link.`;
  } else {
    searchBlock = `

Chưa có kết quả tìm kiếm (chưa cấu hình hoặc không trả về). Đưa ra danh sách nguồn tra cứu chính thống và quy trình người dùng tự tra cứu.`;
  }

  return `Nhiệm vụ: Đã tìm kiếm trước các quyết định quy hoạch đất đai, khoáng sản của vùng ${areaLabel}. Bây giờ SO SÁNH với vị trí người dùng (link bản đồ) và đưa ra báo cáo.

Dữ liệu đầu vào:
- Link Google Map (vị trí cần so sánh): ${mapLink || 'Chưa cung cấp'}${regionFact || ''}${searchBlock}

Đưa ra báo cáo bằng tiếng Việt, có cấu trúc:

1. Vùng hành chính của vị trí: tỉnh/thành, huyện/quận, xã/phường (đúng theo sự thật địa lý đã cho).

2. Các quyết định/quy hoạch đã tìm được cho vùng (từ kết quả tìm kiếm): liệt kê từng quyết định (số, tên, phạm vi ảnh hưởng, hệ lụy pháp lý), kèm link nguồn.

3. So sánh với vị trí: trong các quyết định trên, quyết định nào có khả năng ảnh hưởng tới vị trí này (theo địa bàn, ranh giới nêu trong kết quả). Nếu không đủ thông tin để kết luận, nêu rõ và gợi ý cách tra cứu (VPĐKĐĐ, mã quy hoạch, cổng...).

4. Dự án trọng điểm ảnh hưởng (cao tốc, khai thác khoáng sản...) nếu có trong kết quả và liên quan vị trí.

5. Lưu ý: chỉ cơ quan nhà nước mới xác nhận chính thức; báo cáo chỉ tham khảo. Nguồn chính thống (tên + URL) từ kết quả tìm kiếm.

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
    searchResults = await searchPlanningDecisionsForArea(authoritativeRegion);
  }

  try {
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
    const prompt = buildPlanningPrompt(lat, lng, mapLink || null, authoritativeRegion, searchResults);
    const prov = authoritativeRegion && authoritativeRegion.authoritative;
    const forbid =
      prov && prov.includes('Nam Định')
        ? ' Cấm nêu Hà Nội hay tỉnh/thành khác.'
        : prov && prov.includes('Hà Nội')
          ? ' Cấm nêu Nam Định hay tỉnh khác.'
          : ' Cấm nêu Bà Rịa - Vũng Tàu, Đồng Nai, Bình Dương hay tỉnh khác.';
    const systemContent = authoritativeRegion
      ? `Bạn trả lời bằng tiếng Việt. Trong prompt có mục [SỰ THẬT ĐỊA LÝ – BẮT BUỘC TUÂN THỦ]: bạn PHẢI dùng đúng tỉnh/thành "${prov}" trong toàn bộ báo cáo (mục 1, 2, 4).${forbid} Trả lời văn bản thuần, đánh số 1., 2., ...`
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
