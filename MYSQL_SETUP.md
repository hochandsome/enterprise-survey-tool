# MySQL Migration Guide

## Mục tiêu

Chuyển đổi từ JSON file storage sang MySQL relational database.

## Yêu cầu

- MySQL Server 5.7+ hoặc 8.0+
- Node.js 22+

## Bước 1: Cài MySQL Server

### Windows

**Option A: MySQL Community Server (Official)**
1. Tải từ: https://dev.mysql.com/downloads/mysql/
2. Chọn version phù hợp (Windows 64-bit MSI installer)
3. Chạy installer, chọn "Server Machine" setup type
4. Cấu hình:
   - Port: 3306 (mặc định)
   - MySQL Server Instance: MySQL80 (hoặc tương tự)
   - Windows Service: Yes
5. Hệ thống sẽ prompt nhập password cho `root`
6. Hoàn tất cài đặt

**Option B: XAMPP (All-in-one)**
1. Tải từ: https://www.apachefriends.org/
2. Chạy installer (chọn Apache + MySQL)
3. Mở Control Panel, click "Start" cho MySQL
4. Username: `root`, Password: (trống)

### macOS

```bash
# Using Homebrew
brew install mysql
brew services start mysql

# Run initial setup
mysql_secure_installation
```

### Linux (Ubuntu/Debian)

```bash
sudo apt update
sudo apt install mysql-server

# Start service
sudo systemctl start mysql
sudo systemctl enable mysql
```

## Bước 2: Tạo Database & User

Mở terminal/command prompt và kết nối MySQL:

```bash
mysql -u root -p
```

Nhập password (password rỗng nếu dùng XAMPP, hoặc password bạn thiết lập).

Rồi chạy lệnh SQL sau:

```sql
CREATE DATABASE survey CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'survey'@'localhost' IDENTIFIED BY 'survey123';
GRANT ALL PRIVILEGES ON survey.* TO 'survey'@'localhost';
FLUSH PRIVILEGES;
EXIT;
```

**Kiểm tra**: Kết nối lại bằng user mới:

```bash
mysql -u survey -p survey -h localhost survey
```

Gõ password `survey123`. Nếu thành công là xong!

## Bước 3: Chỉnh sửa `.env`

Sửa file `.env` trong thư mục gốc dự án:

```env
DB_PROVIDER=json
MYSQL_HOST=localhost
MYSQL_PORT=3306
MYSQL_USER=survey
MYSQL_PASSWORD=survey123
MYSQL_DATABASE=survey
```

## Bước 4: Chạy Migration Script

Script này sẽ:
1. Đọc dữ liệu từ `survey-data.json` (JSON cũ)
2. Tạo schema tables trong MySQL
3. Insert tất cả dữ liệu vào MySQL

```bash
node migrate-to-mysql.js
```

Output mong đợi:

```
🚀 Starting MySQL migration...
Connection: survey@localhost:3306/survey
✅ Loaded JSON data
✅ Connected to MySQL
📋 Creating schema...
✅ Schema created/verified
📝 Migrating data...
  Inserting templates...
  Inserting templateQuestions...
  ...
✅ Migration completed successfully!

Next steps:
1. Update .env: DB_PROVIDER=mysql
2. Restart the app: npm start
```

## Bước 5: Chuyển sang MySQL Driver

Sửa `.env`:

```env
DB_PROVIDER=mysql
```

## Bước 6: Khởi động App

```bash
npm start
```

Mở browser:
- http://localhost:3000/admin (admin panel)
- http://localhost:3000/health (health check)

## Troubleshooting

### "MySQL connection refused"

- Kiểm tra MySQL service đang chạy:
  - Windows: Services → MySQL80 (chỉnh sửa để Auto start)
  - macOS: `brew services list` → kiểm tra MySQL status
  - Linux: `sudo systemctl status mysql`

### "Access denied for user 'survey'@'localhost'"

- Kiểm tra `MYSQL_USER` và `MYSQL_PASSWORD` trong `.env` khớp với tạo user
- Chạy lại lệnh SQL ở Bước 2

### "Database 'survey' doesn't exist"

- Kiểm tra đã chạy `CREATE DATABASE survey` chưa
- Hoặc chạy lại migration script

### Migration script gặp lỗi

- Đảm bảo MySQL running
- Kiểm tra credentials trong `.env`
- Xoá tất cả tables (nếu cần reset):
  ```sql
  DROP TABLE IF EXISTS submissionAnswers;
  DROP TABLE IF EXISTS submissions;
  DROP TABLE IF EXISTS drafts;
  DROP TABLE IF EXISTS recipients;
  DROP TABLE IF EXISTS surveyQuestions;
  DROP TABLE IF EXISTS surveys;
  DROP TABLE IF EXISTS templateQuestions;
  DROP TABLE IF EXISTS templates;
  DROP TABLE IF EXISTS companies;
  DROP TABLE IF EXISTS counters;
  ```
  Rồi chạy lại migration script

## Rollback về JSON

Nếu cần quay lại JSON:

```env
DB_PROVIDER=json
```

Data JSON cũ vẫn nằm trong `survey-data.json` (không bị xoá).

## Backup Database

### Backup MySQL

```bash
# Dump to file
mysqldump -u survey -p survey -h localhost survey > survey-backup.sql

# Nhập password: survey123
```

### Restore MySQL

```bash
mysql -u survey -p survey -h localhost survey < survey-backup.sql
```

## Tính năng và Giới hạn

### JSON Mode (hiện tại)
- ✅ Local development nhanh
- ✅ Không cần setup database
- ❌ Không scalable
- ❌ Không hỗ trợ concurrent writes tốt

### MySQL Mode (sau migration)
- ✅ Relational queries
- ✅ Scalable
- ✅ Hỗ trợ concurrent writes
- ✅ Dễ backup/restore
- ❌ Cần setup database server

