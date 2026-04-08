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

- `DB_PROVIDER=json|postgres|mysql` (mặc định `json`)
- `DATABASE_URL=postgresql://...` (bắt buộc khi dùng postgres)

### MySQL mode (local development / production)

1. **Cài MySQL Server**:
   - **Windows**: Tải từ [mysql.com](https://dev.mysql.com/downloads/mysql/) hoặc dùng [XAMPP](https://www.apachefriends.org/)
   - **macOS**: `brew install mysql` rồi `brew services start mysql`
   - **Linux**: `sudo apt install mysql-server` hoặc `sudo yum install mysql-server`

2. **Tạo database**:
   ```sql
   CREATE DATABASE survey;
   CREATE USER 'survey'@'localhost' IDENTIFIED BY 'survey123';
   GRANT ALL PRIVILEGES ON survey.* TO 'survey'@'localhost';
   FLUSH PRIVILEGES;
   ```

3. **Cập nhật `.env`**:
   ```
   DB_PROVIDER=mysql
   MYSQL_HOST=localhost
   MYSQL_PORT=3306
   MYSQL_USER=survey
   MYSQL_PASSWORD=survey123
   MYSQL_DATABASE=survey
   ```

4. **Chạy migration** (chuyển dữ liệu từ JSON cũ sang MySQL):
   ```bash
   node migrate-to-mysql.js
   ```

5. **Khởi động app**:
   ```bash
   npm start
   ```

### PostgreSQL mode (production)

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
