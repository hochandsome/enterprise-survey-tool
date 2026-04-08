# Enterprise Survey Tool (MVP)

## Chức năng có sẵn

- Tạo template câu hỏi khảo sát (multiple choice, short text, scale 1-5)
- Tạo cuộc khảo sát cho doanh nghiệp từ template và chỉnh sửa không ảnh hưởng template gốc
- Import list email nhân sự
- Gửi khảo sát qua email (hoặc log ra console nếu chưa cấu hình SMTP)
- Nhân sự làm khảo sát trên giao diện mobile-first có thanh tiến độ
- Tự động lưu nháp và mở lại đúng câu đang làm dở
- Submit ẩn danh: báo cáo chỉ tổng hợp, không hiển thị câu trả lời theo danh tính
- Dashboard realtime: tổng gửi, đã làm, đang làm dở, điểm trung bình câu scale
- Auto reminder lần 1 sau 3 ngày cho người chưa hoàn thành
- Kiểm tra trạng thái hạ tầng ngay trên Admin UI: DB provider + SMTP verify
- Hỗ trợ 2 chế độ lưu trữ: `json` (local nhanh) và `postgres` (production)

## Cài đặt

```bash
npm.cmd install
Copy-Item .env.example .env -Force
npm.cmd start
```

Mở:

- Admin: http://localhost:3000/admin
- Health: http://localhost:3000/health

## Cấu hình môi trường

- `DB_PROVIDER=json|postgres` (mặc định `json`)
- `DATABASE_URL=postgresql://...` (bắt buộc khi dùng postgres)
- `REMINDER_AFTER_DAYS=3`
- SMTP:
- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`
- `SMTP_TEST_TO` (optional)

## SMTP gửi mail thật

1. Điền SMTP vào `.env`.
2. Vào trang admin và dùng ô `Email test SMTP` để bấm gửi test.
3. Nếu SMTP chưa đúng, mục `System Status` sẽ hiện lỗi verify.

## PostgreSQL mode (production)

1. Sửa `.env`:
	- `DB_PROVIDER=postgres`
	- `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/survey`
2. Chạy app như bình thường, server sẽ tự tạo bảng `app_state`.

## Docker local full stack

```bash
docker compose up --build
```

- App: http://localhost:3000
- Postgres: localhost:5432

## Render deployment

- Repo có sẵn `render.yaml`.
- Trên Render cần set secret env vars:
- `DATABASE_URL`, `BASE_URL`, SMTP credentials.

## Ghi chú ẩn danh

- Dữ liệu trả lời lưu trong `survey-data.json` ở các collection `submissions` và `submissionAnswers`, không chứa email.
- Trạng thái hoàn thành theo email chỉ phục vụ vận hành gửi và nhắc khảo sát.
- Dashboard báo cáo điểm chỉ là dữ liệu tổng hợp.
