# Nguồn dữ liệu crawl – Uy tín & Cập nhật

Tất cả nguồn dưới đây được chọn vì **uy tín** và **cập nhật thường xuyên**. Mỗi lần gọi API, server crawl trực tiếp (hoặc dùng cache ngắn 2 phút) để đảm bảo dữ liệu **mới nhất**.

## Giá vàng

| Nguồn | Loại | Ghi chú |
|-------|------|--------|
| [Kim Tài Ngọc Diamond](https://kimtaingocdiamond.com/) | **Chính** | Thương hiệu vàng bạc uy tín; bảng giá vàng 9999 (Mua vào / Bán ra). |
| [bieudogiavang.net](https://bieudogiavang.net/) | Dự phòng | Tổng hợp giá vàng SJC, dùng khi Kim Tài Ngọc không trả về. |

## Giá xăng dầu

| Nguồn | Loại | Ghi chú |
|-------|------|--------|
| [PVOIL – Tin giá xăng dầu](https://www.pvoil.com.vn/tin-gia-xang-dau) | **Chính thống** | Trang chính thức PV OIL; bảng giá RON 95-III và Dầu DO. |

## Lãi suất

| Nguồn | Loại | Ghi chú |
|-------|------|--------|
| [Ngân hàng Nhà nước (SBV)](https://sbv.gov.vn/) | **Chính thống** | Thông cáo điều chỉnh lãi suất (tái cấp vốn, qua đêm). |
| [Federal Reserve H.15](https://www.federalreserve.gov/releases/h15/default.htm) | **Chính thống** | Lãi suất Fed Funds (Effective) – Cục Dự trữ Liên bang Mỹ. |
| [Webgia.com](https://webgia.com/lai-suat/) | Tổng hợp uy tín | Lãi suất tiết kiệm theo ngân hàng (VCB, MB, VPBank); cập nhật thường xuyên. |
| [Tima.vn](https://tima.vn/tin-tuc/lai-suat-vay-ngan-hang-2727.html) | Tổng hợp uy tín | Bảng lãi suất vay tín chấp / thế chấp các ngân hàng; bài viết cập nhật theo tháng. |

## Cơ chế cập nhật

- **Cache server**: 2 phút cho dữ liệu giá + lãi suất. Sau 2 phút hoặc khi bấm **Làm mới**, server crawl lại từ các nguồn trên.
- **Request crawl**: Mỗi request HTTP tới nguồn gửi kèm `Cache-Control: no-cache` để hạn chế proxy/CDN trả dữ liệu cũ.
- **API response**: `Cache-Control: no-store` cho `/api/prices` và `/api/prices/current` để trình duyệt không cache lâu.
