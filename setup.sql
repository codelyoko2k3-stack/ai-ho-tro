-- ═══════════════════════════════════════════════
--  VIAi CMS – Database Setup
--  Chạy: psql -U <user> -d <db> -f setup.sql
-- ═══════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS admin_users (
  id            SERIAL PRIMARY KEY,
  username      VARCHAR(100) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS products (
  id          SERIAL PRIMARY KEY,
  name        VARCHAR(200) NOT NULL,
  description TEXT,
  icon        VARCHAR(10)  DEFAULT '🤖',
  icon_color  VARCHAR(20)  DEFAULT 'blue',
  badge       VARCHAR(50),
  badge_type  VARCHAR(20),
  category    VARCHAR(50)  DEFAULT 'all',
  users_count INTEGER      DEFAULT 0,
  link        VARCHAR(500) DEFAULT '#',
  active      BOOLEAN      DEFAULT true,
  order_index INTEGER      DEFAULT 0,
  created_at  TIMESTAMP    DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS news_posts (
  id           SERIAL PRIMARY KEY,
  title        VARCHAR(500) NOT NULL,
  excerpt      TEXT,
  image_url    VARCHAR(1000),
  source_name  VARCHAR(100),
  source_tag   VARCHAR(50),
  source_url   VARCHAR(1000),
  published_at DATE         DEFAULT CURRENT_DATE,
  active       BOOLEAN      DEFAULT true,
  created_at   TIMESTAMP    DEFAULT NOW()
);

-- ── Default admin (password: admin123) ───────────────
INSERT INTO admin_users (username, password_hash) VALUES
  ('admin', '$2a$10$rBV2JDeWW3.vKyeCtNDz6.VVN9kZqCfzMPcCJWlFpK7.eMMIuJJ.a')
ON CONFLICT DO NOTHING;

-- ── Seed products ─────────────────────────────────────
INSERT INTO products (name, description, icon, icon_color, badge, badge_type, category, users_count, link, order_index) VALUES
  ('Zalo Sales Agent',         'Tự động tư vấn, chốt đơn và chăm sóc khách hàng qua Zalo OA 24/7 mà không cần nhân viên trực.',                          '💬', 'blue',   'HOT',      'hot',  'sales',     320, '/cong-cu/zalo-sales-agent', 1),
  ('Order Management Agent',   'Tiếp nhận, xử lý đơn hàng từ nhiều kênh (Shopee, Lazada, Website, Zalo) vào một hệ thống duy nhất.',                      '📦', 'orange', 'PHỔ BIẾN', 'pop',  'ops',       210, '/cong-cu/order-management-agent', 2),
  ('CRM Automation Agent',     'Tự động phân loại khách hàng, nhắc lịch chăm sóc, gửi ưu đãi cá nhân hóa theo hành vi mua hàng.',                         '🤝', 'green',  NULL,       NULL,   'sales',     180, '/cong-cu/crm-automation-agent', 3),
  ('Report & Analytics Agent', 'Tổng hợp dữ liệu đa nguồn, tự động tạo và gửi báo cáo hằng ngày qua email hoặc Zalo lúc 8 giờ sáng.',                    '📊', 'yellow', 'MỚI',      'new',  'analytics',  95, '/cong-cu/report-analytics-agent', 4),
  ('Email Marketing Agent',    'Lên lịch, cá nhân hóa và gửi email marketing thông minh tự động theo hành vi người dùng.',                                 '📧', 'purple', 'BETA',     'beta', 'marketing',  60, '/cong-cu/email-marketing-agent', 5),
  ('Facebook Ads Agent',       'Tự động tối ưu ngân sách quảng cáo Facebook, báo cáo ROAS và đề xuất điều chỉnh chiến dịch.',                             '🏭', 'blue',   NULL,       NULL,   'marketing', 140, '/cong-cu/facebook-ads-agent', 6),
  ('Booking & Appointment',    'Tự động nhận lịch hẹn, xác nhận, nhắc nhở khách hàng – phù hợp spa, phòng khám, dịch vụ B2C.',                            '🗓️', 'orange', NULL,       NULL,   'ops',        75, '/cong-cu/booking-appointment-agent', 7),
  ('Custom Enterprise Agent',  'Xây dựng AI Agent hoàn toàn tùy chỉnh theo nghiệp vụ đặc thù, tích hợp với mọi hệ thống nội bộ.',                         '🏗️', 'green',  NULL,       NULL,   'ops',         0, '/cong-cu/custom-enterprise-agent', 8)
ON CONFLICT DO NOTHING;

-- ── Seed news ─────────────────────────────────────────
INSERT INTO news_posts (title, excerpt, image_url, source_name, source_tag, source_url, published_at) VALUES
  ('[genk.vn] AI Agent – Làn sóng tự động hóa đang thay đổi cách doanh nghiệp SME vận hành',
   'Không còn là khái niệm xa xỉ, các AI Agent đang được hàng trăm doanh nghiệp vừa và nhỏ tại Việt Nam ứng dụng để tự động hóa bán hàng, chăm sóc khách hàng và quản lý vận hành...',
   'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=600&q=80',
   'GENK.VN', 'genk', 'https://genk.vn', '2026-04-12'),

  ('[tienphong.vn] VIAi – Lối đi riêng cho kinh doanh online trong thời đại chuyển đổi số',
   'Nền tảng AI Agent của VIAi đang xây dựng hệ thống tự động hóa đa kênh giúp doanh nghiệp tiết kiệm đến 78% thời gian xử lý công việc thủ công hàng ngày...',
   'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=600&q=80',
   'TIỀN PHONG', 'tienpb', 'https://tienphong.vn', '2026-04-08'),

  ('[24h.com.vn] Tăng doanh thu bán hàng online với AI Agent trong làn sóng chuyển đổi số',
   'Chuyển đổi số đặt ra yêu cầu các doanh nghiệp phải nhanh chóng thay đổi tư duy vận hành. AI Agent đang trở thành công cụ không thể thiếu để cạnh tranh trong thị trường hiện đại...',
   'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=600&q=80',
   '24H.COM.VN', 'h24', 'https://24h.com.vn', '2026-04-02'),

  ('[cafebiz.vn] VIAi – Công cụ AI Agent hỗ trợ bán hàng đa kênh hiệu quả cho thời đại 4.0',
   'Việc sử dụng một nền tảng AI Agent hỗ trợ bán hàng online hiệu quả đang là bài toán sống còn của nhiều doanh nghiệp, đặc biệt trong bối cảnh chi phí quảng cáo ngày càng tăng cao...',
   'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=600&q=80',
   'CAFEBIZ', 'cafebiz', 'https://cafebiz.vn', '2026-03-25')
ON CONFLICT DO NOTHING;
