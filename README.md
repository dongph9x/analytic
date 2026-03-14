## Dashboard phân tích giá vàng & giá xăng dầu (Việt Nam)

Ứng dụng web hiển thị **bảng giá** tham khảo:

- **Vàng nhẫn trơn 9999** (triệu VND/lượng) – cột Mua vào / Bán ra
- **Xăng RON 95** (nghìn VND/lít)
- **Dầu DO** (nghìn VND/lít)

Kèm biến động so với ngày trước và thời điểm cập nhật.

### Cơ chế hoạt động

1. **Khi có `OPENAI_API_KEY`** (ưu tiên):
   - Server gọi **ChatGPT** để tổng hợp dữ liệu 30 ngày (labels dạng DD/MM).
   - **Giá vàng hiện tại**: crawl từ [Kim Tài Ngọc Diamond](https://kimtaingocdiamond.com/) – bảng trong `div.gold-card-content`, lấy dòng vàng 9999 (VND/chỉ → quy đổi triệu VND/lượng). Luôn ghi đè số liệu từ ChatGPT bằng số crawl được.
   - **Giá xăng dầu hiện tại**: crawl từ [PVOIL – Tin giá xăng dầu](https://www.pvoil.com.vn/tin-gia-xang-dau), parse bảng chính thống; giá RON 95 và Dầu DO được ghi đè từ bảng này.
   - Dữ liệu trả về: 30 ngày gần nhất (kết thúc hôm nay), giá hiện tại dùng cho bảng và cho điểm cuối chuỗi.

2. **Khi không có API key hoặc ChatGPT lỗi** (fallback):
   - **Vàng**: crawl từ bieudogiavang.net và các nguồn dự phòng trong `crawlers/goldCrawler.js`.
   - **Xăng dầu**: crawl từ `crawlers/fuelCrawler.js`.

3. **Cache**: Dữ liệu cache **2 phút** để luôn ưu tiên cập nhật mới nhất; format hợp lệ là 30 nhãn DD/MM và mảng giá 30 phần tử. Gọi `/api/prices?refresh=1` hoặc bấm **Làm mới** để bỏ cache và crawl lại từ nguồn uy tín (xem `SOURCES.md`).

### Trang web

- **Bảng giá** (`/`, `index.html`): Bảng giá vàng, xăng RON 95, dầu; biến động và nút Làm mới.
- **Tin tức** (`/news.html`): Tổng hợp tin tức toàn cầu ảnh hưởng tới giá vàng, xăng, dầu (từ ChatGPT, cache 1 giờ).
- **Nhận định** (`/outlook.html`): Nhận định xu hướng ngắn hạn (1–3 tháng) và dài hạn (6–12 tháng) cho vàng và xăng/dầu (từ ChatGPT, cache 1 giờ).

### Tính năng

- ✅ **Bảng giá**: Hiển thị Mua vào / Bán ra (vàng), đơn vị, % biến động so với ngày trước.
- ✅ **Tin tức & Nhận định**: Trang tin tức và trang nhận định dùng ChatGPT khi có `OPENAI_API_KEY`; API `/api/news`, `/api/outlook` (hỗ trợ `?refresh=1`).
- ✅ **Tổng hợp bằng ChatGPT (tùy chọn)**: Cấu hình `OPENAI_API_KEY` để dùng ChatGPT; giá hiện tại vẫn lấy từ nguồn chính thống (Kim Tài Ngọc, PVOIL).
- ✅ **Crawl nguồn chính thống**:
  - Vàng: [Kim Tài Ngọc Diamond](https://kimtaingocdiamond.com/) – bảng trong `.gold-card-content`.
  - Xăng dầu: [PVOIL](https://www.pvoil.com.vn/tin-gia-xang-dau) – bảng giá chính thức.
- ✅ **Fallback crawl** khi không dùng ChatGPT hoặc ChatGPT lỗi: `goldCrawler`, `fuelCrawler`.
- ✅ **Cache 2 phút** (giá & lãi suất) / **1 giờ** (tin tức, nhận định); nút **Làm mới** (`?refresh=1`) để fetch lại; crawl từ **nguồn uy tín** (SBV, FED, PVOIL, Webgia, Tima – chi tiết trong `SOURCES.md`).

### Chạy trực tiếp (không Docker)

```bash
cd /Users/apple/Documents/analytic_chart
npm install
npm start
```

**Dùng ChatGPT** (giá hiện tại vẫn từ Kim Tài Ngọc + PVOIL):

```bash
export OPENAI_API_KEY="sk-..."
npm start
```

Mở trình duyệt: `http://localhost:3004`

### Build & chạy bằng Docker Compose

```bash
cd /Users/apple/Documents/analytic_chart
docker compose build
docker compose up -d
```

Truy cập: `http://localhost:3004`

### Cấu trúc dự án

| Thành phần | Mô tả |
|------------|--------|
| `server.js` | API `GET /api/prices` (optional `?refresh=1`), cache 2 phút, ưu tiên ChatGPT rồi fallback crawl. |
| `services/chatgptService.js` | Gọi OpenAI, gắn dữ liệu PVOIL + Kim Tài Ngọc vào prompt, ghi đè giá hiện tại sau khi parse. |
| `services/pvoilFuel.js` | Crawl bảng giá xăng dầu từ PVOIL, trả về RON 95 và Dầu DO (nghìn VND/lít). |
| `services/kimTaiNgocGold.js` | Crawl bảng giá vàng từ div `.gold-card-content` tại Kim Tài Ngọc, lấy vàng 9999 (triệu VND/lượng). |
| `crawlers/goldCrawler.js` | Fallback crawl giá vàng (bieudogiavang.net, …). |
| `crawlers/fuelCrawler.js` | Fallback crawl giá xăng dầu. |
| `services/contentService.js` | Tạo nội dung tin tức (`/api/news`) và nhận định (`/api/outlook`) bằng ChatGPT; cache 1 giờ. |
| `public/` | Giao diện: Bảng giá (`index.html`), Tin tức (`news.html`), Nhận định (`outlook.html`); nav chung. |

### Tùy chỉnh

- **Thời gian cache**: Sửa `cache.ttl` trong `server.js` (mặc định 2 phút). Nguồn crawl và chính sách cập nhật: xem `SOURCES.md`.
- **Thêm nguồn crawl**: Mở rộng `services/kimTaiNgocGold.js`, `services/pvoilFuel.js` hoặc các crawler trong `crawlers/`.

### Lưu ý

- Crawler có cơ chế fallback; nếu không lấy được từ nguồn chính sẽ thử nguồn dự phòng hoặc dữ liệu mẫu.
- Cần file `.env` (hoặc biến môi trường) với `OPENAI_API_KEY` nếu muốn dùng ChatGPT; không bắt buộc để chạy (sẽ dùng crawl).
