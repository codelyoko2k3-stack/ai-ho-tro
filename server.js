require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const helmet    = require('helmet');
const rateLimit = require('express-rate-limit');
const path      = require('path');
const db        = require('./db');
const tg        = require('./telegram');

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
        <div class="nav-item">
          <a href="/#services-intro" class="nav-link">Phần mềm <span class="arrow">▾</span></a>
          <div class="dropdown">
            <a href="/#services-intro"><span class="dd-icon">🔍</span> Giới thiệu VIAi</a>
            <a href="/#services"><span class="dd-icon">💡</span> Tại sao chọn VIAi</a>
            <a href="/#tech"><span class="dd-icon">🔗</span> Công nghệ</a>
            <a href="/#gallery"><span class="dd-icon">⭐</span> Điểm nổi bật</a>
          </div>
        </div>
        <div class="nav-item${active === 'products' ? ' nav-active' : ''}">
          <a href="/#products" class="nav-link">Dịch vụ <span class="arrow">▾</span></a>
          <div class="dropdown dropdown-mega">
            <div class="mega-title">AI Agents cho doanh nghiệp</div>
            <a href="/#products"><span class="dd-icon">💬</span> Zalo Sales Agent</a>
            <a href="/#products"><span class="dd-icon">📦</span> Order Agent</a>
            <a href="/#products"><span class="dd-icon">🤝</span> CRM Agent</a>
            <a href="/#products"><span class="dd-icon">📊</span> Report Agent</a>
            <a href="/#products"><span class="dd-icon">📧</span> Email Agent</a>
            <a href="/#products"><span class="dd-icon">🏭</span> Enterprise Agent</a>
          </div>
        </div>
        <div class="nav-item">
          <a href="/#how" class="nav-link">Khóa học <span class="arrow">▾</span></a>
          <div class="dropdown">
            <a href="/#how-step-1"><span class="dd-icon">🤖</span> Chọn AI Agent phù hợp</a>
            <a href="/#how-step-2"><span class="dd-icon">🔗</span> Kết nối hệ thống hiện tại</a>
            <a href="/#how-step-3"><span class="dd-icon">⚡</span> Agent tự động chạy 24/7</a>
            <a href="/#how-step-4"><span class="dd-icon">📊</span> Theo dõi & tối ưu kết quả</a>
          </div>
        </div>
        <div class="nav-item"><a href="/#pricing" class="nav-link">Bảng giá</a></div>
        <div class="nav-item${active === 'blog' ? ' nav-active' : ''}"><a href="/#blog" class="nav-link">Blog</a></div>
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
    <div class="mobile-nav-item">
      <button class="mobile-nav-link" onclick="toggleMobileSub(this)" type="button">
        Phần mềm <span class="m-arrow">▾</span>
      </button>
      <div class="mobile-submenu">
        <a href="/#services-intro" onclick="closeMobileMenu()"><span>🔍</span> Giới thiệu VIAi</a>
        <a href="/#services" onclick="closeMobileMenu()"><span>💡</span> Tại sao chọn VIAi</a>
        <a href="/#tech" onclick="closeMobileMenu()"><span>🔗</span> Công nghệ</a>
        <a href="/#gallery" onclick="closeMobileMenu()"><span>⭐</span> Điểm nổi bật</a>
      </div>
    </div>

    <div class="mobile-nav-item">
      <button class="mobile-nav-link" onclick="toggleMobileSub(this)" type="button">
        Dịch vụ <span class="m-arrow">▾</span>
      </button>
      <div class="mobile-submenu">
        <a href="/#products" onclick="closeMobileMenu()"><span>💬</span> Zalo Sales Agent</a>
        <a href="/#products" onclick="closeMobileMenu()"><span>📦</span> Order Agent</a>
        <a href="/#products" onclick="closeMobileMenu()"><span>🤝</span> CRM Agent</a>
        <a href="/#products" onclick="closeMobileMenu()"><span>📊</span> Report Agent</a>
        <a href="/#products" onclick="closeMobileMenu()"><span>📧</span> Email Agent</a>
        <a href="/#products" onclick="closeMobileMenu()"><span>🏭</span> Enterprise Agent</a>
      </div>
    </div>

    <div class="mobile-nav-item">
      <button class="mobile-nav-link" onclick="toggleMobileSub(this)" type="button">
        Khóa học <span class="m-arrow">▾</span>
      </button>
      <div class="mobile-submenu">
        <a href="/#how" onclick="closeMobileMenu()"><span>🤖</span> Chọn AI Agent phù hợp</a>
        <a href="/#how" onclick="closeMobileMenu()"><span>🔗</span> Kết nối hệ thống</a>
        <a href="/#how" onclick="closeMobileMenu()"><span>⚡</span> Agent tự động 24/7</a>
        <a href="/#how" onclick="closeMobileMenu()"><span>📊</span> Theo dõi kết quả</a>
      </div>
    </div>

    <a href="/#pricing" class="mobile-plain-link" onclick="closeMobileMenu()">Bảng giá</a>
    <a href="/#blog" class="mobile-plain-link" onclick="closeMobileMenu()">Blog</a>

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
  const siteUrl = 'https://respectful-courtesy-production-4318.up.railway.app';
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
    provider: {
      '@type': 'Organization',
      name: 'VIAi',
      url: siteUrl
    }
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
  </style>
</head>
<body>
  ${renderSiteToolbar('products')}
  <section class="product-hero">
    <div class="hero-inner">
      <div>
        <div class="eyebrow">${escapeHtml(product.icon)} ${escapeHtml(product.category)}</div>
        <h1>${escapeHtml(product.name)}</h1>
        <p class="lead">${escapeHtml(product.description)}</p>
        <div class="hero-actions">
          <a class="primary-cta" href="/dung-thu.html">Đăng ký tư vấn</a>
          <a class="secondary-cta" href="/#products">Xem công cụ khác</a>
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
      <a class="primary-cta" href="/dung-thu.html">Dùng thử FREE</a>
    </div>
  </section>
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

function renderProductPage(product, detail) {
  const siteUrl = 'https://respectful-courtesy-production-4318.up.railway.app';
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
  </style>
</head>
<body>
  ${renderSiteToolbar('products')}
  <section class="p-hero">
    <div class="p-hero-inner">
      <div class="p-eyebrow">${escapeHtml(detail.eyebrow)}</div>
      <h1>${escapeHtml(product.name)}${detail.badge ? `<span class="p-badge" style="background:${detail.badgeColor};color:white">${escapeHtml(detail.badge)}</span>` : ''}</h1>
      <p class="p-hero-desc">${escapeHtml(detail.heroDesc)}</p>
      <div class="p-hero-actions">
        <a href="/dung-thu.html" class="p-cta-main">🚀 Dùng thử miễn phí</a>
        <a href="/san-pham.html" class="p-cta-out">← Xem tất cả Agent</a>
      </div>
    </div>
  </section>

  <div class="p-wrap">
    <img class="p-thumb" src="${escapeHtml(detail.image)}" alt="${escapeHtml(product.name)}" width="960" height="440" />

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

    <div class="p-cta-box">
      <h2>Sẵn sàng triển khai <em>${escapeHtml(product.name)}</em>?</h2>
      <div class="p-cta-btns">
        <a href="/dung-thu.html" class="p-cta-main">🚀 Dùng thử miễn phí 14 ngày</a>
        <a href="/#products" class="p-cta-out">Xem các Agent khác</a>
      </div>
    </div>
  </div>

  <footer class="p-footer">
    <p>© 2026 VIAi Technology. <a href="/privacy.html">Chính sách bảo mật</a> · <a href="/terms.html">Điều khoản</a></p>
  </footer>

  <div class="mobile-menu" id="mobile-menu">
    <div class="mobile-nav-item">
      <button class="mobile-nav-link" onclick="toggleMobileSub(this)" type="button">Phần mềm <span class="m-arrow" style="font-size:.65rem;transition:transform .2s;color:#6B93E8">▾</span></button>
      <div class="mobile-submenu">
        <a href="/#services-intro" onclick="closeMobileMenu()"><span>🔍</span> Giới thiệu VIAi</a>
        <a href="/#services" onclick="closeMobileMenu()"><span>💡</span> Tại sao chọn VIAi</a>
        <a href="/cong-nghe.html" onclick="closeMobileMenu()"><span>🔗</span> Công nghệ</a>
        <a href="/#gallery" onclick="closeMobileMenu()"><span>⭐</span> Điểm nổi bật</a>
      </div>
    </div>
    <div class="mobile-nav-item">
      <button class="mobile-nav-link" onclick="toggleMobileSub(this)" type="button">Dịch vụ <span class="m-arrow" style="font-size:.65rem;transition:transform .2s;color:#6B93E8">▾</span></button>
      <div class="mobile-submenu">
        <a href="/san-pham/zalo-sales-agent" onclick="closeMobileMenu()"><span>💬</span> Zalo Sales Agent</a>
        <a href="/san-pham/order-management-agent" onclick="closeMobileMenu()"><span>📦</span> Order Agent</a>
        <a href="/san-pham/crm-automation-agent" onclick="closeMobileMenu()"><span>🤝</span> CRM Agent</a>
        <a href="/san-pham/report-analytics-agent" onclick="closeMobileMenu()"><span>📊</span> Report Agent</a>
        <a href="/san-pham/facebook-ads-agent" onclick="closeMobileMenu()"><span>🏭</span> Facebook Ads Agent</a>
        <a href="/san-pham/booking-appointment" onclick="closeMobileMenu()"><span>🗓️</span> Booking Agent</a>
      </div>
    </div>
    <a href="/#pricing" class="mobile-plain-link" onclick="closeMobileMenu()">Bảng giá</a>
    <a href="/#blog" class="mobile-plain-link" onclick="closeMobileMenu()">Blog</a>
    <div class="mobile-menu-actions">
      <a href="/login.html" class="btn-login">Đăng nhập</a>
      <a href="/dung-thu.html" class="btn-register">🚀 Dùng thử FREE</a>
    </div>
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
  const siteUrl = 'https://respectful-courtesy-production-4318.up.railway.app';
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
app.use(express.static(__dirname, { index: 'home.html' }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

app.use('/api',       require('./routes/api'));
app.use('/admin-api', require('./routes/admin'));

app.get('/admin', (_req, res) =>
  res.sendFile(path.join(__dirname, 'admin', 'index.html'))
);

app.get('/cong-cu', (_req, res) => res.redirect('/#products'));

app.get('/cong-cu/:slug', (req, res) => {
  const product = PRODUCT_DETAIL_BY_SLUG[req.params.slug];
  if (!product) return res.status(404).sendFile(path.join(__dirname, '404.html'));
  res.send(renderProductDetailPage(product));
});

app.get('/blog/:slug', (req, res) => {
  const post = db.prepare('SELECT * FROM blog_posts WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!post) return res.status(404).sendFile(path.join(__dirname, '404.html'));
  res.send(renderBlogPage(post));
});

app.get('/san-pham/:slug', (req, res) => {
  const product = db.prepare('SELECT * FROM products WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!product) return res.status(404).sendFile(path.join(__dirname, '404.html'));
  const detail = PRODUCT_DETAILS[product.slug];
  if (!detail) return res.status(404).sendFile(path.join(__dirname, '404.html'));
  res.send(renderProductPage(product, detail));
});

// 404 — bắt tất cả route không khớp
app.use((_req, res) =>
  res.status(404).sendFile(path.join(__dirname, '404.html'))
);

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`VIAi CMS running → http://localhost:${PORT}`);
    try { tg.sendMessage('🚀 <b>VIAi Server đã khởi động!</b>'); } catch {}
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
