const Database = require('better-sqlite3');
const path     = require('path');
const bcrypt   = require('bcryptjs');

const DB_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, 'viai.db')
  : path.join(__dirname, 'viai.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS admin_users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    username      TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    totp_secret   TEXT DEFAULT NULL,
    totp_enabled  INTEGER DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    description TEXT,
    icon        TEXT DEFAULT '🤖',
    icon_color  TEXT DEFAULT 'blue',
    badge       TEXT,
    badge_type  TEXT,
    category    TEXT DEFAULT 'all',
    users_count INTEGER DEFAULT 0,
    link        TEXT DEFAULT '#',
    active      INTEGER DEFAULT 1,
    order_index INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS news_posts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    excerpt      TEXT,
    image_url    TEXT,
    source_name  TEXT,
    source_tag   TEXT,
    source_url   TEXT,
    published_at TEXT DEFAULT (date('now')),
    active       INTEGER DEFAULT 1,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS why_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    icon        TEXT DEFAULT '⭐',
    icon_color  TEXT DEFAULT 'blue',
    title       TEXT NOT NULL,
    description TEXT,
    order_index INTEGER DEFAULT 0,
    active      INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS how_steps (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    step_number  INTEGER NOT NULL,
    title        TEXT NOT NULL,
    short_desc   TEXT,
    panel_title  TEXT,
    panel_desc   TEXT,
    features     TEXT DEFAULT '[]',
    mockup_bars  TEXT DEFAULT '[]',
    order_index  INTEGER DEFAULT 0,
    active       INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS tech_items (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    image_url   TEXT,
    title       TEXT NOT NULL,
    description TEXT,
    is_featured INTEGER DEFAULT 0,
    order_index INTEGER DEFAULT 0,
    active      INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS gallery_images (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    image_url   TEXT NOT NULL,
    alt_text    TEXT,
    caption     TEXT,
    order_index INTEGER DEFAULT 0,
    active      INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS blog_posts (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    title        TEXT NOT NULL,
    excerpt      TEXT,
    content      TEXT,
    seo_title    TEXT,
    meta_description TEXT,
    faq_json     TEXT DEFAULT '[]',
    image_alt    TEXT,
    image_url    TEXT,
    category     TEXT DEFAULT 'Tin tức',
    author       TEXT DEFAULT 'VIAi Team',
    slug         TEXT,
    published_at TEXT DEFAULT (date('now')),
    active       INTEGER DEFAULT 1,
    created_at   TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    email         TEXT UNIQUE,
    phone         TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    created_at    TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS customers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    phone      TEXT,
    email      TEXT,
    company    TEXT,
    message    TEXT,
    source     TEXT DEFAULT 'website',
    status     TEXT DEFAULT 'new',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// ── Site settings (homepage globals) ─────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS site_settings (
    key        TEXT PRIMARY KEY,
    value      TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed default settings nếu bảng trống
const settingsDefaults = {
  // SEO
  seo_title:       'VIAi – Phần mềm AI Agent cho doanh nghiệp Việt Nam',
  seo_description: 'VIAi cung cấp AI Agent tự động hóa bán hàng, vận hành và chăm sóc khách hàng 24/7. Triển khai trong 24 giờ, kết nối 100+ ứng dụng, không cần lập trình.',
  seo_keywords:    'AI Agent, tự động hóa doanh nghiệp, Zalo Agent, chatbot doanh nghiệp Việt Nam',
  og_title:        'VIAi – Phần mềm AI Agent cho doanh nghiệp Việt Nam',
  og_description:  'Tự động hóa toàn bộ quy trình bán hàng, vận hành và chăm sóc khách hàng bằng AI Agent. Triển khai trong 24 giờ, không cần lập trình.',
  // Hero
  hero_badge:      'AI Agent Platform • Đang hoạt động',
  hero_title:      'Tự động hóa toàn bộ quy trình bằng AI Agent thông minh',
  hero_desc:       'VIAi cung cấp các AI Agent sẵn sàng triển khai – kết nối đa nền tảng, xử lý tự động 24/7. Bạn chỉ cần quan tâm đến đầu vào và kết quả đầu ra, phần còn lại AI lo.',
  hero_cta1_text:  '🚀 Dùng thử miễn phí 14 ngày',
  hero_cta1_url:   'dung-thu.html',
  hero_cta2_text:  '▶ Xem demo thực tế',
  // Trust stats (hero bottom)
  trust1_num:   '500+',  trust1_label: 'Doanh nghiệp tin dùng',
  trust2_num:   '10x',   trust2_label: 'Tăng năng suất làm việc',
  trust3_num:   '98%',   trust3_label: 'Khách hàng hài lòng',
};
{
  const ins = db.prepare("INSERT OR IGNORE INTO site_settings (key, value) VALUES (?, ?)");
  Object.entries(settingsDefaults).forEach(([k, v]) => ins.run(k, v));
}

// Migration: thêm cột 2FA nếu chưa có
try { db.exec("ALTER TABLE admin_users ADD COLUMN totp_secret TEXT DEFAULT NULL"); } catch {}
try { db.exec("ALTER TABLE admin_users ADD COLUMN totp_enabled INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE blog_posts ADD COLUMN content TEXT"); } catch {}
try { db.exec("ALTER TABLE blog_posts ADD COLUMN seo_title TEXT"); } catch {}
try { db.exec("ALTER TABLE blog_posts ADD COLUMN meta_description TEXT"); } catch {}
try { db.exec("ALTER TABLE blog_posts ADD COLUMN faq_json TEXT DEFAULT '[]'"); } catch {}
try { db.exec("ALTER TABLE blog_posts ADD COLUMN image_alt TEXT"); } catch {}

// Migration: fix encoding cho tech_items, why_items, how_steps
try {
  // Fix tech items
  db.prepare("UPDATE tech_items SET title='AI Agent Engine', description='Bộ máy xử lý ngôn ngữ tự nhiên thế hệ mới, hiểu tiếng Việt chuyên sâu và phản hồi chính xác theo từng ngữ cảnh kinh doanh.' WHERE id=1").run();
  db.prepare("UPDATE tech_items SET title='Tích hợp đa nền tảng', description='Kết nối liền mạch với Zalo, Facebook, Website, CRM, ERP và hơn 50 ứng dụng phổ biến chỉ trong vài phút.' WHERE id=2").run();
  db.prepare("UPDATE tech_items SET title='Bảo mật doanh nghiệp', description='Mã hóa đầu cuối, lưu trữ dữ liệu tại Việt Nam, tuân thủ tiêu chuẩn ISO 27001 và các quy định bảo mật quốc tế.' WHERE id=3").run();
} catch {}

try {
  // Fix why_items
  db.prepare("UPDATE why_items SET icon='⚡', title='Triển khai trong vòng 24 giờ', description='Từ lúc ký hợp đồng đến khi Agent chạy thực tế chỉ mất một ngày làm việc. Đội ngũ VIAi hỗ trợ toàn bộ quá trình cài đặt.' WHERE order_index=1").run();
  db.prepare("UPDATE why_items SET icon='🔗', title='Kết nối hơn 100+ ứng dụng', description='Zalo, Facebook, Google Sheets, Shopee, MISA, Base.vn, WordPress và hàng trăm ứng dụng khác – không cần viết code.' WHERE order_index=2").run();
  db.prepare("UPDATE why_items SET icon='🛡️', title='Bảo mật dữ liệu tuyệt đối', description='Dữ liệu lưu trữ tại máy chủ Việt Nam, mã hóa end-to-end, tuân thủ quy định PDPA và các tiêu chuẩn bảo mật quốc tế.' WHERE order_index=3").run();
  db.prepare("UPDATE why_items SET icon='📞', title='Hỗ trợ 1-1 bởi chuyên gia AI', description='Không phải chatbot – là chuyên gia thực sự hỗ trợ qua Zalo và hotline. Cam kết phản hồi trong vòng 30 phút giờ hành chính.' WHERE order_index=4").run();
  db.prepare("UPDATE why_items SET icon='🔄', title='Tự học và cải thiện theo thời gian', description='Agent sử dụng dữ liệu thực tế của doanh nghiệp để liên tục tối ưu phản hồi và quy trình xử lý, không cần can thiệp thủ công.' WHERE order_index=5").run();
  db.prepare("UPDATE why_items SET icon='💰', title='Cam kết hoàn tiền 7 ngày', description='Nếu sau 7 ngày sử dụng bạn không hài lòng, VIAi cam kết hoàn tiền 100% không cần giải thích. Rủi ro bằng không.' WHERE order_index=6").run();
} catch {}

try {
  // Fix how_steps
  db.prepare("UPDATE how_steps SET title='Chọn AI Agent phù hợp', short_desc='Thư viện Agent đa dạng theo từng nghiệp vụ', panel_title='Chọn AI Agent phù hợp với bạn', panel_desc='Từ thư viện hơn 10 AI Agent chuyên biệt, bạn chọn Agent phù hợp với nghiệp vụ — hoặc để đội ngũ VIAi tư vấn miễn phí Agent tối ưu nhất cho doanh nghiệp bạn.' WHERE step_number=1").run();
  db.prepare("UPDATE how_steps SET title='Kết nối hệ thống hiện tại', short_desc='Tích hợp 100+ ứng dụng không cần code', panel_title='Kết nối với hệ thống bạn đang dùng', panel_desc='VIAi tích hợp với hầu hết các công cụ phổ biến tại Việt Nam — không cần viết một dòng code, không cần thay đổi quy trình cũ. Đội ngũ hỗ trợ cài đặt toàn bộ.' WHERE step_number=2").run();
  db.prepare("UPDATE how_steps SET title='Agent tự động chạy 24/7', short_desc='Xử lý công việc liên tục, không nghỉ', panel_title='AI Agent tự động xử lý mọi thứ 24/7', panel_desc='Sau khi thiết lập, Agent hoạt động liên tục không cần giám sát. Tự phân tích đầu vào, xử lý theo quy trình và tạo ra đầu ra chính xác — ngay cả lúc 2 giờ sáng.' WHERE step_number=3").run();
  db.prepare("UPDATE how_steps SET title='Theo dõi & tối ưu kết quả', short_desc='Dashboard và báo cáo tự động mỗi sáng', panel_title='Theo dõi hiệu suất & tối ưu liên tục', panel_desc='Dashboard trực quan cho thấy toàn bộ hoạt động của Agent theo thời gian thực. Báo cáo tự động gửi lúc 8 giờ sáng, kèm gợi ý tối ưu từ AI để bạn luôn đi trước.' WHERE step_number=4").run();
} catch {}

try {
  // Fix blog SEO titles và meta descriptions
  db.prepare("UPDATE blog_posts SET seo_title='5 cách AI Agent giúp SME tiết kiệm 4 giờ mỗi ngày', meta_description='Khám phá 5 cách AI Agent giúp doanh nghiệp SME Việt Nam tiết kiệm 4 giờ làm việc mỗi ngày — từ trả lời Zalo, xử lý đơn hàng đến gửi báo cáo tự động.' WHERE slug='5-cach-ai-agent-giup-doanh-nghiep-sme-tiet-kiem-4-gio-moi-ngay'").run();
  db.prepare("UPDATE blog_posts SET seo_title='Zalo OA + AI Agent: Chăm sóc khách 24/7 tự động', meta_description='Tích hợp AI Agent vào Zalo OA giúp phản hồi khách trong 3 giây, tự động chốt đơn 24/7 và tăng tỷ lệ chuyển đổi lên 40% mà không cần nhân viên trực.' WHERE slug='zalo-oa-ai-agent-cong-thuc-cham-soc-khach-hang-24-7-khong-can-nhan-vien-truc'").run();
  db.prepare("UPDATE blog_posts SET seo_title='VIAi Report Agent: Báo cáo tự động lúc 8 giờ sáng', meta_description='VIAi ra mắt Report Agent: tự động tổng hợp dữ liệu từ 20+ nguồn, tạo báo cáo doanh thu và gửi qua Zalo lúc 8 giờ sáng mỗi ngày — không cần nhập tay.' WHERE slug='viai-ra-mat-tinh-nang-report-agent-bao-cao-tu-dong-gui-luc-8-gio-sang-moi-ngay'").run();
  db.prepare("UPDATE blog_posts SET seo_title='Xu hướng AI Agent thay đổi thị trường Việt 2026', meta_description='Từ chatbot đơn giản đến AI Agent đa bước — thị trường Việt Nam 2026 đang chứng kiến làn sóng tự động hóa mạnh mẽ. Khám phá 4 xu hướng AI Agent nổi bật.' WHERE slug='chuyen-doi-so-2026-xu-huong-ai-agent-nao-dang-thay-doi-thi-truong-viet-nam'").run();
} catch {}

// Migration: bổ sung content cho các bài blog seed chưa có nội dung
try {
  const blogContents = {
    '5-cach-ai-agent-giup-doanh-nghiep-sme-tiet-kiem-4-gio-moi-ngay': `## Doanh nghiệp SME đang mất bao nhiêu thời gian cho việc lặp lại?

Theo khảo sát từ hơn 200 doanh nghiệp vừa và nhỏ tại Việt Nam, trung bình mỗi nhân viên mất 4–5 giờ mỗi ngày cho các công việc lặp lại: trả lời tin nhắn Zalo, xác nhận đơn hàng, gửi báo cáo thủ công, nhắc lịch chăm sóc khách hàng. Đây là những việc AI Agent có thể làm thay hoàn toàn.

## 5 cách AI Agent giúp tiết kiệm 4 giờ mỗi ngày

### 1. Tự động trả lời tin nhắn Zalo & Facebook 24/7

AI Agent phân tích nội dung tin nhắn và trả lời trong vòng 3 giây — kể cả lúc 2 giờ sáng. Doanh nghiệp không bỏ lỡ khách hàng nào, dù ngoài giờ làm việc.

### 2. Xử lý và xác nhận đơn hàng tự động

Khi khách đặt hàng qua Zalo, Website hoặc sàn TMĐT, AI Agent tự động tạo đơn, kiểm tra tồn kho, gửi xác nhận cho khách và thông báo cho bộ phận kho.

### 3. Gửi báo cáo doanh thu lúc 8 giờ sáng mỗi ngày

AI Agent thu thập dữ liệu từ các kênh bán hàng, tự tạo báo cáo và gửi thẳng vào Zalo của chủ doanh nghiệp. Mọi thứ sẵn sàng trước khi bắt đầu ngày làm việc.

### 4. Nhắc lịch chăm sóc khách hàng tự động

AI Agent theo dõi lịch sử mua hàng và tự động gửi tin nhắn nhắc nhở, ưu đãi tái mua vào đúng thời điểm khách hàng có xu hướng mua lại.

### 5. Phân loại và chuyển tiếp yêu cầu hỗ trợ

Khi khách có vấn đề phức tạp, AI Agent tự phân loại theo mức độ ưu tiên và chuyển cho nhân viên phù hợp, kèm toàn bộ lịch sử hội thoại.

## Bắt đầu từ đâu?

Không cần triển khai toàn bộ cùng lúc. Hầu hết doanh nghiệp bắt đầu từ một tác vụ cụ thể — thường là trả lời tin nhắn Zalo hoặc xử lý đơn hàng — và mở rộng dần sau khi thấy hiệu quả rõ ràng. VIAi hỗ trợ triển khai trong 24 giờ, không cần kiến thức kỹ thuật. [Đăng ký dùng thử miễn phí](/dung-thu.html) để bắt đầu ngay hôm nay.`,

    'zalo-oa-ai-agent-cong-thuc-cham-soc-khach-hang-24-7-khong-can-nhan-vien-truc': `## Tại sao Zalo OA là kênh bán hàng quan trọng nhất của SME Việt?

Với hơn 75 triệu người dùng tại Việt Nam, Zalo là nơi khách hàng nhắn tin, hỏi giá và đặt hàng hằng ngày. Thế nhưng đa số doanh nghiệp vẫn xử lý tin nhắn Zalo thủ công — dẫn đến phản hồi chậm, bỏ lỡ khách và kiệt sức nhân viên.

## AI Agent làm gì trên Zalo OA?

### Phản hồi tức thì mọi lúc

AI Agent phân tích nội dung tin nhắn và trả lời trong vòng 3 giây — bất kể ngày hay đêm, kể cả cuối tuần và ngày lễ.

### Tư vấn sản phẩm thông minh

Dựa trên thông tin khách cung cấp, AI Agent gợi ý sản phẩm phù hợp, gửi hình ảnh, bảng giá và thông tin ưu đãi hiện tại.

### Thu thập thông tin và tạo đơn hàng

Khi khách đồng ý mua, AI Agent thu thập địa chỉ giao hàng, xác nhận số lượng và tự động tạo đơn trong hệ thống.

### Chăm sóc sau bán tự động

Sau khi giao hàng, AI Agent tự động hỏi thăm trải nghiệm khách hàng, xử lý phản hồi và gửi ưu đãi cho lần mua tiếp theo.

## Kết quả thực tế

Các doanh nghiệp triển khai Zalo Sales Agent của VIAi ghi nhận: tỷ lệ chuyển đổi tăng 40%, thời gian phản hồi giảm từ 2 tiếng xuống còn 3 phút, chi phí nhân sự chăm sóc khách hàng giảm 35%.

[Xem chi tiết Zalo Sales Agent](/san-pham/zalo-sales-agent) hoặc [đăng ký dùng thử miễn phí](/dung-thu.html) để trải nghiệm ngay.`,

    'viai-ra-mat-tinh-nang-report-agent-bao-cao-tu-dong-gui-luc-8-gio-sang-moi-ngay': `## Vấn đề của báo cáo thủ công

Mỗi buổi sáng, nhiều chủ doanh nghiệp phải tự tổng hợp số liệu từ nhiều nguồn: đơn hàng trên Shopee, doanh thu từ Website, tồn kho trên phần mềm kho, hiệu suất nhân viên từ CRM. Công việc này mất 30–90 phút và dễ sai sót.

## Report Agent của VIAi làm gì?

### Tổng hợp dữ liệu từ 20+ nguồn

Report Agent kết nối với các kênh bán hàng, phần mềm kế toán, CRM và hệ thống kho để thu thập toàn bộ dữ liệu cần thiết — tự động, không cần nhập liệu thủ công.

### Tạo báo cáo theo mẫu doanh nghiệp

Báo cáo được thiết kế theo nhu cầu cụ thể: doanh thu theo kênh, sản phẩm bán chạy, tỷ lệ tồn kho, hiệu suất từng nhân viên kinh doanh. Định dạng rõ ràng, dễ đọc ngay trên điện thoại.

### Gửi tự động lúc 8:00 sáng mỗi ngày

Không cần nhớ, không cần làm thủ công. Đúng 8 giờ sáng, báo cáo ngày hôm trước được gửi thẳng vào Zalo cá nhân hoặc Email của chủ doanh nghiệp.

### Cảnh báo bất thường

Khi doanh thu giảm đột ngột, tồn kho xuống thấp hoặc có đơn hàng bất thường, Report Agent gửi cảnh báo ngay lập tức.

## Ai nên dùng Report Agent?

Report Agent phù hợp với doanh nghiệp có từ 3 kênh bán hàng trở lên, hoặc cần tổng hợp dữ liệu từ nhiều bộ phận. [Tìm hiểu thêm](/san-pham/report-analytics-agent) hoặc [đăng ký dùng thử](/dung-thu.html).`,

    'chuyen-doi-so-2026-xu-huong-ai-agent-nao-dang-thay-doi-thi-truong-viet-nam': `## Từ chatbot đến AI Agent: sự khác biệt là gì?

Chatbot truyền thống chỉ trả lời câu hỏi theo kịch bản có sẵn. AI Agent là bước tiến xa hơn — không chỉ trả lời mà còn hành động: tạo đơn hàng, gửi email, cập nhật CRM, tổng hợp báo cáo và phối hợp với các hệ thống khác.

## 4 xu hướng AI Agent nổi bật tại Việt Nam năm 2026

### 1. AI Agent trong bán hàng đa kênh

Doanh nghiệp không còn quản lý từng kênh riêng lẻ. AI Agent tích hợp Zalo, Facebook, Website và sàn TMĐT vào một luồng xử lý thống nhất.

### 2. Tự động hóa quy trình vận hành nội bộ

Từ xử lý đơn hàng, quản lý kho đến tổng hợp báo cáo — các quy trình lặp đi lặp lại đang được thay thế bởi AI Agent.

### 3. AI Agent cho chăm sóc khách hàng cá nhân hóa

Thay vì gửi cùng một tin nhắn cho tất cả, AI Agent phân tích hành vi mua sắm và gửi nội dung phù hợp cho từng người.

### 4. Báo cáo và phân tích thông minh

Chủ doanh nghiệp không cần chờ kế toán tổng hợp cuối tháng. AI Agent thu thập, phân tích và gửi báo cáo theo thời gian thực.

## VIAi đang giúp doanh nghiệp Việt bắt đầu thế nào?

VIAi cung cấp 6 AI Agent chuyên biệt, mỗi Agent giải quyết một nghiệp vụ cụ thể. Doanh nghiệp có thể bắt đầu từ một Agent phù hợp nhất và mở rộng dần theo nhu cầu thực tế.

[Xem danh sách AI Agent của VIAi](/san-pham.html) hoặc [đặt lịch tư vấn miễn phí](/dung-thu.html).`
  };
  const upd = db.prepare('UPDATE blog_posts SET content = ? WHERE slug = ? AND (content IS NULL OR content = \'\')');
  Object.entries(blogContents).forEach(([slug, content]) => upd.run(content, slug));
} catch {}

// Migration: xóa dấu "..." cuối title/seo_title/meta_description trong blog_posts
try {
  db.exec("UPDATE blog_posts SET title = SUBSTR(title,1,LENGTH(title)-3) WHERE title LIKE '%...'");
  db.exec("UPDATE blog_posts SET seo_title = SUBSTR(seo_title,1,LENGTH(seo_title)-3) WHERE seo_title LIKE '%...'");
  db.exec("UPDATE blog_posts SET meta_description = SUBSTR(meta_description,1,LENGTH(meta_description)-3) WHERE meta_description LIKE '%...'");
} catch {}

// Tạo admin mặc định nếu chưa có
const existing = db.prepare('SELECT id FROM admin_users WHERE username = ?').get('admin');
if (!existing) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO admin_users (username, password_hash) VALUES (?, ?)').run('admin', hash);
}

// Seed products nếu bảng trống
const prodCount = db.prepare('SELECT COUNT(*) as c FROM products').get().c;
if (prodCount === 0) {
  const ins = db.prepare(`
    INSERT INTO products (name, description, icon, icon_color, badge, badge_type, category, users_count, link, order_index)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  [
    ['Zalo Sales Agent',        'Tự động tư vấn, chốt đơn và chăm sóc khách hàng qua Zalo OA 24/7 mà không cần nhân viên trực.',                 '💬','blue',  'HOT',      'hot',  'sales',    320, '/san-pham/zalo-sales-agent',      1],
    ['Order Management Agent',  'Tiếp nhận, xử lý đơn hàng từ nhiều kênh (Shopee, Lazada, Website, Zalo) vào một hệ thống duy nhất.',             '📦','orange','PHỔ BIẾN', 'pop',  'ops',      210, '/san-pham/order-management-agent', 2],
    ['CRM Automation Agent',    'Tự động phân loại khách hàng, nhắc lịch chăm sóc, gửi ưu đãi cá nhân hóa theo hành vi mua hàng.',                '🤝','green', null,       null,   'sales',    180, '/san-pham/crm-automation-agent',   3],
    ['Report & Analytics Agent','Tổng hợp dữ liệu đa nguồn, tự động tạo và gửi báo cáo hằng ngày qua email hoặc Zalo lúc 8 giờ sáng.',           '📊','yellow','MỚI',      'new',  'analytics', 95, '/san-pham/report-analytics-agent', 4],
    ['Email Marketing Agent',   'Lên lịch, cá nhân hóa và gửi email marketing thông minh tự động theo hành vi người dùng.',                       '📧','purple','BETA',     'beta', 'marketing', 60, '/san-pham/email-marketing-agent',  5],
    ['Facebook Ads Agent',      'Tự động tối ưu ngân sách quảng cáo Facebook, báo cáo ROAS và đề xuất điều chỉnh chiến dịch.',                    '🏭','blue',  null,       null,   'marketing',140, '/san-pham/facebook-ads-agent',     6],
    ['Booking & Appointment',   'Tự động nhận lịch hẹn, xác nhận, nhắc nhở khách hàng – phù hợp spa, phòng khám, dịch vụ B2C.',                   '🗓️','orange',null,      null,   'ops',       75, '/san-pham/booking-appointment',7],
    ['Custom Enterprise Agent', 'Xây dựng AI Agent hoàn toàn tùy chỉnh theo nghiệp vụ đặc thù, tích hợp với mọi hệ thống nội bộ.',                '🏗️','green', null,       null,   'ops',        0, '/san-pham/custom-enterprise-agent',8],
  ].forEach(row => ins.run(...row));
}

// Migration: sửa icon và description bị lỗi encoding trong DB cũ
try {
  const fixes = [
    ['Zalo Sales Agent',        '💬', 'Tự động tư vấn, chốt đơn và chăm sóc khách hàng qua Zalo OA 24/7 mà không cần nhân viên trực.'],
    ['Order Management Agent',  '📦', 'Tiếp nhận, xử lý đơn hàng từ nhiều kênh (Shopee, Lazada, Website, Zalo) vào một hệ thống duy nhất.'],
    ['CRM Automation Agent',    '🤝', 'Tự động phân loại khách hàng, nhắc lịch chăm sóc, gửi ưu đãi cá nhân hóa theo hành vi mua hàng.'],
    ['Report & Analytics Agent','📊', 'Tổng hợp dữ liệu đa nguồn, tự động tạo và gửi báo cáo hằng ngày qua email hoặc Zalo lúc 8 giờ sáng.'],
    ['Email Marketing Agent',   '📧', 'Lên lịch, cá nhân hóa và gửi email marketing thông minh tự động theo hành vi người dùng.'],
    ['Facebook Ads Agent',      '🏭', 'Tự động tối ưu ngân sách quảng cáo Facebook, báo cáo ROAS và đề xuất điều chỉnh chiến dịch.'],
    ['Booking & Appointment',   '🗓️', 'Tự động nhận lịch hẹn, xác nhận, nhắc nhở khách hàng – phù hợp spa, phòng khám, dịch vụ B2C.'],
    ['Custom Enterprise Agent', '🏗️', 'Xây dựng AI Agent hoàn toàn tùy chỉnh theo nghiệp vụ đặc thù, tích hợp với mọi hệ thống nội bộ.'],
  ];
  const upd = db.prepare("UPDATE products SET icon=?, description=? WHERE name=? AND (icon LIKE '%Ä%' OR icon LIKE '%Ã%' OR LENGTH(icon) > 8)");
  fixes.forEach(([name, icon, desc]) => upd.run(icon, desc, name));
} catch {}

// Migration: cập nhật link sản phẩm → trang /san-pham/[slug]
try {
  const linkMap = {
    'Zalo Sales Agent':        '/san-pham/zalo-sales-agent',
    'Order Management Agent':  '/san-pham/order-management-agent',
    'CRM Automation Agent':    '/san-pham/crm-automation-agent',
    'Report & Analytics Agent':'/san-pham/report-analytics-agent',
    'Email Marketing Agent':   '/san-pham/email-marketing-agent',
    'Facebook Ads Agent':      '/san-pham/facebook-ads-agent',
    'Booking & Appointment':   '/san-pham/booking-appointment',
    'Custom Enterprise Agent': '/san-pham/custom-enterprise-agent',
  };
  Object.entries(linkMap).forEach(([name, link]) => {
    db.prepare("UPDATE products SET link = ? WHERE name = ?").run(link, name);
  });
} catch {}

try {
  db.prepare("UPDATE blog_posts SET content = replace(content, '/san-pham.html#zalo-sales', '/san-pham/zalo-sales-agent') WHERE content LIKE '%/san-pham.html#zalo-sales%'").run();
  db.prepare("UPDATE blog_posts SET content = replace(content, '/san-pham.html#report-analytics', '/san-pham/report-analytics-agent') WHERE content LIKE '%/san-pham.html#report-analytics%'").run();
} catch {}

// Seed news nếu bảng trống
const newsCount = db.prepare('SELECT COUNT(*) as c FROM news_posts').get().c;
if (newsCount === 0) {
  const ins = db.prepare(`
    INSERT INTO news_posts (title, excerpt, image_url, source_name, source_tag, source_url, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  [
    ['[genk.vn] AI Agent – Làn sóng tự động hóa đang thay đổi cách doanh nghiệp SME vận hành',      'Không còn là khái niệm xa xỉ, các AI Agent đang được hàng trăm doanh nghiệp vừa và nhỏ tại Việt Nam ứng dụng...', 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=600&q=80','GENK.VN',   'genk',    'https://genk.vn',    '2026-04-12'],
    ['[tienphong.vn] VIAi – Lối đi riêng cho kinh doanh online trong thời đại chuyển đổi số',       'Nền tảng AI Agent của VIAi đang xây dựng hệ thống tự động hóa đa kênh giúp doanh nghiệp tiết kiệm đến 78%...',  'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=600&q=80','TIỀN PHONG','tienpb',  'https://tienphong.vn','2026-04-08'],
    ['[24h.com.vn] Tăng doanh thu bán hàng online với AI Agent trong làn sóng chuyển đổi số',        'Chuyển đổi số đặt ra yêu cầu các doanh nghiệp phải nhanh chóng thay đổi tư duy vận hành...',                    'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=600&q=80','24H.COM.VN','h24',     'https://24h.com.vn', '2026-04-02'],
    ['[cafebiz.vn] VIAi – Công cụ AI Agent hỗ trợ bán hàng đa kênh hiệu quả cho thời đại 4.0',     'Việc sử dụng một nền tảng AI Agent hỗ trợ bán hàng online hiệu quả đang là bài toán sống còn...',                'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=600&q=80','CAFEBIZ',  'cafebiz', 'https://cafebiz.vn', '2026-03-25'],
  ].forEach(row => ins.run(...row));
}

// Seed why_items
if (db.prepare('SELECT COUNT(*) as c FROM why_items').get().c === 0) {
  const ins = db.prepare('INSERT INTO why_items (icon, icon_color, title, description, order_index) VALUES (?,?,?,?,?)');
  [
    ['⚡','blue',  'Triển khai trong vòng 24 giờ',      'Từ lúc ký hợp đồng đến khi Agent chạy thực tế chỉ mất một ngày làm việc. Đội ngũ VIAi hỗ trợ toàn bộ quá trình cài đặt.', 1],
    ['🔗','orange','Kết nối hơn 100+ ứng dụng',         'Zalo, Facebook, Google Sheets, Shopee, MISA, Base.vn, WordPress và hàng trăm ứng dụng khác – không cần viết code.', 2],
    ['🛡️','green', 'Bảo mật dữ liệu tuyệt đối',         'Dữ liệu lưu trữ tại máy chủ Việt Nam, mã hóa end-to-end, tuân thủ quy định PDPA và các tiêu chuẩn bảo mật quốc tế.', 3],
    ['📞','yellow','Hỗ trợ 1-1 bởi chuyên gia AI',      'Không phải chatbot – là chuyên gia thực sự hỗ trợ qua Zalo và hotline. Cam kết phản hồi trong vòng 30 phút giờ hành chính.', 4],
    ['🔄','blue',  'Tự học và cải thiện theo thời gian', 'Agent sử dụng dữ liệu thực tế của doanh nghiệp để liên tục tối ưu phản hồi và quy trình xử lý, không cần can thiệp thủ công.', 5],
    ['💰','orange','Cam kết hoàn tiền 7 ngày',           'Nếu sau 7 ngày sử dụng bạn không hài lòng, VIAi cam kết hoàn tiền 100% không cần giải thích. Rủi ro bằng không.', 6],
  ].forEach(r => ins.run(...r));
}

// Seed how_steps
if (db.prepare('SELECT COUNT(*) as c FROM how_steps').get().c === 0) {
  const ins = db.prepare('INSERT INTO how_steps (step_number, title, short_desc, panel_title, panel_desc, features, mockup_bars, order_index) VALUES (?,?,?,?,?,?,?,?)');
  [
    [1,'Chọn AI Agent phù hợp','Thư viện Agent đa dạng theo từng nghiệp vụ','Chọn AI Agent phù hợp với bạn',
     'Từ thư viện hơn 10 AI Agent chuyên biệt, bạn chọn Agent phù hợp với nghiệp vụ — hoặc để đội ngũ VIAi tư vấn miễn phí Agent tối ưu nhất cho doanh nghiệp bạn.',
     '["Thư viện Agent phân loại theo ngành: bán lẻ, F&B, dịch vụ, thương mại điện tử","Xem demo trực tiếp trước khi quyết định triển khai","Tư vấn 1-1 miễn phí với chuyên gia AI của VIAi"]',
     '[{"label":"Zalo Sales Agent","value":"⭐ Phù hợp nhất","color":"blue"},{"label":"Order Management Agent","value":"Phổ biến","color":"orange"},{"label":"CRM Automation Agent","value":"Gợi ý","color":"green"}]', 1],
    [2,'Kết nối hệ thống hiện tại','Tích hợp 100+ ứng dụng không cần code','Kết nối với hệ thống bạn đang dùng',
     'VIAi tích hợp với hầu hết các công cụ phổ biến tại Việt Nam — không cần viết một dòng code, không cần thay đổi quy trình cũ. Đội ngũ hỗ trợ cài đặt toàn bộ.',
     '["Kết nối Zalo OA, Facebook Messenger, Website trong vài phút","Tích hợp Google Sheets, MISA, Base.vn, Shopee, Lazada","Webhook & API mở cho hệ thống nội bộ tùy chỉnh"]',
     '[{"label":"Zalo OA","value":"✓ Đã kết nối","color":"green"},{"label":"Google Sheets","value":"✓ Đã kết nối","color":"green"},{"label":"MISA Accounting","value":"⟳ Đang đồng bộ","color":"blue"}]', 2],
    [3,'Agent tự động chạy 24/7','Xử lý công việc liên tục, không nghỉ','AI Agent tự động xử lý mọi thứ 24/7',
     'Sau khi thiết lập, Agent hoạt động liên tục không cần giám sát. Tự phân tích đầu vào, xử lý theo quy trình và tạo ra đầu ra chính xác — ngay cả lúc 2 giờ sáng.',
     '["Hoạt động 24/7, 365 ngày — không nghỉ lễ, không ốm đau","Xử lý đồng thời hàng trăm yêu cầu cùng một lúc","Tự học và cải thiện theo dữ liệu thực tế của doanh nghiệp"]',
     '[{"label":"Tin nhắn đã xử lý hôm nay","value":"128 tin","color":"green"},{"label":"Đơn hàng tự động tạo","value":"34 đơn","color":"green"},{"label":"Uptime hệ thống","value":"99.9%","color":"blue"}]', 3],
    [4,'Theo dõi & tối ưu kết quả','Dashboard và báo cáo tự động mỗi sáng','Theo dõi hiệu suất & tối ưu liên tục',
     'Dashboard trực quan cho thấy toàn bộ hoạt động của Agent theo thời gian thực. Báo cáo tự động gửi lúc 8 giờ sáng, kèm gợi ý tối ưu từ AI để bạn luôn đi trước.',
     '["Dashboard realtime — số liệu cập nhật từng phút","Báo cáo tự động gửi qua Zalo hoặc Email mỗi sáng","Gợi ý tối ưu từ AI dựa trên xu hướng dữ liệu của bạn"]',
     '[{"label":"Thời gian tiết kiệm / ngày","value":"4.2 giờ","color":"blue"},{"label":"Doanh thu tháng này","value":"+65%","color":"green"},{"label":"Chi phí vận hành","value":"-52%","color":"orange"}]', 4],
  ].forEach(r => ins.run(...r));
}

// Seed tech_items
if (db.prepare('SELECT COUNT(*) as c FROM tech_items').get().c === 0) {
  const ins = db.prepare('INSERT INTO tech_items (image_url, title, description, is_featured, order_index) VALUES (?,?,?,?,?)');
  [
    ['anhlogo/tech1.svg','AI Agent Engine','Bộ máy xử lý ngôn ngữ tự nhiên thế hệ mới, hiểu tiếng Việt chuyên sâu và phản hồi chính xác theo từng ngữ cảnh kinh doanh.',0,1],
    ['anhlogo/tech2.svg','Tích hợp đa nền tảng','Kết nối liền mạch với Zalo, Facebook, Website, CRM, ERP và hơn 50 ứng dụng phổ biến chỉ trong vài phút.',1,2],
    ['anhlogo/tech3.svg','Bảo mật doanh nghiệp','Mã hóa đầu cuối, lưu trữ dữ liệu tại Việt Nam, tuân thủ tiêu chuẩn ISO 27001 và các quy định bảo mật quốc tế.',0,3],
  ].forEach(r => ins.run(...r));
}

// Seed blog_posts
if (db.prepare('SELECT COUNT(*) as c FROM blog_posts').get().c === 0) {
  const ins = db.prepare('INSERT INTO blog_posts (title, excerpt, content, image_url, category, author, slug, published_at) VALUES (?,?,?,?,?,?,?,?)');
  [
    ['5 cách AI Agent giúp doanh nghiệp SME tiết kiệm 4 giờ mỗi ngày',
     'Thay vì thuê thêm nhân sự, hàng trăm doanh nghiệp vừa và nhỏ đang ứng dụng AI Agent để tự động hóa các tác vụ lặp đi lặp lại — từ trả lời khách hàng, xử lý đơn hàng đến gửi báo cáo sáng.',
     `## Doanh nghiệp SME đang mất bao nhiêu thời gian cho việc lặp lại?

Theo khảo sát từ hơn 200 doanh nghiệp vừa và nhỏ tại Việt Nam, trung bình mỗi nhân viên mất **4–5 giờ mỗi ngày** cho các công việc lặp lại: trả lời tin nhắn Zalo, xác nhận đơn hàng, gửi báo cáo thủ công, nhắc lịch chăm sóc khách hàng. Đây là những việc AI Agent có thể làm thay hoàn toàn.

## 5 cách AI Agent giúp tiết kiệm 4 giờ mỗi ngày

### 1. Tự động trả lời tin nhắn Zalo & Facebook 24/7

Thay vì nhân viên phải trực máy liên tục, AI Agent phân tích nội dung tin nhắn, hiểu ý định khách hàng và phản hồi chính xác trong vài giây — kể cả lúc 2 giờ sáng. Doanh nghiệp không bỏ lỡ khách hàng nào, dù ngoài giờ làm việc.

### 2. Xử lý và xác nhận đơn hàng tự động

Khi khách đặt hàng qua Zalo, Website hoặc sàn TMĐT, AI Agent tự động tạo đơn, kiểm tra tồn kho, gửi xác nhận cho khách và thông báo cho bộ phận kho — không cần nhân viên can thiệp thủ công.

### 3. Gửi báo cáo doanh thu lúc 8 giờ sáng mỗi ngày

Thay vì mất 30–60 phút tổng hợp số liệu mỗi sáng, AI Agent thu thập dữ liệu từ các kênh bán hàng, tự tạo báo cáo và gửi thẳng vào Zalo của chủ doanh nghiệp. Mọi thứ sẵn sàng trước khi bắt đầu ngày làm việc.

### 4. Nhắc lịch chăm sóc khách hàng tự động

AI Agent theo dõi lịch sử mua hàng và tự động gửi tin nhắn nhắc nhở, ưu đãi tái mua vào đúng thời điểm khách hàng có xu hướng mua lại. Tỷ lệ quay lại tăng mà không cần tốn thêm ngân sách marketing.

### 5. Phân loại và chuyển tiếp yêu cầu hỗ trợ

Khi khách có vấn đề phức tạp, AI Agent tự phân loại theo mức độ ưu tiên và chuyển cho nhân viên phù hợp, kèm toàn bộ lịch sử hội thoại. Nhân viên không cần hỏi lại từ đầu, tiết kiệm thời gian xử lý cho cả hai phía.

## Bắt đầu từ đâu?

Không cần triển khai toàn bộ cùng lúc. Hầu hết doanh nghiệp bắt đầu từ một tác vụ cụ thể — thường là trả lời tin nhắn Zalo hoặc xử lý đơn hàng — và mở rộng dần sau khi thấy hiệu quả rõ ràng.

VIAi hỗ trợ triển khai trong **24 giờ**, không cần kiến thức kỹ thuật. [Đăng ký dùng thử miễn phí](/dung-thu.html) để bắt đầu ngay hôm nay.`,
     'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=800&q=80',
     'Hướng dẫn', 'VIAi Team', '5-cach-ai-agent-giup-doanh-nghiep-sme-tiet-kiem-4-gio-moi-ngay', '2026-05-10'],

    ['Zalo OA + AI Agent: Công thức chăm sóc khách hàng 24/7 không cần nhân viên trực',
     'Tích hợp AI Agent vào Zalo Official Account giúp doanh nghiệp phản hồi tức thì mọi lúc, tăng tỷ lệ chuyển đổi lên 40% và giảm chi phí vận hành đáng kể.',
     `## Tại sao Zalo OA là kênh bán hàng quan trọng nhất của SME Việt?

Với hơn 75 triệu người dùng tại Việt Nam, Zalo là nơi khách hàng nhắn tin, hỏi giá và đặt hàng hằng ngày. Thế nhưng đa số doanh nghiệp vẫn xử lý tin nhắn Zalo thủ công — dẫn đến phản hồi chậm, bỏ lỡ khách và kiệt sức nhân viên.

## AI Agent làm gì trên Zalo OA?

### Phản hồi tức thì mọi lúc

AI Agent phân tích nội dung tin nhắn và trả lời trong vòng 3 giây — bất kể ngày hay đêm, kể cả cuối tuần và ngày lễ. Khách hàng không phải chờ đợi, tỷ lệ rời bỏ giảm đáng kể.

### Tư vấn sản phẩm thông minh

Dựa trên thông tin khách cung cấp, AI Agent gợi ý sản phẩm phù hợp, gửi hình ảnh, bảng giá và thông tin ưu đãi hiện tại — đúng như một nhân viên bán hàng thực thụ.

### Thu thập thông tin và tạo đơn hàng

Khi khách đồng ý mua, AI Agent thu thập địa chỉ giao hàng, xác nhận số lượng và tự động tạo đơn trong hệ thống — không cần nhân viên can thiệp.

### Chăm sóc sau bán tự động

Sau khi giao hàng, AI Agent tự động hỏi thăm trải nghiệm khách hàng, xử lý phản hồi và gửi ưu đãi cho lần mua tiếp theo vào đúng thời điểm.

## Kết quả thực tế từ doanh nghiệp dùng VIAi

Các doanh nghiệp triển khai Zalo Sales Agent của VIAi ghi nhận: tỷ lệ chuyển đổi tăng **40%**, thời gian phản hồi giảm từ 2 tiếng xuống còn **3 phút**, chi phí nhân sự chăm sóc khách hàng giảm **35%**.

Điều quan trọng là AI không thay thế nhân viên — mà giúp nhân viên tập trung vào những cuộc trò chuyện thực sự cần tư duy và đàm phán, thay vì lặp đi lặp lại cùng một câu trả lời.

[Xem chi tiết Zalo Sales Agent](/san-pham/zalo-sales-agent) hoặc [đăng ký dùng thử miễn phí](/dung-thu.html) để trải nghiệm ngay.`,
     'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=800&q=80',
     'Kiến thức AI', 'VIAi Team', 'zalo-oa-ai-agent-cong-thuc-cham-soc-khach-hang-24-7-khong-can-nhan-vien-truc', '2026-05-05'],

    ['VIAi ra mắt tính năng Report Agent: báo cáo tự động gửi lúc 8 giờ sáng mỗi ngày',
     'Tính năng mới nhất của VIAi cho phép doanh nghiệp nhận báo cáo doanh thu, tồn kho và hiệu suất nhân viên tự động qua Zalo hoặc Email — không cần nhập liệu thủ công.',
     `## Vấn đề của báo cáo thủ công

Mỗi buổi sáng, nhiều chủ doanh nghiệp phải tự tổng hợp số liệu từ nhiều nguồn: đơn hàng trên Shopee, doanh thu từ Website, tồn kho trên phần mềm kho, hiệu suất nhân viên từ CRM. Công việc này mất 30–90 phút và dễ sai sót.

## Report Agent của VIAi làm gì?

### Tổng hợp dữ liệu từ 20+ nguồn

Report Agent kết nối với các kênh bán hàng, phần mềm kế toán, CRM và hệ thống kho để thu thập toàn bộ dữ liệu cần thiết — tự động, không cần nhập liệu thủ công.

### Tạo báo cáo theo mẫu doanh nghiệp

Báo cáo được thiết kế theo nhu cầu cụ thể: doanh thu theo kênh, sản phẩm bán chạy, tỷ lệ tồn kho, hiệu suất từng nhân viên kinh doanh, chi phí vận hành. Định dạng rõ ràng, dễ đọc ngay trên điện thoại.

### Gửi tự động lúc 8:00 sáng mỗi ngày

Không cần nhớ, không cần làm thủ công. Đúng 8 giờ sáng, báo cáo ngày hôm trước được gửi thẳng vào Zalo cá nhân hoặc Email của chủ doanh nghiệp và các quản lý liên quan.

### Cảnh báo bất thường

Khi doanh thu giảm đột ngột, tồn kho xuống thấp hoặc có đơn hàng bất thường, Report Agent gửi cảnh báo ngay lập tức — không chờ đến báo cáo ngày hôm sau.

## Ai nên dùng Report Agent?

Report Agent phù hợp với doanh nghiệp có từ 3 kênh bán hàng trở lên, hoặc cần tổng hợp dữ liệu từ nhiều bộ phận. Đặc biệt hữu ích cho chủ doanh nghiệp muốn nắm tình hình kinh doanh mà không mất thời gian tổng hợp thủ công.

[Tìm hiểu thêm về Report Agent](/san-pham/report-analytics-agent) hoặc [đăng ký dùng thử](/dung-thu.html).`,
     'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&q=80',
     'Tin tức', 'VIAi Team', 'viai-ra-mat-tinh-nang-report-agent-bao-cao-tu-dong-gui-luc-8-gio-sang-moi-ngay', '2026-04-28'],

    ['Chuyển đổi số 2026: Xu hướng AI Agent nào đang thay đổi thị trường Việt Nam?',
     'Từ chatbot đơn giản đến các AI Agent thông minh có khả năng xử lý đa bước — thị trường Việt Nam đang chứng kiến làn sóng chuyển đổi mạnh mẽ nhất trong lịch sử công nghệ doanh nghiệp.',
     `## Từ chatbot đến AI Agent: sự khác biệt là gì?

Chatbot truyền thống chỉ trả lời câu hỏi theo kịch bản có sẵn. AI Agent là bước tiến xa hơn — không chỉ trả lời mà còn **hành động**: tạo đơn hàng, gửi email, cập nhật CRM, tổng hợp báo cáo và phối hợp với các hệ thống khác để hoàn thành một chuỗi công việc.

## 4 xu hướng AI Agent nổi bật tại Việt Nam năm 2026

### 1. AI Agent trong bán hàng đa kênh

Doanh nghiệp không còn quản lý từng kênh riêng lẻ. AI Agent tích hợp Zalo, Facebook, Website và sàn TMĐT vào một luồng xử lý thống nhất — khách hàng nhắn tin ở đâu cũng nhận được phản hồi ngay lập tức.

### 2. Tự động hóa quy trình vận hành nội bộ

Từ xử lý đơn hàng, quản lý kho đến tổng hợp báo cáo — các quy trình lặp đi lặp lại đang được thay thế bởi AI Agent, giúp nhân viên tập trung vào công việc tạo ra giá trị cao hơn.

### 3. AI Agent cho chăm sóc khách hàng cá nhân hóa

Thay vì gửi cùng một tin nhắn cho tất cả khách hàng, AI Agent phân tích hành vi mua sắm và gửi nội dung phù hợp cho từng người — đúng sản phẩm, đúng thời điểm, đúng kênh.

### 4. Báo cáo và phân tích thông minh

Chủ doanh nghiệp không cần chờ kế toán tổng hợp cuối tháng. AI Agent thu thập, phân tích và gửi báo cáo theo thời gian thực — giúp quyết định nhanh hơn, chính xác hơn.

## VIAi đang giúp doanh nghiệp Việt bắt đầu thế nào?

VIAi cung cấp 6 AI Agent chuyên biệt, mỗi Agent giải quyết một nghiệp vụ cụ thể. Doanh nghiệp có thể bắt đầu từ một Agent phù hợp nhất, đo hiệu quả và mở rộng dần theo nhu cầu thực tế — không cần đầu tư lớn ngay từ đầu.

[Xem danh sách AI Agent của VIAi](/san-pham.html) hoặc [đặt lịch tư vấn miễn phí](/dung-thu.html) để tìm Agent phù hợp với doanh nghiệp bạn.`,
     'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=800&q=80',
     'Kiến thức AI', 'VIAi Team', 'chuyen-doi-so-2026-xu-huong-ai-agent-nao-dang-thay-doi-thi-truong-viet-nam', '2026-04-18'],
  ].forEach(r => ins.run(...r));
}

// Seed gallery_images
if (db.prepare('SELECT COUNT(*) as c FROM gallery_images').get().c === 0) {
  const ins = db.prepare('INSERT INTO gallery_images (image_url, alt_text, caption, order_index) VALUES (?,?,?,?)');
  [
    ['anhthucte/dot-pha-cung-ai-xu-huong-marketing-0-dong-2026-768x512.png','Đột phá cùng AI','Đột phá cùng AI – Marketing 0 đồng 2026',1],
    ['anhthucte/MIE_7791.jpg','VIAi Event','Sự kiện VIAi',2],
    ['anhthucte/MIE_7723.jpg','VIAi Workshop','Workshop VIAi',3],
    ['anhthucte/workshop-don-song-facebook-reel-tiktok-16.jpg','Workshop Facebook Reel TikTok','Workshop Facebook Reel & TikTok',4],
    ['anhthucte/workshop-don-song-facebook-reel-tiktok-18.jpg','Workshop Facebook Reel TikTok','Workshop Facebook Reel & TikTok',5],
    ['anhthucte/workshop-don-song-facebook-reel-tiktok-9.jpg','Workshop TikTok','Workshop Đón sóng Facebook Reel & TikTok',6],
    ['anhthucte/workshop-don-song-facebook-reel-tiktok-9 (1).jpg','Workshop thực chiến','Workshop thực chiến',7],
    ['anhthucte/recap-yep-2023-15.jpg','Recap YEP 2023','Recap YEP 2023',8],
    ['anhthucte/sinh-nhat-thang-10-va-114-e1672282860276.jpg','Sinh nhật VIAi','Sinh nhật VIAi',9],
    ['anhthucte/Tang-doanh-thu-ban-hang-online-voi-Phan-mem-MKT-trong-chuyen-doi-so-tang-doanh-thu-1-1672047623-662-width660height441-e1672282875587.jpg','Tăng doanh thu','Tăng doanh thu bán hàng online',10],
    ['anhthucte/image001-1581-e1672282835511.jpg','VIAi Team','Đội ngũ VIAi',11],
    ['anhthucte/z5299536897724_8b8bb639b1c98ff462309ff8dc09b0e3.jpg','VIAi Community','Cộng đồng VIAi',12],
    ['anhthucte/z4598430502394_9052a9725f6fdf47e164880e74218e3c-1.jpg','VIAi Activity','Hoạt động VIAi',13],
  ].forEach(r => ins.run(...r));
}

// Migration: thêm cột slug cho products
try { db.exec("ALTER TABLE products ADD COLUMN slug TEXT DEFAULT NULL"); } catch {}
// Hardcode slug + link cho từng sản phẩm theo tên (không dùng regex Unicode)
try {
  const PROD_SLUGS = {
    'Zalo Sales Agent':        'zalo-sales-agent',
    'Order Management Agent':  'order-management-agent',
    'CRM Automation Agent':    'crm-automation-agent',
    'Report & Analytics Agent':'report-analytics-agent',
    'Email Marketing Agent':   'email-marketing-agent',
    'Facebook Ads Agent':      'facebook-ads-agent',
    'Booking & Appointment':   'booking-appointment',
    'Custom Enterprise Agent': 'custom-enterprise-agent',
  };
  Object.entries(PROD_SLUGS).forEach(([name, slug]) => {
    db.prepare("UPDATE products SET slug=?, link=? WHERE name=?").run(slug, `/san-pham/${slug}`, name);
  });
} catch {}

// Migration slug chạy SAU seeds để đảm bảo bao phủ cả dữ liệu mới seed
function makeSlug(title) {
  return String(title || 'bai-viet')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd').replace(/Đ/g, 'D')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70) || 'bai-viet';
}
try {
  const noSlug = db.prepare("SELECT id, title FROM blog_posts WHERE slug IS NULL OR slug = ''").all();
  noSlug.forEach(post => {
    let base = makeSlug(post.title), slug = base, i = 2;
    while (db.prepare('SELECT id FROM blog_posts WHERE slug = ? AND id != ?').get(slug, post.id)) slug = `${base}-${i++}`;
    db.prepare('UPDATE blog_posts SET slug = ? WHERE id = ?').run(slug, post.id);
  });
} catch {}

module.exports = db;
