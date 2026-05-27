const { Pool } = require('pg');
const bcrypt   = require('bcryptjs');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('railway')
    ? { rejectUnauthorized: false }
    : false,
});

// Chuyển ? placeholders của SQLite sang $1, $2, ... của PostgreSQL
function toPg(sql) {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
}

// Wrapper giả lập API better-sqlite3 nhưng async
class Statement {
  constructor(sql) { this.sql = sql; }

  async all(...args) {
    const params = args.flat();
    const { rows } = await pool.query(toPg(this.sql), params);
    return rows;
  }

  async get(...args) {
    const params = args.flat();
    const { rows } = await pool.query(toPg(this.sql), params);
    return rows[0] || null;
  }

  async run(...args) {
    const params = args.flat();
    let pgSql = toPg(this.sql);
    const isInsert = pgSql.trim().toUpperCase().startsWith('INSERT');
    // Không thêm RETURNING id cho site_settings (primary key là TEXT)
    const needsReturning = isInsert && !/site_settings/i.test(pgSql);
    if (needsReturning) pgSql += ' RETURNING id';
    const result = await pool.query(pgSql, params);
    return {
      lastInsertRowid: result.rows[0]?.id || null,
      changes: result.rowCount,
    };
  }
}

const db = {
  prepare: (sql) => new Statement(sql),
  exec:    async (sql) => { await pool.query(sql); },
  pragma:  () => {},   // no-op với PostgreSQL
  pool,
};

// ── Khởi tạo schema & seed ────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id            SERIAL PRIMARY KEY,
      username      TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      totp_secret   TEXT DEFAULT NULL,
      totp_enabled  INTEGER DEFAULT 0,
      display_name  TEXT DEFAULT NULL,
      email         TEXT DEFAULT NULL,
      avatar_url    TEXT DEFAULT NULL,
      created_at    TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS products (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      icon        TEXT DEFAULT '🤖',
      icon_color  TEXT DEFAULT 'blue',
      badge       TEXT,
      badge_type  TEXT,
      category    TEXT DEFAULT 'all',
      users_count INTEGER DEFAULT 0,
      link        TEXT DEFAULT '#',
      slug        TEXT DEFAULT NULL,
      active      INTEGER DEFAULT 1,
      order_index INTEGER DEFAULT 0,
      created_at  TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS news_posts (
      id           SERIAL PRIMARY KEY,
      title        TEXT NOT NULL,
      excerpt      TEXT,
      image_url    TEXT,
      source_name  TEXT,
      source_tag   TEXT,
      source_url   TEXT,
      published_at TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD'),
      active       INTEGER DEFAULT 1,
      created_at   TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS why_items (
      id          SERIAL PRIMARY KEY,
      icon        TEXT DEFAULT '⭐',
      icon_color  TEXT DEFAULT 'blue',
      title       TEXT NOT NULL,
      description TEXT,
      order_index INTEGER DEFAULT 0,
      active      INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS how_steps (
      id           SERIAL PRIMARY KEY,
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
      id          SERIAL PRIMARY KEY,
      image_url   TEXT,
      title       TEXT NOT NULL,
      description TEXT,
      is_featured INTEGER DEFAULT 0,
      order_index INTEGER DEFAULT 0,
      active      INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS gallery_images (
      id          SERIAL PRIMARY KEY,
      image_url   TEXT NOT NULL,
      alt_text    TEXT,
      caption     TEXT,
      order_index INTEGER DEFAULT 0,
      active      INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS blog_posts (
      id               SERIAL PRIMARY KEY,
      title            TEXT NOT NULL,
      excerpt          TEXT,
      content          TEXT,
      seo_title        TEXT,
      meta_description TEXT,
      faq_json         TEXT DEFAULT '[]',
      image_alt        TEXT,
      image_url        TEXT,
      category         TEXT DEFAULT 'Tin tức',
      author           TEXT DEFAULT 'ViAI Team',
      slug             TEXT,
      published_at     TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD'),
      active           INTEGER DEFAULT 1,
      created_at       TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      name          TEXT NOT NULL,
      email         TEXT UNIQUE,
      phone         TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      status        TEXT DEFAULT 'active',
      source_page   TEXT DEFAULT NULL,
      last_login    TEXT DEFAULT NULL,
      created_at    TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS customers (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL,
      phone      TEXT,
      email      TEXT,
      company    TEXT,
      message    TEXT,
      source     TEXT DEFAULT 'website',
      status     TEXT DEFAULT 'new',
      created_at TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS page_views (
      id         SERIAL PRIMARY KEY,
      path       TEXT NOT NULL,
      ip         TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS login_logs (
      id         SERIAL PRIMARY KEY,
      username   TEXT,
      ip         TEXT,
      success    INTEGER DEFAULT 1,
      note       TEXT,
      created_at TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS otp_verifications (
      id          SERIAL PRIMARY KEY,
      token       TEXT UNIQUE NOT NULL,
      target      TEXT NOT NULL,
      target_type TEXT NOT NULL,
      otp         TEXT NOT NULL,
      user_data   TEXT NOT NULL,
      attempts    INTEGER DEFAULT 0,
      expires_at  BIGINT NOT NULL,
      created_at  TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS site_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );

    CREATE TABLE IF NOT EXISTS solution_cards (
      id          SERIAL PRIMARY KEY,
      kicker      TEXT DEFAULT '',
      image_url   TEXT,
      title       TEXT NOT NULL,
      description TEXT,
      link_url    TEXT DEFAULT '/',
      order_index INTEGER DEFAULT 0,
      active      INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS feature_cards (
      id          SERIAL PRIMARY KEY,
      image_url   TEXT,
      title       TEXT NOT NULL,
      description TEXT,
      link_url    TEXT DEFAULT '/',
      order_index INTEGER DEFAULT 0,
      active      INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS pricing_plans (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      icon        TEXT DEFAULT '🌱',
      subtitle    TEXT,
      price_month TEXT NOT NULL,
      price_year  TEXT,
      highlight   INTEGER DEFAULT 0,
      badge       TEXT,
      cta_text    TEXT DEFAULT 'Dùng thử miễn phí',
      features    TEXT DEFAULT '[]',
      order_index INTEGER DEFAULT 0,
      active      INTEGER DEFAULT 1,
      created_at  TEXT DEFAULT TO_CHAR(NOW(), 'YYYY-MM-DD HH24:MI:SS')
    );
  `);

  // ── Seed site_settings ──────────────────────────────
  const settingsDefaults = {
    seo_title:       'ViAI – Phần mềm AI Agent cho doanh nghiệp Việt Nam',
    seo_description: 'ViAI cung cấp AI Agent tự động hóa bán hàng, vận hành và chăm sóc khách hàng 24/7. Triển khai trong 24 giờ, kết nối 100+ ứng dụng, không cần lập trình.',
    seo_keywords:    'AI Agent, tự động hóa doanh nghiệp, Zalo Agent, chatbot doanh nghiệp Việt Nam',
    og_title:        'ViAI – Phần mềm AI Agent cho doanh nghiệp Việt Nam',
    og_description:  'Tự động hóa toàn bộ quy trình bán hàng, vận hành và chăm sóc khách hàng bằng AI Agent. Triển khai trong 24 giờ, không cần lập trình.',
    hero_badge:      'AI Agent Platform • Đang hoạt động',
    hero_title:      'Tự động hóa toàn bộ quy trình bằng AI Agent thông minh',
    hero_desc:       'ViAI cung cấp các AI Agent sẵn sàng triển khai – kết nối đa nền tảng, xử lý tự động 24/7.',
    hero_cta1_text:  '🚀 Dùng thử miễn phí 14 ngày',
    hero_cta1_url:   'dung-thu.html',
    hero_cta2_text:  '▶ Xem demo thực tế',
    trust1_num:   '500+',  trust1_label: 'Doanh nghiệp tin dùng',
    trust2_num:   '10x',   trust2_label: 'Tăng năng suất làm việc',
    trust3_num:   '98%',   trust3_label: 'Khách hàng hài lòng',
    cta_title:    'Sẵn sàng để AI làm việc thay bạn?',
    cta_subtitle: 'Dùng thử miễn phí 14 ngày · Không cần thẻ tín dụng · Hỗ trợ cài đặt 1-1 miễn phí',
    cta_btn1_text:'🚀 Bắt đầu miễn phí ngay',
    cta_btn2_text:'📞 Tư vấn ngay hôm nay',
    homepage_faq: JSON.stringify([
      { q: 'ViAI khác gì so với chatbot thông thường?', a: 'Chatbot chỉ trả lời theo kịch bản cố định. AI Agent của ViAI hiểu ngữ cảnh, tự ra quyết định và thực hiện hành động — tạo đơn, cập nhật CRM, gửi báo cáo — hoàn toàn tự động 24/7.' },
      { q: 'Tôi không biết lập trình, có dùng được không?', a: 'Hoàn toàn không cần kỹ năng kỹ thuật. Giao diện tiếng Việt, đội ngũ ViAI hỗ trợ 1-1 từ đầu đến cuối trong 24 giờ.' },
      { q: 'Dữ liệu khách hàng của tôi có an toàn không?', a: 'Dữ liệu mã hóa end-to-end, lưu tại máy chủ Việt Nam, tuân thủ ISO 27001. ViAI không chia sẻ dữ liệu với bên thứ ba.' },
      { q: 'Triển khai mất bao lâu?', a: 'Trong vòng 24 giờ làm việc kể từ khi ký hợp đồng. Đội ngũ ViAI cài đặt, kết nối và chạy thử nghiệm — bạn chỉ cần cấp quyền truy cập.' },
      { q: 'ViAI kết nối được với những nền tảng nào?', a: 'Zalo OA, Facebook Messenger, Shopee, Lazada, Google Sheets, MISA, Base.vn và 50+ nền tảng khác.' },
      { q: 'Nếu không hài lòng thì sao?', a: 'Hoàn tiền 100% trong 14 ngày, không hỏi lý do.' },
    ]),
  };
  for (const [k, v] of Object.entries(settingsDefaults)) {
    await pool.query(
      'INSERT INTO site_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING',
      [k, v]
    );
  }

  // ── Seed admin ──────────────────────────────────────
  const existing = await pool.query('SELECT id FROM admin_users WHERE username = $1', ['admin']);
  if (existing.rows.length === 0) {
    const hash = bcrypt.hashSync('admin123', 10);
    await pool.query('INSERT INTO admin_users (username, password_hash) VALUES ($1, $2)', ['admin', hash]);
  }

  // ── Seed products ───────────────────────────────────
  const { rows: [{ c: prodCount }] } = await pool.query('SELECT COUNT(*) as c FROM products');
  if (parseInt(prodCount) === 0) {
    const ins = `INSERT INTO products (name,description,icon,icon_color,badge,badge_type,category,users_count,link,slug,order_index) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`;
    const products = [
      ['Zalo Sales Agent','Tự động tư vấn, chốt đơn và chăm sóc khách hàng qua Zalo OA 24/7 mà không cần nhân viên trực.','💬','blue','HOT','hot','sales',320,'/san-pham/zalo-sales-agent','zalo-sales-agent',1],
      ['Order Management Agent','Tiếp nhận, xử lý đơn hàng từ nhiều kênh (Shopee, Lazada, Website, Zalo) vào một hệ thống duy nhất.','📦','orange','PHỔ BIẾN','pop','ops',210,'/san-pham/order-management-agent','order-management-agent',2],
      ['CRM Automation Agent','Tự động phân loại khách hàng, nhắc lịch chăm sóc, gửi ưu đãi cá nhân hóa theo hành vi mua hàng.','🤝','green',null,null,'sales',180,'/san-pham/crm-automation-agent','crm-automation-agent',3],
      ['Report & Analytics Agent','Tổng hợp dữ liệu đa nguồn, tự động tạo và gửi báo cáo hằng ngày qua email hoặc Zalo lúc 8 giờ sáng.','📊','yellow','MỚI','new','analytics',95,'/san-pham/report-analytics-agent','report-analytics-agent',4],
      ['Email Marketing Agent','Lên lịch, cá nhân hóa và gửi email marketing thông minh tự động theo hành vi người dùng.','📧','purple','BETA','beta','marketing',60,'/san-pham/email-marketing-agent','email-marketing-agent',5],
      ['Facebook Ads Agent','Tự động tối ưu ngân sách quảng cáo Facebook, báo cáo ROAS và đề xuất điều chỉnh chiến dịch.','📢','blue',null,null,'marketing',140,'/san-pham/facebook-ads-agent','facebook-ads-agent',6],
      ['Booking & Appointment','Tự động nhận lịch hẹn, xác nhận, nhắc nhở khách hàng – phù hợp spa, phòng khám, dịch vụ B2C.','📅','orange',null,null,'ops',75,'/san-pham/booking-appointment','booking-appointment',7],
      ['Custom Enterprise Agent','Xây dựng AI Agent hoàn toàn tùy chỉnh theo nghiệp vụ đặc thù, tích hợp với mọi hệ thống nội bộ.','🏢','green',null,null,'ops',0,'/san-pham/custom-enterprise-agent','custom-enterprise-agent',8],
    ];
    for (const p of products) await pool.query(ins, p);
  }

  // ── Seed news ───────────────────────────────────────
  const { rows: [{ c: newsCount }] } = await pool.query('SELECT COUNT(*) as c FROM news_posts');
  if (parseInt(newsCount) === 0) {
    const ins = `INSERT INTO news_posts (title,excerpt,image_url,source_name,source_tag,source_url,published_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`;
    const news = [
      ['ViAI cam kết hiệu quả AI Agent cho doanh nghiệp Việt','ViAI mang đến giải pháp AI Agent đóng gói sẵn, giúp doanh nghiệp tự động hóa vận hành mà không cần đội kỹ thuật chuyên sâu.','anhlogo/a.jpg','genk.vn','genk','#press','2026-05-15'],
      ['ViAI đồng hành cùng cộng đồng doanh nghiệp SME','Mở rộng cơ hội tiếp cận AI Agent cho các doanh nghiệp vừa và nhỏ tại Việt Nam.','anhlogo/b.jpg','cand.com.vn','tienpb','#press','2026-05-12'],
      ['AI Agent trở thành xu hướng vận hành năm 2026','Doanh nghiệp bắt đầu đưa trợ lý AI vào bán hàng, chăm sóc khách hàng và báo cáo.','anhlogo/d.png','cafebiz.vn','cafebiz','#press','2026-05-08'],
    ];
    for (const n of news) await pool.query(ins, n);
  }

  // ── Seed why_items ──────────────────────────────────
  const { rows: [{ c: whyCount }] } = await pool.query('SELECT COUNT(*) as c FROM why_items');
  if (parseInt(whyCount) === 0) {
    const ins = `INSERT INTO why_items (icon,icon_color,title,description,order_index) VALUES ($1,$2,$3,$4,$5)`;
    const items = [
      ['⚡','blue','Triển khai trong vòng 24 giờ','Từ lúc ký hợp đồng đến khi Agent chạy thực tế chỉ mất một ngày làm việc.',1],
      ['🔗','orange','Kết nối hơn 100+ ứng dụng','Zalo, Facebook, Google Sheets, Shopee, MISA, Base.vn và hàng trăm ứng dụng khác – không cần viết code.',2],
      ['🛡️','green','Bảo mật dữ liệu tuyệt đối','Dữ liệu lưu trữ tại máy chủ Việt Nam, mã hóa end-to-end, tuân thủ quy định PDPA.',3],
      ['📞','yellow','Hỗ trợ 1-1 bởi chuyên gia AI','Cam kết phản hồi trong vòng 30 phút giờ hành chính.',4],
      ['🔄','blue','Tự học và cải thiện theo thời gian','Agent liên tục tối ưu phản hồi và quy trình xử lý dựa trên dữ liệu thực tế.',5],
      ['💰','orange','Cam kết hoàn tiền 7 ngày','Hoàn tiền 100% không cần giải thích nếu không hài lòng.',6],
    ];
    for (const i of items) await pool.query(ins, i);
  }

  // ── Seed how_steps ──────────────────────────────────
  const { rows: [{ c: howCount }] } = await pool.query('SELECT COUNT(*) as c FROM how_steps');
  if (parseInt(howCount) === 0) {
    const ins = `INSERT INTO how_steps (step_number,title,short_desc,panel_title,panel_desc,features,mockup_bars,order_index) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
    const steps = [
      [1,'Chọn AI Agent phù hợp','Thư viện Agent đa dạng theo từng nghiệp vụ','Chọn AI Agent phù hợp với bạn','Từ thư viện hơn 10 AI Agent chuyên biệt, bạn chọn Agent phù hợp với nghiệp vụ.','["Thư viện Agent phân loại theo ngành","Xem demo trực tiếp trước khi triển khai","Tư vấn 1-1 miễn phí với chuyên gia AI"]','[{"label":"Zalo Sales Agent","value":"⭐ Phù hợp nhất","color":"blue"}]',1],
      [2,'Kết nối hệ thống hiện tại','Tích hợp 100+ ứng dụng không cần code','Kết nối với hệ thống bạn đang dùng','ViAI tích hợp với hầu hết các công cụ phổ biến tại Việt Nam.','["Kết nối Zalo OA, Facebook, Website","Tích hợp Google Sheets, MISA, Shopee","Webhook & API mở cho hệ thống nội bộ"]','[{"label":"Zalo OA","value":"✓ Đã kết nối","color":"green"}]',2],
      [3,'Agent tự động chạy 24/7','Xử lý công việc liên tục, không nghỉ','AI Agent tự động xử lý mọi thứ 24/7','Sau khi thiết lập, Agent hoạt động liên tục không cần giám sát.','["Hoạt động 24/7, 365 ngày","Xử lý hàng trăm yêu cầu cùng lúc","Tự học và cải thiện theo dữ liệu thực tế"]','[{"label":"Tin nhắn hôm nay","value":"128 tin","color":"green"}]',3],
      [4,'Theo dõi & tối ưu kết quả','Dashboard và báo cáo tự động mỗi sáng','Theo dõi hiệu suất & tối ưu liên tục','Dashboard trực quan cập nhật thời gian thực. Báo cáo tự động lúc 8 giờ sáng.','["Dashboard realtime","Báo cáo tự động qua Zalo hoặc Email","Gợi ý tối ưu từ AI"]','[{"label":"Thời gian tiết kiệm","value":"4.2 giờ/ngày","color":"blue"}]',4],
    ];
    for (const s of steps) await pool.query(ins, s);
  }

  // ── Seed tech_items ─────────────────────────────────
  const { rows: [{ c: techCount }] } = await pool.query('SELECT COUNT(*) as c FROM tech_items');
  if (parseInt(techCount) === 0) {
    const ins = `INSERT INTO tech_items (image_url,title,description,is_featured,order_index) VALUES ($1,$2,$3,$4,$5)`;
    const items = [
      ['anhlogo/tech1.svg','AI Agent Engine','Bộ máy xử lý ngôn ngữ tự nhiên thế hệ mới, hiểu tiếng Việt chuyên sâu.',0,1],
      ['anhlogo/tech2.svg','Tích hợp đa nền tảng','Kết nối liền mạch với Zalo, Facebook, Website, CRM, ERP và hơn 50 ứng dụng.',1,2],
      ['anhlogo/tech3.svg','Bảo mật doanh nghiệp','Mã hóa đầu cuối, lưu trữ dữ liệu tại Việt Nam, tuân thủ tiêu chuẩn ISO 27001.',0,3],
    ];
    for (const i of items) await pool.query(ins, i);
  }

  // ── Seed blog_posts ─────────────────────────────────
  const { rows: [{ c: blogCount }] } = await pool.query('SELECT COUNT(*) as c FROM blog_posts');
  if (parseInt(blogCount) === 0) {
    const ins = `INSERT INTO blog_posts (title,excerpt,content,image_url,category,author,slug,published_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`;
    const posts = [
      ['5 cách AI Agent giúp doanh nghiệp SME tiết kiệm 4 giờ mỗi ngày','Thay vì thuê thêm nhân sự, hàng trăm doanh nghiệp đang ứng dụng AI Agent để tự động hóa tác vụ lặp lại.','## Doanh nghiệp SME đang mất bao nhiêu thời gian?\n\nTheo khảo sát, mỗi nhân viên mất 4-5 giờ/ngày cho công việc lặp lại. AI Agent có thể làm thay.\n\n## 5 cách tiết kiệm\n\n### 1. Tự động trả lời Zalo 24/7\n### 2. Xử lý đơn hàng tự động\n### 3. Gửi báo cáo lúc 8 giờ sáng\n### 4. Nhắc lịch chăm sóc khách\n### 5. Phân loại và chuyển tiếp yêu cầu\n\n[Dùng thử miễn phí](/dung-thu.html)','https://images.unsplash.com/photo-1677442136019-21780ecad995?w=800&q=80','Hướng dẫn','ViAI Team','5-cach-ai-agent-giup-doanh-nghiep-sme-tiet-kiem-4-gio-moi-ngay','2026-05-10'],
      ['Hướng dẫn chọn AI Agent phù hợp cho đội sales','Cách xác định quy trình cần tự động hóa trước khi triển khai AI Agent.','## Tại sao cần chọn đúng Agent?\n\nMỗi doanh nghiệp có quy trình khác nhau. Chọn sai Agent sẽ lãng phí thời gian và tiền bạc.\n\n## Các tiêu chí lựa chọn\n\n1. Xác định tác vụ lặp lại nhiều nhất\n2. Đo thời gian tiết kiệm được\n3. Chi phí vs lợi ích\n\n[Tư vấn miễn phí](/dung-thu.html)','https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=800&q=80','Hướng dẫn','ViAI Team','huong-dan-chon-ai-agent-cho-sales','2026-05-05'],
      ['Checklist bảo mật khi đưa AI vào dữ liệu khách hàng','Những điểm cần kiểm tra về phân quyền, mã hóa và lưu trữ dữ liệu.','## Bảo mật dữ liệu là ưu tiên hàng đầu\n\nKhi đưa AI vào hệ thống, cần đảm bảo dữ liệu khách hàng được bảo vệ.\n\n## Checklist\n\n- [ ] Mã hóa dữ liệu đầu cuối\n- [ ] Kiểm soát phân quyền truy cập\n- [ ] Backup dữ liệu định kỳ\n- [ ] Tuân thủ quy định PDPA\n\n[Tìm hiểu thêm](/san-pham.html)','https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=800&q=80','Bảo mật','ViAI Team','checklist-bao-mat-ai-du-lieu-khach-hang','2026-05-01'],
    ];
    for (const p of posts) await pool.query(ins, p);
  }

  // ── Seed gallery_images ─────────────────────────────
  const { rows: [{ c: galleryCount }] } = await pool.query('SELECT COUNT(*) as c FROM gallery_images');
  if (parseInt(galleryCount) === 0) {
    const ins = `INSERT INTO gallery_images (image_url,alt_text,caption,order_index) VALUES ($1,$2,$3,$4)`;
    const imgs = [
      ['anhthucte/MIE_7791.jpg','ViAI Event','Sự kiện ViAI',1],
      ['anhthucte/MIE_7723.jpg','ViAI Workshop','Workshop ViAI',2],
      ['anhthucte/workshop-don-song-facebook-reel-tiktok-16.jpg','Workshop Facebook Reel TikTok','Workshop thực chiến',3],
    ];
    for (const i of imgs) await pool.query(ins, i);
  }

  // ── Seed solution_cards ─────────────────────────────
  const { rows: [{ c: solCount }] } = await pool.query('SELECT COUNT(*) as c FROM solution_cards');
  if (parseInt(solCount) === 0) {
    const ins = `INSERT INTO solution_cards (kicker,image_url,title,description,link_url,order_index) VALUES ($1,$2,$3,$4,$5,$6)`;
    const items = [
      ['Phần mềm','anhlogo/anh3.png','AI Agent đóng gói sẵn','Tự động hóa bán hàng, CSKH, marketing và báo cáo với các Agent triển khai nhanh.','/phan-mem',1],
      ['Dịch vụ','anhlogo/anh1.png','Triển khai AI trọn gói','Chuyên gia ViAI tư vấn, cấu hình, tích hợp và bàn giao để đội ngũ dùng được ngay.','/dich-vu',2],
      ['Đào tạo','anhlogo/anh2.png','Khóa học AI Agent','Huấn luyện đội ngũ tự vận hành, đo lường và tối ưu AI Agent theo quy trình thực tế.','/dao-tao',3],
    ];
    for (const i of items) await pool.query(ins, i);
  }

  // ── Seed feature_cards ──────────────────────────────
  const { rows: [{ c: featCount }] } = await pool.query('SELECT COUNT(*) as c FROM feature_cards');
  if (parseInt(featCount) === 0) {
    const ins = `INSERT INTO feature_cards (image_url,title,description,link_url,order_index) VALUES ($1,$2,$3,$4,$5)`;
    const items = [
      ['anhlogo/congnghe4.png','Nền tảng AI Agent','AI Brain trung tâm xử lý dữ liệu — tự động hóa toàn bộ quy trình từ đầu đến cuối 24/7.','/nen-tang-ai-agent',1],
      ['anhlogo/congnghe5.png','Tích hợp 50+ nền tảng','Zalo, Facebook, Website, CRM, ERP — kết nối chỉ vài phút, không cần lập trình.','/tich-hop-50-nen-tang',2],
      ['anhlogo/congnghe6.png','Bảo mật chuẩn doanh nghiệp','ISO 27001, mã hóa 256-bit, lưu trữ tại Việt Nam — dữ liệu luôn an toàn tuyệt đối.','/bao-mat-doanh-nghiep',3],
    ];
    for (const i of items) await pool.query(ins, i);
  }

  console.log('✅ Database initialized');
}

module.exports = { db, initDb };
