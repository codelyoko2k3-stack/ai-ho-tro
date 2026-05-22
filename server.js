require('dotenv').config();
const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const compression  = require('compression');
const path         = require('path');
const { db, initDb } = require('./db');
const tg           = require('./telegram');

const SITE_URL = (process.env.SITE_URL || 'https://phanmemaiagent.net').replace(/\/$/, '');

const app = express();

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cleanSeoText(value) {
  return String(value || '')
    .replace(/\bviai\b/gi, 'VIAi')
    .replace(/\bai\b/g, 'AI')
    .replace(/(VIAi\s+hỗ trợ)\s+hỗ trợ/gi, '$1')
    .replace(/hỗ trợ\s+hỗ trợ/gi, 'hỗ trợ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanMetaDescription(value) {
  let cleaned = cleanSeoText(value).replace(
    /VIAi\s+hỗ trợ\s+doanh nghiệp\s+ứng dụng\s+VIAi\s+hỗ trợ\s+(.+?)\s+để/i,
    'VIAi giúp doanh nghiệp ứng dụng AI vào $1 để'
  );
  if (cleaned.length < 140 && /hiệu quả\.$/i.test(cleaned)) {
    cleaned = cleaned.replace(/hiệu quả\.$/i, 'hiệu quả hơn.');
  }
  if (cleaned.length < 140) cleaned += ' Phù hợp doanh nghiệp Việt.';
  if (cleaned.length > 160) cleaned = cleaned.slice(0, 160).replace(/\s+\S*$/, '');
  return cleaned;
}

function jsonLd(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function stripMarkdownTitle(md, title = '') {
  let value = String(md || '').replace(/^\s*#\s+.+(?:\r?\n)+/, '').trim();
  const expected = String(title || '').trim().toLowerCase();
  if (expected) {
    const lines = value.split(/\r?\n/);
    if (String(lines[0] || '').trim().toLowerCase() === expected) {
      value = lines.slice(1).join('\n').trim();
    }
  }
  return value;
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, (_m, label, href) => {
      const attrs = href.startsWith('http') ? ' target="_blank" rel="noopener noreferrer"' : '';
      return `<a href="${href}"${attrs}>${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function renderMarkdown(md, options = {}) {
  const skipH1 = options.skipH1 !== false;
  const lines = String(md || '').split(/\r?\n/);
  let html = '';
  let inUl = false, inOl = false, inTable = false, tableHead = true;

  const closeUl    = () => { if (inUl)    { html += '</ul>';             inUl = false; } };
  const closeOl    = () => { if (inOl)    { html += '</ol>';             inOl = false; } };
  const closeTable = () => { if (inTable) { html += '</tbody></table></div>'; inTable = false; tableHead = true; } };
  const closeLists = () => { closeUl(); closeOl(); };
  const closeAll   = () => { closeLists(); closeTable(); };

  for (let i = 0; i < lines.length; i++) {
    const raw  = lines[i];
    const line = raw.trim();

    if (!line) { closeAll(); continue; }

    // --- Image block: ![alt](url)
    const imgM = line.match(/^!\[([^\]]*)\]\((https?:\/\/[^)\s]+|\/[^)\s]+)\)$/);
    if (imgM) {
      closeAll();
      const alt = escapeHtml(imgM[1]);
      html += `<figure class="blog-fig"><img src="${imgM[2]}" alt="${alt}" loading="lazy" />${alt ? `<figcaption>${alt}</figcaption>` : ''}</figure>`;
      continue;
    }

    // --- Table row: | a | b |
    if (line.startsWith('|') && line.endsWith('|')) {
      const cells = line.slice(1,-1).split('|').map(c => c.trim());
      // separator row
      if (cells.every(c => /^[-: ]+$/.test(c))) continue;
      closeLists();
      if (!inTable) {
        html += '<div class="tbl-wrap"><table><thead><tr>' +
          cells.map(c => `<th>${renderInlineMarkdown(c)}</th>`).join('') +
          '</tr></thead><tbody>';
        inTable = true; tableHead = false;
      } else {
        html += '<tr>' + cells.map(c => `<td>${renderInlineMarkdown(c)}</td>`).join('') + '</tr>';
      }
      continue;
    } else { closeTable(); }

    // --- Horizontal rule
    if (/^---+$/.test(line)) { closeAll(); html += '<hr class="blog-hr" />'; continue; }

    // --- Blockquote
    if (line.startsWith('> ')) {
      closeAll();
      html += `<blockquote class="blog-quote">${renderInlineMarkdown(line.slice(2))}</blockquote>`;
      continue;
    }

    // --- Headings
    if (line.startsWith('### ')) { closeAll(); html += `<h3>${renderInlineMarkdown(line.slice(4))}</h3>`; continue; }
    if (line.startsWith('## '))  { closeAll(); html += `<h2>${renderInlineMarkdown(line.slice(3))}</h2>`; continue; }
    if (line.startsWith('# '))   { closeAll(); if (!skipH1) html += `<h1>${renderInlineMarkdown(line.slice(2))}</h1>`; continue; }

    // --- Ordered list
    if (/^\d+\.\s/.test(line)) {
      closeUl(); closeTable();
      if (!inOl) { html += '<ol>'; inOl = true; }
      html += `<li>${renderInlineMarkdown(line.replace(/^\d+\.\s+/, ''))}</li>`;
      continue;
    }

    // --- Unordered list
    if (line.startsWith('- ') || line.startsWith('* ')) {
      closeOl(); closeTable();
      if (!inUl) { html += '<ul>'; inUl = true; }
      html += `<li>${renderInlineMarkdown(line.slice(2))}</li>`;
      continue;
    }

    // --- Paragraph
    closeAll();
    html += `<p>${renderInlineMarkdown(line)}</p>`;
  }
  closeAll();
  return html;
}

function renderSiteToolbar(active = '') {
  return `
  <header class="site-header">
    <div class="header-inner">
      <a href="/" class="site-logo" aria-label="Về trang chủ VIAi">
        <img src="/anhlogo/logo2.png" alt="VIAi" class="logo-img" width="150" height="150" />
      </a>

      <nav class="main-nav" id="main-nav" aria-label="Điều hướng chính">
        <div class="nav-item"><a href="/#services-intro" class="nav-link">Giới thiệu</a></div>
        <div class="nav-item${active === 'products' ? ' nav-active' : ''}">
          <a href="/#products" class="nav-link">Phần mềm <span class="nav-badge">HOT</span> <span class="arrow">▾</span></a>
          <div class="dropdown dropdown-mega service-dropdown">
            <div class="mega-title">AI Agent đang triển khai</div>
            <a href="/san-pham/zalo-sales-agent"><span class="dd-icon">💬</span><span><strong>Zalo Sales Agent</strong><small>Tư vấn và chốt đơn qua Zalo OA 24/7</small></span></a>
            <a href="/san-pham/order-management-agent"><span class="dd-icon">📦</span><span><strong>Order Agent</strong><small>Tạo đơn, cập nhật trạng thái và đồng bộ kho</small></span></a>
            <a href="/san-pham/crm-automation-agent"><span class="dd-icon">🤝</span><span><strong>CRM Agent</strong><small>Phân loại lead và chăm sóc khách hàng</small></span></a>
            <a href="/san-pham/report-analytics-agent"><span class="dd-icon">📊</span><span><strong>Report Agent</strong><small>Tự tổng hợp báo cáo vận hành mỗi ngày</small></span></a>
            <a href="/san-pham/email-marketing-agent"><span class="dd-icon">📧</span><span><strong>Email Marketing Agent</strong><small>Gửi email cá nhân hóa theo hành vi khách</small></span></a>
            <a href="/san-pham/facebook-ads-agent"><span class="dd-icon">📢</span><span><strong>Facebook Ads Agent</strong><small>Tạo và tối ưu quảng cáo tự động</small></span></a>
            <a href="/san-pham/booking-appointment"><span class="dd-icon">📅</span><span><strong>Booking Agent</strong><small>Đặt lịch và nhắc hẹn tự động</small></span></a>
            <a href="/san-pham/custom-enterprise-agent"><span class="dd-icon">🏢</span><span><strong>Enterprise Agent</strong><small>Tùy chỉnh theo quy trình riêng</small></span></a>
            <a href="/#products" class="service-dropdown-all"><span class="dd-icon">↗</span><span><strong>Xem tất cả phần mềm</strong><small>Đi tới thư viện AI Agent trên trang chủ</small></span></a>
          </div>
        </div>
        <div class="nav-item"><a href="/#how" class="nav-link">Quy trình</a></div>
        <div class="nav-item"><a href="/#tech" class="nav-link">Công nghệ</a></div>
        <div class="nav-item${active === 'blog' ? ' nav-active' : ''}">
          <a href="/#blog" class="nav-link">Tin tức <span class="arrow">▾</span></a>
          <div class="dropdown dropdown-mega news-dropdown">
            <div class="mega-title">Truyền thông nói về VIAi</div>
            <a href="/#blog"><span class="dd-icon">📰</span><span><strong>VIAi cam kết hiệu quả AI Agent</strong><small>genk.vn · 15/05/2026</small></span></a>
            <a href="/#blog"><span class="dd-icon">🤝</span><span><strong>VIAi đồng hành cùng doanh nghiệp SME</strong><small>cand.com.vn · 12/05/2026</small></span></a>
            <a href="/#blog"><span class="dd-icon">🚀</span><span><strong>AI Agent — xu hướng vận hành năm 2026</strong><small>cafebiz.vn · 08/05/2026</small></span></a>
            <div class="mega-title" style="margin-top:8px">Blog kiến thức</div>
            <a href="/blog/5-cach-ai-agent-giup-doanh-nghiep-sme-tiet-kiem-4-gio-moi-ngay"><span class="dd-icon">💡</span><span><strong>5 cách AI Agent tiết kiệm 4 giờ/ngày</strong><small>Kiến thức AI · 15/05/2026</small></span></a>
            <a href="/blog/huong-dan-chon-ai-agent-cho-sales"><span class="dd-icon">📋</span><span><strong>Chọn AI Agent phù hợp cho đội sales</strong><small>Hướng dẫn · 10/05/2026</small></span></a>
            <a href="/blog/checklist-bao-mat-ai-du-lieu-khach-hang"><span class="dd-icon">🔒</span><span><strong>Checklist bảo mật AI & dữ liệu khách hàng</strong><small>Bảo mật · 06/05/2026</small></span></a>
            <a href="/#blog" class="service-dropdown-all"><span class="dd-icon">↗</span><span><strong>Xem tất cả tin tức</strong><small>Truy cập trang tin tức trên trang chủ</small></span></a>
          </div>
        </div>
      </nav>

      <div class="header-actions">
        <div id="header-auth">
          <a href="/login.html" class="btn-login" id="btn-login-link">Đăng nhập</a>
        </div>
        <a href="/dung-thu.html" class="btn-register">🚀 Dùng thử FREE</a>
      </div>

      <button class="hamburger-btn" id="hamburger-btn" onclick="toggleMobileMenu()" aria-label="Mở menu">
        <span></span>
        <span></span>
        <span></span>
      </button>
    </div>
  </header>

  <div class="mobile-menu" id="mobile-menu">
    <a href="/#services-intro" class="mobile-plain-link" onclick="closeMobileMenu()">Giới thiệu</a>
    <div class="mobile-nav-item">
      <button class="mobile-nav-link" onclick="toggleMobileSub(this)" type="button">
        Phần mềm <span class="m-arrow">▾</span>
      </button>
      <div class="mobile-submenu">
        <a href="/san-pham/zalo-sales-agent" onclick="closeMobileMenu()"><span>💬</span> Zalo Sales Agent</a>
        <a href="/san-pham/order-management-agent" onclick="closeMobileMenu()"><span>📦</span> Order Agent</a>
        <a href="/san-pham/crm-automation-agent" onclick="closeMobileMenu()"><span>🤝</span> CRM Agent</a>
        <a href="/san-pham/report-analytics-agent" onclick="closeMobileMenu()"><span>📊</span> Report Agent</a>
        <a href="/san-pham/email-marketing-agent" onclick="closeMobileMenu()"><span>📧</span> Email Marketing Agent</a>
        <a href="/san-pham/facebook-ads-agent" onclick="closeMobileMenu()"><span>📢</span> Facebook Ads Agent</a>
        <a href="/#products" onclick="closeMobileMenu()"><span>↗</span> Xem tất cả phần mềm</a>
      </div>
    </div>
    <a href="/#how" class="mobile-plain-link" onclick="closeMobileMenu()">Quy trình</a>
    <a href="/#tech" class="mobile-plain-link" onclick="closeMobileMenu()">Công nghệ</a>
    <div class="mobile-nav-item">
      <button class="mobile-nav-link" onclick="toggleMobileSub(this)" type="button">
        Tin tức <span class="m-arrow">▾</span>
      </button>
      <div class="mobile-submenu">
        <a href="/#blog" onclick="closeMobileMenu()"><span>📰</span> VIAi cam kết hiệu quả AI Agent</a>
        <a href="/#blog" onclick="closeMobileMenu()"><span>🤝</span> VIAi đồng hành cùng doanh nghiệp SME</a>
        <a href="/#blog" onclick="closeMobileMenu()"><span>🚀</span> AI Agent — xu hướng vận hành 2026</a>
        <a href="/blog/5-cach-ai-agent-giup-doanh-nghiep-sme-tiet-kiem-4-gio-moi-ngay" onclick="closeMobileMenu()"><span>💡</span> 5 cách AI Agent tiết kiệm 4 giờ/ngày</a>
        <a href="/blog/huong-dan-chon-ai-agent-cho-sales" onclick="closeMobileMenu()"><span>📋</span> Chọn AI Agent phù hợp cho đội sales</a>
        <a href="/blog/checklist-bao-mat-ai-du-lieu-khach-hang" onclick="closeMobileMenu()"><span>🔒</span> Checklist bảo mật AI & dữ liệu</a>
        <a href="/#blog" onclick="closeMobileMenu()"><span>↗</span> Xem tất cả tin tức</a>
      </div>
    </div>

    <div class="mobile-menu-actions">
      <a href="/login.html" class="btn-login">Đăng nhập</a>
      <a href="/dung-thu.html" class="btn-register">🚀 Dùng thử FREE</a>
    </div>
  </div>`;
}

function renderSiteToolbarScript() {
  return `<script>
    function toggleMobileMenu() {
      const btn = document.getElementById('hamburger-btn');
      const menu = document.getElementById('mobile-menu');
      if (!btn || !menu) return;
      btn.classList.toggle('open');
      menu.classList.toggle('open');
      document.body.style.overflow = menu.classList.contains('open') ? 'hidden' : '';
    }

    function closeMobileMenu() {
      const btn = document.getElementById('hamburger-btn');
      const menu = document.getElementById('mobile-menu');
      if (btn) btn.classList.remove('open');
      if (menu) menu.classList.remove('open');
      document.body.style.overflow = '';
    }

    function toggleMobileSub(el) {
      const item = el.parentElement;
      const wasOpen = item.classList.contains('m-open');
      document.querySelectorAll('.mobile-nav-item.m-open').forEach(i => i.classList.remove('m-open'));
      if (!wasOpen) item.classList.add('m-open');
    }

    function escapeClientHtml(value) {
      return String(value).replace(/[&<>"']/g, ch => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[ch]));
    }

    (function syncHeaderAuth() {
      const name = localStorage.getItem('user_name');
      const token = localStorage.getItem('user_token');
      const authEl = document.getElementById('header-auth');
      if (!name || !token || !authEl) return;
      const initials = name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase();
      const safeName = escapeClientHtml(name);
      authEl.innerHTML =
        '<div class="user-dropdown-wrap" id="user-dropdown-wrap">' +
          '<button class="user-trigger" onclick="toggleUserMenu()" type="button">' +
            '<span class="user-avatar">' + initials + '</span>' +
            '<span class="user-name">' + safeName + '</span>' +
            '<span class="user-caret">▾</span>' +
          '</button>' +
          '<div class="user-menu" id="user-menu">' +
            '<a href="/profile.html">👤 Trang cá nhân</a>' +
            '<a href="/dung-thu.html">🚀 Dùng thử</a>' +
            '<button onclick="userLogout()" type="button">Đăng xuất</button>' +
          '</div>' +
        '</div>';
    })();

    function toggleUserMenu() {
      const menu = document.getElementById('user-menu');
      if (menu) menu.classList.toggle('open');
    }

    function userLogout() {
      localStorage.removeItem('user_token');
      localStorage.removeItem('user_name');
      window.location.reload();
    }

    document.addEventListener('click', (e) => {
      const mobileMenu = document.getElementById('mobile-menu');
      const mobileBtn = document.getElementById('hamburger-btn');
      if (mobileMenu && mobileBtn && mobileMenu.classList.contains('open') &&
          !mobileMenu.contains(e.target) && !mobileBtn.contains(e.target)) {
        closeMobileMenu();
      }

      const userWrap = document.getElementById('user-dropdown-wrap');
      if (userWrap && !userWrap.contains(e.target)) {
        const userMenu = document.getElementById('user-menu');
        if (userMenu) userMenu.classList.remove('open');
      }
    });

    window.addEventListener('resize', () => {
      if (window.innerWidth > 960) closeMobileMenu();
    });
  </script>`;
}

const PRODUCT_DETAIL_PAGES = [
  {
    slug: 'zalo-sales-agent',
    name: 'Zalo Sales Agent',
    icon: '💬',
    category: 'Bán hàng',
    description: 'AI Agent tự động tư vấn, chốt đơn và chăm sóc khách hàng trên Zalo OA 24/7 cho doanh nghiệp bán hàng.',
    summary: 'Phù hợp với shop online, chuỗi bán lẻ và đội kinh doanh cần phản hồi khách nhanh, không bỏ sót hội thoại, đồng bộ đơn hàng và chăm sóc lại sau mua.',
    stats: [['3 giây', 'phản hồi tin nhắn'], ['24/7', 'tư vấn tự động'], ['320+', 'doanh nghiệp dùng']],
    features: ['Tự động trả lời câu hỏi thường gặp theo dữ liệu sản phẩm, giá và chính sách bán hàng.', 'Gợi ý sản phẩm phù hợp theo nhu cầu khách hàng trong hội thoại.', 'Thu thập thông tin giao hàng, tạo đơn nháp và chuyển cho đội bán hàng khi cần.', 'Gửi tin nhắn chăm sóc sau mua, nhắc tái mua và xử lý phản hồi cơ bản.'],
    workflow: ['Kết nối Zalo OA và nguồn dữ liệu sản phẩm.', 'Huấn luyện kịch bản tư vấn, chính sách bán hàng và tone trả lời.', 'Agent phản hồi, chốt thông tin và ghi nhận lead/đơn hàng.', 'Đội kinh doanh theo dõi các hội thoại cần can thiệp trong dashboard.'],
    integrations: ['Zalo OA', 'Website', 'CRM', 'Google Sheet', 'Phần mềm bán hàng'],
    useCases: ['Shop online có nhiều tin nhắn hỏi giá.', 'Doanh nghiệp chạy quảng cáo kéo khách về Zalo.', 'Đội chăm sóc khách cần tự động hóa sau mua.']
  },
  {
    slug: 'order-management-agent',
    name: 'Order Management Agent',
    icon: '📦',
    category: 'Vận hành',
    description: 'Tự động tiếp nhận, chuẩn hóa và điều phối đơn hàng từ nhiều kênh về một luồng xử lý thống nhất.',
    summary: 'Giúp đội vận hành giảm nhập liệu thủ công, hạn chế sai sót khi tổng hợp đơn từ Shopee, Lazada, Website, Zalo và các kênh bán khác.',
    stats: [['5+', 'kênh đơn hàng'], ['1 luồng', 'xử lý tập trung'], ['210+', 'doanh nghiệp dùng']],
    features: ['Gom đơn từ nhiều kênh và chuẩn hóa thông tin khách hàng, sản phẩm, phí giao hàng.', 'Kiểm tra trạng thái tồn kho hoặc dữ liệu đơn trùng trước khi chuyển xử lý.', 'Tự động gửi xác nhận đơn, hướng dẫn thanh toán và trạng thái giao hàng.', 'Tạo cảnh báo khi thiếu hàng, sai thông tin hoặc đơn cần xử lý thủ công.'],
    workflow: ['Kết nối các kênh bán hàng hiện tại.', 'Thiết lập quy tắc kiểm tra đơn, kho và trạng thái thanh toán.', 'Agent gom đơn, chuẩn hóa dữ liệu và chuyển đến đội xử lý.', 'Báo cáo tình trạng đơn theo ngày, kênh và trạng thái.'],
    integrations: ['Shopee', 'Lazada', 'Website', 'Zalo', 'Google Sheet', 'Phần mềm kho'],
    useCases: ['Shop xử lý nhiều đơn mỗi ngày.', 'Doanh nghiệp bán đa kênh cần giảm sai sót nhập liệu.', 'Đội kho cần nhận đơn sạch và đúng trạng thái.']
  },
  {
    slug: 'crm-automation-agent',
    name: 'CRM Automation Agent',
    icon: '🤝',
    category: 'Bán hàng',
    description: 'Tự động phân loại khách hàng, nhắc lịch chăm sóc và cá nhân hóa ưu đãi theo hành vi mua hàng.',
    summary: 'Biến CRM thành hệ thống chủ động: tự nhắc việc, tự phân nhóm khách, tự gợi ý hành động tiếp theo cho sales và chăm sóc khách hàng.',
    stats: [['180+', 'doanh nghiệp dùng'], ['Tự động', 'phân nhóm khách'], ['Đúng lúc', 'nhắc chăm sóc']],
    features: ['Chấm điểm lead dựa trên nguồn, mức độ quan tâm và lịch sử tương tác.', 'Tạo lịch nhắc chăm sóc theo chu kỳ mua hàng hoặc trạng thái giao dịch.', 'Gợi ý ưu đãi cá nhân hóa cho từng nhóm khách.', 'Đồng bộ ghi chú, hội thoại và lịch sử mua hàng vào hồ sơ khách.'],
    workflow: ['Nhập hoặc đồng bộ dữ liệu khách hàng hiện có.', 'Cấu hình nhóm khách, trạng thái lead và quy tắc chăm sóc.', 'Agent tự cập nhật hồ sơ, nhắc việc và đề xuất nội dung liên hệ.', 'Quản lý theo dõi tỷ lệ chuyển đổi và hiệu quả chăm sóc.'],
    integrations: ['CRM nội bộ', 'Zalo', 'Email', 'Google Sheet', 'Website form'],
    useCases: ['Đội sales cần nhắc lịch chăm sóc tự động.', 'Doanh nghiệp có khách mua lặp lại.', 'Cần phân nhóm khách để chạy ưu đãi chính xác hơn.']
  },
  {
    slug: 'report-analytics-agent',
    name: 'Report & Analytics Agent',
    icon: '📊',
    category: 'Phân tích',
    description: 'Tổng hợp dữ liệu đa nguồn, tạo báo cáo tự động và gửi thông tin quan trọng vào đúng thời điểm.',
    summary: 'Thay việc tổng hợp thủ công mỗi sáng bằng một Agent tự gom số liệu, phát hiện biến động và gửi báo cáo dễ đọc qua email hoặc Zalo.',
    stats: [['8:00', 'gửi báo cáo sáng'], ['20+', 'nguồn dữ liệu'], ['95+', 'doanh nghiệp dùng']],
    features: ['Kết nối dữ liệu bán hàng, quảng cáo, CRM, kho và file báo cáo.', 'Tạo báo cáo theo mẫu: doanh thu, đơn hàng, sản phẩm bán chạy, hiệu suất kênh.', 'Gửi cảnh báo khi doanh thu giảm, tồn kho thấp hoặc chi phí quảng cáo bất thường.', 'Cho phép hỏi nhanh số liệu bằng ngôn ngữ tự nhiên.'],
    workflow: ['Xác định chỉ số cần theo dõi và nguồn dữ liệu.', 'Thiết lập lịch gửi báo cáo, người nhận và mẫu trình bày.', 'Agent tự lấy dữ liệu, tổng hợp và kiểm tra bất thường.', 'Báo cáo được gửi qua kênh bạn chọn.'],
    integrations: ['Google Sheet', 'CRM', 'Facebook Ads', 'Email', 'Zalo', 'Phần mềm bán hàng'],
    useCases: ['Chủ doanh nghiệp muốn xem số liệu mỗi sáng.', 'Đội marketing cần theo dõi hiệu quả kênh.', 'Quản lý vận hành cần cảnh báo bất thường sớm.']
  },
  {
    slug: 'email-marketing-agent',
    name: 'Email Marketing Agent',
    icon: '📧',
    category: 'Marketing',
    description: 'Lên lịch, cá nhân hóa và gửi email marketing tự động theo hành vi người dùng.',
    summary: 'Agent hỗ trợ tạo chuỗi email chăm sóc, phân nhóm khách và tối ưu nội dung để nuôi dưỡng lead, kích hoạt mua lại và giảm churn.',
    stats: [['60+', 'doanh nghiệp dùng'], ['Cá nhân hóa', 'theo hành vi'], ['Tự động', 'gửi theo lịch']],
    features: ['Phân nhóm danh sách theo nguồn lead, hành vi mua hàng và mức độ tương tác.', 'Tạo chuỗi email chào mừng, nuôi dưỡng, nhắc giỏ hàng và tái mua.', 'Cá nhân hóa tiêu đề, nội dung và ưu đãi theo từng nhóm khách.', 'Theo dõi mở email, click, phản hồi và đề xuất tối ưu chiến dịch.'],
    workflow: ['Đồng bộ danh sách khách hàng và lịch sử tương tác.', 'Chọn mục tiêu chiến dịch và nhóm khách nhận email.', 'Agent đề xuất nội dung, lịch gửi và tiêu chí dừng.', 'Theo dõi hiệu quả và tự đề xuất vòng tối ưu tiếp theo.'],
    integrations: ['Email SMTP', 'CRM', 'Website form', 'Google Sheet', 'Landing page'],
    useCases: ['Nuôi dưỡng lead sau khi đăng ký form.', 'Gửi ưu đãi cá nhân hóa cho khách cũ.', 'Tự động nhắc khách hoàn tất đơn hàng.']
  },
  {
    slug: 'facebook-ads-agent',
    name: 'Facebook Ads Agent',
    icon: '🏭',
    category: 'Marketing',
    description: 'Theo dõi chiến dịch Facebook Ads, báo cáo ROAS và đề xuất điều chỉnh ngân sách.',
    summary: 'Giúp đội marketing đọc nhanh hiệu quả quảng cáo, phát hiện nhóm quảng cáo kém và nhận đề xuất tối ưu dựa trên dữ liệu chuyển đổi.',
    stats: [['140+', 'doanh nghiệp dùng'], ['ROAS', 'báo cáo tự động'], ['Theo ngày', 'đề xuất tối ưu']],
    features: ['Tổng hợp chi phí, lead, đơn hàng, CPA, ROAS theo chiến dịch và nhóm quảng cáo.', 'Phát hiện quảng cáo tụt hiệu quả hoặc ngân sách tiêu không cân đối.', 'Đề xuất tăng, giảm hoặc tạm dừng ngân sách theo mục tiêu kinh doanh.', 'Tạo báo cáo ngắn gọn cho chủ doanh nghiệp hoặc trưởng nhóm marketing.'],
    workflow: ['Kết nối tài khoản quảng cáo và nguồn dữ liệu chuyển đổi.', 'Chọn chỉ số mục tiêu như CPA, ROAS hoặc số lead.', 'Agent theo dõi biến động và gửi báo cáo định kỳ.', 'Đội marketing duyệt đề xuất trước khi điều chỉnh chiến dịch.'],
    integrations: ['Facebook Ads', 'Website Pixel', 'CRM', 'Google Sheet', 'Zalo'],
    useCases: ['Shop chạy quảng cáo chuyển đổi mỗi ngày.', 'Agency cần báo cáo nhanh cho nhiều chiến dịch.', 'Doanh nghiệp muốn kiểm soát ngân sách tốt hơn.']
  },
  {
    slug: 'booking-appointment-agent',
    name: 'Booking & Appointment',
    icon: '🗓️',
    category: 'Vận hành',
    description: 'Tự động nhận lịch hẹn, xác nhận và nhắc khách trước giờ hẹn cho các mô hình dịch vụ.',
    summary: 'Phù hợp spa, clinic, phòng khám, studio, tư vấn và các dịch vụ B2C cần giảm bỏ lỡ lịch hẹn và giảm tải cho lễ tân.',
    stats: [['75+', 'doanh nghiệp dùng'], ['Tự động', 'xác nhận lịch'], ['Giảm', 'khách quên hẹn']],
    features: ['Tư vấn khung giờ trống và ghi nhận thông tin đặt lịch từ khách hàng.', 'Tự động xác nhận, đổi lịch hoặc hủy lịch theo quy tắc đã thiết lập.', 'Nhắc khách trước giờ hẹn qua Zalo, SMS hoặc email.', 'Tổng hợp lịch theo nhân viên, chi nhánh, dịch vụ và trạng thái.'],
    workflow: ['Kết nối lịch làm việc, dịch vụ và khung giờ trống.', 'Thiết lập quy tắc xác nhận, đổi lịch, hủy lịch và nhắc lịch.', 'Agent nhận yêu cầu đặt lịch từ khách và cập nhật hệ thống.', 'Nhân viên xem lịch hẹn đã được chuẩn hóa trong dashboard.'],
    integrations: ['Google Calendar', 'Zalo', 'Website form', 'CRM', 'SMS/Email'],
    useCases: ['Spa và thẩm mỹ viện cần tự động nhắc hẹn.', 'Phòng khám có nhiều lịch tư vấn.', 'Dịch vụ B2C nhận booking từ nhiều kênh.']
  },
  {
    slug: 'custom-enterprise-agent',
    name: 'Custom Enterprise Agent',
    icon: '🏗️',
    category: 'Tùy chỉnh',
    description: 'Xây dựng AI Agent theo nghiệp vụ đặc thù, tích hợp với hệ thống nội bộ và quy trình riêng.',
    summary: 'Dành cho doanh nghiệp có quy trình phức tạp, dữ liệu riêng hoặc nhu cầu tích hợp sâu với ERP, CRM, kho, kế toán và hệ thống vận hành nội bộ.',
    stats: [['Tùy chỉnh', 'theo nghiệp vụ'], ['Đa hệ thống', 'tích hợp sâu'], ['Enterprise', 'quy mô triển khai']],
    features: ['Phân tích quy trình hiện tại và thiết kế Agent theo từng vai trò nghiệp vụ.', 'Kết nối API, database, file nội bộ và phần mềm doanh nghiệp đang dùng.', 'Thiết lập quyền truy cập, kiểm duyệt hành động và nhật ký vận hành.', 'Triển khai theo giai đoạn để kiểm soát rủi ro và đo hiệu quả rõ ràng.'],
    workflow: ['Khảo sát nghiệp vụ, dữ liệu và mục tiêu tự động hóa.', 'Thiết kế luồng Agent, quyền truy cập và tiêu chí đánh giá.', 'Tích hợp hệ thống, kiểm thử trong môi trường giới hạn.', 'Mở rộng triển khai và tối ưu theo dữ liệu thực tế.'],
    integrations: ['ERP', 'CRM', 'Database nội bộ', 'API riêng', 'Kho/Kế toán', 'Zalo/Email'],
    useCases: ['Doanh nghiệp cần tự động hóa quy trình riêng.', 'Cần tích hợp nhiều hệ thống nội bộ.', 'Muốn triển khai AI Agent có kiểm soát bảo mật và phân quyền.']
  }
];

const PRODUCT_DETAIL_BY_SLUG = Object.fromEntries(PRODUCT_DETAIL_PAGES.map(page => [page.slug, page]));

function renderProductList(items) {
  return items.map(item => `<li>${escapeHtml(item)}</li>`).join('');
}

function renderProductDetailPage(product) {
  const siteUrl = SITE_URL;
  const absoluteUrl = `${siteUrl}/cong-cu/${product.slug}`;
  const title = `${product.name} | VIAi`;
  const desc = product.description;
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: product.name,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: desc,
    url: absoluteUrl,
    provider: { '@type': 'Organization', name: 'VIAi', url: siteUrl }
  };
  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Trang chủ', item: siteUrl },
      { '@type': 'ListItem', position: 2, name: 'Công cụ', item: `${siteUrl}/cong-cu` },
      { '@type': 'ListItem', position: 3, name: product.name, item: absoluteUrl },
    ],
  };

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/png" href="/anhlogo/logo2.png" />
  <link rel="shortcut icon" href="/anhlogo/logo2.png" />
  <link rel="apple-touch-icon" href="/anhlogo/logo2.png" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet" />
  <meta name="description" content="${escapeHtml(desc)}" />
  <link rel="canonical" href="${escapeHtml(absoluteUrl)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="VIAi" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(desc)}" />
  <meta property="og:url" content="${escapeHtml(absoluteUrl)}" />
  <meta property="og:image" content="${siteUrl}/anhlogo/logo2.png" />
  <script type="application/ld+json">${jsonLd(schema)}</script>
  <script type="application/ld+json">${jsonLd(breadcrumbSchema)}</script>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--primary:#1A56DB;--primary-dark:#1040B0;--primary-light:#4B82F4;--accent:#FF6B00;--accent-light:#FF8C38;--green:#00B341;--yellow:#FFB800;--gray-50:#EEF3FF;--gray-100:#DBEAFE;--gray-300:#6B93E8;--gray-600:#1E3A8A;--gray-900:#0F172A}
    html{scroll-behavior:smooth}
    body{font-family:'Be Vietnam Pro',Arial,sans-serif;color:var(--gray-900);background:white;line-height:1.7;overflow-x:hidden}
    a{text-decoration:none;color:inherit}
    .site-header{position:sticky;top:0;z-index:999;background:white;border-bottom:2px solid var(--primary);box-shadow:0 2px 12px rgba(26,86,219,.08)}
    .header-inner{max-width:1240px;margin:0 auto;padding:0 24px;height:80px;display:flex;align-items:center;justify-content:space-between;gap:24px}
    .site-logo{display:flex;align-items:center;flex-shrink:0}.logo-img{height:150px;width:auto;object-fit:contain;display:block;mix-blend-mode:multiply}
    .main-nav{flex:1;display:flex;align-items:center;justify-content:center;gap:4px}.nav-item{position:relative}
    .nav-item>a{display:flex;align-items:center;gap:4px;padding:8px 14px;font-size:.9rem;font-weight:600;text-transform:uppercase;color:var(--gray-600);border-radius:8px;transition:all .2s;white-space:nowrap;position:relative}
    .nav-item>a::after{content:'';position:absolute;bottom:2px;left:14px;right:14px;height:2.5px;background:var(--primary);border-radius:2px;transform:scaleX(0);opacity:0;transition:transform .25s ease,opacity .25s ease;transform-origin:left center}
    .nav-item>a:hover,.nav-item.nav-active>a{color:var(--primary);background:var(--gray-50)}.nav-item>a:hover::after,.nav-item.nav-active>a::after{transform:scaleX(1);opacity:1}
    .nav-item>a .arrow{font-size:.65rem;transition:transform .2s}.nav-item:hover>a .arrow{transform:rotate(180deg)}
    .dropdown{display:block;position:absolute;top:calc(100% + 4px);left:0;min-width:220px;background:white;border:1px solid rgba(26,86,219,.1);border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,.04),0 20px 50px rgba(26,86,219,.14);padding:10px;z-index:100;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(-8px);transition:opacity .25s ease,visibility .25s ease,transform .25s cubic-bezier(.16,1,.3,1)}
    .dropdown::before{content:'';position:absolute;top:-6px;left:20px;width:12px;height:12px;background:white;border-left:1px solid rgba(26,86,219,.1);border-top:1px solid rgba(26,86,219,.1);transform:rotate(45deg);border-radius:2px 0 0 0}
    .nav-item:hover .dropdown,.nav-item:focus-within .dropdown{opacity:1;visibility:visible;pointer-events:auto;transform:translateY(0)}
    .dropdown a{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;font-size:.85rem;font-weight:500;color:var(--gray-600);transition:all .18s ease}.dropdown a:hover{background:var(--gray-50);color:var(--primary);transform:translateX(3px)}
    .dropdown a .dd-icon{font-size:1.1rem;flex-shrink:0}.dropdown-mega{min-width:480px;display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:14px}.dropdown-mega::before{left:50%;transform:translateX(-50%) rotate(45deg)}.mega-title{grid-column:1/-1;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--gray-300);padding:4px 14px 8px;border-bottom:1px solid var(--gray-100);margin-bottom:4px}
    .header-actions{display:flex;align-items:center;gap:10px;flex-shrink:0}.btn-login{display:inline-flex;align-items:center;justify-content:center;padding:8px 18px;border:2px solid var(--primary);border-radius:8px;font-size:.85rem;font-weight:700;color:var(--primary);transition:all .2s;background:white}.btn-login:hover{background:var(--primary);color:white}.btn-register{display:inline-flex;align-items:center;justify-content:center;padding:8px 18px;background:var(--accent);border-radius:8px;font-size:.85rem;font-weight:700;color:white;transition:all .2s;box-shadow:0 4px 14px rgba(255,107,74,.35)}.btn-register:hover{background:var(--accent-light);transform:translateY(-1px)}
    .hamburger-btn{display:none;flex-direction:column;justify-content:center;gap:5px;width:40px;height:40px;background:none;border:none;cursor:pointer;padding:6px;border-radius:8px;transition:background .2s;flex-shrink:0}.hamburger-btn:hover{background:var(--gray-50)}.hamburger-btn span{display:block;width:22px;height:2.5px;background:var(--gray-600);border-radius:2px;transition:all .3s ease}.hamburger-btn.open span:nth-child(1){transform:translateY(7.5px) rotate(45deg)}.hamburger-btn.open span:nth-child(2){opacity:0;transform:scaleX(0)}.hamburger-btn.open span:nth-child(3){transform:translateY(-7.5px) rotate(-45deg)}
    .mobile-menu{display:none;position:fixed;top:80px;left:0;right:0;background:white;border-top:2px solid var(--primary);box-shadow:0 8px 32px rgba(0,0,0,.12);z-index:998;padding:16px 20px 24px;max-height:calc(100vh - 80px);overflow-y:auto}.mobile-menu.open{display:block}.mobile-nav-item{border-bottom:1px solid #f1f5f9}.mobile-nav-link{width:100%;display:flex;align-items:center;justify-content:space-between;padding:14px 4px;font-size:.95rem;font-weight:700;color:var(--gray-600);cursor:pointer;background:none;border:none;font-family:inherit;text-align:left}.mobile-nav-link .m-arrow{font-size:.65rem;color:var(--gray-300)}.mobile-nav-item.m-open .m-arrow{transform:rotate(180deg)}.mobile-submenu{display:none;padding:0 0 8px 12px}.mobile-nav-item.m-open .mobile-submenu{display:block}.mobile-submenu a{display:flex;align-items:center;gap:10px;padding:10px 8px;font-size:.88rem;font-weight:500;color:var(--gray-600);border-radius:8px}.mobile-plain-link{display:block;padding:14px 4px;font-size:.95rem;font-weight:700;color:var(--gray-600);border-bottom:1px solid #f1f5f9}.mobile-menu-actions{display:flex;flex-direction:column;gap:10px;margin-top:20px}.mobile-menu-actions .btn-login,.mobile-menu-actions .btn-register{text-align:center;padding:12px;font-size:.95rem}
    .user-dropdown-wrap{position:relative;display:inline-block}.user-trigger{display:flex;align-items:center;gap:8px;background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:8px;font-family:inherit}.user-trigger:hover{background:var(--gray-50)}.user-avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--primary-light));color:white;font-size:.78rem;font-weight:800;display:flex;align-items:center;justify-content:center}.user-name{font-size:.85rem;font-weight:700;color:var(--gray-600);max-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.user-caret{font-size:.6rem;color:var(--gray-300)}.user-menu{display:none;position:absolute;top:calc(100% + 8px);right:0;background:white;border:1px solid var(--gray-100);border-radius:12px;box-shadow:0 16px 40px rgba(26,86,219,.12);padding:8px;min-width:180px;z-index:1000}.user-menu.open{display:block}.user-menu a,.user-menu button{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;font-size:.85rem;font-weight:600;color:var(--gray-600);background:none;border:none;cursor:pointer;width:100%;font-family:inherit;text-align:left}.user-menu button{color:#E52222;border-top:1px solid var(--gray-100);margin-top:4px}
    .product-hero{background:linear-gradient(135deg,#0F172A 0%,#1A56DB 62%,#FF6B00 100%);color:white;padding:76px 20px;position:relative;overflow:hidden}.product-hero::after{content:'';position:absolute;width:460px;height:460px;border-radius:50%;background:rgba(255,255,255,.08);right:-120px;top:-170px}.hero-inner{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1.05fr) 420px;gap:56px;align-items:center;position:relative;z-index:1}.eyebrow{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.13);border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:6px 14px;font-size:.78rem;font-weight:800;text-transform:uppercase;letter-spacing:.8px;margin-bottom:20px}.product-hero h1{font-size:clamp(2.1rem,4vw,4rem);line-height:1.1;font-weight:900;margin-bottom:18px}.lead{font-size:1.08rem;max-width:720px;color:rgba(255,255,255,.86)}.hero-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}.primary-cta,.secondary-cta{display:inline-flex;align-items:center;justify-content:center;padding:13px 22px;border-radius:8px;font-weight:800;font-size:.92rem}.primary-cta{background:#FF6B00;color:white;box-shadow:0 10px 28px rgba(255,107,0,.35)}.secondary-cta{border:1.5px solid rgba(255,255,255,.42);color:white;background:rgba(255,255,255,.08)}
    .hero-panel{background:white;color:var(--gray-900);border-radius:14px;padding:24px;border:1px solid rgba(255,255,255,.5);box-shadow:0 30px 90px rgba(0,0,0,.22)}.panel-top{display:flex;align-items:center;gap:14px;margin-bottom:20px}.big-icon{width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,rgba(26,86,219,.12),rgba(255,107,0,.09));display:flex;align-items:center;justify-content:center;font-size:2rem}.panel-name{font-size:1.05rem;font-weight:900}.panel-cat{font-size:.78rem;color:var(--gray-300);font-weight:700}.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.stat{background:var(--gray-50);border:1px solid var(--gray-100);border-radius:10px;padding:12px;text-align:center}.stat strong{display:block;font-size:1rem;color:var(--primary);line-height:1.1}.stat span{display:block;font-size:.68rem;color:var(--gray-600);line-height:1.35;margin-top:5px}
    .section{padding:72px 20px}.section.alt{background:#F7FAFF}.inner{max-width:1180px;margin:0 auto}.two-col{display:grid;grid-template-columns:.92fr 1.08fr;gap:56px;align-items:start}.section-tag{font-size:.75rem;font-weight:900;text-transform:uppercase;letter-spacing:1.2px;color:var(--primary);margin-bottom:10px}.section h2{font-size:clamp(1.55rem,2.4vw,2.35rem);line-height:1.18;margin-bottom:16px}.section p{color:#334155;font-size:.98rem}.feature-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}.feature-card{border:1px solid var(--gray-100);border-radius:10px;padding:18px;background:white}.feature-card strong{display:block;color:var(--gray-900);font-size:.98rem;margin-bottom:6px}.feature-card p{font-size:.88rem}.list{display:grid;gap:12px;list-style:none}.list li{background:white;border:1px solid var(--gray-100);border-radius:10px;padding:14px 16px;color:#334155;font-weight:600}.workflow{counter-reset:step;display:grid;gap:14px}.workflow li{list-style:none;position:relative;background:white;border:1px solid var(--gray-100);border-radius:10px;padding:16px 16px 16px 56px;color:#334155}.workflow li::before{counter-increment:step;content:counter(step);position:absolute;left:16px;top:16px;width:26px;height:26px;border-radius:50%;background:var(--primary);color:white;font-size:.8rem;font-weight:900;display:flex;align-items:center;justify-content:center}.chips{display:flex;flex-wrap:wrap;gap:10px}.chip{border:1px solid var(--gray-100);background:white;color:var(--gray-600);font-size:.85rem;font-weight:700;padding:8px 12px;border-radius:999px}.cta-band{background:var(--gray-900);color:white;padding:58px 20px}.cta-inner{max-width:1180px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:28px}.cta-inner h2{font-size:clamp(1.5rem,2.6vw,2.5rem);line-height:1.2}.cta-inner p{color:rgba(255,255,255,.72);margin-top:8px;max-width:640px}
    @media(max-width:960px){.main-nav,.header-actions{display:none}.hamburger-btn{display:flex}.hero-inner,.two-col{grid-template-columns:1fr}.hero-panel{max-width:520px}.cta-inner{flex-direction:column;align-items:flex-start}}
    @media(max-width:640px){.header-inner{padding:0 18px}.logo-img{height:132px}.product-hero{padding:52px 18px}.section{padding:52px 18px}.feature-grid,.stat-grid{grid-template-columns:1fr}.hero-actions{flex-direction:column}.primary-cta,.secondary-cta{width:100%}}
    /* CTA animations */
    @keyframes cta-pulse-ring{0%{box-shadow:0 0 0 0 rgba(255,107,0,.55)}70%{box-shadow:0 0 0 14px rgba(255,107,0,0)}100%{box-shadow:0 0 0 0 rgba(255,107,0,0)}}
    .cta-pulse{animation:cta-pulse-ring 2.2s cubic-bezier(.4,0,.6,1) infinite}.cta-pulse:hover{animation-play-state:paused}
    .cta-shimmer{position:relative;overflow:hidden;isolation:isolate}.cta-shimmer::after{content:'';position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.28) 50%,transparent 70%);transform:translateX(-100%);transition:transform .8s ease;pointer-events:none}.cta-shimmer:hover::after{transform:translateX(100%)}
    .cta-glow{box-shadow:0 8px 26px -6px rgba(255,107,0,.58)}
    @keyframes arrow-b{0%,100%{transform:translateX(0)}50%{transform:translateX(4px)}}
    .cta-arrow{display:inline-block;animation:arrow-b 1.4s ease-in-out infinite}
    /* Sticky bar mobile */
    .sticky-cu{display:none;position:fixed;bottom:0;left:0;right:0;background:white;border-top:1px solid #e2e8f0;box-shadow:0 -4px 16px rgba(0,0,0,.08);padding:10px 16px;z-index:990;align-items:center;gap:10px}
    .sticky-cu-name{flex:1;font-size:.88rem;font-weight:800;color:#0F172A}
    @media(max-width:480px){.sticky-cu{display:flex}.product-hero{padding-bottom:80px}}
  </style>
</head>
<body>
  ${renderSiteToolbar('products')}
  <section class="product-hero">
    <div class="hero-inner">
      <div>
        <nav style="display:flex;align-items:center;gap:6px;font-size:.78rem;color:rgba(255,255,255,.6);margin-bottom:16px;flex-wrap:wrap" aria-label="Breadcrumb">
          <a href="/" style="color:rgba(255,255,255,.6);transition:color .2s" onmouseover="this.style.color='#FFB800'" onmouseout="this.style.color='rgba(255,255,255,.6)'">Trang chủ</a>
          <span style="color:rgba(255,255,255,.35);font-size:.65rem">›</span>
          <a href="/san-pham.html" style="color:rgba(255,255,255,.6)">Công cụ</a>
          <span style="color:rgba(255,255,255,.35);font-size:.65rem">›</span>
          <span style="color:rgba(255,255,255,.9)">${escapeHtml(product.name)}</span>
        </nav>
        <div class="eyebrow">${escapeHtml(product.icon)} ${escapeHtml(product.category)}</div>
        <h1>${escapeHtml(product.name)}</h1>
        <p class="lead">${escapeHtml(product.description)}</p>
        <div class="hero-actions">
          <a class="primary-cta cta-pulse cta-shimmer cta-glow" href="/dung-thu.html">Đăng ký tư vấn <span class="cta-arrow">→</span></a>
          <a class="secondary-cta" href="/san-pham.html">← Xem công cụ khác</a>
        </div>
      </div>
      <aside class="hero-panel">
        <div class="panel-top">
          <div class="big-icon">${escapeHtml(product.icon)}</div>
          <div>
            <div class="panel-name">${escapeHtml(product.name)}</div>
            <div class="panel-cat">VIAi AI Agent</div>
          </div>
        </div>
        <div class="stat-grid">
          ${product.stats.map(([value, label]) => `<div class="stat"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join('')}
        </div>
      </aside>
    </div>
  </section>

  <section class="section">
    <div class="inner two-col">
      <div>
        <div class="section-tag">Tổng quan</div>
        <h2>Công cụ này giải quyết việc gì?</h2>
        <p>${escapeHtml(product.summary)}</p>
      </div>
      <div class="feature-grid">
        ${product.features.map((feature, index) => `<div class="feature-card"><strong>Tính năng ${index + 1}</strong><p>${escapeHtml(feature)}</p></div>`).join('')}
      </div>
    </div>
  </section>

  <section class="section alt">
    <div class="inner two-col">
      <div>
        <div class="section-tag">Quy trình</div>
        <h2>Cách Agent vận hành</h2>
        <ol class="workflow">${renderProductList(product.workflow)}</ol>
      </div>
      <div>
        <div class="section-tag">Phù hợp cho</div>
        <h2>Nên dùng khi nào?</h2>
        <ul class="list">${renderProductList(product.useCases)}</ul>
      </div>
    </div>
  </section>

  <section class="section">
    <div class="inner">
      <div class="section-tag">Tích hợp</div>
      <h2>Kết nối với hệ thống đang dùng</h2>
      <div class="chips">${product.integrations.map(item => `<span class="chip">${escapeHtml(item)}</span>`).join('')}</div>
    </div>
  </section>

  <section class="cta-band">
    <div class="cta-inner">
      <div>
        <h2>Muốn triển khai ${escapeHtml(product.name)}?</h2>
        <p>VIAi có thể khảo sát quy trình hiện tại và đề xuất cấu hình Agent phù hợp cho doanh nghiệp của bạn.</p>
      </div>
      <a class="primary-cta cta-pulse cta-shimmer cta-glow" href="/dung-thu.html">Dùng thử FREE <span class="cta-arrow">→</span></a>
    </div>
  </section>

  <!-- Sticky bar mobile -->
  <div class="sticky-cu" aria-hidden="true">
    <div class="sticky-cu-name">${escapeHtml(product.name)}</div>
    <a href="/dung-thu.html" style="border:2px solid #1A56DB;border-radius:8px;padding:8px 14px;font-size:.82rem;font-weight:700;color:#1A56DB">Tư vấn</a>
    <a href="/dung-thu.html" class="primary-cta cta-glow" style="padding:9px 16px;font-size:.82rem">Dùng thử FREE</a>
  </div>
  ${renderSiteToolbarScript()}
</body>
</html>`;
}

const PRODUCT_DETAILS = {
  'zalo-sales-agent': {
    eyebrow: '💬 Bán hàng Zalo', hero: 'Tư vấn & chốt đơn 24/7 qua Zalo OA',
    heroDesc: 'AI Agent tự động trả lời khách hàng, gửi báo giá và chốt đơn qua Zalo Official Account — không cần nhân viên trực, hoạt động 24/7.',
    image: 'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=900&q=80',
    features: [
      { icon: '⚡', text: 'Phản hồi tức thì trong vòng 3 giây, 24/7 kể cả lễ tết' },
      { icon: '📋', text: 'Tự động gửi báo giá, catalog sản phẩm theo yêu cầu khách' },
      { icon: '🔀', text: 'Phân loại nhu cầu và chuyển khách đến đúng nhân viên' },
      { icon: '🔔', text: 'Nhắc lịch chăm sóc sau bán hàng, tái mua tự động' },
      { icon: '📊', text: 'Tổng hợp toàn bộ lịch sử hội thoại vào CRM' },
    ],
    example: {
      label: 'Shop thời trang online — 11 giờ đêm',
      steps: [
        { icon: '👤', role: 'Khách', msg: 'Bạn ơi áo polo xanh navy còn size L không? Giá bao nhiêu ạ?' },
        { icon: '🤖', role: 'AI Agent (3 giây)', msg: 'Dạ còn ạ! Áo polo Navy size L còn 8 chiếc. Giá 350.000đ, freeship đơn từ 500k. Bạn muốn đặt ngay không ạ? 😊' },
        { icon: '👤', role: 'Khách', msg: 'Cho mình 2 cái. Giao về Quận 7 nhé' },
        { icon: '🤖', role: 'AI Agent', msg: '✅ Đã tạo đơn #2847 — 2 áo polo Navy L = 700.000đ. Giao Q.7 dự kiến 2-3 ngày. Mình gửi link thanh toán nhé!' },
      ],
    },
    stats: [{ num: '320+', label: 'Doanh nghiệp đang dùng' }, { num: '40%', label: 'Tăng tỷ lệ chốt đơn' }, { num: '3 giây', label: 'Thời gian phản hồi' }],
    desc: 'Với hơn 75 triệu người dùng Zalo tại Việt Nam, đây là kênh bán hàng quan trọng nhất của SME. VIAi Zalo Sales Agent tự động hóa toàn bộ quy trình tư vấn và chốt đơn — từ lúc khách nhắn tin đến khi đơn hàng được tạo.',
    badge: 'HOT', badgeColor: '#FF6B00',
  },
  'order-management-agent': {
    eyebrow: '📦 Vận hành đơn hàng', hero: 'Xử lý đơn hàng đa kênh tự động',
    heroDesc: 'Tiếp nhận và xử lý đơn hàng từ Shopee, Lazada, Website, Zalo vào một hệ thống duy nhất. Tự động xác nhận, phân phối kho và cập nhật trạng thái.',
    image: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=900&q=80',
    features: [
      { icon: '🔗', text: 'Đồng bộ đơn hàng từ 10+ sàn: Shopee, Lazada, TikTok Shop, Website' },
      { icon: '✅', text: 'Tự động xác nhận đơn và thông báo khách qua Zalo/SMS' },
      { icon: '🏭', text: 'Phân bổ kho thông minh theo vị trí và tồn kho thực tế' },
      { icon: '🚚', text: 'Cập nhật trạng thái vận chuyển real-time cho khách hàng' },
      { icon: '📈', text: 'Báo cáo tồn kho và doanh số tự động hằng ngày' },
    ],
    example: {
      label: 'Shop mỹ phẩm — 200 đơn/ngày từ 3 sàn',
      steps: [
        { icon: '🛒', role: 'Shopee', msg: 'Đơn mới #SP-9921 — Son kem Laneige 2 hộp — 380.000đ — Q.Bình Thạnh' },
        { icon: '🤖', role: 'AI Agent (2 giây)', msg: 'Kiểm tra tồn kho kho HCM: còn 45 hộp ✓ → Phân bổ kho HCM → Tạo phiếu xuất kho → Đặt GHTK → Gửi mã tracking cho khách' },
        { icon: '📦', role: 'Kho HCM', msg: 'Nhận phiếu xuất #PX-0234 — đóng gói và bàn giao GHTK lúc 14:00' },
        { icon: '📱', role: 'Khách hàng', msg: 'Nhận Zalo: "Đơn #SP-9921 đã giao GHTK, mã vận đơn: GHN123456. Dự kiến 1-2 ngày"' },
      ],
    },
    stats: [{ num: '210+', label: 'Doanh nghiệp đang dùng' }, { num: '85%', label: 'Giảm lỗi xử lý đơn' }, { num: '2 giây', label: 'Xử lý mỗi đơn hàng' }],
    desc: 'Quản lý đơn hàng thủ công từ nhiều kênh gây ra sai sót, chậm trễ và mất khách. Order Management Agent tập trung toàn bộ đơn hàng vào một nơi và tự động xử lý từ A đến Z.',
    badge: 'PHỔ BIẾN', badgeColor: '#1A56DB',
  },
  'crm-automation-agent': {
    eyebrow: '🤝 CRM & Chăm sóc khách hàng', hero: 'Chăm sóc khách hàng cá nhân hóa tự động',
    heroDesc: 'Tự động phân loại khách hàng theo hành vi mua hàng, nhắc lịch chăm sóc định kỳ và gửi ưu đãi cá nhân hóa đúng thời điểm.',
    image: 'https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=900&q=80',
    features: [
      { icon: '🎯', text: 'Phân nhóm khách hàng tự động theo mô hình RFM' },
      { icon: '📅', text: 'Nhắc lịch chăm sóc và follow-up theo chu kỳ mua hàng' },
      { icon: '🎁', text: 'Gửi ưu đãi cá nhân hóa đúng thời điểm khách dễ mua lại' },
      { icon: '📌', text: 'Theo dõi vòng đời khách hàng từ mới → trung thành → VIP' },
      { icon: '📲', text: 'Tích hợp đa kênh: Zalo, Email, SMS cùng lúc' },
    ],
    example: {
      label: 'Shop nước hoa — tái kích hoạt khách cũ',
      steps: [
        { icon: '🤖', role: 'AI phân tích', msg: 'Khách Nguyễn Lan — mua 3 lần, lần cuối 45 ngày trước — chu kỳ mua TB: 40 ngày → Đến hạn chăm sóc' },
        { icon: '💌', role: 'AI gửi Zalo', msg: 'Lan ơi, hôm nay shop có ưu đãi 15% dành riêng cho bạn — chai Chanel số 5 bạn hay dùng đang giảm. Mua ngay trước 23:59 nhé! 🌸' },
        { icon: '👤', role: 'Khách Lan', msg: '(Click link) → Thêm vào giỏ hàng → Thanh toán 850.000đ' },
        { icon: '📊', role: 'CRM cập nhật', msg: 'Lan → Nâng hạng VIP — Thiết lập chiến dịch chăm sóc VIP — Nhắc lịch sau 35 ngày' },
      ],
    },
    stats: [{ num: '180+', label: 'Doanh nghiệp đang dùng' }, { num: '65%', label: 'Tăng tỷ lệ mua lại' }, { num: '92%', label: 'Khách hàng hài lòng' }],
    desc: 'Chăm sóc khách hàng đúng cách tăng doanh thu tái mua lên 65%. CRM Automation Agent giúp doanh nghiệp xây dựng mối quan hệ bền chặt với từng khách hàng — hoàn toàn tự động.',
    badge: null, badgeColor: null,
  },
  'report-analytics-agent': {
    eyebrow: '📊 Báo cáo & Phân tích', hero: 'Báo cáo tự động gửi lúc 8 giờ sáng mỗi ngày',
    heroDesc: 'Tổng hợp dữ liệu từ nhiều nguồn, tự động tạo báo cáo doanh thu, tồn kho, hiệu suất nhân viên và gửi qua Zalo hoặc Email mỗi sáng.',
    image: 'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=900&q=80',
    features: [
      { icon: '⏰', text: 'Báo cáo tự động gửi đúng 8:00 sáng mỗi ngày qua Zalo' },
      { icon: '🔌', text: 'Kết nối và tổng hợp dữ liệu từ 20+ nguồn khác nhau' },
      { icon: '📱', text: 'Dashboard realtime xem trực tiếp trên điện thoại bất kỳ lúc nào' },
      { icon: '🚨', text: 'Phát hiện bất thường và gửi cảnh báo ngay lập tức' },
      { icon: '💡', text: 'Gợi ý tối ưu từ AI dựa trên xu hướng dữ liệu thực tế' },
    ],
    example: {
      label: 'Chuỗi cửa hàng F&B — 5 chi nhánh',
      steps: [
        { icon: '⏰', role: '7:58 sáng', msg: 'AI Agent thu thập dữ liệu từ 5 POS, Google Sheets tồn kho, phần mềm nhân sự' },
        { icon: '🤖', role: '8:00 sáng — Zalo chủ', msg: '📊 Báo cáo hôm qua:\n• Doanh thu: 12.4tr (+8% so hôm qua)\n• Chi nhánh Quận 1 dẫn đầu: 3.2tr\n• Tồn kho cà phê sắp hết tại Q.7 ⚠️\n• 3 nhân viên vắng mặt không phép' },
        { icon: '🚨', role: '10:30 sáng — Cảnh báo', msg: 'Doanh thu Q.3 giảm 35% so TB — thấp bất thường. Đề xuất kiểm tra ca làm việc và máy POS' },
        { icon: '👤', role: 'Chủ cửa hàng', msg: 'Gọi điện cho quản lý Q.3 → Phát hiện máy POS lỗi từ sáng → Xử lý kịp thời' },
      ],
    },
    stats: [{ num: '95+', label: 'Doanh nghiệp đang dùng' }, { num: '4.2 giờ', label: 'Tiết kiệm mỗi ngày' }, { num: '100%', label: 'Dữ liệu tự động' }],
    desc: 'Không còn mất 30–60 phút mỗi sáng để tổng hợp số liệu. Report Agent tự động thu thập, phân tích và gửi báo cáo trước khi bạn bắt đầu ngày làm việc.',
    badge: 'MỚI', badgeColor: '#00B341',
  },
  'facebook-ads-agent': {
    eyebrow: '🏭 Marketing & Quảng cáo', hero: 'Tối ưu ngân sách quảng cáo Facebook tự động',
    heroDesc: 'Giám sát và tối ưu chiến dịch Facebook Ads theo thời gian thực. Tự động điều chỉnh ngân sách theo hiệu quả và gửi báo cáo ROAS hằng ngày.',
    image: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=900&q=80',
    features: [
      { icon: '👁️', text: 'Giám sát tất cả chiến dịch 24/7 theo thời gian thực' },
      { icon: '⚙️', text: 'Tự động điều chỉnh ngân sách và bid để tối ưu ROAS' },
      { icon: '🔔', text: 'Cảnh báo ngay khi CPA vượt ngưỡng hoặc ngân sách sắp hết' },
      { icon: '🎯', text: 'Phân tích và đề xuất điều chỉnh target audience hiệu quả hơn' },
      { icon: '📩', text: 'Báo cáo ROAS và hiệu quả chiến dịch gửi tự động mỗi ngày' },
    ],
    example: {
      label: 'Shop đồ gia dụng — ngân sách 5tr/ngày',
      steps: [
        { icon: '📉', role: '14:00 — Phát hiện', msg: 'Chiến dịch "Nồi cơm điện" CPA tăng từ 45k → 120k trong 2 giờ. ROAS giảm từ 4.2x → 1.8x' },
        { icon: '🤖', role: 'AI tự động xử lý', msg: 'Tạm dừng nhóm quảng cáo kém hiệu quả → Tăng budget 40% cho nhóm ROAS > 3.5x → Thay creative mới từ thư viện' },
        { icon: '📈', role: '16:00 — Kết quả', msg: 'ROAS phục hồi lên 3.8x — CPA về 52k — Doanh thu chiều tăng 65% so buổi sáng' },
        { icon: '📩', role: '20:00 — Báo cáo', msg: 'Zalo chủ shop: Hôm nay ROAS 3.6x, tiết kiệm 850k so ngân sách ban đầu, doanh thu +2.4tr' },
      ],
    },
    stats: [{ num: '140+', label: 'Doanh nghiệp đang dùng' }, { num: '35%', label: 'Giảm chi phí/đơn hàng' }, { num: '2.8x', label: 'Cải thiện ROAS trung bình' }],
    desc: 'Chi phí quảng cáo Facebook ngày càng tăng. Facebook Ads Agent tự động tối ưu từng chiến dịch để tăng hiệu quả và giảm chi phí — không cần chuyên gia marketing trực 24/7.',
    badge: null, badgeColor: null,
  },
  'booking-appointment': {
    eyebrow: '🗓️ Đặt lịch & Hẹn giờ', hero: 'Đặt lịch hẹn tự động 24/7',
    heroDesc: 'Tự động nhận lịch hẹn, xác nhận qua Zalo/SMS, nhắc nhở khách hàng trước 24 giờ và đồng bộ lịch với nhân viên. Phù hợp spa, phòng khám, dịch vụ B2C.',
    image: 'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=900&q=80',
    features: [
      { icon: '🕐', text: 'Nhận đặt lịch 24/7 qua Zalo, Website, Facebook Messenger' },
      { icon: '✉️', text: 'Tự động xác nhận lịch và gửi nhắc nhở trước 24 giờ' },
      { icon: '👩‍💼', text: 'Phân bổ lịch thông minh cho từng kỹ thuật viên/bác sĩ' },
      { icon: '🔄', text: 'Khách hủy/đổi lịch tự động — cập nhật ngay lập tức' },
      { icon: '📆', text: 'Đồng bộ lịch hai chiều với Google Calendar' },
    ],
    example: {
      label: 'Spa làm nail — 11 giờ đêm',
      steps: [
        { icon: '👤', role: 'Khách Hương', msg: 'Cho mình đặt lịch làm gel tay + chân thứ 6 tuần này nhé. Khoảng 3 giờ chiều được không?' },
        { icon: '🤖', role: 'AI Agent', msg: 'Thứ 6 lúc 15:00 còn 1 slot cho kỹ thuật viên Linh (nail gel). Dịch vụ: Gel tay + chân = 350.000đ, khoảng 90 phút. Xác nhận đặt lịch không ạ?' },
        { icon: '👤', role: 'Khách Hương', msg: 'Xác nhận nhé!' },
        { icon: '🤖', role: 'AI Agent', msg: '✅ Đã đặt lịch thứ 6 — 15:00 với Linh. Mình sẽ nhắc bạn lúc 9:00 sáng thứ 6 nhé! Hẹn gặp bạn 🌸' },
      ],
    },
    stats: [{ num: '75+', label: 'Doanh nghiệp đang dùng' }, { num: '60%', label: 'Giảm tỷ lệ hủy hẹn' }, { num: '98%', label: 'Khách nhận xác nhận tức thì' }],
    desc: 'Quản lý lịch hẹn thủ công gây nhầm lẫn, bỏ sót và mất khách. Booking Agent tự động hóa toàn bộ quy trình — từ nhận lịch đến nhắc nhở.',
    badge: null, badgeColor: null,
  },
  'email-marketing-agent': {
    eyebrow: '📧 Email Marketing', hero: 'Email Marketing tự động theo hành vi người dùng',
    heroDesc: 'Lên lịch, cá nhân hóa và gửi email marketing thông minh tự động. Agent phân tích hành vi và gửi đúng nội dung, đúng người, đúng thời điểm.',
    image: 'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=900&q=80',
    features: [
      { icon: '🤖', text: 'Tự động gửi email dựa trên hành vi: xem sản phẩm, bỏ giỏ hàng' },
      { icon: '🎨', text: 'Cá nhân hóa nội dung và tên cho từng khách hàng' },
      { icon: '🧪', text: 'A/B testing tự động tiêu đề và nội dung để tối ưu tỷ lệ mở' },
      { icon: '📊', text: 'Theo dõi open rate, click rate, unsubscribe theo thời gian thực' },
      { icon: '🔗', text: 'Đồng bộ danh sách khách hàng với CRM và landing page' },
    ],
    example: {
      label: 'Shop đồ thể thao — chiến dịch giỏ hàng bỏ quên',
      steps: [
        { icon: '🛒', role: 'Hành vi khách', msg: 'Minh xem giày Nike Air Max, thêm vào giỏ 1.250.000đ → Thoát trang không mua' },
        { icon: '🤖', role: '1 giờ sau — AI gửi email', msg: 'Tiêu đề: "Minh ơi, đôi giày bạn thích sắp hết hàng!" — Nội dung: ảnh giày, giá, nút "Mua ngay" + mã giảm 5% COMEBACK05' },
        { icon: '👤', role: 'Minh (tỷ lệ mở 68%)', msg: 'Click email → Dùng mã COMEBACK05 → Thanh toán 1.187.500đ' },
        { icon: '📊', role: 'Kết quả chiến dịch', msg: '1.200 email gửi → 816 mở (68%) → 94 mua hàng → Doanh thu 112tr — ROI: 4.2x' },
      ],
    },
    stats: [{ num: '60+', label: 'Doanh nghiệp đang dùng' }, { num: '45%', label: 'Tăng tỷ lệ mở email' }, { num: '3x', label: 'ROI so với email thủ công' }],
    desc: 'Email marketing vẫn là kênh có ROI cao nhất khi được cá nhân hóa đúng cách. Email Marketing Agent tự động phân tích hành vi và gửi đúng nội dung vào đúng thời điểm.',
    badge: 'BETA', badgeColor: '#FFB800',
  },
  'custom-enterprise-agent': {
    eyebrow: '🏗️ Enterprise', hero: 'AI Agent tùy chỉnh hoàn toàn theo nghiệp vụ',
    heroDesc: 'Xây dựng AI Agent hoàn toàn tùy chỉnh theo quy trình đặc thù của doanh nghiệp. Tích hợp với mọi hệ thống nội bộ — ERP, CRM, phần mềm kế toán.',
    image: 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=900&q=80',
    features: [
      { icon: '🔍', text: 'Phân tích toàn bộ quy trình và thiết kế Agent phù hợp nhất' },
      { icon: '🔌', text: 'Tích hợp với ERP, CRM, MISA, Base.vn, phần mềm nội bộ' },
      { icon: '🧠', text: 'Đào tạo AI trên dữ liệu và nghiệp vụ thực tế của doanh nghiệp' },
      { icon: '🛡️', text: 'Bảo mật dữ liệu chuẩn doanh nghiệp, lưu trữ tại Việt Nam' },
      { icon: '📞', text: 'Hỗ trợ 1-1 vận hành liên tục, SLA cam kết uptime 99.9%' },
    ],
    example: {
      label: 'Công ty logistics — 500 đơn vận chuyển/ngày',
      steps: [
        { icon: '🔍', role: 'Tuần 1 — Khảo sát', msg: 'Đội VIAi phân tích quy trình: nhận đơn → phân công tài xế → theo dõi → báo cáo. Xác định 4 điểm tắc nghẽn chính' },
        { icon: '⚙️', role: 'Tuần 2-3 — Xây dựng', msg: 'Tạo Agent tích hợp với phần mềm quản lý xe, Zalo tài xế, hệ thống hóa đơn. Đào tạo AI trên 50.000 đơn hàng lịch sử' },
        { icon: '🚀', role: 'Tuần 4 — Triển khai', msg: 'Agent vận hành: tự động phân công tài xế, cập nhật vị trí, thông báo khách, tạo hóa đơn' },
        { icon: '📊', role: 'Tháng 2 — Kết quả', msg: 'Tiết kiệm 6 giờ nhân công/ngày — Giảm 92% lỗi phân công — Tăng 28% đơn xử lý/ngày' },
      ],
    },
    stats: [{ num: 'Liên hệ', label: 'Báo giá tùy chỉnh' }, { num: '24h', label: 'Triển khai thử nghiệm' }, { num: '99.9%', label: 'Uptime đảm bảo' }],
    desc: 'Mỗi doanh nghiệp có quy trình riêng. Custom Enterprise Agent được xây dựng hoàn toàn theo yêu cầu đặc thù — từ phân tích nghiệp vụ đến triển khai và vận hành.',
    badge: null, badgeColor: null,
  },
};

const PRODUCT_ENRICHMENT = {
  'zalo-sales-agent': {
    commitmentSpecific: { icon: '⚡', title: 'Cam kết phản hồi < 3 giây', desc: 'Response time trung bình < 3 giây 24/7, kể cả ngày lễ và 2 giờ sáng — không đạt → hoàn phí tháng đó.' },
    problems: [
      'Nhân viên phải trực Zalo 24/7, mệt mỏi và hay bỏ sót tin nhắn ngoài giờ làm việc.',
      'Khách hỏi giá lúc tối khuya, sáng hôm sau mới trả lời — họ đã mua của đối thủ rồi.',
      'Không có quy trình thu thập thông tin giao hàng nhất quán, đơn hay sai địa chỉ.',
      'Mỗi nhân viên tư vấn một kiểu, thiếu nhất quán về giá và chính sách.',
      'Không theo dõi được khách đã hỏi mà chưa mua để chăm sóc lại.',
      'Chi phí nhân sự CSKH tăng nhưng tỷ lệ chốt đơn không cải thiện.',
    ],
    testimonials: [
      { name: 'Anh Nguyễn Minh Tuấn', role: 'Chủ shop thời trang online 500 đơn/ngày', quote: 'Trước tôi cần 3 bạn trực Zalo chia ca, lương 30M/tháng. Giờ VIAi xử lý 95% tin nhắn tự động, chỉ giữ 1 bạn cho ca đặc biệt. Doanh thu tăng 38% vì không bỏ sót khách đêm khuya nữa.' },
      { name: 'Chị Lê Thu Hằng', role: 'Founder chuỗi mỹ phẩm 8 cửa hàng', quote: 'Bot trả lời đúng giá, đúng chính sách, đúng tone thương hiệu — khách còn không biết đang chat với AI. Tỷ lệ chốt đơn từ Zalo tăng từ 22% lên 41% sau 3 tháng.' },
    ],
    faq: [
      { q: 'VIAi Zalo Sales Agent có cần tôi viết kịch bản không?', a: 'Không. Bạn chỉ cần cung cấp danh sách sản phẩm, giá và chính sách. VIAi tự học và tạo kịch bản tư vấn phù hợp trong vòng 24 giờ.' },
      { q: 'Khách hỏi những câu hóc búa thì Agent xử lý thế nào?', a: 'Agent nhận ra câu hỏi phức tạp và tự động chuyển sang nhân viên thực, kèm toàn bộ lịch sử hội thoại. Khách không phải kể lại từ đầu.' },
      { q: 'Tích hợp vào Zalo OA của tôi mất bao lâu?', a: 'Thường 2-4 giờ. Đội ngũ VIAi hỗ trợ toàn bộ quá trình kết nối — bạn không cần biết kỹ thuật.' },
      { q: 'Dữ liệu khách hàng có được bảo mật không?', a: 'Có. Toàn bộ dữ liệu được mã hóa AES-256, lưu trên server tại Việt Nam. VIAi không bán hay chia sẻ dữ liệu của bạn với bên thứ ba.' },
    ],
  },
  'order-management-agent': {
    commitmentSpecific: { icon: '🎯', title: 'Cam kết giảm 80% lỗi đơn', desc: 'Sau 30 ngày dùng, tỷ lệ đơn xử lý sai giảm tối thiểu 80% — không đạt → hoàn phí hoặc gia hạn miễn phí 2 tháng.' },
    problems: [
      'Tổng hợp đơn từ Shopee, Lazada, Website, Zalo vào một file Excel tốn cả buổi sáng.',
      'Đơn nhập sai thông tin giao hàng vì copy-paste qua nhiều bước thủ công.',
      'Kho không biết đơn nào cần xuất trước, giao hàng hay bị delay không rõ lý do.',
      'Khách hỏi trạng thái đơn nhưng nhân viên phải mò trên nhiều hệ thống khác nhau.',
      'Hết hàng chỉ biết khi khách đã đặt và xác nhận — phải hủy đơn rất xấu hổ.',
    ],
    testimonials: [
      { name: 'Anh Trần Duy Khoa', role: 'Quản lý vận hành shop đa kênh 300 đơn/ngày', quote: 'Trước mỗi sáng 2 bạn ngồi tổng hợp đơn từ 5 kênh mất 3 tiếng. Giờ Agent xử lý tự động trong 5 phút, cả team tập trung vào đóng gói và CSKH. Lỗi đơn giảm từ 8% xuống còn 0.3%.' },
      { name: 'Chị Phạm Ngọc Mai', role: 'Chủ warehouse mỹ phẩm 150 SKU', quote: 'Lần đầu tiên kho tôi có thể xuất đơn theo đúng thứ tự ưu tiên. Agent tự tạo phiếu xuất kho, không cần ai nhập tay nữa. Giao hàng đúng hẹn tăng từ 78% lên 96%.' },
    ],
    faq: [
      { q: 'Agent kết nối được với những sàn và kênh nào?', a: 'Shopee, Lazada, TikTok Shop, Website (WooCommerce/Haravan/Shopify), Zalo OA, Facebook. Có thể mở rộng thêm qua API theo yêu cầu.' },
      { q: 'Nếu tôi đang dùng phần mềm quản lý kho riêng thì sao?', a: 'VIAi tích hợp với hầu hết phần mềm kho phổ biến tại Việt Nam (Base, KiotViet, MISA). Trường hợp hệ thống riêng, đội kỹ thuật sẽ kết nối qua API.' },
      { q: 'Đơn bất thường (địa chỉ sai, COD nghi ngờ) thì Agent xử lý thế nào?', a: 'Agent gắn cờ cảnh báo và giữ đơn ở trạng thái chờ duyệt thay vì xử lý tự động. Bạn được thông báo ngay để quyết định.' },
      { q: 'Thời gian triển khai mất bao lâu?', a: 'Kết nối cơ bản 1-2 ngày. Tích hợp đầy đủ với phần mềm kho và quy tắc nghiệp vụ riêng thường 3-5 ngày làm việc.' },
    ],
  },
  'crm-automation-agent': {
    commitmentSpecific: { icon: '📈', title: 'Cam kết tăng 30% tỷ lệ tái mua', desc: 'Sau 90 ngày dùng CRM Agent, tỷ lệ khách mua lần 2 tăng tối thiểu 30% — không đạt → gia hạn miễn phí 3 tháng.' },
    problems: [
      'Dữ liệu khách hàng nằm rải rác trong Excel, Zalo, chat — không có cái nhìn tổng thể.',
      'Nhân viên sales quên follow-up khách tiềm năng, deal nguội dần mà không biết.',
      'Không phân biệt được khách VIP với khách bình thường để ưu tiên chăm sóc.',
      'Gửi cùng một chương trình khuyến mãi cho tất cả khách — hiệu quả thấp, chi phí cao.',
      'Không có hệ thống nhắc tái mua tự động theo chu kỳ mua hàng của từng khách.',
    ],
    testimonials: [
      { name: 'Anh Đỗ Quốc Bảo', role: 'Sales Manager chuỗi nội thất 12 chi nhánh', quote: 'Team tôi trước bỏ sót 40% khách tiềm năng vì không có hệ thống nhắc. Sau khi dùng CRM Agent, tỷ lệ chuyển đổi lead tăng 55%, doanh số tháng 3 đạt kỷ lục công ty.' },
      { name: 'Chị Nguyễn Thị Lan', role: 'Chủ spa chuỗi 4 cơ sở tại HCM', quote: 'Agent tự nhắc khách tái booking đúng lúc, đúng dịch vụ họ hay dùng. Tỷ lệ khách quay lại tăng từ 34% lên 61% chỉ sau 2 tháng triển khai.' },
    ],
    faq: [
      { q: 'CRM Agent có thay thế được phần mềm CRM hiện tại của tôi không?', a: 'Không thay thế mà bổ trợ. Agent kết nối với CRM bạn đang dùng (Hubspot, Base, MISA CRM...) và tự động hóa các tác vụ lặp lại thay vì nhập liệu thủ công.' },
      { q: 'Mô hình phân nhóm khách hàng RFM là gì?', a: 'RFM phân khách theo 3 tiêu chí: Recency (mua gần đây chưa), Frequency (mua bao nhiêu lần), Monetary (chi tiêu bao nhiêu). Agent tự động tính điểm và nhóm khách mỗi ngày.' },
      { q: 'Tôi có thể tùy chỉnh quy tắc chăm sóc không?', a: 'Có. Bạn tự thiết lập: sau bao nhiêu ngày nhắc, nội dung tin nhắn như thế nào, ưu đãi gì cho từng nhóm. Đội VIAi hỗ trợ cấu hình theo nghiệp vụ.' },
      { q: 'Dữ liệu nhập vào có được backup không?', a: 'Có. Dữ liệu được backup tự động mỗi ngày, lưu trữ 90 ngày. Bạn có thể export bất kỳ lúc nào dưới dạng CSV/Excel.' },
    ],
  },
  'report-analytics-agent': {
    commitmentSpecific: { icon: '⏰', title: 'Cam kết gửi báo cáo đúng 8:00', desc: 'Báo cáo sáng gửi đúng 8:00 mỗi ngày — trễ quá 15 phút → hoàn phí ngày đó. Đã đúng giờ 99.7% trong 6 tháng qua.' },
    problems: [
      'Mỗi sáng mất 45-90 phút tổng hợp số liệu từ nhiều nguồn vào một báo cáo.',
      'Số liệu hay sai vì copy-paste thủ công từ nhiều file, phát hiện ra thì đã gửi cho sếp.',
      'Không biết ngay khi doanh thu giảm đột ngột hoặc chi phí tăng bất thường.',
      'Báo cáo không đồng nhất, mỗi người làm một kiểu, khó so sánh qua các kỳ.',
      'Dữ liệu từ quảng cáo, kho, nhân sự, bán hàng nằm ở 5-7 hệ thống khác nhau.',
    ],
    testimonials: [
      { name: 'Anh Lê Hoàng Nam', role: 'CEO chuỗi F&B 8 chi nhánh tại HN', quote: 'Mỗi sáng lúc 8h tôi đã có báo cáo đầy đủ trong Zalo trước khi uống xong ly cà phê. Phát hiện chi nhánh Q.Đống Đa đang lỗ nhờ báo cáo Agent — cứu được 80 triệu/tháng.' },
      { name: 'Chị Võ Thị Kim Anh', role: 'CFO công ty phân phối 200 nhân viên', quote: 'Trước tôi cần kế toán viên tổng hợp 2-3 ngày mới có báo cáo tháng. Giờ Report Agent làm xong trong 3 phút, chính xác hơn, và gửi tự động. Kế toán team tập trung vào phân tích thay vì nhập liệu.' },
    ],
    faq: [
      { q: 'Agent kết nối với nguồn dữ liệu nào?', a: 'Google Sheets, MISA, KiotViet, Shopee/Lazada seller center, Facebook Ads, Google Ads, các phần mềm bán hàng, và API tùy chỉnh. Hỗ trợ tối đa 20+ nguồn đồng thời.' },
      { q: 'Báo cáo gửi qua kênh nào?', a: 'Zalo cá nhân, Zalo nhóm, Email, hoặc cả hai cùng lúc. Bạn chọn người nhận và lịch gửi tùy ý.' },
      { q: 'Tôi có thể tự thiết kế mẫu báo cáo không?', a: 'Có. Đội VIAi làm việc với bạn để tùy chỉnh mẫu báo cáo theo nhu cầu thực tế trong buổi onboarding.' },
      { q: 'Khi dữ liệu nguồn bị lỗi hoặc mất kết nối, Agent xử lý thế nào?', a: 'Agent gửi cảnh báo ngay và bỏ qua nguồn lỗi, vẫn tổng hợp từ các nguồn còn lại. Bạn nhận được báo cáo kèm ghi chú rõ ràng về nguồn không lấy được.' },
    ],
  },
  'facebook-ads-agent': {
    commitmentSpecific: { icon: '📊', title: 'Cam kết ROAS tăng tối thiểu 25%', desc: 'Sau 60 ngày dùng, ROAS trung bình tăng ít nhất 25% — không đạt → miễn phí phí VIAi tháng tiếp theo.' },
    problems: [
      'Không đủ thời gian theo dõi hàng chục chiến dịch chạy song song mỗi ngày.',
      'Ngân sách đổ vào nhóm quảng cáo kém, chỉ biết khi cuối ngày xem báo cáo.',
      'A/B test thủ công chậm, test được 2-3 mẫu/tuần trong khi đối thủ test hàng chục.',
      'Báo cáo ROAS cho khách hàng mất cả ngày tổng hợp từ nhiều tài khoản.',
      'Không có cảnh báo khi CPA vượt ngưỡng hoặc budget sắp hết giữa chừng.',
    ],
    testimonials: [
      { name: 'Anh Phạm Quốc Cường', role: 'Media buyer quản 1.5 tỷ ngân sách/tháng', quote: 'Trước tôi cần ngồi màn hình từ sáng đến tối mới bắt kịp biến động. Giờ Agent cảnh báo ngay khi có nhóm nào lệch ngưỡng, tôi chỉ cần duyệt quyết định. ROAS tăng 31% tháng đầu.' },
      { name: 'Chị Bùi Minh Châu', role: 'Trưởng phòng Marketing hệ thống thời trang', quote: 'Báo cáo ROAS tự động mỗi sáng giúp sếp tôi theo dõi được mà không cần hỏi team. CPL giảm 28%, tôi có thêm thời gian làm chiến lược thay vì ngồi kéo số liệu.' },
    ],
    faq: [
      { q: 'Agent có thể tự điều chỉnh ngân sách không hay chỉ đề xuất?', a: 'Mặc định Agent đề xuất và bạn duyệt. Gói Pro+ có thể cấu hình auto-adjust trong biên độ bạn cho phép (ví dụ ±20% ngân sách/ngày).' },
      { q: 'Hỗ trợ những loại chiến dịch nào?', a: 'Tất cả loại chiến dịch Facebook: Conversion, Traffic, Reach, Lead, Catalog, Video Views. Tối ưu theo mục tiêu bạn chọn.' },
      { q: 'Tôi quản lý nhiều tài khoản ads cho nhiều khách thì sao?', a: 'Agent quản lý được nhiều tài khoản Business Manager cùng lúc. Báo cáo tổng hợp hoặc riêng lẻ theo từng khách tùy cấu hình.' },
      { q: 'Agent có truy cập vào tài khoản ads của tôi không?', a: 'Kết nối qua Facebook Marketing API với quyền đọc và tùy chọn ghi ngân sách. Bạn kiểm soát hoàn toàn quyền truy cập và có thể thu hồi bất kỳ lúc nào.' },
    ],
  },
  'booking-appointment': {
    commitmentSpecific: { icon: '📅', title: 'Cam kết giảm 50% hủy hẹn', desc: 'Sau 60 ngày nhắc hẹn tự động, tỷ lệ khách hủy hẹn giảm tối thiểu 50% — không đạt → hoàn phí 1 tháng.' },
    problems: [
      'Lễ tân mất 2-3 giờ/ngày chỉ để xác nhận, nhắc hẹn và đổi lịch cho khách.',
      'Khách đặt lịch lúc tối muộn, sáng hôm sau mới xác nhận — họ đã book chỗ khác rồi.',
      'Nhân viên xem lịch ở nhiều chỗ khác nhau, hay bị chồng lịch hoặc bỏ trống vô lý.',
      'Không có hệ thống nhắc khách trước giờ hẹn, tỷ lệ no-show rất cao.',
      'Khó tổng hợp doanh thu theo dịch vụ, nhân viên và chi nhánh để tối ưu.',
    ],
    testimonials: [
      { name: 'Chị Trần Thị Thúy', role: 'Chủ chuỗi spa 5 cơ sở tại HCM & HN', quote: 'Tỷ lệ no-show từ 22% xuống 4% sau khi bật nhắc tự động trước 24h. Lễ tân từ 3 người xuống 1 người, 2 bạn còn lại chuyển sang chăm sóc khách trực tiếp.' },
      { name: 'Bác sĩ Nguyễn Trung Hiếu', role: 'Phòng khám nha khoa 4 ghế', quote: 'Bệnh nhân đặt lịch 11 giờ đêm và nhận xác nhận ngay. Ngày hôm sau tôi có lịch sạch và đầy đủ thông tin khám trước. Agent thay được cả lễ tân buổi tối.' },
    ],
    faq: [
      { q: 'Agent tích hợp được với Google Calendar không?', a: 'Có. Đồng bộ 2 chiều với Google Calendar, Outlook và hầu hết app lịch phổ biến. Kỹ thuật viên và bác sĩ xem lịch ngay trên điện thoại cá nhân.' },
      { q: 'Khách đặt lịch qua kênh nào?', a: 'Zalo OA, Facebook Messenger, Website chatbot, và form đặt lịch nhúng trên trang web. Agent nhận và xử lý đồng nhất từ tất cả kênh.' },
      { q: 'Nếu nhân viên nghỉ đột xuất thì lịch hẹn xử lý thế nào?', a: 'Agent tự động đề xuất chuyển lịch sang nhân viên khác có khung giờ trống và thông báo cho khách. Bạn duyệt trong 1 click.' },
      { q: 'Tôi có thể xem báo cáo doanh thu theo từng kỹ thuật viên không?', a: 'Có. Dashboard hiển thị doanh thu, số lịch, tỷ lệ no-show và hiệu suất theo từng nhân viên, dịch vụ và chi nhánh.' },
    ],
  },
  'email-marketing-agent': {
    commitmentSpecific: { icon: '📧', title: 'Cam kết open rate > 35%', desc: 'Email chiến dịch đầu tiên đạt open rate > 35% — không đạt → VIAi tối ưu lại miễn phí đến khi đạt.' },
    problems: [
      'Gửi cùng một email cho toàn bộ danh sách, tỷ lệ mở thấp và hủy đăng ký nhiều.',
      'Không có automation nhắc giỏ hàng bỏ quên — mất hàng trăm triệu doanh thu tiềm năng.',
      'Tự viết email marketing tốn thời gian, không biết tiêu đề nào hiệu quả nhất.',
      'Không theo dõi được khách nào mở, click và mua hàng từ email nào.',
      'Danh sách email không được làm sạch, tỷ lệ bounce cao ảnh hưởng uy tín domain.',
    ],
    testimonials: [
      { name: 'Anh Lý Văn Khoa', role: 'CMO startup thương mại điện tử', quote: 'Chuỗi email giỏ hàng bỏ quên thu hồi được 18% doanh thu từ khách rời đi. Mỗi tháng 120 triệu chỉ từ automation email — trước đây bỏ đi hết.' },
      { name: 'Chị Ngô Thị Hương', role: 'Marketing Manager nền tảng giáo dục online', quote: 'A/B test tự động 50 tiêu đề cùng lúc giúp tìm ra winner nhanh gấp 8 lần. Open rate tăng từ 18% lên 47%, chi phí email marketing giảm 60%.' },
    ],
    faq: [
      { q: 'Agent hỗ trợ gửi email qua server nào?', a: 'Tích hợp với SendGrid, Mailchimp, Amazon SES, SMTP riêng của bạn. Bạn dùng domain email riêng, không chia sẻ IP với người khác.' },
      { q: 'Tôi có thể thiết kế template email đẹp không?', a: 'Có. VIAi cung cấp sẵn 20+ template tiếng Việt responsive. Bạn cũng có thể upload template HTML riêng hoặc dùng drag-and-drop editor.' },
      { q: 'GDPR và unsubscribe có được xử lý tự động không?', a: 'Có. Link unsubscribe tự động thêm vào mỗi email. Người dùng hủy đăng ký được xóa khỏi danh sách ngay lập tức và không bao giờ nhận lại.' },
      { q: 'Tôi có thể xem ai đã mở email và click vào link nào không?', a: 'Có. Dashboard theo dõi từng người: ai mở, ai click, ai mua hàng từ email. Dùng để phân nhóm và gửi follow-up chính xác hơn.' },
    ],
  },
  'custom-enterprise-agent': {
    commitmentSpecific: { icon: '🏗️', title: 'Cam kết triển khai trong 30 ngày', desc: 'Agent tùy chỉnh hoạt động trong production tối đa 30 ngày làm việc — quá hạn → miễn phí toàn bộ phí triển khai.' },
    problems: [
      'Quy trình nghiệp vụ quá đặc thù, không có phần mềm nào trên thị trường đáp ứng được.',
      'Nhiều hệ thống nội bộ (ERP, CRM, kho, kế toán) không nói chuyện được với nhau.',
      'Nhân viên phải nhập liệu thủ công vào nhiều hệ thống — mất thời gian và hay sai.',
      'Không kiểm soát được quy trình phê duyệt, dữ liệu thất lạc giữa các bộ phận.',
      'Muốn ứng dụng AI nhưng không biết bắt đầu từ đâu và e ngại rủi ro dữ liệu.',
    ],
    testimonials: [
      { name: 'Anh Đinh Văn Hải', role: 'CTO tập đoàn logistics 500 nhân viên', quote: 'VIAi khảo sát 3 tuần, hiểu nghiệp vụ phân công xe tải của chúng tôi sâu hơn cả vendor ERP đã làm việc 2 năm. Agent tự động phân công 400 đơn vận chuyển/ngày, tiết kiệm 8 giờ nhân công.' },
      { name: 'Bà Nguyễn Thị Lan', role: 'GĐ vận hành chuỗi bán lẻ 80 cửa hàng', quote: 'Chúng tôi có phần mềm riêng từ 2018 không kết nối được với gì. VIAi xây Agent bridge toàn bộ hệ thống trong 3 tuần. Giờ dữ liệu chạy thông suốt từ POS đến kế toán không cần người nhập tay.' },
    ],
    faq: [
      { q: 'Qui trình khảo sát và thiết kế mất bao lâu?', a: 'Thường 1-2 tuần cho nghiệp vụ tiêu chuẩn, 3-4 tuần cho hệ thống phức tạp nhiều bộ phận. Bạn sẽ nhận được tài liệu thiết kế trước khi bắt đầu code.' },
      { q: 'Hệ thống cũ của tôi không có API thì có kết nối được không?', a: 'Vẫn được trong hầu hết trường hợp. Đội VIAi có thể xây RPA (robotic process automation) để tương tác với giao diện cũ, hoặc kết nối trực tiếp database với quyền phù hợp.' },
      { q: 'Tôi có nhận được code nguồn không?', a: 'Tùy gói. Gói Enterprise Full bàn giao toàn bộ code nguồn, tài liệu và quyền tự vận hành. Gói SaaS thì VIAi vận hành và bảo trì, bạn trả phí hàng tháng.' },
      { q: 'Nếu cần thay đổi sau khi triển khai thì tính như thế nào?', a: 'Thay đổi nhỏ trong 3 tháng đầu miễn phí. Thay đổi lớn hoặc tính năng mới tính theo giờ công minh bạch. Không có phí ẩn.' },
    ],
  },
};

function renderProductPage(product, detail, related = []) {
  const siteUrl = SITE_URL;
  const title = `${product.name} – VIAi AI Agent`;
  const desc = detail.heroDesc;
  const canonicalUrl = `${siteUrl}/san-pham/${product.slug}`;
  const image = detail.image || `${siteUrl}/anhlogo/logo2.png`;

  const featuresHtml = detail.features.map(f =>
    `<li><span class="feat-ico">${f.icon}</span><span>${escapeHtml(f.text)}</span></li>`
  ).join('');

  const statsHtml = detail.stats.map(s =>
    `<div class="pstat"><span class="pstat-num">${escapeHtml(s.num)}</span><span class="pstat-lbl">${escapeHtml(s.label)}</span></div>`
  ).join('');

  const exampleHtml = detail.example ? `
    <div class="p-card">
      <div class="p-section-title">Ví dụ thực tế</div>
      <div class="ex-label">📍 ${escapeHtml(detail.example.label)}</div>
      <div class="ex-flow">
        ${detail.example.steps.map((s, i) => `
        <div class="ex-step">
          <div class="ex-avatar">${s.icon}</div>
          <div class="ex-bubble ${i % 2 === 1 ? 'ex-bubble--ai' : ''}">
            <div class="ex-role">${escapeHtml(s.role)}</div>
            <div class="ex-msg">${escapeHtml(s.msg)}</div>
          </div>
        </div>`).join('')}
      </div>
    </div>` : '';

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link rel="icon" type="image/png" href="/anhlogo/logo2.png" />
  <link rel="shortcut icon" href="/anhlogo/logo2.png" />
  <link rel="apple-touch-icon" href="/anhlogo/logo2.png" />
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
  <meta name="description" content="${escapeHtml(desc)}" />
  <meta name="robots" content="index, follow" />
  <meta property="og:type" content="website" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(desc)}" />
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}" />
  <meta property="og:image" content="${escapeHtml(image)}" />
  <meta property="og:site_name" content="VIAi" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(desc)}" />
  <meta name="twitter:image" content="${escapeHtml(image)}" />
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-42Q77HM690"></script>
  <script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','G-42Q77HM690');</script>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet" />
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--primary:#1A56DB;--primary-dark:#1040B0;--primary-light:#4B82F4;--accent:#FF6B00;--accent-light:#FF8C38;--green:#00B341;--gray-50:#EEF3FF;--gray-100:#DBEAFE;--gray-300:#6B93E8;--gray-600:#1E3A8A;--gray-900:#0F172A}
    html{scroll-behavior:smooth}
    body{font-family:'Be Vietnam Pro',Arial,sans-serif;color:var(--gray-900);background:#f4f8ff;overflow-x:hidden}
    a{text-decoration:none;color:inherit}
    /* ── Header (same as siteToolbar) ── */
    .site-header{position:sticky;top:0;z-index:999;background:white;border-bottom:2px solid var(--primary);box-shadow:0 2px 12px rgba(26,86,219,.08)}
    .header-inner{max-width:1240px;margin:0 auto;padding:0 24px;height:80px;display:flex;align-items:center;justify-content:space-between;gap:24px}
    .site-logo{display:flex;align-items:center;gap:10px;flex-shrink:0}
    .logo-img{height:150px;width:auto;object-fit:contain;display:block;flex-shrink:0;mix-blend-mode:multiply}
    .main-nav{flex:1;display:flex;align-items:center;justify-content:center;gap:4px}
    .nav-item{position:relative}
    .nav-item>a{display:flex;align-items:center;gap:4px;padding:8px 14px;font-size:.9rem;font-weight:600;text-transform:uppercase;color:var(--gray-600);border-radius:8px;transition:all .2s;white-space:nowrap;position:relative}
    .nav-item>a::after{content:'';position:absolute;bottom:2px;left:14px;right:14px;height:2.5px;background:var(--primary);border-radius:2px;transform:scaleX(0);opacity:0;transition:transform .25s,opacity .25s;transform-origin:left}
    .nav-item>a:hover,.nav-item.nav-active>a{color:var(--primary);background:var(--gray-50)}
    .nav-item>a:hover::after,.nav-item.nav-active>a::after{transform:scaleX(1);opacity:1}
    .nav-item>a .arrow{font-size:.65rem;transition:transform .2s}
    .nav-item:hover>a .arrow{transform:rotate(180deg)}
    .dropdown{display:block;position:absolute;top:calc(100% + 4px);left:0;min-width:220px;background:white;border:1px solid rgba(26,86,219,.1);border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,.04),0 20px 50px rgba(26,86,219,.14);padding:10px;z-index:100;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(-8px);transition:opacity .25s,visibility .25s,transform .25s cubic-bezier(.16,1,.3,1)}
    .nav-item:hover .dropdown,.nav-item:focus-within .dropdown{opacity:1;visibility:visible;pointer-events:auto;transform:translateY(0)}
    .dropdown a{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;font-size:.85rem;font-weight:500;color:var(--gray-600);transition:all .18s}
    .dropdown a:hover{background:var(--gray-50);color:var(--primary);transform:translateX(3px)}
    .dropdown a .dd-icon{font-size:1.1rem;flex-shrink:0}
    .dropdown-mega{min-width:480px;display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:14px}
    .dropdown-mega .mega-title{grid-column:1/-1;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--gray-300);padding:4px 14px 8px;border-bottom:1px solid var(--gray-100);margin-bottom:4px}
    .header-actions{display:flex;align-items:center;gap:10px;flex-shrink:0}
    .btn-login{padding:8px 18px;border:2px solid var(--primary);border-radius:8px;font-size:.85rem;font-weight:700;color:var(--primary);transition:all .2s;background:white;display:inline-flex;align-items:center}
    .btn-login:hover{background:var(--primary);color:white}
    .btn-register{padding:8px 18px;background:var(--accent);border-radius:8px;font-size:.85rem;font-weight:700;color:white;transition:all .2s;box-shadow:0 4px 14px rgba(255,107,74,.35);display:inline-flex;align-items:center}
    .btn-register:hover{background:var(--accent-light);transform:translateY(-1px)}
    .hamburger-btn{display:none;flex-direction:column;justify-content:center;gap:5px;width:40px;height:40px;background:none;border:none;cursor:pointer;padding:6px;border-radius:8px;flex-shrink:0}
    .hamburger-btn span{display:block;width:22px;height:2.5px;background:var(--gray-600);border-radius:2px;transition:all .3s;transform-origin:center}
    .hamburger-btn.open span:nth-child(1){transform:translateY(7.5px) rotate(45deg)}
    .hamburger-btn.open span:nth-child(2){opacity:0;transform:scaleX(0)}
    .hamburger-btn.open span:nth-child(3){transform:translateY(-7.5px) rotate(-45deg)}
    .mobile-menu{display:none;position:fixed;top:80px;left:0;right:0;background:white;border-top:2px solid var(--primary);box-shadow:0 8px 32px rgba(0,0,0,.12);z-index:998;padding:16px 20px 24px;max-height:calc(100vh - 80px);overflow-y:auto}
    .mobile-menu.open{display:block}
    .mobile-nav-item{border-bottom:1px solid #f1f5f9}
    .mobile-nav-link{width:100%;display:flex;align-items:center;justify-content:space-between;padding:14px 4px;font-size:.95rem;font-weight:700;color:var(--gray-600);cursor:pointer;background:none;border:none;font-family:inherit;text-align:left}
    .mobile-nav-item.m-open .m-arrow{transform:rotate(180deg)}
    .mobile-submenu{display:none;padding:0 0 8px 12px}
    .mobile-nav-item.m-open .mobile-submenu{display:block}
    .mobile-submenu a{display:flex;align-items:center;gap:10px;padding:10px 8px;font-size:.88rem;font-weight:500;color:var(--gray-600);border-radius:8px;transition:all .15s}
    .mobile-submenu a:hover{background:var(--gray-50);color:var(--primary)}
    .mobile-plain-link{display:block;padding:14px 4px;font-size:.95rem;font-weight:700;color:var(--gray-600);border-bottom:1px solid #f1f5f9}
    .mobile-menu-actions{display:flex;flex-direction:column;gap:10px;margin-top:20px}
    @media(max-width:960px){.main-nav,.header-actions{display:none}.hamburger-btn{display:flex}}
    /* ── Hero ── */
    .p-hero{background:linear-gradient(135deg,#0F172A 0%,#1A56DB 60%,#1040B0 100%);padding:72px 20px 60px;position:relative;overflow:hidden}
    .p-hero::before{content:'';position:absolute;width:600px;height:600px;background:rgba(255,255,255,.04);border-radius:50%;top:-280px;right:-150px;pointer-events:none}
    .p-hero-inner{max-width:960px;margin:0 auto;position:relative;z-index:1}
    .p-eyebrow{display:inline-block;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);color:#FFB800;font-size:.8rem;font-weight:700;padding:6px 16px;border-radius:50px;margin-bottom:20px;letter-spacing:.5px}
    .p-hero h1{font-size:clamp(1.8rem,3.5vw,2.8rem);font-weight:900;color:white;line-height:1.22;margin-bottom:16px}
    .p-hero-desc{font-size:1.05rem;color:rgba(255,255,255,.78);line-height:1.75;margin-bottom:32px;max-width:680px}
    .p-hero-actions{display:flex;gap:14px;flex-wrap:wrap}
    .p-cta-main{background:var(--accent);color:white;padding:14px 28px;border-radius:8px;font-weight:800;font-size:.95rem;box-shadow:0 6px 20px rgba(255,107,74,.4);transition:all .2s}
    .p-cta-main:hover{background:var(--accent-light);transform:translateY(-2px)}
    .p-cta-out{background:rgba(255,255,255,.1);color:white;padding:14px 24px;border-radius:8px;font-weight:700;font-size:.95rem;border:1.5px solid rgba(255,255,255,.3);transition:all .2s}
    .p-cta-out:hover{background:rgba(255,255,255,.2)}
    .p-badge{display:inline-block;padding:4px 12px;border-radius:20px;font-size:.78rem;font-weight:800;margin-left:12px;vertical-align:middle}
    /* ── Content ── */
    .p-wrap{max-width:960px;margin:0 auto;padding:48px 20px 72px}
    .p-thumb{width:100%;max-height:440px;object-fit:cover;border-radius:16px;margin-bottom:36px;box-shadow:0 12px 40px rgba(15,23,42,.12)}
    .p-card{background:white;border:1px solid #e2e8f0;border-radius:16px;padding:36px;box-shadow:0 8px 28px rgba(15,23,42,.06);margin-bottom:28px}
    .p-section-title{font-size:1.2rem;font-weight:900;color:var(--primary);margin-bottom:20px;display:flex;align-items:center;gap:10px}
    .p-section-title::before{content:'';display:block;width:4px;height:22px;background:var(--accent);border-radius:2px}
    .p-desc{font-size:1rem;color:#334155;line-height:1.8;margin-bottom:0}
    .p-features{list-style:none;display:flex;flex-direction:column;gap:14px}
    .p-features li{display:flex;align-items:flex-start;gap:12px;font-size:.97rem;color:#334155;line-height:1.6}
    .feat-ico{font-size:1.25rem;flex-shrink:0;width:32px;height:32px;display:flex;align-items:center;justify-content:center;background:var(--gray-50);border-radius:8px;border:1px solid var(--gray-100)}
    .ex-label{font-size:.82rem;font-weight:700;color:#64748b;margin-bottom:16px;padding:8px 12px;background:#f8faff;border-radius:8px;border-left:3px solid var(--accent)}
    .ex-flow{display:flex;flex-direction:column;gap:12px}
    .ex-step{display:flex;align-items:flex-start;gap:12px}
    .ex-avatar{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--primary-light));display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0}
    .ex-bubble{flex:1;background:#f8faff;border:1px solid #e2e8f0;border-radius:0 12px 12px 12px;padding:10px 14px}
    .ex-bubble--ai{background:#EEF3FF;border-color:rgba(26,86,219,.15);border-radius:12px 12px 12px 0}
    .ex-role{font-size:.75rem;font-weight:800;color:var(--primary);margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px}
    .ex-msg{font-size:.88rem;color:#334155;line-height:1.65;white-space:pre-line}
    .p-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:24px}
    .pstat{background:linear-gradient(135deg,#EEF3FF,#F8FAFF);border:1px solid rgba(26,86,219,.1);border-radius:12px;padding:20px 16px;text-align:center}
    .pstat-num{display:block;font-size:1.8rem;font-weight:900;color:var(--primary);line-height:1}
    .pstat-lbl{display:block;font-size:.78rem;color:#64748b;font-weight:600;margin-top:4px}
    /* ── CTA box ── */
    .p-cta-box{background:linear-gradient(135deg,#1040B0,#1A56DB 55%,#FF6B00 100%);border-radius:20px;padding:48px 40px;display:flex;align-items:center;justify-content:space-between;gap:32px;flex-wrap:wrap;position:relative;overflow:hidden}
    .p-cta-box::before{content:'';position:absolute;width:400px;height:400px;background:rgba(255,255,255,.04);border-radius:50%;top:-200px;right:-100px}
    .p-cta-box h2{font-size:clamp(1.3rem,2.2vw,1.8rem);font-weight:900;color:white;position:relative;z-index:1}
    .p-cta-box h2 em{font-style:normal;color:#FFB800}
    .p-cta-btns{display:flex;gap:12px;flex-shrink:0;position:relative;z-index:1;flex-wrap:wrap}
    /* ── Footer (minimal) ── */
    .p-footer{background:#0A1F6E;color:rgba(255,255,255,.6);padding:24px 20px;text-align:center;font-size:.82rem}
    .p-footer a{color:rgba(255,255,255,.4)}
    .p-footer a:hover{color:white}
    @media(max-width:640px){.p-hero{padding:52px 18px 44px}.p-wrap{padding:32px 18px 56px}.p-card{padding:22px}.p-stats{grid-template-columns:1fr 1fr}.p-cta-box{padding:32px 24px}}
    /* ── Breadcrumb ── */
    .p-breadcrumb{display:flex;align-items:center;gap:6px;font-size:.78rem;color:rgba(255,255,255,.65);margin-bottom:20px;flex-wrap:wrap}
    .p-breadcrumb a{color:rgba(255,255,255,.65);transition:color .2s}.p-breadcrumb a:hover{color:#FFB800}
    .p-breadcrumb .sep{color:rgba(255,255,255,.35);font-size:.65rem}.p-breadcrumb .cur{color:rgba(255,255,255,.92)}
    /* ── CTA animations ── */
    @keyframes cta-pulse-ring{0%{box-shadow:0 0 0 0 rgba(255,107,0,.55)}70%{box-shadow:0 0 0 14px rgba(255,107,0,0)}100%{box-shadow:0 0 0 0 rgba(255,107,0,0)}}
    .cta-pulse{animation:cta-pulse-ring 2.2s cubic-bezier(.4,0,.6,1) infinite}.cta-pulse:hover{animation-play-state:paused}
    .cta-shimmer{position:relative;overflow:hidden;isolation:isolate}.cta-shimmer::after{content:'';position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.28) 50%,transparent 70%);transform:translateX(-100%);transition:transform .8s ease;pointer-events:none}.cta-shimmer:hover::after{transform:translateX(100%)}
    .cta-glow{box-shadow:0 8px 26px -6px rgba(255,107,0,.58)}.cta-glow:hover{box-shadow:0 12px 32px -6px rgba(255,107,0,.72)}
    @keyframes arrow-b{0%,100%{transform:translateX(0)}50%{transform:translateX(4px)}}
    .cta-arrow{display:inline-block;animation:arrow-b 1.4s ease-in-out infinite}
    /* ── Sections chung ── */
    .sec{padding:56px 20px}.sec-alt{background:#F8FAFF}.sec-dark{background:#0A2472;color:white}
    .sec-inner{max-width:960px;margin:0 auto}
    .sec-label{font-size:.72rem;font-weight:900;text-transform:uppercase;letter-spacing:1.2px;color:var(--accent);margin-bottom:6px}
    .sec-h2{font-size:clamp(1.4rem,2.2vw,2rem);font-weight:900;margin-bottom:8px;color:var(--gray-900)}
    .sec-dark .sec-h2{color:white}
    .sec-sub{font-size:.95rem;color:#64748b;margin-bottom:28px}
    .sec-dark .sec-sub{color:rgba(255,255,255,.65)}
    /* ── Pain points ── */
    .pain-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px}
    .pain-card{display:flex;align-items:flex-start;gap:12px;background:white;border-radius:12px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.05)}
    .pain-ico{width:34px;height:34px;border-radius:50%;background:#FFF0E6;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:.95rem}
    .pain-num{font-size:.65rem;font-weight:700;text-transform:uppercase;color:#bbb;margin-bottom:2px}
    .pain-txt{font-size:.87rem;color:#334155;line-height:1.55}
    /* ── Commitments ── */
    .commit-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-top:28px}
    .commit-card{border-radius:12px;padding:18px;background:rgba(255,255,255,.06)}
    .commit-card.featured{background:rgba(255,107,0,.18);border:1.5px solid rgba(255,107,0,.6)}
    .commit-ico{font-size:1.3rem;margin-bottom:10px}
    .commit-ttl{font-size:.87rem;font-weight:800;margin-bottom:5px}
    .commit-desc{font-size:.74rem;color:rgba(255,255,255,.68);line-height:1.55}
    .commit-tag{font-size:.64rem;font-weight:700;text-transform:uppercase;color:var(--accent);margin-top:8px}
    /* ── Testimonials ── */
    .testi-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px;margin-top:28px}
    .testi-card{background:#F8FAFF;border:1px solid #E2E8F0;border-radius:14px;padding:22px}
    .testi-q{font-size:.88rem;color:#334155;line-height:1.7;font-style:italic;margin-bottom:14px}
    .testi-author{display:flex;align-items:center;gap:10px}
    .testi-av{width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--primary-light));color:white;font-size:.78rem;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .testi-name{font-size:.84rem;font-weight:800;color:var(--gray-900)}
    .testi-role{font-size:.74rem;color:#64748b}
    /* ── FAQ ── */
    .faq-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-top:28px}
    .faq-item{background:white;border:1px solid #E2E8F0;border-radius:12px;padding:18px}
    .faq-q{font-size:.88rem;font-weight:700;color:var(--gray-900);margin-bottom:8px;display:flex;gap:8px}
    .faq-qn{color:var(--accent);flex-shrink:0}
    .faq-a{font-size:.84rem;color:#475569;line-height:1.65}
    /* ── Related products ── */
    .related-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-top:28px}
    .related-card{border:1px solid #E2E8F0;border-radius:14px;overflow:hidden;background:white;transition:transform .2s,box-shadow .2s}
    .related-card:hover{transform:translateY(-3px);box-shadow:0 8px 24px rgba(26,86,219,.11)}
    .related-thumb{background:linear-gradient(135deg,#1040B0,#1A56DB);padding:20px 16px;display:flex;align-items:center;gap:10px}
    .related-ico{font-size:1.8rem}
    .related-badge{font-size:.66rem;font-weight:700;text-transform:uppercase;background:rgba(255,255,255,.18);color:white;padding:3px 10px;border-radius:20px}
    .related-body{padding:14px 16px}
    .related-name{font-size:.9rem;font-weight:800;color:var(--gray-900);margin-bottom:4px}
    .related-tagline{font-size:.76rem;color:#64748b;line-height:1.5}
    /* ── Sticky bottom bar ── */
    .sticky-bar{display:none;position:fixed;bottom:0;left:0;right:0;background:white;border-top:1px solid #e2e8f0;box-shadow:0 -4px 16px rgba(0,0,0,.08);padding:10px 16px;z-index:990;align-items:center;gap:10px}
    .sb-info{flex:1}.sb-lbl{font-size:.65rem;text-transform:uppercase;color:#94a3b8;letter-spacing:.4px}
    .sb-name{font-size:.88rem;font-weight:800;color:var(--gray-900)}
    /* ── Responsive new sections ── */
    @media(max-width:768px){.pain-grid,.testi-grid,.faq-grid,.related-grid{grid-template-columns:1fr}.commit-grid{grid-template-columns:repeat(2,1fr)}.sec{padding:44px 18px}}
    @media(max-width:480px){.commit-grid{grid-template-columns:1fr}.sticky-bar{display:flex}.p-wrap{padding-bottom:80px}}
  </style>
</head>
<body>
  ${renderSiteToolbar('products')}

  <!-- 1. HERO -->
  <section class="p-hero">
    <div class="p-hero-inner">
      <nav class="p-breadcrumb" aria-label="Breadcrumb">
        <a href="/">Trang chủ</a>
        <span class="sep">›</span>
        <a href="/san-pham.html">Sản phẩm</a>
        <span class="sep">›</span>
        <span class="cur">${escapeHtml(product.name)}</span>
      </nav>
      <div class="p-eyebrow">${escapeHtml(detail.eyebrow)}</div>
      <h1>${escapeHtml(product.name)}${detail.badge ? `<span class="p-badge" style="background:${detail.badgeColor};color:white">${escapeHtml(detail.badge)}</span>` : ''}</h1>
      <p class="p-hero-desc">${escapeHtml(detail.heroDesc)}</p>
      <div class="p-hero-actions">
        <a href="/dung-thu.html" class="p-cta-main cta-pulse cta-shimmer cta-glow">🚀 Dùng thử miễn phí <span class="cta-arrow">→</span></a>
        <a href="/san-pham.html" class="p-cta-out">← Xem tất cả Agent</a>
      </div>
    </div>
  </section>

  <!-- 2. PAIN POINTS -->
  ${detail.problems && detail.problems.length ? `
  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="sec-label">Vấn đề thực tế</div>
      <h2 class="sec-h2">Doanh nghiệp bạn đang gặp những vấn đề này?</h2>
      <div class="pain-grid">
        ${detail.problems.map((p, i) => `
        <div class="pain-card">
          <div class="pain-ico">⚠️</div>
          <div>
            <div class="pain-num">Vấn đề ${i + 1}</div>
            <div class="pain-txt">${escapeHtml(p)}</div>
          </div>
        </div>`).join('')}
      </div>
    </div>
  </section>` : ''}

  <!-- 3. INTRO + FEATURES -->
  <div class="p-wrap">
    <img class="p-thumb" src="${escapeHtml(detail.image)}" alt="${escapeHtml(product.name)}" width="960" height="440" loading="lazy" />

    <div class="p-card">
      <div class="p-section-title">Giới thiệu</div>
      <p class="p-desc">${escapeHtml(detail.desc)}</p>
    </div>

    <div class="p-card">
      <div class="p-section-title">Tính năng chính</div>
      <ul class="p-features">${featuresHtml}</ul>
    </div>

    ${exampleHtml}

    <div class="p-card">
      <div class="p-section-title">Hiệu quả thực tế</div>
      <div class="p-stats">${statsHtml}</div>
    </div>
  </div>

  <!-- 4. COMMITMENTS (dark) -->
  <section class="sec sec-dark">
    <div class="sec-inner">
      <div class="sec-label" style="color:#FFB800">Cam kết rõ ràng</div>
      <h2 class="sec-h2">5 cam kết cụ thể — không chung chung</h2>
      <div class="commit-grid">
        ${detail.commitmentSpecific ? `
        <div class="commit-card featured">
          <div class="commit-ico">${escapeHtml(detail.commitmentSpecific.icon)}</div>
          <div class="commit-ttl">${escapeHtml(detail.commitmentSpecific.title)}</div>
          <div class="commit-desc">${escapeHtml(detail.commitmentSpecific.desc)}</div>
          <div class="commit-tag">★ Riêng cho sản phẩm này</div>
        </div>` : ''}
        <div class="commit-card"><div class="commit-ico">🔒</div><div class="commit-ttl">Bảo mật AES-256</div><div class="commit-desc">Server Viettel IDC tại Việt Nam, đạt chuẩn ISO/IEC 27001. Dữ liệu của bạn không bao giờ rời khỏi lãnh thổ Việt Nam.</div></div>
        <div class="commit-card"><div class="commit-ico">↩️</div><div class="commit-ttl">Hoàn tiền 14 ngày</div><div class="commit-desc">Không hài lòng trong 14 ngày đầu — hoàn 100% không hỏi lý do. Đã hoàn tiền cho 23 khách hàng năm 2026.</div></div>
        <div class="commit-card"><div class="commit-ico">🎓</div><div class="commit-ttl">Đào tạo 1-1 miễn phí</div><div class="commit-desc">2 buổi onboarding qua Google Meet. Đội ngũ hỗ trợ đến khi anh dùng được thành thạo.</div></div>
        <div class="commit-card"><div class="commit-ico">💬</div><div class="commit-ttl">Hỗ trợ tiếng Việt 24/7</div><div class="commit-desc">Zalo + hotline 0914.888.678. Gói Pro+ trực 24/7, gói Starter trong giờ hành chính.</div></div>
      </div>
    </div>
  </section>

  <!-- 5. TESTIMONIALS -->
  ${detail.testimonials && detail.testimonials.length ? `
  <section class="sec">
    <div class="sec-inner">
      <div class="sec-label">Khách hàng nói gì</div>
      <h2 class="sec-h2">${escapeHtml(String(product.users_count || ''))}+ doanh nghiệp đã chọn ${escapeHtml(product.name)}</h2>
      <div class="testi-grid">
        ${detail.testimonials.map(t => {
          const initials = t.name.split(' ').map(w => w[0]).join('').slice(0, 2).toUpperCase()
          return `
        <div class="testi-card">
          <p class="testi-q">"${escapeHtml(t.quote)}"</p>
          <div class="testi-author">
            <div class="testi-av">${escapeHtml(initials)}</div>
            <div>
              <div class="testi-name">${escapeHtml(t.name)}</div>
              <div class="testi-role">${escapeHtml(t.role)}</div>
            </div>
          </div>
        </div>`}).join('')}
      </div>
    </div>
  </section>` : ''}

  <!-- 6. FAQ -->
  ${detail.faq && detail.faq.length ? `
  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="sec-label">Câu hỏi thường gặp</div>
      <h2 class="sec-h2">Bạn đang thắc mắc điều gì?</h2>
      <div class="faq-grid">
        ${detail.faq.map((item, i) => `
        <div class="faq-item">
          <div class="faq-q"><span class="faq-qn">Q${i + 1}.</span>${escapeHtml(item.q)}</div>
          <div class="faq-a">${escapeHtml(item.a)}</div>
        </div>`).join('')}
      </div>
    </div>
  </section>` : ''}

  <!-- 7. RELATED PRODUCTS -->
  ${related.length ? `
  <section class="sec">
    <div class="sec-inner">
      <div class="sec-label">Khám phá thêm</div>
      <h2 class="sec-h2">Các AI Agent khác của VIAi</h2>
      <div class="related-grid">
        ${related.map(r => `
        <a href="/san-pham/${escapeHtml(r.slug)}" class="related-card">
          <div class="related-thumb">
            <span style="font-size:2rem">${escapeHtml(r.icon || '🤖')}</span>
            ${r.badge ? `<span class="related-badge">${escapeHtml(r.badge)}</span>` : ''}
          </div>
          <div class="related-body">
            <div class="related-name">${escapeHtml(r.name)}</div>
            <div class="related-tagline">${escapeHtml(r.description || r.detail?.heroDesc || '')}</div>
          </div>
        </a>`).join('')}
      </div>
    </div>
  </section>` : ''}

  <!-- 8. CTA -->
  <div class="p-wrap" style="padding-top:0">
    <div class="p-cta-box">
      <h2>Sẵn sàng triển khai <em>${escapeHtml(product.name)}</em>?</h2>
      <div class="p-cta-btns">
        <a href="/dung-thu.html" class="p-cta-main cta-pulse cta-shimmer cta-glow">🚀 Dùng thử miễn phí 14 ngày</a>
        <a href="/san-pham.html" class="p-cta-out">Xem các Agent khác</a>
      </div>
    </div>
  </div>

  <footer class="p-footer">
    <p>© 2026 VIAi Technology. <a href="/privacy.html">Chính sách bảo mật</a> · <a href="/terms.html">Điều khoản</a></p>
  </footer>

  <!-- Sticky bottom bar (mobile only) -->
  <div class="sticky-bar" aria-hidden="true">
    <div class="sb-info">
      <div class="sb-lbl">${escapeHtml(product.name)}</div>
      <div class="sb-name">Dùng thử miễn phí 7 ngày</div>
    </div>
    <a href="/dung-thu.html" style="border:2px solid var(--primary);border-radius:8px;padding:8px 14px;font-size:.82rem;font-weight:700;color:var(--primary)">Dùng thử</a>
    <a href="/dung-thu.html" class="p-cta-main cta-glow" style="padding:9px 16px;font-size:.82rem">Đăng ký ngay</a>
  </div>

  <script>
    function toggleMobileMenu() {
      const btn = document.getElementById('hamburger-btn');
      const menu = document.getElementById('mobile-menu');
      btn.classList.toggle('open');
      menu.classList.toggle('open');
      document.body.style.overflow = menu.classList.contains('open') ? 'hidden' : '';
    }
    function closeMobileMenu() {
      document.getElementById('hamburger-btn').classList.remove('open');
      document.getElementById('mobile-menu').classList.remove('open');
      document.body.style.overflow = '';
    }
    function toggleMobileSub(el) {
      const item = el.parentElement;
      const wasOpen = item.classList.contains('m-open');
      document.querySelectorAll('.mobile-nav-item.m-open').forEach(i => i.classList.remove('m-open'));
      if (!wasOpen) item.classList.add('m-open');
    }
    document.addEventListener('click', e => {
      const menu = document.getElementById('mobile-menu');
      const btn = document.getElementById('hamburger-btn');
      if (menu && menu.classList.contains('open') && !menu.contains(e.target) && !btn.contains(e.target)) closeMobileMenu();
    });
    let ddTimer = null;
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('mouseenter', () => { clearTimeout(ddTimer); document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('dd-open')); item.classList.add('dd-open'); });
      item.addEventListener('mouseleave', () => { ddTimer = setTimeout(() => item.classList.remove('dd-open'), 300); });
    });
  </script>
</body>
</html>`;
}

function renderBlogPage(post) {
  let faq = [];
  try { faq = JSON.parse(post.faq_json || '[]'); } catch {}
  const siteUrl = SITE_URL;
  const displayTitle = cleanSeoText(post.title);
  const title = cleanSeoText(post.seo_title || displayTitle);
  const pageTitle = /\bVIAi\b/i.test(title) ? title : `${title} | VIAi`;
  const desc = cleanMetaDescription(post.meta_description || post.excerpt || '');
  const url = `/blog/${post.slug}`;
  const absoluteUrl = `${siteUrl}${url}`;
  const imageUrl = post.image_url || `${siteUrl}/anhlogo/logo2.png`;
  const cleanContent = stripMarkdownTitle(post.content || post.excerpt || '', displayTitle);
  const articleSchema = {
    '@context': 'https://schema.org',
    '@type': 'BlogPosting',
    headline: displayTitle,
    description: desc,
    image: [imageUrl],
    datePublished: post.published_at,
    dateModified: post.published_at,
    author: { '@type': 'Organization', name: post.author || 'VIAi Team' },
    publisher: {
      '@type': 'Organization',
      name: 'VIAi',
      logo: { '@type': 'ImageObject', url: `${siteUrl}/anhlogo/logo2.png` }
    },
    mainEntityOfPage: { '@type': 'WebPage', '@id': absoluteUrl }
  };
  const breadcrumbSchema = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Trang chủ', item: siteUrl },
      { '@type': 'ListItem', position: 2, name: 'Blog', item: `${siteUrl}/#blog` },
      { '@type': 'ListItem', position: 3, name: displayTitle, item: absoluteUrl },
    ],
  };
  const faqSchema = Array.isArray(faq) && faq.length ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map(item => ({
      '@type': 'Question',
      name: item.question || '',
      acceptedAnswer: { '@type': 'Answer', text: item.answer || '' }
    }))
  } : null;
  const faqHtml = Array.isArray(faq) && faq.length
    ? `<section class="blog-faq"><h2>FAQ</h2>${faq.map(item => `
        <details>
          <summary>${escapeHtml(item.question || '')}</summary>
          <p>${escapeHtml(item.answer || '')}</p>
        </details>`).join('')}</section>`
    : '';

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(pageTitle)}</title>
  <link rel="icon" type="image/png" href="/anhlogo/logo2.png" />
  <link rel="shortcut icon" href="/anhlogo/logo2.png" />
  <link rel="apple-touch-icon" href="/anhlogo/logo2.png" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet" />
  <meta name="description" content="${escapeHtml(desc)}" />
  <link rel="canonical" href="${escapeHtml(absoluteUrl)}" />
  <meta property="og:type" content="article" />
  <meta property="og:site_name" content="VIAi" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(desc)}" />
  <meta property="og:url" content="${escapeHtml(absoluteUrl)}" />
  <meta property="og:image" content="${escapeHtml(imageUrl)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(desc)}" />
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}" />
  <script type="application/ld+json">${jsonLd(articleSchema)}</script>
  <script type="application/ld+json">${jsonLd(breadcrumbSchema)}</script>
  ${faqSchema ? `<script type="application/ld+json">${jsonLd(faqSchema)}</script>` : ''}
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--primary:#1A56DB;--primary-dark:#1040B0;--primary-light:#4B82F4;--accent:#FF6B00;--accent-light:#FF8C38;--gray-50:#EEF3FF;--gray-100:#DBEAFE;--gray-300:#6B93E8;--gray-600:#1E3A8A;--gray-900:#0F172A}
    html{scroll-behavior:smooth}
    body{font-family:'Be Vietnam Pro',Arial,'Helvetica Neue',sans-serif;background:#f4f7ff;color:#0f172a;line-height:1.75;overflow-x:hidden}
    a{text-decoration:none;color:inherit}
    .site-header{position:sticky;top:0;z-index:999;background:white;border-bottom:2px solid var(--primary);box-shadow:0 2px 12px rgba(26,86,219,.08)}
    .header-inner{max-width:1240px;margin:0 auto;padding:0 24px;height:80px;display:flex;align-items:center;justify-content:space-between;gap:24px}
    .site-logo{display:flex;align-items:center;gap:10px;flex-shrink:0}
    .logo-img{height:150px;width:auto;object-fit:contain;display:block;flex-shrink:0;mix-blend-mode:multiply}
    .main-nav{flex:1;display:flex;align-items:center;justify-content:center;gap:4px}
    .nav-item{position:relative}
    .nav-item>a{display:flex;align-items:center;gap:4px;padding:8px 14px;font-size:.9rem;font-weight:600;text-transform:uppercase;color:var(--gray-600);border-radius:8px;transition:all .2s;white-space:nowrap;position:relative}
    .nav-item>a::after{content:'';position:absolute;bottom:2px;left:14px;right:14px;height:2.5px;background:var(--primary);border-radius:2px;transform:scaleX(0);opacity:0;transition:transform .25s ease,opacity .25s ease;transform-origin:left center}
    .nav-item>a:hover,.nav-item.nav-active>a{color:var(--primary);background:var(--gray-50)}
    .nav-item>a:hover::after,.nav-item.nav-active>a::after{transform:scaleX(1);opacity:1}
    .nav-item>a .arrow{font-size:.65rem;transition:transform .2s}
    .nav-item:hover>a .arrow{transform:rotate(180deg)}
    .dropdown{display:block;position:absolute;top:calc(100% + 4px);left:0;min-width:220px;background:white;border:1px solid rgba(26,86,219,.1);border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,.04),0 20px 50px rgba(26,86,219,.14);padding:10px;z-index:100;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(-8px);transition:opacity .25s ease,visibility .25s ease,transform .25s cubic-bezier(.16,1,.3,1)}
    .dropdown::before{content:'';position:absolute;top:-6px;left:20px;width:12px;height:12px;background:white;border-left:1px solid rgba(26,86,219,.1);border-top:1px solid rgba(26,86,219,.1);transform:rotate(45deg);border-radius:2px 0 0 0}
    .nav-item:hover .dropdown,.nav-item:focus-within .dropdown{opacity:1;visibility:visible;pointer-events:auto;transform:translateY(0)}
    .dropdown a{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;font-size:.85rem;font-weight:500;color:var(--gray-600);transition:all .18s ease}
    .dropdown a:hover{background:var(--gray-50);color:var(--primary);transform:translateX(3px)}
    .dropdown a .dd-icon{font-size:1.1rem;flex-shrink:0}
    .dropdown-mega{min-width:480px;display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:14px}
    .dropdown-mega::before{left:50%;transform:translateX(-50%) rotate(45deg)}
    .dropdown-mega .mega-title{grid-column:1/-1;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--gray-300);padding:4px 14px 8px;border-bottom:1px solid var(--gray-100);margin-bottom:4px}
    .header-actions{display:flex;align-items:center;gap:10px;flex-shrink:0}
    .btn-login{display:inline-flex;align-items:center;justify-content:center;padding:8px 18px;border:2px solid var(--primary);border-radius:8px;font-size:.85rem;font-weight:700;color:var(--primary);transition:all .2s;background:white}
    .btn-login:hover{background:var(--primary);color:white}
    .btn-register{display:inline-flex;align-items:center;justify-content:center;padding:8px 18px;background:var(--accent);border-radius:8px;font-size:.85rem;font-weight:700;color:white;transition:all .2s;box-shadow:0 4px 14px rgba(255,107,74,.35)}
    .btn-register:hover{background:var(--accent-light);transform:translateY(-1px)}
    .hamburger-btn{display:none;flex-direction:column;justify-content:center;gap:5px;width:40px;height:40px;background:none;border:none;cursor:pointer;padding:6px;border-radius:8px;transition:background .2s;flex-shrink:0}
    .hamburger-btn:hover{background:var(--gray-50)}
    .hamburger-btn span{display:block;width:22px;height:2.5px;background:var(--gray-600);border-radius:2px;transition:all .3s ease;transform-origin:center}
    .hamburger-btn.open span:nth-child(1){transform:translateY(7.5px) rotate(45deg)}
    .hamburger-btn.open span:nth-child(2){opacity:0;transform:scaleX(0)}
    .hamburger-btn.open span:nth-child(3){transform:translateY(-7.5px) rotate(-45deg)}
    .mobile-menu{display:none;position:fixed;top:80px;left:0;right:0;background:white;border-top:2px solid var(--primary);box-shadow:0 8px 32px rgba(0,0,0,.12);z-index:998;padding:16px 20px 24px;max-height:calc(100vh - 80px);overflow-y:auto;animation:slideDown .25s ease}
    .mobile-menu.open{display:block}
    @keyframes slideDown{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
    .mobile-nav-item{border-bottom:1px solid #f1f5f9}
    .mobile-nav-link{width:100%;display:flex;align-items:center;justify-content:space-between;padding:14px 4px;font-size:.95rem;font-weight:700;color:var(--gray-600);cursor:pointer;background:none;border:none;font-family:inherit;text-align:left}
    .mobile-nav-link .m-arrow{font-size:.65rem;transition:transform .2s;color:var(--gray-300)}
    .mobile-nav-item.m-open .m-arrow{transform:rotate(180deg)}
    .mobile-submenu{display:none;padding:0 0 8px 12px}
    .mobile-nav-item.m-open .mobile-submenu{display:block}
    .mobile-submenu a{display:flex;align-items:center;gap:10px;padding:10px 8px;font-size:.88rem;font-weight:500;color:var(--gray-600);border-radius:8px;transition:all .15s}
    .mobile-submenu a:hover{background:var(--gray-50);color:var(--primary)}
    .mobile-plain-link{display:block;padding:14px 4px;font-size:.95rem;font-weight:700;color:var(--gray-600);border-bottom:1px solid #f1f5f9}
    .mobile-menu-actions{display:flex;flex-direction:column;gap:10px;margin-top:20px}
    .mobile-menu-actions .btn-login,.mobile-menu-actions .btn-register{text-align:center;padding:12px;font-size:.95rem}
    .user-dropdown-wrap{position:relative;display:inline-block}
    .user-trigger{display:flex;align-items:center;gap:8px;background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:8px;transition:background .2s;font-family:inherit}
    .user-trigger:hover{background:var(--gray-50)}
    .user-avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--primary-light));color:white;font-size:.78rem;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0}
    .user-name{font-size:.85rem;font-weight:700;color:var(--gray-600);max-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .user-caret{font-size:.6rem;color:var(--gray-300)}
    .user-menu{display:none;position:absolute;top:calc(100% + 8px);right:0;background:white;border:1px solid var(--gray-100);border-radius:12px;box-shadow:0 16px 40px rgba(26,86,219,.12);padding:8px;min-width:180px;z-index:1000}
    .user-menu.open{display:block}
    .user-menu a,.user-menu button{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;font-size:.85rem;font-weight:600;color:var(--gray-600);background:none;border:none;cursor:pointer;width:100%;font-family:inherit;text-align:left;transition:all .2s}
    .user-menu a:hover,.user-menu button:hover{background:var(--gray-50)}
    .user-menu button{color:#E52222;border-top:1px solid var(--gray-100);margin-top:4px}
    .hero{background:linear-gradient(135deg,#0F172A,#1A56DB);color:white;padding:52px 20px 42px}
    .hero-inner{max-width:960px;margin:0 auto}.cat{font-size:.78rem;font-weight:800;color:#FFB800;text-transform:uppercase;letter-spacing:1px;margin-bottom:12px}
    h1{font-size:clamp(1.8rem,4vw,3.1rem);line-height:1.18;margin-bottom:14px}
    .meta{font-size:.9rem;color:rgba(255,255,255,.75)}
    .wrap{max-width:960px;margin:0 auto;padding:32px 20px 70px}
    .thumb{width:100%;max-height:420px;object-fit:cover;border-radius:14px;margin-bottom:28px;background:#e2e8f0}
    article{background:white;border:1px solid #e2e8f0;border-radius:14px;padding:30px;box-shadow:0 8px 28px rgba(15,23,42,.06)}
    article h2{font-size:1.35rem;margin:30px 0 10px;color:#1A56DB}
    article h3{font-size:1.05rem;margin:22px 0 8px;color:#0f172a}
    article p{font-size:1rem;color:#334155;margin:0 0 14px}
    article a{color:#1A56DB;font-weight:700;text-decoration:none}article a:hover{text-decoration:underline}
    article ul{padding-left:22px;margin:8px 0 16px}
    article ol{padding-left:22px;margin:8px 0 16px}
    article li{margin:6px 0;color:#334155}
    article hr.blog-hr{border:none;border-top:2px solid #e2e8f0;margin:28px 0}
    article blockquote.blog-quote{margin:20px 0;padding:14px 20px;border-left:4px solid #1A56DB;background:#EEF3FF;border-radius:0 10px 10px 0;color:#1E3A8A;font-style:italic;font-size:.97rem}
    article figure.blog-fig{margin:24px 0;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;background:#f8faff}
    article figure.blog-fig img{width:100%;max-height:500px;object-fit:cover;display:block}
    article figure.blog-fig figcaption{padding:8px 14px;font-size:.82rem;color:#64748b;text-align:center;background:#f8faff}
    .tbl-wrap{overflow-x:auto;margin:18px 0 22px;border-radius:10px;border:1px solid #e2e8f0;box-shadow:0 2px 8px rgba(0,0,0,.04)}
    .tbl-wrap table{width:100%;border-collapse:collapse;font-size:.9rem;min-width:400px}
    .tbl-wrap thead th{background:#1A56DB;color:white;padding:10px 14px;text-align:left;font-weight:700;font-size:.82rem;white-space:nowrap}
    .tbl-wrap tbody td{padding:9px 14px;border-bottom:1px solid #f1f5f9;color:#334155;vertical-align:top}
    .tbl-wrap tbody tr:last-child td{border-bottom:none}
    .tbl-wrap tbody tr:nth-child(even) td{background:#f8faff}
    .tbl-wrap tbody tr:hover td{background:#EEF3FF}
    .blog-faq{margin-top:24px;background:white;border:1px solid #e2e8f0;border-radius:14px;padding:24px}
    .blog-faq h2{font-size:1.35rem;color:#1A56DB;margin-bottom:14px}
    details{border-top:1px solid #e2e8f0;padding:14px 0}details:first-of-type{border-top:none}
    summary{cursor:pointer;font-weight:800;color:#0f172a}details p{margin-top:8px;color:#475569}
    @media(max-width:960px){.main-nav,.header-actions{display:none}.hamburger-btn{display:flex}}
    @media(max-width:640px){.header-inner{padding:0 18px}.logo-img{height:132px}article{padding:22px}.hero{padding:42px 18px 34px}.wrap{padding:28px 18px 56px}}
  </style>
</head>
<body>
  ${renderSiteToolbar('blog')}
  <section class="hero">
    <div class="hero-inner">
      <div class="cat">${escapeHtml(post.category || 'Kiến thức AI')}</div>
      <h1>${escapeHtml(displayTitle)}</h1>
      <div class="meta">${escapeHtml(post.author || 'VIAi Team')} · ${escapeHtml(post.published_at || '')}</div>
    </div>
  </section>
  <main class="wrap">
    ${post.image_url ? `<img class="thumb" src="${escapeHtml(post.image_url)}" alt="${escapeHtml(post.image_alt || displayTitle)}" />` : ''}
    <article>${renderMarkdown(cleanContent, { skipH1: true })}</article>
    ${faqHtml}
  </main>
  ${renderSiteToolbarScript()}
</body>
</html>`;
}

// ── Security headers ──────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false, // tắt CSP để không block inline script/style
  crossOriginEmbedderPolicy: false,
}));

// ── CORS — chỉ cho phép domain của mình ──────────────
const allowedOrigins = [
  'https://phanmemaiagent.net',
  'https://www.phanmemaiagent.net',
  'https://ai-ho-tro-production.up.railway.app',
  'https://respectful-courtesy-production-4318.up.railway.app',
  'http://localhost:3000',
];
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) cb(null, true);
    else cb(new Error('CORS blocked'));
  },
  credentials: true,
}));

// ── Rate limiting ─────────────────────────────────────
// Giới hạn toàn bộ API: 100 request/phút
app.use('/api', rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'Quá nhiều yêu cầu, vui lòng thử lại sau.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

// Giới hạn admin-api: 60 request/phút
app.use('/admin-api', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Quá nhiều yêu cầu, vui lòng thử lại sau.' },
  standardHeaders: true,
  legacyHeaders: false,
}));

// ── CSRF: kiểm tra Origin cho các request thay đổi dữ liệu ──
app.use((req, res, next) => {
  if (['POST','PUT','DELETE','PATCH'].includes(req.method)) {
    const origin  = req.headers['origin']  || '';
    const referer = req.headers['referer'] || '';
    const allowed = allowedOrigins.some(o => origin.startsWith(o) || referer.startsWith(o));
    // Bỏ qua nếu không có origin (curl, Postman dev) nhưng giữ auth middleware
    if (origin && !allowed)
      return res.status(403).json({ error: 'Yêu cầu bị từ chối' });
  }
  next();
});

app.use(express.json({ limit: '2mb' }));

// ── Gzip compression ──────────────────────────────────
app.use(compression({ threshold: 1024 }));

// ── Page view tracking ────────────────────────────────
app.use((req, res, next) => {
  if (req.method === 'GET'
    && !req.path.startsWith('/api')
    && !req.path.startsWith('/admin')
    && !req.path.startsWith('/uploads')
    && !/\.(css|js|png|jpg|jpeg|ico|svg|woff|woff2|webp|gif|map|txt|xml)$/i.test(req.path)) {
    try { db.prepare('INSERT INTO page_views (path, ip) VALUES (?, ?)').run(req.path, req.ip || '').catch(()=>{}); } catch {}
  }
  next();
});

// ── Dynamic sitemap.xml ───────────────────────────────
app.get('/sitemap.xml', async (_req, res) => {
  const now = new Date().toISOString().slice(0, 10);
  const staticPages = [
    { loc: '/', changefreq: 'weekly',  priority: '1.0' },
    { loc: '/san-pham.html', changefreq: 'weekly',  priority: '0.9' },
    { loc: '/cong-nghe.html',changefreq: 'monthly', priority: '0.7' },
    { loc: '/about.html',    changefreq: 'monthly', priority: '0.7' },
    { loc: '/dung-thu.html', changefreq: 'monthly', priority: '0.8' },
    { loc: '/privacy.html',  changefreq: 'yearly',  priority: '0.3' },
    { loc: '/terms.html',    changefreq: 'yearly',  priority: '0.3' },
    { loc: '/cookies.html',  changefreq: 'yearly',  priority: '0.3' },
  ];
  const blogs    = await db.prepare("SELECT slug, published_at FROM blog_posts WHERE active=1 ORDER BY published_at DESC").all();
  const products = await db.prepare("SELECT slug FROM products WHERE active=1 AND slug IS NOT NULL ORDER BY order_index ASC").all();
  const congcus  = Object.keys(PRODUCT_DETAIL_BY_SLUG);

  const urlTag = ({ loc, lastmod, changefreq, priority }) =>
    `  <url>\n    <loc>${SITE_URL}${loc}</loc>\n` +
    (lastmod ? `    <lastmod>${lastmod}</lastmod>\n` : '') +
    `    <changefreq>${changefreq}</changefreq>\n    <priority>${priority}</priority>\n  </url>`;

  const entries = [
    ...staticPages.map(p => urlTag({ ...p, lastmod: now })),
    ...products.map(p => urlTag({ loc: `/san-pham/${p.slug}`, lastmod: now, changefreq: 'weekly', priority: '0.85' })),
    ...congcus.map(s  => urlTag({ loc: `/cong-cu/${s}`,       lastmod: now, changefreq: 'monthly', priority: '0.75' })),
    ...blogs.map(b    => urlTag({ loc: `/blog/${b.slug}`,     lastmod: b.published_at || now, changefreq: 'monthly', priority: '0.7' })),
  ];

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${entries.join('\n')}\n</urlset>`);
});

// ── Dynamic robots.txt ────────────────────────────────
app.get('/robots.txt', (_req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=86400');
  res.send(
    `User-agent: *\nAllow: /\nDisallow: /admin\nDisallow: /admin-api/\nDisallow: /api/\nDisallow: /uploads/\n\nSitemap: ${SITE_URL}/sitemap.xml`
  );
});

// ── Homepage động — inject settings từ DB ────────────
// Phải đặt TRƯỚC express.static để override index file
const fs = require('fs');
function getHomeTemplate() {
  return fs.readFileSync(path.join(__dirname, 'home.html'), 'utf8');
}
async function getSiteSettings() {
  const rows = await db.prepare('SELECT key, value FROM site_settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}
app.get('/', async (_req, res) => {
  try {
    const s = await getSiteSettings();
    let html = getHomeTemplate();
    // SEO
    html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(s.seo_title || '')}</title>`);
    html = html.replace(/(<meta name="description" content=")[^"]*/, `$1${escapeHtml(s.seo_description || '')}`);
    html = html.replace(/(<meta name="keywords" content=")[^"]*/, `$1${escapeHtml(s.seo_keywords || '')}`);
    html = html.replace(/(<meta property="og:title" content=")[^"]*/, `$1${escapeHtml(s.og_title || s.seo_title || '')}`);
    html = html.replace(/(<meta property="og:description" content=")[^"]*/, `$1${escapeHtml(s.og_description || s.seo_description || '')}`);
    html = html.replace(/(<meta name="twitter:title" content=")[^"]*/, `$1${escapeHtml(s.og_title || s.seo_title || '')}`);
    html = html.replace(/(<meta name="twitter:description" content=")[^"]*/, `$1${escapeHtml(s.og_description || s.seo_description || '')}`);
    // Hero badge
    if (s.hero_badge) html = html.replace(
      /(<div class="hero-tag">[\s\S]*?<div class="dot"><\/div>\s*)([^<]+)/,
      `$1${escapeHtml(s.hero_badge)}\n        `
    );
    // Hero description
    if (s.hero_desc) html = html.replace(
      /(<p class="hero-desc">)([\s\S]*?)(<\/p>)/,
      `$1\n          ${escapeHtml(s.hero_desc)}\n        $3`
    );
    // Trust stats
    const trustReplace = (num, pattern, suffix) => {
      if (!num) return;
      const bare = num.replace(/[+x%]/g, '');
      html = html.replace(new RegExp(`(<div class="trust-num">)${pattern}(<span>${suffix}<\\/span>)`), `$1${bare}$2`);
    };
    trustReplace(s.trust1_num, '500', '\\+');
    if (s.trust1_label) html = html.replace('Doanh nghiệp tin dùng', escapeHtml(s.trust1_label));
    trustReplace(s.trust2_num, '10', 'x');
    if (s.trust2_label) html = html.replace('Tăng năng suất làm việc', escapeHtml(s.trust2_label));
    trustReplace(s.trust3_num, '98', '%');
    if (s.trust3_label) html = html.replace('Khách hàng hài lòng', escapeHtml(s.trust3_label));

    // CTA section
    if (s.cta_title) html = html.replace(
      /(<h2>Sẵn sàng để <em>)AI làm việc(<\/em> thay bạn\?<\/h2>)/,
      `$1${escapeHtml(s.cta_title).replace('Sẵn sàng để ','').replace(' thay bạn?','')}$2`
    ).replace('Sẵn sàng để <em>AI làm việc</em> thay bạn?', `${escapeHtml(s.cta_title)}`);
    if (s.cta_subtitle) html = html.replace(
      'Dùng thử miễn phí 14 ngày · Không cần thẻ tín dụng · Hỗ trợ cài đặt 1-1 miễn phí',
      escapeHtml(s.cta_subtitle)
    );
    if (s.cta_btn1_text) html = html.replace('🚀 Bắt đầu miễn phí ngay', escapeHtml(s.cta_btn1_text));
    if (s.cta_btn2_text) html = html.replace('📞 Tư vấn ngay hôm nay', escapeHtml(s.cta_btn2_text));

    // FAQ — inject vào FAQ_DATA constant trong JS
    if (s.homepage_faq) {
      try {
        const faqArr = JSON.parse(s.homepage_faq);
        const faqJs = JSON.stringify(faqArr);
        html = html.replace(/const FAQ_DATA = \[[\s\S]*?\];/, `const FAQ_DATA = ${faqJs};`);
      } catch {}
    }

    // Pricing — inject pricing cards từ DB
    const plans = await db.prepare('SELECT * FROM pricing_plans WHERE active=1 ORDER BY order_index ASC').all();
    if (plans.length > 0) {
      const pricingHtml = plans.map(plan => {
        let features = [];
        try { features = JSON.parse(plan.features || '[]'); } catch {}
        const isHighlight = !!plan.highlight;
        const bgStyle = isHighlight
          ? 'background:linear-gradient(160deg,#1040B0,#1A56DB);color:white;position:relative;transform:scale(1.03);box-shadow:0 20px 50px rgba(26,86,219,0.35)'
          : 'background:white;border:1.5px solid #e8eef8';
        const priceColor = isHighlight ? 'color:white' : 'color:var(--gray-900)';
        const featureColor = isHighlight ? 'color:rgba(255,255,255,0.85)' : 'color:#374151';
        const checkColor = isHighlight ? 'color:rgba(255,255,255,0.9)' : 'color:var(--green)';
        const ctaStyle = isHighlight
          ? 'background:white;color:var(--primary);font-weight:800'
          : 'border:2px solid var(--primary);color:var(--primary)';
        const badge = plan.badge ? `<div style="position:absolute;top:-14px;left:50%;transform:translateX(-50%);background:var(--accent);color:white;font-size:0.72rem;font-weight:800;padding:4px 18px;border-radius:20px;white-space:nowrap">${escapeHtml(plan.badge)}</div>` : '';
        return `<div style="${bgStyle};border-radius:20px;padding:36px 28px;transition:all 0.25s" class="reveal">${badge}
          <div style="font-size:1.6rem;margin-bottom:12px">${escapeHtml(plan.icon||'🌱')}</div>
          <div style="font-size:0.8rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;${isHighlight?'color:rgba(255,255,255,0.6)':'color:#64748b'};margin-bottom:8px">${escapeHtml(plan.name)}</div>
          <div style="font-size:0.85rem;${isHighlight?'color:rgba(255,255,255,0.7)':'color:#94a3b8'};margin-bottom:20px">${escapeHtml(plan.subtitle||'')}</div>
          <div style="margin-bottom:24px">
            <span class="price-month" style="font-size:2.2rem;font-weight:900;${priceColor}">${escapeHtml(plan.price_month)}</span>
            ${plan.price_year ? `<span class="price-year" style="font-size:2.2rem;font-weight:900;${priceColor};display:none">${escapeHtml(plan.price_year)}</span>` : ''}
            <span style="font-size:0.85rem;${isHighlight?'color:rgba(255,255,255,0.5)':'color:#94a3b8'}">/tháng</span>
          </div>
          <a href="/dung-thu.html" style="display:block;text-align:center;padding:12px;border-radius:10px;font-weight:700;font-size:0.9rem;margin-bottom:28px;transition:all 0.2s;${ctaStyle}">${escapeHtml(plan.cta_text||'Dùng thử miễn phí')}</a>
          <ul style="list-style:none;display:flex;flex-direction:column;gap:10px">
            ${features.map(f => `<li style="font-size:0.85rem;${featureColor};display:flex;gap:8px"><span style="${checkColor}">✓</span> ${escapeHtml(f)}</li>`).join('')}
          </ul>
        </div>`;
      }).join('');
      html = html.replace(
        /<div style="display:grid;grid-template-columns:repeat\(3,1fr\);gap:24px" id="pricing-grid">[\s\S]*?<\/div>\s*\n\s*\n\s*<\/div>\s*\n\s*<\/section>\s*\n\s*<!-- CTA/,
        `<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:24px" id="pricing-grid">${pricingHtml}</div>\n\n</div>\n</section>\n<!-- CTA`
      );
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(html);
  } catch(e) {
    res.sendFile(path.join(__dirname, 'home.html'));
  }
});

// ── Block sensitive files trước khi static serve ─────
// Ngăn express.static tiết lộ source code, DB và config
const BLOCKED_EXTENSIONS = /\.(db|db-shm|db-wal|js|mjs|cjs|json|sql|log|md|txt|npmrc|gitignore|env|lock)$/i;
const ALLOWED_PATHS = [
  '/robots.txt', '/sitemap.xml',           // dynamic routes (đã xử lý trước)
  '/google4e6ef32eed8f2a43.html',          // Google Search Console verification
];
app.use((req, res, next) => {
  const p = req.path.toLowerCase();
  if (BLOCKED_EXTENSIONS.test(p) && !ALLOWED_PATHS.includes(p)) {
    return res.status(404).end();
  }
  next();
});

// ── Static files với cache headers ───────────────────
const staticOpts = {
  index: false,
  setHeaders(res, filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (['.jpg','.jpeg','.png','.gif','.webp','.svg','.ico'].includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable'); // 30 ngày
    } else if (['.js','.css'].includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=604800'); // 7 ngày
    } else if (['.html'].includes(ext)) {
      res.setHeader('Cache-Control', 'public, max-age=300'); // 5 phút
    }
  },
};
app.use(express.static(__dirname, staticOpts));
app.use('/uploads', express.static(path.join(__dirname, 'uploads'), {
  setHeaders(res) { res.setHeader('Cache-Control', 'public, max-age=2592000'); }
}));

app.use('/api',       require('./routes/api'));
app.use('/admin-api', require('./routes/admin'));

app.get('/admin', (_req, res) =>
  res.sendFile(path.join(__dirname, 'admin', 'index.html'))
);

// ── Footer dùng chung cho 3 trang giải pháp ──────────
function renderSolutionFooter() {
  return `
  <footer style="background:linear-gradient(135deg,#0A1628 0%,#0D2144 100%);color:white;padding:48px 20px 24px;margin-top:0">
    <div style="max-width:1180px;margin:0 auto">
      <div style="display:grid;grid-template-columns:1.8fr 1fr 1fr 1fr;gap:32px;margin-bottom:40px">
        <div>
          <img src="/anhlogo/logo4.png" alt="VIAi" style="height:48px;margin-bottom:14px;filter:brightness(0) invert(1)" onerror="this.style.display='none'" />
          <p style="font-size:.85rem;color:rgba(255,255,255,.6);line-height:1.7;max-width:300px">AI Agent Platform dành cho doanh nghiệp vừa và nhỏ Việt Nam. Tự động hóa thông minh – hiệu quả – dễ dùng.</p>
        </div>
        <div>
          <h5 style="font-size:.78rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,.4);margin-bottom:12px">Phần mềm</h5>
          <ul style="list-style:none;display:flex;flex-direction:column;gap:8px">
            <li><a href="/cong-cu/zalo-sales-agent" style="font-size:.84rem;color:rgba(255,255,255,.65);text-decoration:none;transition:color .2s" onmouseover="this.style.color='#FFB800'" onmouseout="this.style.color='rgba(255,255,255,.65)'">Zalo Sales Agent</a></li>
            <li><a href="/cong-cu/order-management-agent" style="font-size:.84rem;color:rgba(255,255,255,.65);text-decoration:none" onmouseover="this.style.color='#FFB800'" onmouseout="this.style.color='rgba(255,255,255,.65)'">Order Agent</a></li>
            <li><a href="/cong-cu/crm-automation-agent" style="font-size:.84rem;color:rgba(255,255,255,.65);text-decoration:none" onmouseover="this.style.color='#FFB800'" onmouseout="this.style.color='rgba(255,255,255,.65)'">CRM Agent</a></li>
            <li><a href="/cong-cu/report-analytics-agent" style="font-size:.84rem;color:rgba(255,255,255,.65);text-decoration:none" onmouseover="this.style.color='#FFB800'" onmouseout="this.style.color='rgba(255,255,255,.65)'">Report Agent</a></li>
          </ul>
        </div>
        <div>
          <h5 style="font-size:.78rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,.4);margin-bottom:12px">Giải pháp</h5>
          <ul style="list-style:none;display:flex;flex-direction:column;gap:8px">
            <li><a href="/phan-mem" style="font-size:.84rem;color:rgba(255,255,255,.65);text-decoration:none" onmouseover="this.style.color='#FFB800'" onmouseout="this.style.color='rgba(255,255,255,.65)'">Phần mềm AI Agent</a></li>
            <li><a href="/dich-vu" style="font-size:.84rem;color:rgba(255,255,255,.65);text-decoration:none" onmouseover="this.style.color='#FFB800'" onmouseout="this.style.color='rgba(255,255,255,.65)'">Dịch vụ triển khai</a></li>
            <li><a href="/dao-tao" style="font-size:.84rem;color:rgba(255,255,255,.65);text-decoration:none" onmouseover="this.style.color='#FFB800'" onmouseout="this.style.color='rgba(255,255,255,.65)'">Khóa học AI Agent</a></li>
          </ul>
        </div>
        <div>
          <h5 style="font-size:.78rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:rgba(255,255,255,.4);margin-bottom:12px">Liên hệ</h5>
          <ul style="list-style:none;display:flex;flex-direction:column;gap:8px">
            <li style="font-size:.84rem;color:rgba(255,255,255,.65)">📞 1900 8686 06</li>
            <li style="font-size:.84rem;color:rgba(255,255,255,.65)">📞 1900 8686 08</li>
            <li style="font-size:.84rem;color:rgba(255,255,255,.65)">✉️ support@viai.vn</li>
            <li><a href="/about.html" style="font-size:.84rem;color:rgba(255,255,255,.65);text-decoration:none" onmouseover="this.style.color='#FFB800'" onmouseout="this.style.color='rgba(255,255,255,.65)'">Về chúng tôi</a></li>
          </ul>
        </div>
      </div>
      <div style="border-top:1px solid rgba(255,255,255,.08);padding-top:20px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
        <p style="font-size:.78rem;color:rgba(255,255,255,.4)">© 2026 VIAi Technology. Bảo lưu mọi quyền.</p>
        <div style="display:flex;gap:16px">
          <a href="/privacy.html" style="font-size:.78rem;color:rgba(255,255,255,.4);text-decoration:none" onmouseover="this.style.color='white'" onmouseout="this.style.color='rgba(255,255,255,.4)'">Chính sách bảo mật</a>
          <a href="/terms.html" style="font-size:.78rem;color:rgba(255,255,255,.4);text-decoration:none" onmouseover="this.style.color='white'" onmouseout="this.style.color='rgba(255,255,255,.4)'">Điều khoản</a>
        </div>
      </div>
    </div>
  </footer>`;
}

// ── CSS chung cho 3 trang giải pháp ──────────────────
function renderSolutionCSS() {
  return `
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--primary:#1A56DB;--primary-dark:#1040B0;--accent:#FF6B00;--accent-light:#FF8C38;--gray-50:#EEF3FF;--gray-100:#DBEAFE;--gray-600:#1E3A8A;--gray-900:#0F172A}
    html{scroll-behavior:smooth}body{font-family:'Be Vietnam Pro',Arial,sans-serif;color:var(--gray-900);background:#F8FAFF;overflow-x:hidden}
    a{text-decoration:none;color:inherit}
    /* header */
    .site-header{position:sticky;top:0;z-index:999;background:white;border-bottom:2px solid var(--primary);box-shadow:0 2px 12px rgba(26,86,219,.08)}
    .header-inner{max-width:1240px;margin:0 auto;padding:0 24px;height:80px;display:flex;align-items:center;justify-content:space-between;gap:24px}
    .site-logo{display:flex;align-items:center;flex-shrink:0}.logo-img{height:150px;width:auto;object-fit:contain;mix-blend-mode:multiply}
    .main-nav{flex:1;display:flex;align-items:center;justify-content:center;gap:4px}.nav-item{position:relative}
    .nav-item>a{display:flex;align-items:center;gap:4px;padding:8px 14px;font-size:.9rem;font-weight:600;text-transform:uppercase;color:var(--gray-600);border-radius:8px;transition:all .2s;white-space:nowrap;position:relative}
    .nav-item>a::after{content:'';position:absolute;bottom:2px;left:14px;right:14px;height:2.5px;background:var(--primary);border-radius:2px;transform:scaleX(0);opacity:0;transition:transform .25s,opacity .25s;transform-origin:left}
    .nav-item>a:hover,.nav-item.nav-active>a{color:var(--primary);background:var(--gray-50)}.nav-item>a:hover::after,.nav-item.nav-active>a::after{transform:scaleX(1);opacity:1}
    .nav-item>a .arrow{font-size:.65rem;transition:transform .2s}.nav-item:hover>a .arrow{transform:rotate(180deg)}
    .dropdown{display:block;position:absolute;top:calc(100% + 4px);left:0;min-width:220px;background:white;border:1px solid rgba(26,86,219,.1);border-radius:12px;box-shadow:0 4px 6px rgba(0,0,0,.04),0 20px 50px rgba(26,86,219,.14);padding:10px;z-index:100;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(-8px);transition:opacity .25s,visibility .25s,transform .25s cubic-bezier(.16,1,.3,1)}
    .nav-item:hover .dropdown,.nav-item:focus-within .dropdown{opacity:1;visibility:visible;pointer-events:auto;transform:translateY(0)}
    .dropdown a{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:8px;font-size:.85rem;font-weight:500;color:var(--gray-600);transition:all .18s}.dropdown a:hover{background:var(--gray-50);color:var(--primary);transform:translateX(3px)}
    .dropdown a .dd-icon{font-size:1.1rem;flex-shrink:0}.dropdown-mega{min-width:480px;display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:14px}.mega-title{grid-column:1/-1;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:#6B93E8;padding:4px 14px 8px;border-bottom:1px solid var(--gray-100);margin-bottom:4px}
    .header-actions{display:flex;align-items:center;gap:10px;flex-shrink:0}.btn-login{padding:8px 18px;border:2px solid var(--primary);border-radius:8px;font-size:.85rem;font-weight:700;color:var(--primary);transition:all .2s;background:white;display:inline-flex;align-items:center}.btn-login:hover{background:var(--primary);color:white}.btn-register{padding:8px 18px;background:var(--accent);border-radius:8px;font-size:.85rem;font-weight:700;color:white;transition:all .2s;display:inline-flex;align-items:center}.btn-register:hover{background:var(--accent-light);transform:translateY(-1px)}
    .hamburger-btn{display:none;flex-direction:column;justify-content:center;gap:5px;width:40px;height:40px;background:none;border:none;cursor:pointer;padding:6px;border-radius:8px;flex-shrink:0}.hamburger-btn span{display:block;width:22px;height:2.5px;background:var(--gray-600);border-radius:2px;transition:all .3s;transform-origin:center}.hamburger-btn.open span:nth-child(1){transform:translateY(7.5px) rotate(45deg)}.hamburger-btn.open span:nth-child(2){opacity:0;transform:scaleX(0)}.hamburger-btn.open span:nth-child(3){transform:translateY(-7.5px) rotate(-45deg)}
    .mobile-menu{display:none;position:fixed;top:80px;left:0;right:0;background:white;border-top:2px solid var(--primary);box-shadow:0 8px 32px rgba(0,0,0,.12);z-index:998;padding:16px 20px 24px;max-height:calc(100vh - 80px);overflow-y:auto}.mobile-menu.open{display:block}
    .mobile-nav-item{border-bottom:1px solid #f1f5f9}.mobile-nav-link{width:100%;display:flex;align-items:center;justify-content:space-between;padding:14px 4px;font-size:.95rem;font-weight:700;color:var(--gray-600);cursor:pointer;background:none;border:none;font-family:inherit;text-align:left}.mobile-nav-item.m-open .m-arrow{transform:rotate(180deg)}.mobile-submenu{display:none;padding:0 0 8px 12px}.mobile-nav-item.m-open .mobile-submenu{display:block}.mobile-submenu a{display:flex;align-items:center;gap:10px;padding:10px 8px;font-size:.88rem;font-weight:500;color:var(--gray-600);border-radius:8px}.mobile-plain-link{display:block;padding:14px 4px;font-size:.95rem;font-weight:700;color:var(--gray-600);border-bottom:1px solid #f1f5f9}.mobile-menu-actions{display:flex;flex-direction:column;gap:10px;margin-top:20px}
    @media(max-width:960px){.main-nav,.header-actions{display:none}.hamburger-btn{display:flex}}
    /* CTA animations */
    @keyframes cta-pulse-ring{0%{box-shadow:0 0 0 0 rgba(255,107,0,.55)}70%{box-shadow:0 0 0 14px rgba(255,107,0,0)}100%{box-shadow:0 0 0 0 rgba(255,107,0,0)}}.cta-pulse{animation:cta-pulse-ring 2.2s cubic-bezier(.4,0,.6,1) infinite}.cta-pulse:hover{animation-play-state:paused}
    .cta-shimmer{position:relative;overflow:hidden;isolation:isolate}.cta-shimmer::after{content:'';position:absolute;inset:0;background:linear-gradient(110deg,transparent 30%,rgba(255,255,255,.28) 50%,transparent 70%);transform:translateX(-100%);transition:transform .8s ease;pointer-events:none}.cta-shimmer:hover::after{transform:translateX(100%)}
    .cta-glow{box-shadow:0 8px 26px -6px rgba(255,107,0,.58)}.cta-glow:hover{box-shadow:0 12px 32px -6px rgba(255,107,0,.72)}
    @keyframes arrow-b{0%,100%{transform:translateX(0)}50%{transform:translateX(4px)}}.cta-arrow{display:inline-block;animation:arrow-b 1.4s ease-in-out infinite}
    /* page sections */
    .sol-hero{background:linear-gradient(135deg,#0F172A 0%,#1A56DB 60%,#1040B0 100%);padding:72px 20px 60px;position:relative;overflow:hidden;color:white}
    .sol-hero::before{content:'';position:absolute;width:500px;height:500px;background:rgba(255,255,255,.04);border-radius:50%;top:-200px;right:-100px;pointer-events:none}
    .sol-inner{max-width:1100px;margin:0 auto;position:relative;z-index:1}
    .sol-bc{display:flex;align-items:center;gap:6px;font-size:.78rem;color:rgba(255,255,255,.6);margin-bottom:18px}.sol-bc a{color:rgba(255,255,255,.6);transition:color .2s}.sol-bc a:hover{color:#FFB800}.sol-bc .sep{font-size:.6rem;color:rgba(255,255,255,.35)}
    .sol-tag{display:inline-block;background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.2);color:#FFB800;font-size:.78rem;font-weight:700;padding:5px 14px;border-radius:50px;margin-bottom:16px;letter-spacing:.5px}
    .sol-hero h1{font-size:clamp(2rem,4vw,3.2rem);font-weight:900;line-height:1.18;margin-bottom:14px}
    .sol-hero p{font-size:1.05rem;color:rgba(255,255,255,.78);max-width:680px;line-height:1.75;margin-bottom:28px}
    .sol-btns{display:flex;gap:12px;flex-wrap:wrap}
    .sol-btn-main{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:white;padding:13px 24px;border-radius:10px;font-weight:800;font-size:.95rem;transition:all .2s}
    .sol-btn-out{display:inline-flex;align-items:center;gap:8px;border:2px solid rgba(255,255,255,.35);color:white;padding:13px 22px;border-radius:10px;font-weight:700;font-size:.95rem;background:rgba(255,255,255,.08);transition:all .2s}.sol-btn-out:hover{background:rgba(255,255,255,.18)}
    .sec{padding:64px 20px}.sec-alt{background:white}.sec-inner{max-width:1100px;margin:0 auto}
    .sec-label{font-size:.72rem;font-weight:900;text-transform:uppercase;letter-spacing:1.2px;color:var(--accent);margin-bottom:6px}
    .sec-h2{font-size:clamp(1.5rem,2.5vw,2.2rem);font-weight:900;margin-bottom:10px;color:var(--gray-900)}
    .sec-sub{font-size:.97rem;color:#64748b;margin-bottom:36px;max-width:680px}
    .card-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px}
    .card-grid-2{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}
    .card-grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}
    .sol-card{background:white;border:1px solid #E2E8F0;border-radius:14px;padding:22px;transition:box-shadow .2s,transform .2s}.sol-card:hover{box-shadow:0 8px 28px rgba(26,86,219,.1);transform:translateY(-2px)}
    .sol-card-icon{font-size:2rem;margin-bottom:12px}
    .sol-card h3{font-size:1rem;font-weight:800;margin-bottom:7px;color:var(--gray-900)}
    .sol-card p{font-size:.86rem;color:#475569;line-height:1.65}
    .sol-card-link{display:inline-flex;align-items:center;gap:5px;font-size:.82rem;font-weight:700;color:var(--primary);margin-top:12px}
    .agent-card{background:white;border:1px solid #E2E8F0;border-radius:14px;overflow:hidden;transition:all .2s}.agent-card:hover{box-shadow:0 8px 24px rgba(26,86,219,.1);transform:translateY(-2px)}
    .agent-thumb{background:linear-gradient(135deg,#1040B0,#1A56DB);padding:20px 16px;display:flex;align-items:center;gap:10px}
    .agent-thumb-ico{font-size:2rem}.agent-thumb-badge{font-size:.65rem;font-weight:700;text-transform:uppercase;background:rgba(255,255,255,.18);color:white;padding:3px 9px;border-radius:20px;margin-left:auto}
    .agent-body{padding:16px}.agent-name{font-size:.95rem;font-weight:800;color:var(--gray-900);margin-bottom:5px}.agent-desc{font-size:.8rem;color:#64748b;line-height:1.55;margin-bottom:10px}
    .agent-link{font-size:.8rem;font-weight:700;color:var(--primary);display:flex;align-items:center;gap:4px}
    .step-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:0;position:relative}
    .step-grid::before{content:'';position:absolute;top:32px;left:10%;right:10%;height:2px;background:linear-gradient(90deg,var(--primary),var(--accent));z-index:0}
    .step{text-align:center;padding:0 12px;position:relative;z-index:1}
    .step-num{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--accent));color:white;font-size:1.4rem;font-weight:900;display:flex;align-items:center;justify-content:center;margin:0 auto 16px;box-shadow:0 4px 16px rgba(26,86,219,.3)}
    .step h3{font-size:.92rem;font-weight:800;margin-bottom:6px;color:var(--gray-900)}.step p{font-size:.8rem;color:#64748b;line-height:1.6}
    .commit-dark{background:#0A2472;color:white;padding:64px 20px}
    .commit-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:12px;margin-top:28px}
    .commit-card{border-radius:12px;padding:18px;background:rgba(255,255,255,.06)}.commit-card.feat{background:rgba(255,107,0,.18);border:1.5px solid rgba(255,107,0,.6)}
    .commit-ico{font-size:1.3rem;margin-bottom:10px}.commit-ttl{font-size:.87rem;font-weight:800;margin-bottom:5px}.commit-desc{font-size:.74rem;color:rgba(255,255,255,.68);line-height:1.55}
    .cta-band{background:linear-gradient(135deg,#1040B0,#1A56DB 55%,#FF6B00 100%);border-radius:20px;padding:52px 40px;display:flex;align-items:center;justify-content:space-between;gap:28px;flex-wrap:wrap;margin:60px 20px;max-width:1100px;margin-left:auto;margin-right:auto}
    .cta-band h2{font-size:clamp(1.5rem,2.4vw,2.2rem);font-weight:900;color:white;line-height:1.2}
    .cta-band p{color:rgba(255,255,255,.75);margin-top:8px;max-width:560px;font-size:.97rem}
    .cta-btns{display:flex;gap:12px;flex-wrap:wrap;flex-shrink:0}
    .faq-grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:28px}
    .faq-item{background:white;border:1px solid #E2E8F0;border-radius:12px;padding:18px}
    .faq-q{font-size:.9rem;font-weight:700;color:var(--gray-900);margin-bottom:8px;display:flex;gap:8px}
    .faq-qn{color:var(--accent);flex-shrink:0}.faq-a{font-size:.85rem;color:#475569;line-height:1.65}
    /* Example flow */
    .ex-wrap{background:white;border:1px solid #E2E8F0;border-radius:16px;padding:28px;margin-top:28px}
    .ex-label{font-size:.82rem;font-weight:700;color:#64748b;margin-bottom:18px;padding:9px 14px;background:#F8FAFF;border-radius:8px;border-left:3px solid var(--accent);display:flex;align-items:center;gap:8px}
    .ex-flow{display:flex;flex-direction:column;gap:14px}
    .ex-step{display:flex;align-items:flex-start;gap:12px}
    .ex-avatar{width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,var(--primary),#4B82F4);display:flex;align-items:center;justify-content:center;font-size:1.1rem;flex-shrink:0;box-shadow:0 2px 8px rgba(26,86,219,.2)}
    .ex-bubble{flex:1;background:#F8FAFF;border:1px solid #e2e8f0;border-radius:0 12px 12px 12px;padding:11px 14px}
    .ex-bubble.ai{background:#EEF3FF;border-color:rgba(26,86,219,.15);border-radius:12px 12px 12px 0}
    .ex-role{font-size:.72rem;font-weight:800;color:var(--primary);margin-bottom:4px;text-transform:uppercase;letter-spacing:.5px}
    .ex-msg{font-size:.88rem;color:#334155;line-height:1.7}
    .ex-results{display:flex;gap:0;border:1px solid #E2E8F0;border-radius:12px;overflow:hidden;margin-top:20px}
    .ex-result-item{flex:1;text-align:center;padding:14px 10px;background:linear-gradient(135deg,#EEF3FF,#F8FAFF)}
    .ex-result-item:not(:last-child){border-right:1px solid #E2E8F0}
    .ex-result-num{font-size:1.4rem;font-weight:900;color:var(--primary);display:block}
    .ex-result-lbl{font-size:.72rem;color:#64748b;font-weight:600;margin-top:2px;display:block}
    @media(max-width:768px){.card-grid,.card-grid-4,.commit-grid{grid-template-columns:repeat(2,1fr)}.step-grid{grid-template-columns:1fr 1fr;row-gap:28px}.step-grid::before{display:none}.faq-grid,.card-grid-2{grid-template-columns:1fr}.cta-band{flex-direction:column;padding:36px 24px;margin:40px 16px}.ex-results{flex-wrap:wrap}.ex-result-item{flex:1 0 40%}}{.card-grid,.card-grid-4,.commit-grid{grid-template-columns:repeat(2,1fr)}.step-grid{grid-template-columns:1fr 1fr;row-gap:28px}.step-grid::before{display:none}.faq-grid,.card-grid-2{grid-template-columns:1fr}.cta-band{flex-direction:column;padding:36px 24px;margin:40px 16px}}
    @media(max-width:480px){.card-grid,.card-grid-4,.commit-grid{grid-template-columns:1fr}.sol-btns{flex-direction:column}}
  </style>`;
}

// ── Page 1: /phan-mem ─────────────────────────────────
function renderPhanMem() {
  const agents = [
    { slug:'zalo-sales-agent', icon:'💬', name:'Zalo Sales Agent', desc:'Tư vấn và chốt đơn qua Zalo OA 24/7 — không cần nhân viên trực.', badge:'HOT' },
    { slug:'order-management-agent', icon:'📦', name:'Order Management Agent', desc:'Gom đơn từ Shopee, Lazada, Website vào một luồng xử lý thống nhất.', badge:'PHỔ BIẾN' },
    { slug:'crm-automation-agent', icon:'🤝', name:'CRM Automation Agent', desc:'Phân loại khách hàng, nhắc lịch chăm sóc và gửi ưu đãi cá nhân hóa.', badge:'' },
    { slug:'report-analytics-agent', icon:'📊', name:'Report & Analytics Agent', desc:'Tổng hợp báo cáo từ 20+ nguồn, gửi Zalo lúc 8h sáng mỗi ngày.', badge:'MỚI' },
    { slug:'email-marketing-agent', icon:'📧', name:'Email Marketing Agent', desc:'Lên lịch và gửi email cá nhân hóa theo hành vi người dùng.', badge:'BETA' },
    { slug:'facebook-ads-agent', icon:'📢', name:'Facebook Ads Agent', desc:'Theo dõi ROAS, đề xuất tối ưu ngân sách quảng cáo tự động.', badge:'' },
    { slug:'booking-appointment', icon:'🗓️', name:'Booking & Appointment', desc:'Nhận lịch hẹn, xác nhận và nhắc khách tự động 24/7.', badge:'' },
    { slug:'custom-enterprise-agent', icon:'🏗️', name:'Custom Enterprise Agent', desc:'Xây dựng AI Agent theo nghiệp vụ đặc thù của doanh nghiệp anh.', badge:'' },
  ];
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Phần mềm AI Agent đóng gói sẵn | VIAi</title>
  <meta name="description" content="8 AI Agent sẵn sàng triển khai cho doanh nghiệp Việt — Zalo Sales, Order, CRM, Report, Email, Ads, Booking. Triển khai trong 24 giờ, không cần kỹ thuật."/>
  <link rel="canonical" href="${SITE_URL}/phan-mem"/>
  <meta property="og:title" content="Phần mềm AI Agent | VIAi"/><meta property="og:description" content="8 AI Agent đóng gói sẵn cho doanh nghiệp Việt."/><meta property="og:url" content="${SITE_URL}/phan-mem"/>
  <link rel="icon" href="/anhlogo/logo2.png"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
  ${renderSolutionCSS()}
</head>
<body>
  ${renderSiteToolbar()}
  <!-- HERO -->
  <section class="sol-hero">
    <div class="sol-inner">
      <nav class="sol-bc"><a href="/">Trang chủ</a><span class="sep">›</span><span style="color:rgba(255,255,255,.9)">Phần mềm AI Agent</span></nav>
      <div class="sol-tag">Phần mềm</div>
      <h1>AI Agent đóng gói sẵn<br>triển khai trong <em style="color:#FFB800;font-style:normal">24 giờ</em></h1>
      <p>8 AI Agent chuyên biệt, sẵn sàng kết nối với hệ thống của bạn. Không cần đội kỹ thuật, không cần viết code — VIAi lo toàn bộ cài đặt và bàn giao.</p>
      <div class="sol-btns">
        <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">🚀 Dùng thử miễn phí <span class="cta-arrow">→</span></a>
        <a href="#agents" class="sol-btn-out">Xem danh sách Agent ↓</a>
      </div>
    </div>
  </section>

  <!-- TẠI SAO CHỌN -->
  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="sec-label">Lợi ích</div>
      <h2 class="sec-h2">Tại sao chọn phần mềm AI Agent của VIAi?</h2>
      <p class="sec-sub">Không phải chatbot — là AI Agent thực sự hành động: tạo đơn, cập nhật CRM, gửi báo cáo, chăm sóc khách hàng — hoàn toàn tự động.</p>
      <div class="card-grid">
        <div class="sol-card"><div class="sol-card-icon">⚡</div><h3>Triển khai trong 24 giờ</h3><p>Từ lúc ký hợp đồng đến khi Agent chạy thực tế chỉ mất một ngày làm việc. Đội ngũ VIAi hỗ trợ cài đặt toàn bộ.</p></div>
        <div class="sol-card"><div class="sol-card-icon">🔗</div><h3>Kết nối 100+ ứng dụng</h3><p>Zalo, Facebook, Shopee, Lazada, Google Sheets, MISA, Base.vn và hàng trăm ứng dụng khác — không cần viết code.</p></div>
        <div class="sol-card"><div class="sol-card-icon">🛡️</div><h3>Bảo mật dữ liệu tuyệt đối</h3><p>Dữ liệu lưu tại máy chủ Việt Nam, mã hóa end-to-end, tuân thủ tiêu chuẩn ISO 27001 và quy định PDPA.</p></div>
        <div class="sol-card"><div class="sol-card-icon">📞</div><h3>Hỗ trợ 1-1 tiếng Việt</h3><p>Chuyên gia thực sự hỗ trợ qua Zalo và hotline. Cam kết phản hồi trong 30 phút giờ hành chính.</p></div>
        <div class="sol-card"><div class="sol-card-icon">🔄</div><h3>Tự học và cải thiện</h3><p>Agent sử dụng dữ liệu thực tế của doanh nghiệp để liên tục tối ưu phản hồi và quy trình xử lý.</p></div>
        <div class="sol-card"><div class="sol-card-icon">💰</div><h3>Hoàn tiền 14 ngày</h3><p>Nếu không hài lòng trong 14 ngày đầu, VIAi hoàn 100% không hỏi lý do. Rủi ro bằng không.</p></div>
      </div>
    </div>
  </section>

  <!-- DANH SÁCH AGENT -->
  <section class="sec" id="agents">
    <div class="sec-inner">
      <div class="sec-label">Thư viện Agent</div>
      <h2 class="sec-h2">8 AI Agent sẵn sàng triển khai</h2>
      <p class="sec-sub">Chọn Agent phù hợp với nghiệp vụ — hoặc để đội ngũ VIAi tư vấn miễn phí Agent tối ưu nhất cho doanh nghiệp của bạn.</p>
      <div class="card-grid" style="grid-template-columns:repeat(4,1fr)">
        ${agents.map(a => `
        <a href="/san-pham/${escapeHtml(a.slug)}" class="agent-card">
          <div class="agent-thumb">
            <span class="agent-thumb-ico">${escapeHtml(a.icon)}</span>
            ${a.badge ? `<span class="agent-thumb-badge">${escapeHtml(a.badge)}</span>` : ''}
          </div>
          <div class="agent-body">
            <div class="agent-name">${escapeHtml(a.name)}</div>
            <div class="agent-desc">${escapeHtml(a.desc)}</div>
            <div class="agent-link">Xem chi tiết <span class="cta-arrow" style="animation-duration:2s">→</span></div>
          </div>
        </a>`).join('')}
      </div>
    </div>
  </section>

  <!-- VÍ DỤ THỰC TẾ - PHAN MEM -->
  <section class="sec">
    <div class="sec-inner">
      <div class="sec-label">Ví dụ thực tế</div>
      <h2 class="sec-h2">Xem AI Agent hoạt động như thế nào?</h2>
      <p class="sec-sub">Shop mỹ phẩm online — 11 giờ đêm, nhân viên đã nghỉ</p>
      <div class="ex-wrap">
        <div class="ex-label">📍 Shop mỹ phẩm online — khách nhắn Zalo lúc 23:14</div>
        <div class="ex-flow">
          <div class="ex-step">
            <div class="ex-avatar">👤</div>
            <div class="ex-bubble">
              <div class="ex-role">Khách hàng</div>
              <div class="ex-msg">Bạn ơi, Serum Vitamin C 30ml còn hàng không? Giá bao nhiêu vậy? Mình cần gấp</div>
            </div>
          </div>
          <div class="ex-step">
            <div class="ex-avatar">🤖</div>
            <div class="ex-bubble ai">
              <div class="ex-role">Zalo Sales Agent · 3 giây</div>
              <div class="ex-msg">Dạ còn ạ! Serum Vitamin C 30ml hiện có 24 hộp. 💛 Giá gốc 530.000đ → Đang sale còn <strong>450.000đ</strong> (giảm 15%). Anh/chị muốn đặt ngay không ạ?</div>
            </div>
          </div>
          <div class="ex-step">
            <div class="ex-avatar">👤</div>
            <div class="ex-bubble">
              <div class="ex-role">Khách hàng</div>
              <div class="ex-msg">Cho mình 2 hộp nhé, giao về Quận 3 TP.HCM</div>
            </div>
          </div>
          <div class="ex-step">
            <div class="ex-avatar">🤖</div>
            <div class="ex-bubble ai">
              <div class="ex-role">Zalo Sales Agent · tự động</div>
              <div class="ex-msg">✅ Đã tạo đơn <strong>#7823</strong> — 2 Serum Vitamin C = <strong>900.000đ</strong> (freeship đơn từ 500k). Giao Q.3 dự kiến 1-2 ngày. Mình gửi link thanh toán nhé! 🛍️</div>
            </div>
          </div>
          <div class="ex-step">
            <div class="ex-avatar">📊</div>
            <div class="ex-bubble ai">
              <div class="ex-role">Báo cáo sáng 8:00 gửi cho chủ shop</div>
              <div class="ex-msg">Đêm qua: 12 đơn tự động · Doanh thu 8.4tr · 3 khách mới · Không cần nhân viên trực ✨</div>
            </div>
          </div>
        </div>
        <div class="ex-results">
          <div class="ex-result-item"><span class="ex-result-num">3s</span><span class="ex-result-lbl">Phản hồi tức thì</span></div>
          <div class="ex-result-item"><span class="ex-result-num">24/7</span><span class="ex-result-lbl">Không cần trực</span></div>
          <div class="ex-result-item"><span class="ex-result-num">100%</span><span class="ex-result-lbl">Tự động tạo đơn</span></div>
          <div class="ex-result-item"><span class="ex-result-num">0đ</span><span class="ex-result-lbl">Chi phí nhân sự đêm</span></div>
        </div>
      </div>
    </div>
  </section>

  <!-- FAQ -->
  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="sec-label">Câu hỏi thường gặp</div>
      <h2 class="sec-h2">Bạn đang thắc mắc điều gì?</h2>
      <div class="faq-grid">
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q1.</span>Tôi không biết lập trình, có dùng được không?</div><div class="faq-a">Hoàn toàn không cần kỹ thuật. Giao diện tiếng Việt, đội VIAi hỗ trợ cài đặt 1-1 từ đầu đến cuối trong 24 giờ.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q2.</span>Agent có hoạt động 24/7 không?</div><div class="faq-a">Có. Agent chạy liên tục không cần giám sát — kể cả cuối tuần, ngày lễ và 2 giờ sáng. Uptime cam kết 99.9%.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q3.</span>Tôi có thể dùng nhiều Agent cùng lúc không?</div><div class="faq-a">Có. Nhiều doanh nghiệp dùng 2-3 Agent cùng lúc (ví dụ Zalo Sales + CRM + Report). Giá ưu đãi khi combo.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q4.</span>Dữ liệu khách hàng có an toàn không?</div><div class="faq-a">Mã hóa AES-256, lưu trữ tại Việt Nam, tuân thủ ISO 27001. VIAi không bán hay chia sẻ dữ liệu với bên thứ ba.</div></div>
      </div>
    </div>
  </section>

  <!-- CTA -->
  <div class="cta-band">
    <div><h2>Sẵn sàng triển khai AI Agent?</h2><p>Bắt đầu với 7 ngày dùng thử miễn phí — không cần thẻ tín dụng, đội VIAi hỗ trợ cài đặt 1-1.</p></div>
    <div class="cta-btns">
      <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">🚀 Dùng thử miễn phí</a>
      <a href="/#pricing" class="sol-btn-out" style="border-color:rgba(255,255,255,.4)">Xem bảng giá</a>
    </div>
  </div>

  ${renderSolutionFooter()}
  ${renderSiteToolbarScript()}
</body>
</html>`;
}

// ── Page 2: /dich-vu ─────────────────────────────────
function renderDichVu() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Dịch vụ triển khai AI Agent trọn gói | VIAi</title>
  <meta name="description" content="VIAi tư vấn, cấu hình, tích hợp và bàn giao AI Agent trọn gói cho doanh nghiệp. Cam kết triển khai trong 30 ngày, SLA 99.9% uptime."/>
  <link rel="canonical" href="${SITE_URL}/dich-vu"/>
  <meta property="og:title" content="Dịch vụ triển khai AI Agent | VIAi"/><meta property="og:url" content="${SITE_URL}/dich-vu"/>
  <link rel="icon" href="/anhlogo/logo2.png"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
  ${renderSolutionCSS()}
</head>
<body>
  ${renderSiteToolbar()}
  <!-- HERO -->
  <section class="sol-hero" style="background:linear-gradient(135deg,#0F172A 0%,#0D3B8E 55%,#1A56DB 100%)">
    <div class="sol-inner">
      <nav class="sol-bc"><a href="/">Trang chủ</a><span class="sep">›</span><span style="color:rgba(255,255,255,.9)">Dịch vụ triển khai</span></nav>
      <div class="sol-tag">Dịch vụ</div>
      <h1>Triển khai AI Agent<br><em style="color:#FFB800;font-style:normal">trọn gói</em> — bàn giao tận tay</h1>
      <p>Đội ngũ VIAi khảo sát quy trình, thiết kế giải pháp, cấu hình tích hợp và đào tạo team của bạn — cho đến khi Agent vận hành trơn tru và sinh ra kết quả thực tế.</p>
      <div class="sol-btns">
        <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">📞 Đặt lịch tư vấn miễn phí <span class="cta-arrow">→</span></a>
        <a href="#quy-trinh" class="sol-btn-out">Xem quy trình ↓</a>
      </div>
    </div>
  </section>

  <!-- DỊCH VỤ BAO GỒM -->
  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="sec-label">Gói dịch vụ</div>
      <h2 class="sec-h2">Chúng tôi làm gì cho bạn?</h2>
      <p class="sec-sub">Từ khảo sát nghiệp vụ đến vận hành thực tế — VIAi đồng hành toàn bộ hành trình AI của doanh nghiệp.</p>
      <div class="card-grid">
        <div class="sol-card"><div class="sol-card-icon">🔍</div><h3>Tư vấn & Khảo sát</h3><p>Phân tích quy trình hiện tại, xác định điểm tắc nghẽn và đề xuất AI Agent phù hợp nhất với mục tiêu kinh doanh của bạn.</p></div>
        <div class="sol-card"><div class="sol-card-icon">⚙️</div><h3>Cấu hình & Tích hợp</h3><p>Kết nối Agent với Zalo OA, CRM, phần mềm kho, hệ thống kế toán và tất cả nền tảng doanh nghiệp đang sử dụng.</p></div>
        <div class="sol-card"><div class="sol-card-icon">🧠</div><h3>Đào tạo AI theo dữ liệu</h3><p>Huấn luyện Agent trên dữ liệu thực tế: sản phẩm, giá, chính sách, kịch bản bán hàng và nghiệp vụ đặc thù.</p></div>
        <div class="sol-card"><div class="sol-card-icon">🚀</div><h3>Triển khai & Bàn giao</h3><p>Chạy thử nghiệm trong môi trường thực, điều chỉnh theo phản hồi và bàn giao khi Agent đạt chuẩn kỳ vọng.</p></div>
        <div class="sol-card"><div class="sol-card-icon">📊</div><h3>Theo dõi & Báo cáo</h3><p>Dashboard theo dõi hiệu suất Agent theo thời gian thực. Báo cáo định kỳ về ROI và đề xuất tối ưu liên tục.</p></div>
        <div class="sol-card"><div class="sol-card-icon">🛠️</div><h3>Bảo trì & Hỗ trợ</h3><p>Đội kỹ thuật trực 24/7 cho gói Pro+. Cập nhật Agent theo thay đổi nghiệp vụ không tính phí trong 3 tháng đầu.</p></div>
      </div>
    </div>
  </section>

  <!-- QUY TRÌNH -->
  <section class="sec" id="quy-trinh">
    <div class="sec-inner">
      <div class="sec-label">Quy trình</div>
      <h2 class="sec-h2">4 bước từ ký kết đến vận hành</h2>
      <p class="sec-sub" style="margin-bottom:48px">Minh bạch, đúng tiến độ, có cam kết cụ thể ở từng giai đoạn.</p>
      <div class="step-grid">
        <div class="step"><div class="step-num">1</div><h3>Khảo sát nghiệp vụ</h3><p>Phỏng vấn team, phân tích quy trình và xác định 3-5 điểm tắc nghẽn cần tự động hóa ngay.</p></div>
        <div class="step"><div class="step-num">2</div><h3>Thiết kế giải pháp</h3><p>Đề xuất kiến trúc Agent, kế hoạch tích hợp và timeline triển khai — được duyệt trước khi bắt đầu.</p></div>
        <div class="step"><div class="step-num">3</div><h3>Tích hợp & Đào tạo</h3><p>Kết nối hệ thống, huấn luyện AI trên dữ liệu thực và kiểm thử trong môi trường staging.</p></div>
        <div class="step"><div class="step-num">4</div><h3>Go-live & Tối ưu</h3><p>Chạy production, theo dõi 2 tuần đầu, điều chỉnh và bàn giao kèm tài liệu vận hành đầy đủ.</p></div>
      </div>
    </div>
  </section>

  <!-- CAM KẾT -->
  <section class="commit-dark">
    <div style="max-width:1100px;margin:0 auto">
      <div style="font-size:.72rem;font-weight:900;text-transform:uppercase;letter-spacing:1.2px;color:#FFB800;margin-bottom:6px">Cam kết</div>
      <h2 style="font-size:clamp(1.5rem,2.5vw,2.2rem);font-weight:900;color:white;margin-bottom:28px">5 cam kết cụ thể — không chung chung</h2>
      <div class="commit-grid">
        <div class="commit-card feat"><div class="commit-ico">🏗️</div><div class="commit-ttl">Triển khai trong 30 ngày</div><div class="commit-desc">Agent vận hành production tối đa 30 ngày làm việc — quá hạn → miễn phí toàn bộ phí triển khai.</div></div>
        <div class="commit-card"><div class="commit-ico">🔒</div><div class="commit-ttl">Bảo mật AES-256</div><div class="commit-desc">Server Viettel IDC tại Việt Nam, đạt chuẩn ISO/IEC 27001.</div></div>
        <div class="commit-card"><div class="commit-ico">↩️</div><div class="commit-ttl">Hoàn tiền 14 ngày</div><div class="commit-desc">Không hài lòng trong 14 ngày đầu → hoàn 100% không hỏi lý do.</div></div>
        <div class="commit-card"><div class="commit-ico">🎓</div><div class="commit-ttl">Đào tạo 1-1 miễn phí</div><div class="commit-desc">2 buổi onboarding qua Google Meet. Hỗ trợ đến khi team dùng thành thạo.</div></div>
        <div class="commit-card"><div class="commit-ico">💬</div><div class="commit-ttl">SLA 99.9% uptime</div><div class="commit-desc">Cam kết uptime 99.9%, hỗ trợ Zalo + hotline 24/7 cho gói Pro+.</div></div>
      </div>
    </div>
  </section>

  <!-- VÍ DỤ THỰC TẾ - DICH VU -->
  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="sec-label">Ví dụ thực tế</div>
      <h2 class="sec-h2">Triển khai cho chuỗi spa 5 chi nhánh — 3 tuần</h2>
      <p class="sec-sub">Từ quy trình thủ công đến AI Agent vận hành hoàn toàn tự động</p>
      <div class="ex-wrap">
        <div class="ex-label">📍 Chuỗi spa & thẩm mỹ viện — 5 chi nhánh tại TP.HCM</div>
        <div class="ex-flow">
          <div class="ex-step">
            <div class="ex-avatar">🔍</div>
            <div class="ex-bubble ai">
              <div class="ex-role">Tuần 1 — Khảo sát nghiệp vụ</div>
              <div class="ex-msg">Đội VIAi phân tích quy trình: nhận booking → phân nhân viên → nhắc hẹn → báo cáo. Xác định 4 điểm tắc nghẽn: lễ tân bận xác nhận lịch, khách hay quên hẹn, lịch nhân viên bị chồng, không có báo cáo tập trung.</div>
            </div>
          </div>
          <div class="ex-step">
            <div class="ex-avatar">⚙️</div>
            <div class="ex-bubble ai">
              <div class="ex-role">Tuần 2 — Cấu hình & tích hợp</div>
              <div class="ex-msg">Kết nối Zalo OA, Google Calendar và phần mềm quản lý spa. Đào tạo Booking Agent trên 2.000 lịch sử đặt lịch thực tế. Kiểm thử toàn bộ luồng nhận lịch → xác nhận → nhắc hẹn.</div>
            </div>
          </div>
          <div class="ex-step">
            <div class="ex-avatar">🚀</div>
            <div class="ex-bubble ai">
              <div class="ex-role">Tuần 3 — Go-live</div>
              <div class="ex-msg">Agent vận hành chính thức: tự nhận lịch từ Zalo 24/7, phân kỹ thuật viên theo lịch trống, gửi nhắc hẹn trước 24h. Lễ tân chuyển sang chăm sóc khách trực tiếp tại quầy.</div>
            </div>
          </div>
          <div class="ex-step">
            <div class="ex-avatar">📊</div>
            <div class="ex-bubble">
              <div class="ex-role">Tháng 1 — Kết quả thực tế</div>
              <div class="ex-msg">Tỷ lệ hủy hẹn giảm 62% · Lễ tân tiết kiệm 3 giờ/ngày · 98% khách nhận xác nhận trong 30 giây · Doanh thu tăng 18% do nhận được booking ngoài giờ hành chính</div>
            </div>
          </div>
        </div>
        <div class="ex-results">
          <div class="ex-result-item"><span class="ex-result-num">3 tuần</span><span class="ex-result-lbl">Thời gian triển khai</span></div>
          <div class="ex-result-item"><span class="ex-result-num">-62%</span><span class="ex-result-lbl">Tỷ lệ hủy hẹn</span></div>
          <div class="ex-result-item"><span class="ex-result-num">3h/ngày</span><span class="ex-result-lbl">Tiết kiệm nhân sự</span></div>
          <div class="ex-result-item"><span class="ex-result-num">+18%</span><span class="ex-result-lbl">Doanh thu tháng 1</span></div>
        </div>
      </div>
    </div>
  </section>

  <!-- FAQ -->
  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="sec-label">FAQ</div>
      <h2 class="sec-h2">Câu hỏi thường gặp về dịch vụ</h2>
      <div class="faq-grid">
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q1.</span>Dịch vụ này khác gì so với tự mua phần mềm?</div><div class="faq-a">Phần mềm anh tự cài đặt. Dịch vụ trọn gói thì VIAi lo từ A-Z: khảo sát, cấu hình, đào tạo và bảo trì — phù hợp với doanh nghiệp không có đội kỹ thuật nội bộ.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q2.</span>Chi phí triển khai tính như thế nào?</div><div class="faq-a">Phí một lần cho giai đoạn triển khai + phí vận hành hàng tháng. Liên hệ để nhận báo giá chi tiết theo quy mô và số Agent cần triển khai.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q3.</span>Hệ thống cũ của tôi có tích hợp được không?</div><div class="faq-a">Trong hầu hết trường hợp — có. VIAi tích hợp qua API, webhook hoặc RPA. Trường hợp phức tạp hơn sẽ được đánh giá miễn phí trong buổi khảo sát.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q4.</span>Sau khi triển khai nếu cần thay đổi thì sao?</div><div class="faq-a">Thay đổi nhỏ trong 3 tháng đầu miễn phí. Thay đổi lớn tính theo giờ công minh bạch — không có phí ẩn.</div></div>
      </div>
    </div>
  </section>

  <!-- CTA -->
  <div class="cta-band">
    <div><h2>Đặt lịch tư vấn miễn phí</h2><p>30 phút khảo sát, VIAi sẽ đề xuất giải pháp phù hợp và báo giá cụ thể cho doanh nghiệp của bạn.</p></div>
    <div class="cta-btns">
      <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">📞 Đặt lịch tư vấn ngay</a>
      <a href="/phan-mem" class="sol-btn-out" style="border-color:rgba(255,255,255,.4)">Xem phần mềm AI Agent</a>
    </div>
  </div>

  ${renderSolutionFooter()}
  ${renderSiteToolbarScript()}
</body>
</html>`;
}

// ── Page 3: /dao-tao ─────────────────────────────────
function renderDaoTao() {
  const courses = [
    { icon:'🤖', level:'Cơ bản', name:'AI Agent 101', desc:'Hiểu AI Agent là gì, cách hoạt động và cách chọn Agent phù hợp với nghiệp vụ doanh nghiệp. Dành cho người mới bắt đầu.', duration:'8 buổi', format:'Online + Video ghi lại', price:'3.990.000đ' },
    { icon:'⚙️', level:'Thực chiến', name:'n8n & Automation Thực chiến', desc:'Xây dựng workflow tự động hóa với n8n — kết nối Zalo, Google Sheets, CRM và hơn 400 ứng dụng. Không cần code.', duration:'12 buổi', format:'Online Live + Project thực tế', price:'6.990.000đ' },
    { icon:'🏆', level:'Nâng cao', name:'AI Agent for Business', desc:'Thiết kế và triển khai hệ thống AI Agent đa bước cho doanh nghiệp. Bao gồm quản lý prompt, đánh giá hiệu suất và scale.', duration:'16 buổi', format:'Online + 1-1 Mentoring', price:'12.990.000đ' },
  ];
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Khóa học AI Agent thực chiến | VIAi</title>
  <meta name="description" content="Khóa học AI Agent thực chiến cho doanh nghiệp Việt Nam — từ cơ bản đến nâng cao. Học n8n, automation, và cách triển khai AI Agent cho nghiệp vụ thực tế."/>
  <link rel="canonical" href="${SITE_URL}/dao-tao"/>
  <meta property="og:title" content="Khóa học AI Agent | VIAi"/><meta property="og:url" content="${SITE_URL}/dao-tao"/>
  <link rel="icon" href="/anhlogo/logo2.png"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
  ${renderSolutionCSS()}
  <style>
    .course-card{background:white;border:1px solid #E2E8F0;border-radius:16px;overflow:hidden;transition:all .2s}.course-card:hover{box-shadow:0 12px 32px rgba(26,86,219,.12);transform:translateY(-3px)}
    .course-head{background:linear-gradient(135deg,#1040B0,#1A56DB);padding:24px;color:white}
    .course-level{font-size:.68rem;font-weight:700;text-transform:uppercase;letter-spacing:.8px;background:rgba(255,255,255,.18);padding:3px 10px;border-radius:20px;display:inline-block;margin-bottom:10px}
    .course-icon{font-size:2.2rem;margin-bottom:10px;display:block}
    .course-head h3{font-size:1.2rem;font-weight:900;margin-bottom:6px}.course-head p{font-size:.85rem;color:rgba(255,255,255,.8);line-height:1.6}
    .course-body{padding:20px}.course-meta{display:flex;flex-direction:column;gap:7px;margin-bottom:16px}
    .course-meta-item{display:flex;align-items:center;gap:8px;font-size:.84rem;color:#475569}
    .course-meta-item span:first-child{font-size:.9rem;width:20px}
    .course-price{font-size:1.6rem;font-weight:900;color:var(--primary);margin-bottom:16px}
    .course-btn{display:block;text-align:center;background:var(--accent);color:white;padding:11px;border-radius:8px;font-weight:700;font-size:.9rem;transition:all .2s}.course-btn:hover{background:var(--accent-light);transform:translateY(-1px)}
    .benefit-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px}
    .benefit-item{display:flex;align-items:flex-start;gap:12px;background:white;border-radius:12px;padding:16px;border:1px solid #E2E8F0}
    .benefit-ico{font-size:1.4rem;flex-shrink:0;margin-top:2px}
    .benefit-title{font-size:.9rem;font-weight:800;margin-bottom:4px;color:var(--gray-900)}.benefit-desc{font-size:.82rem;color:#475569;line-height:1.6}
    @media(max-width:768px){.benefit-grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  ${renderSiteToolbar()}
  <!-- HERO -->
  <section class="sol-hero" style="background:linear-gradient(135deg,#0F172A 0%,#1E3A8A 50%,#0F172A 100%)">
    <div class="sol-inner">
      <nav class="sol-bc"><a href="/">Trang chủ</a><span class="sep">›</span><span style="color:rgba(255,255,255,.9)">Khóa học AI Agent</span></nav>
      <div class="sol-tag">Đào tạo</div>
      <h1>Khóa học AI Agent<br><em style="color:#FFB800;font-style:normal">thực chiến</em> cho doanh nghiệp</h1>
      <p>Huấn luyện đội ngũ tự vận hành, đo lường và tối ưu AI Agent theo quy trình thực tế. Từ người mới bắt đầu đến triển khai production thực tế.</p>
      <div class="sol-btns">
        <a href="#khoa-hoc" class="sol-btn-main cta-pulse cta-shimmer cta-glow">📚 Xem các khóa học <span class="cta-arrow">→</span></a>
        <a href="/dung-thu.html" class="sol-btn-out">Đăng ký tư vấn miễn phí</a>
      </div>
      <div style="display:flex;gap:24px;margin-top:28px;flex-wrap:wrap">
        <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">500+</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Học viên</div></div>
        <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">3</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Cấp độ khóa học</div></div>
        <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">4.9★</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Đánh giá trung bình</div></div>
        <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">24/7</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Hỗ trợ học viên</div></div>
      </div>
    </div>
  </section>

  <!-- KHÓA HỌC -->
  <section class="sec sec-alt" id="khoa-hoc">
    <div class="sec-inner">
      <div class="sec-label">Chương trình đào tạo</div>
      <h2 class="sec-h2">Chọn khóa học phù hợp</h2>
      <p class="sec-sub">Lộ trình học từ cơ bản đến nâng cao — mỗi khóa đều có project thực tế và chứng chỉ hoàn thành.</p>
      <div class="card-grid">
        ${courses.map(c => `
        <div class="course-card">
          <div class="course-head">
            <span class="course-level">${escapeHtml(c.level)}</span>
            <span class="course-icon">${escapeHtml(c.icon)}</span>
            <h3>${escapeHtml(c.name)}</h3>
            <p>${escapeHtml(c.desc)}</p>
          </div>
          <div class="course-body">
            <div class="course-meta">
              <div class="course-meta-item"><span>⏱️</span><span>${escapeHtml(c.duration)}</span></div>
              <div class="course-meta-item"><span>💻</span><span>${escapeHtml(c.format)}</span></div>
              <div class="course-meta-item"><span>🎓</span><span>Chứng chỉ hoàn thành</span></div>
            </div>
            <div class="course-price">${escapeHtml(c.price)}</div>
            <a href="/dung-thu.html" class="course-btn">Đăng ký ngay →</a>
          </div>
        </div>`).join('')}
      </div>
    </div>
  </section>

  <!-- LỢI ÍCH -->
  <section class="sec">
    <div class="sec-inner">
      <div class="sec-label">Lợi ích</div>
      <h2 class="sec-h2">Sau khóa học, bạn có thể làm gì?</h2>
      <p class="sec-sub" style="margin-bottom:28px">Kỹ năng thực tế — không phải lý thuyết suông.</p>
      <div class="benefit-grid">
        <div class="benefit-item"><div class="benefit-ico">🤖</div><div><div class="benefit-title">Tự chọn và cấu hình AI Agent</div><div class="benefit-desc">Biết cách đánh giá và chọn Agent phù hợp, cấu hình kịch bản và quy tắc xử lý theo nghiệp vụ.</div></div></div>
        <div class="benefit-item"><div class="benefit-ico">🔗</div><div><div class="benefit-title">Tích hợp với hệ thống hiện tại</div><div class="benefit-desc">Kết nối Agent với Zalo, CRM, Google Sheets, phần mềm kế toán và 400+ ứng dụng qua n8n.</div></div></div>
        <div class="benefit-item"><div class="benefit-ico">📊</div><div><div class="benefit-title">Đo lường và tối ưu hiệu suất</div><div class="benefit-desc">Xây dashboard theo dõi KPI của Agent, phân tích dữ liệu và ra quyết định tối ưu dựa trên số liệu.</div></div></div>
        <div class="benefit-item"><div class="benefit-ico">🏢</div><div><div class="benefit-title">Triển khai cho toàn doanh nghiệp</div><div class="benefit-desc">Nhân rộng mô hình từ 1 Agent thành nhiều Agent phối hợp — tự động hóa chuỗi quy trình phức tạp.</div></div></div>
      </div>
    </div>
  </section>

  <!-- VÍ DỤ THỰC TẾ - DAO TAO -->
  <section class="sec">
    <div class="sec-inner">
      <div class="sec-label">Ví dụ thực tế</div>
      <h2 class="sec-h2">Hành trình học của chị Hoa — chủ shop thời trang</h2>
      <p class="sec-sub">Từ người không biết kỹ thuật đến tự vận hành 3 AI Agent sau 3 tháng</p>
      <div class="ex-wrap">
        <div class="ex-label">📍 Chị Nguyễn Thu Hoa — chủ shop thời trang online, 200 đơn/ngày</div>
        <div class="ex-flow">
          <div class="ex-step">
            <div class="ex-avatar">😓</div>
            <div class="ex-bubble">
              <div class="ex-role">Trước khi học — vấn đề thực tế</div>
              <div class="ex-msg">"Mình mất 4-5 tiếng/ngày chỉ để trả lời Zalo, tổng hợp đơn từ 3 sàn và làm báo cáo thủ công. Không có thời gian làm chiến lược hay chăm sóc khách hàng VIP."</div>
            </div>
          </div>
          <div class="ex-step">
            <div class="ex-avatar">📚</div>
            <div class="ex-bubble ai">
              <div class="ex-role">Tuần 4 — Sau khóa AI Agent 101</div>
              <div class="ex-msg">"Mình hiểu AI Agent hoạt động thế nào rồi. Đã tự kết nối Zalo OA với n8n, tự động lấy đơn từ Shopee về một bảng Google Sheets. Tiết kiệm 1 tiếng/ngày ngay từ tuần đầu!"</div>
            </div>
          </div>
          <div class="ex-step">
            <div class="ex-avatar">⚡</div>
            <div class="ex-bubble ai">
              <div class="ex-role">Tháng 2 — Sau khóa n8n Thực chiến</div>
              <div class="ex-msg">"Tự xây được workflow nhắc khách sau mua hàng, tự động gửi voucher sinh nhật và phân loại khách VIP. Tỷ lệ review 5 sao tăng 3x, khách quay lại mua tăng rõ rệt."</div>
            </div>
          </div>
          <div class="ex-step">
            <div class="ex-avatar">🏆</div>
            <div class="ex-bubble">
              <div class="ex-role">Tháng 3 — Kết quả</div>
              <div class="ex-msg">"Mình đang tự vận hành 3 AI Agent: Zalo Sales, Order Management và Report. Tiết kiệm gần 4 tiếng/ngày. Doanh thu tháng 3 tăng 38% so với trước khi học vì có thêm thời gian làm marketing."</div>
            </div>
          </div>
        </div>
        <div class="ex-results">
          <div class="ex-result-item"><span class="ex-result-num">4h/ngày</span><span class="ex-result-lbl">Tiết kiệm được</span></div>
          <div class="ex-result-item"><span class="ex-result-num">3 Agent</span><span class="ex-result-lbl">Tự vận hành</span></div>
          <div class="ex-result-item"><span class="ex-result-num">3x</span><span class="ex-result-lbl">Tỷ lệ review tăng</span></div>
          <div class="ex-result-item"><span class="ex-result-num">+38%</span><span class="ex-result-lbl">Doanh thu tháng 3</span></div>
        </div>
      </div>
    </div>
  </section>

  <!-- FAQ -->
  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="sec-label">FAQ</div>
      <h2 class="sec-h2">Câu hỏi về khóa học</h2>
      <div class="faq-grid">
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q1.</span>Tôi không biết kỹ thuật có học được không?</div><div class="faq-a">Khóa cơ bản AI Agent 101 không yêu cầu kiến thức kỹ thuật. Khóa n8n yêu cầu biết sử dụng máy tính thành thạo. Khóa nâng cao phù hợp người có hiểu biết về hệ thống.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q2.</span>Học xong có được hỗ trợ triển khai thực tế không?</div><div class="faq-a">Có. Học viên được ưu đãi 20% khi dùng dịch vụ triển khai của VIAi và được mentor review project trong 30 ngày sau khi học xong.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q3.</span>Học online hay offline?</div><div class="faq-a">Chủ yếu online live qua Zoom, có ghi lại video để xem lại. Một số khóa có buổi workshop offline tại TP.HCM và Hà Nội.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q4.</span>Có học phần mềm của VIAi trong khóa học không?</div><div class="faq-a">Có. Học viên được dùng thử toàn bộ nền tảng VIAi trong suốt khóa học để thực hành trên dữ liệu thực tế của doanh nghiệp mình.</div></div>
      </div>
    </div>
  </section>

  <!-- CTA -->
  <div class="cta-band">
    <div><h2>Bắt đầu hành trình AI của bạn</h2><p>Tư vấn chọn khóa học phù hợp — miễn phí, không áp lực. Khai giảng hàng tháng.</p></div>
    <div class="cta-btns">
      <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">📚 Đăng ký tư vấn ngay</a>
      <a href="/dich-vu" class="sol-btn-out" style="border-color:rgba(255,255,255,.4)">Xem dịch vụ triển khai</a>
    </div>
  </div>

  ${renderSolutionFooter()}
  ${renderSiteToolbarScript()}
</body>
</html>`;
}

// ── Routes cho 3 trang giải pháp ─────────────────────
app.get('/phan-mem', (_req, res) => res.setHeader('Content-Type','text/html;charset=utf-8') && res.send(renderPhanMem()));
app.get('/dich-vu',  (_req, res) => res.setHeader('Content-Type','text/html;charset=utf-8') && res.send(renderDichVu()));
app.get('/dao-tao',  (_req, res) => res.setHeader('Content-Type','text/html;charset=utf-8') && res.send(renderDaoTao()));

app.get('/cong-cu', (_req, res) => res.redirect('/#products'));

app.get('/cong-cu/:slug', (req, res) => {
  const product = PRODUCT_DETAIL_BY_SLUG[req.params.slug];
  if (!product) return res.status(404).sendFile(path.join(__dirname, '404.html'));
  res.send(renderProductDetailPage(product));
});

app.get('/blog', async (_req, res) => {
  const posts = await db.prepare("SELECT id,title,excerpt,image_url,category,author,slug,published_at FROM blog_posts WHERE active=1 ORDER BY published_at DESC").all();
  const siteUrl = SITE_URL;
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Blog – Kiến thức AI Agent cho doanh nghiệp | VIAi</title>
  <meta name="description" content="Kiến thức thực tế về AI Agent, tự động hóa và chuyển đổi số cho doanh nghiệp Việt Nam. Hướng dẫn, tin tức và case study từ VIAi."/>
  <link rel="canonical" href="${siteUrl}/blog"/>
  <link rel="icon" href="/anhlogo/logo2.png"/>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Be Vietnam Pro',sans-serif;background:#f4f7ff;color:#0f172a;line-height:1.7}
    a{text-decoration:none;color:inherit}
    .site-header{position:sticky;top:0;z-index:999;background:white;border-bottom:2px solid #1A56DB;box-shadow:0 2px 12px rgba(26,86,219,.08)}
    .header-inner{max-width:1240px;margin:0 auto;padding:0 24px;height:72px;display:flex;align-items:center;justify-content:space-between}
    .logo-img{height:120px;width:auto;object-fit:contain;mix-blend-mode:multiply}
    .header-actions{display:flex;gap:10px}
    .btn-login{padding:8px 18px;border:2px solid #1A56DB;border-radius:8px;font-size:.85rem;font-weight:700;color:#1A56DB;background:white}
    .btn-register{padding:8px 18px;background:#FF6B00;border-radius:8px;font-size:.85rem;font-weight:700;color:white}
    /* hero */
    .blog-hero{background:linear-gradient(135deg,#0F172A 0%,#1A56DB 60%,#FF6B00 100%);padding:60px 20px;text-align:center;color:white}
    .blog-hero h1{font-size:clamp(1.8rem,3vw,2.8rem);font-weight:900;margin-bottom:12px}
    .blog-hero p{font-size:1rem;color:rgba(255,255,255,.75);max-width:560px;margin:0 auto}
    /* filters */
    .blog-filters{max-width:1200px;margin:32px auto 0;padding:0 20px;display:flex;gap:10px;flex-wrap:wrap}
    .filter-btn{padding:7px 18px;border-radius:50px;font-size:.82rem;font-weight:700;border:1.5px solid #dbe8ff;background:white;color:#1A56DB;cursor:pointer;transition:all .2s}
    .filter-btn.active,.filter-btn:hover{background:#1A56DB;color:white;border-color:#1A56DB}
    /* grid */
    .blog-wrap{max-width:1200px;margin:32px auto 80px;padding:0 20px}
    .blog-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:28px}
    .blog-card{background:white;border-radius:16px;overflow:hidden;border:1px solid #e8eef8;transition:all .25s;display:flex;flex-direction:column}
    .blog-card:hover{transform:translateY(-4px);box-shadow:0 12px 32px rgba(26,86,219,.1)}
    .blog-card-img{width:100%;height:200px;object-fit:cover;display:block;background:#EEF3FF}
    .blog-card-img-placeholder{width:100%;height:200px;background:linear-gradient(135deg,#1040B0,#1A56DB);display:flex;align-items:center;justify-content:center;font-size:2.5rem}
    .blog-card-body{padding:20px 22px 24px;flex:1;display:flex;flex-direction:column}
    .blog-cat{font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:#FF6B00;margin-bottom:10px}
    .blog-title{font-size:1rem;font-weight:800;color:#0f172a;line-height:1.45;margin-bottom:10px;flex:1}
    .blog-title:hover{color:#1A56DB}
    .blog-excerpt{font-size:.84rem;color:#64748b;line-height:1.7;margin-bottom:16px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .blog-meta{display:flex;align-items:center;justify-content:space-between;font-size:.78rem;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:14px;margin-top:auto}
    .blog-read-more{font-size:.82rem;font-weight:700;color:#1A56DB}
    .empty-state{text-align:center;padding:80px 20px;color:#94a3b8}
    @media(max-width:640px){.blog-grid{grid-template-columns:1fr}}
  </style>
</head>
<body>
  ${renderSiteToolbar('blog')}
  <div class="blog-hero">
    <h1>Blog <span style="color:#FFB800">VIAi</span></h1>
    <p>Kiến thức thực tế về AI Agent, tự động hóa và chuyển đổi số cho doanh nghiệp Việt Nam</p>
  </div>

  <div class="blog-filters" id="filters">
    <button class="filter-btn active" onclick="filterCat('all',this)">Tất cả</button>
    ${[...new Set(posts.map(p=>p.category).filter(Boolean))].map(cat=>
      `<button class="filter-btn" onclick="filterCat('${escapeHtml(cat)}',this)">${escapeHtml(cat)}</button>`
    ).join('')}
  </div>

  <div class="blog-wrap">
    ${posts.length === 0 ? '<div class="empty-state"><p>Chưa có bài viết nào.</p></div>' :
    `<div class="blog-grid" id="blog-grid">
      ${posts.map(p => `
        <a href="/blog/${escapeHtml(p.slug||'')}" class="blog-card" data-cat="${escapeHtml(p.category||'')}">
          ${p.image_url
            ? `<img src="${escapeHtml(p.image_url)}" alt="${escapeHtml(p.title)}" class="blog-card-img" loading="lazy"/>`
            : `<div class="blog-card-img-placeholder">📝</div>`}
          <div class="blog-card-body">
            <div class="blog-cat">${escapeHtml(p.category||'Tin tức')}</div>
            <div class="blog-title">${escapeHtml(p.title)}</div>
            <div class="blog-excerpt">${escapeHtml(p.excerpt||'')}</div>
            <div class="blog-meta">
              <span>${escapeHtml(p.author||'VIAi Team')} · ${p.published_at ? p.published_at.slice(0,10) : ''}</span>
              <span class="blog-read-more">Đọc thêm →</span>
            </div>
          </div>
        </a>`).join('')}
    </div>`}
  </div>

  ${renderSiteToolbarScript()}
  <script>
    function filterCat(cat, el) {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      el.classList.add('active');
      document.querySelectorAll('.blog-card').forEach(card => {
        card.style.display = (cat === 'all' || card.dataset.cat === cat) ? '' : 'none';
      });
    }
  </script>
</body>
</html>`);
});

app.get('/blog/:slug', async (req, res) => {
  const post = await db.prepare('SELECT * FROM blog_posts WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!post) return res.status(404).sendFile(path.join(__dirname, '404.html'));
  res.send(renderBlogPage(post));
});

app.get('/san-pham/:slug', async (req, res) => {
  const product = await db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!product) return res.status(404).sendFile(path.join(__dirname, '404.html'));
  const base = PRODUCT_DETAILS[product.slug];
  if (!base) return res.status(404).sendFile(path.join(__dirname, '404.html'));
  const detail = Object.assign({}, base, PRODUCT_ENRICHMENT[product.slug] || {});
  // Lấy tối đa 3 sản phẩm liên quan (khác slug hiện tại, có data trong PRODUCT_DETAILS)
  const relatedRaw = await db.prepare(
    'SELECT * FROM products WHERE slug != ? AND active = 1 AND slug IS NOT NULL ORDER BY order_index ASC LIMIT 6'
  ).all(product.slug);
  const related = relatedRaw
    .filter(p => PRODUCT_DETAILS[p.slug])
    .slice(0, 3)
    .map(p => ({ ...p, detail: PRODUCT_DETAILS[p.slug] }));
  res.send(renderProductPage(product, detail, related));
});

// 404 — bắt tất cả route không khớp
app.use((_req, res) =>
  res.status(404).sendFile(path.join(__dirname, '404.html'))
);

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  initDb().then(() => {
    app.listen(PORT, () => {
      console.log(`VIAi CMS running → http://localhost:${PORT}`);
      try { tg.sendMessage('🚀 <b>VIAi Server đã khởi động!</b>'); } catch {}
    });
  }).catch(err => {
    console.error('❌ DB init failed:', err.message);
    process.exit(1);
  });
  // Báo cáo tự động 8h sáng mỗi ngày
  function scheduleDailyReport() {
    const now  = new Date();
    const next = new Date();
    next.setHours(8, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    setTimeout(() => {
      tg.sendDailyReport(db);
      setInterval(() => tg.sendDailyReport(db), 24 * 60 * 60 * 1000);
    }, next - now);
  }
  scheduleDailyReport();
}

module.exports = app;
