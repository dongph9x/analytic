# Tích hợp n8n

n8n cho phép tự động hóa workflow (lên lịch làm mới tin, gửi thông báo, gọi API…). Dự án hỗ trợ chạy n8n cùng Docker và webhook để n8n gọi ngược lại app.

**Luồng dữ liệu:** Chỉ **n8n** (webhook theo lịch) cập nhật dữ liệu. **Web** chỉ đọc dữ liệu đã có (file/cache), không gọi crawl hay ChatGPT khi người dùng mở trang. Tin tức → `data/news.json`, Tổng hợp → `data/summary.json`, Nhận định → `data/outlook.json`, Giá → `data/prices.json` (và cache). Cập nhật theo lịch trong n8n (vd mỗi 10 phút gọi POST `/api/webhook/trigger/all`).

## 1. Chạy n8n cùng app (Docker Compose)

Trong thư mục dự án:

```bash
docker compose up -d
```

- **App:** http://localhost:3004  
- **n8n:** http://localhost:5678  

Trong mạng Docker, app có hostname `analytic-chart`, n8n gọi app qua URL: `http://analytic-chart:3004`.

**Nếu mở http://localhost:5678 không thấy gì:**
1. **Docker đã chạy chưa?** Mở Docker Desktop (Mac/Windows) hoặc start docker daemon.
2. **Đã start container chưa?** Chạy `docker compose up -d` trong thư mục dự án.
3. **n8n đã chạy chưa?** Kiểm tra: `docker compose ps` — container `n8n_analytic` phải ở trạng thái `Up`. Xem log: `docker compose logs n8n` (vài giây sau khi start mới có thể truy cập được).
4. **Port 5678 có bị trùng không?** Thử đổi trong `docker-compose.yml` thành `"5679:5678"` rồi truy cập http://localhost:5679.

### Biến môi trường (tùy chọn)

Thêm vào `.env` nếu cần:

| Biến | Mô tả |
|------|--------|
| `N8N_BASIC_AUTH_ACTIVE` | `true` để bật đăng nhập n8n |
| `N8N_BASIC_AUTH_USER` | Tên đăng nhập n8n |
| `N8N_BASIC_AUTH_PASSWORD` | Mật khẩu n8n |
| `N8N_WEBHOOK_SECRET` | Secret để gọi webhook trigger của app (xem mục 2) |

## 2. Webhook: n8n gọi app để chạy job

App có endpoint **POST** `/api/webhook/trigger` để n8n (hoặc cron, script) kích hoạt job mà không cần đăng nhập trình duyệt.

### Xác thực

- Nếu đặt `N8N_WEBHOOK_SECRET` trong `.env`, mỗi request phải gửi đúng secret:
  - **Header:** `X-Webhook-Secret: <secret>`
  - hoặc **Body JSON:** `{ "secret": "<secret>", "job": "news" }`
- Nếu không đặt `N8N_WEBHOOK_SECRET`, có thể gọi không cần secret (chỉ nên dùng trong môi trường nội bộ).

### Tham số job

- **Cách 1 – URL riêng (khuyến nghị trong n8n):** Mỗi chức năng một URL, không cần body.
  - **Tin tức:** `POST /api/webhook/trigger/news`
  - **Tổng hợp:** `POST /api/webhook/trigger/summary`
  - **Nhận định:** `POST /api/webhook/trigger/outlook`
  - **Giá (làm mới cache):** `POST /api/webhook/trigger/prices`
  - **Chạy tất cả:** `POST /api/webhook/trigger/all`
- **Cách 2 – Một URL + body:** `POST /api/webhook/trigger` với body `{ "job": "news" | "summary" | "outlook" | "prices" | "all" }` hoặc query `?job=news`.

Ý nghĩa từng job:
- `news` – chạy job tin tức (ChatGPT + ghi file), làm mới `/api/news`
- `summary` – chạy job tổng hợp (ChatGPT + ghi file), làm mới `/api/summary`
- `outlook` – chạy job nhận định (ChatGPT + ghi file), làm mới `/api/outlook`
- `prices` – làm mới cache giá (crawl + ChatGPT nếu có)
- `all` – chạy cả news, summary, outlook và prices

### Ví dụ trong n8n

1. Thêm node **Schedule Trigger** (ví dụ mỗi 10 phút).
2. Thêm node **HTTP Request** (dùng URL riêng cho từng job, không cần body):
   - **Method:** POST
   - **URL (chọn một):**
     - Tin tức: `http://analytic-chart:3004/api/webhook/trigger/news`
     - Tổng hợp: `http://analytic-chart:3004/api/webhook/trigger/summary`
     - Nhận định: `http://analytic-chart:3004/api/webhook/trigger/outlook`
     - Giá: `http://analytic-chart:3004/api/webhook/trigger/prices`
     - Tất cả: `http://analytic-chart:3004/api/webhook/trigger/all`
     (Nếu n8n trong Docker, app trên máy: thay `analytic-chart` bằng `host.docker.internal`. Ngoài Docker: dùng `localhost`.)
   - **Header (nếu có N8N_WEBHOOK_SECRET):** `X-Webhook-Secret` = giá trị secret. Không cần body.
3. Server trả **202** ngay, job chạy nền. Response: `{ "ok": true, "job": "news", "message": "Đã đưa job vào hàng đợi, đang chạy nền" }`.

**Lỗi "Problem in node 'HTTP Request'" / "Not found":**
- Webhook **chỉ nhận POST**, không nhận GET. Mở URL bằng trình duyệt (GET) sẽ thấy 405 hoặc 404.
- **Kiểm tra kết nối trước:** Gọi **GET** `http://analytic-chart:3004/api/health` (hoặc host.docker.internal / IP máy). Nếu trả `{ "ok": true, "service": "analytic-chart" }` thì app đang chạy và đúng host/port; sau đó gọi **POST** `/api/webhook/trigger`.
- Nếu GET /api/health cũng not found: app chưa chạy, sai port, hoặc sai host. Trong Docker: cả hai container phải cùng network; từ n8n ra app trên máy (Mac/Windows) dùng `http://host.docker.internal:3004`, Linux dùng IP máy (vd `192.168.1.100`).
- Sau khi sửa code, nhớ **build lại image và restart:** `docker compose build analytic-chart && docker compose up -d analytic-chart`.

### Kiểm tra kết nối (trước khi gọi webhook)

Dùng **GET** để xem app có nhận request không:

```bash
curl -s http://localhost:3004/api/health
# Kỳ vọng: {"ok":true,"service":"analytic-chart","time":"..."}
```

Nếu GET /api/health cũng "not found" → app chưa chạy đúng port hoặc cần rebuild image.

### Ví dụ cURL (POST webhook)

```bash
# Chạy job tin tức (bỏ -H X-Webhook-Secret nếu không set N8N_WEBHOOK_SECRET)
curl -X POST http://localhost:3004/api/webhook/trigger \
  -H "Content-Type: application/json" \
  -H "X-Webhook-Secret: YOUR_SECRET" \
  -d '{"job":"news"}'

# Chạy tất cả job
curl -X POST "http://localhost:3004/api/webhook/trigger?job=all" \
  -H "X-Webhook-Secret: YOUR_SECRET"
```

## 3. n8n gọi API app (đọc dữ liệu)

Các API sau yêu cầu đăng nhập (session) hoặc mật khẩu (API_AUTH_PASSWORD), nên từ n8n thường dùng webhook trigger (mục 2) để “đẩy” job chạy, thay vì gọi GET từ n8n để đọc tin/giá. Nếu vẫn muốn n8n đọc dữ liệu:

- Đăng nhập trước: **POST** `/api/auth` với `{ "password": "..." }`, lấy cookie session.
- Sau đó **GET** `/api/news`, `/api/summary`, `/api/prices` với cookie đó.

Hoặc dùng **HTTP Request** trong n8n với Basic Auth / custom header nếu bạn cấu hình server hỗ trợ.

## 4. App gọi n8n (webhook từ app)

Hiện app chưa có cấu hình “gửi webhook tới n8n”. Nếu muốn khi có tin mới hoặc giá mới app gọi n8n:

1. Trong n8n tạo workflow có **Webhook** node (Trigger), lấy URL (vd: `http://n8n:5678/webhook/xxx`).
2. Thêm vào `.env` biến ví dụ: `N8N_WEBHOOK_URL=http://n8n:5678/webhook/xxx`
3. Trong code app, sau khi chạy job (vd: `runNewsJob()`), gọi `axios.post(process.env.N8N_WEBHOOK_URL, { event: 'news_updated' })`.

Phần này có thể bổ sung sau nếu bạn cần.
