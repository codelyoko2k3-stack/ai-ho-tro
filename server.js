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
    .replace(/\bViAI\b/gi, 'ViAI')
    .replace(/\bai\b/g, 'AI')
    .replace(/(ViAI\s+hỗ trợ)\s+hỗ trợ/gi, '$1')
    .replace(/hỗ trợ\s+hỗ trợ/gi, 'hỗ trợ')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanMetaDescription(value) {
  let cleaned = cleanSeoText(value).replace(
    /ViAI\s+hỗ trợ\s+doanh nghiệp\s+ứng dụng\s+ViAI\s+hỗ trợ\s+(.+?)\s+để/i,
    'ViAI giúp doanh nghiệp ứng dụng AI vào $1 để'
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

function renderNavbarCSS() {
  return `<style id="viai-navbar-css">
/* ─── Shared Navbar — source of truth (sửa ở đây là xong tất cả pages) ─── */
.site-header{position:sticky;top:0;z-index:999;background:#fff;border-bottom:2px solid var(--primary);box-shadow:0 2px 12px rgba(26,86,219,.08)}
.header-inner{max-width:1240px;margin:0 auto;padding:0 24px;height:72px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:16px}
.site-logo{display:flex;align-items:center;gap:10px;justify-self:start}
.logo-img{height:64px;width:auto;max-width:150px;object-fit:contain;display:block;flex-shrink:0;mix-blend-mode:normal}
/* Nav */
.main-nav{display:flex;align-items:center;justify-content:center;gap:4px}
.nav-item{position:relative}
.nav-item>a{display:flex;align-items:center;gap:4px;padding:8px 14px;font-size:.9rem;font-weight:600;color:var(--gray-600,#1E3A8A);border-radius:8px;transition:all .2s;white-space:nowrap;position:relative}
.nav-item>a::after{content:'';position:absolute;bottom:2px;left:14px;right:14px;height:2.5px;background:var(--primary,#1A56DB);border-radius:2px;transform:scaleX(0);opacity:0;transition:transform .25s ease,opacity .25s ease;transform-origin:left center}
.nav-item>a:hover{color:var(--primary,#1A56DB);background:var(--gray-50,#EEF3FF)}
.nav-item>a:hover::after{transform:scaleX(1);opacity:1}
.nav-item>a .arrow{font-size:.65rem;transition:transform .2s}
.nav-item:hover>a .arrow{transform:rotate(180deg)}
.nav-badge{display:inline-flex;align-items:center;height:18px;padding:0 6px;border-radius:999px;background:#FF6B00;color:#fff;font-size:.62rem;font-weight:900;line-height:1}
/* Dropdown */
.dropdown{display:block;position:absolute;top:calc(100% + 4px);left:0;min-width:220px;background:#fff;border:1px solid rgba(26,86,219,.1);border-radius:16px;box-shadow:0 4px 6px rgba(0,0,0,.04),0 20px 50px rgba(26,86,219,.14);padding:10px;z-index:100;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(-8px);transition:opacity .25s ease,visibility .25s ease,transform .25s cubic-bezier(.16,1,.3,1)}
.dropdown::before{content:'';position:absolute;top:-6px;left:20px;width:12px;height:12px;background:#fff;border-left:1px solid rgba(26,86,219,.1);border-top:1px solid rgba(26,86,219,.1);transform:rotate(45deg);border-radius:2px 0 0 0}
.nav-item:hover .dropdown,.nav-item:focus-within .dropdown,.nav-item.dd-open .dropdown{opacity:1;visibility:visible;pointer-events:auto;transform:translateY(0)}
.dropdown a{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:10px;font-size:.85rem;font-weight:500;color:var(--gray-600,#1E3A8A);transition:all .18s ease}
.dropdown a:hover{background:var(--gray-50,#EEF3FF);color:var(--primary,#1A56DB);transform:translateX(3px)}
.dropdown a .dd-icon{font-size:1.1rem;flex-shrink:0}
/* Mega menu Phần mềm */
.dropdown-mega{min-width:480px;display:grid;grid-template-columns:1fr 1fr;gap:4px;padding:14px}
.dropdown-mega::before{left:50%;transform:translateX(-50%) rotate(45deg)}
.dropdown-mega .mega-title{grid-column:1/-1;font-size:.7rem;font-weight:700;text-transform:uppercase;letter-spacing:.8px;color:var(--gray-300,#6B93E8);padding:4px 14px 8px;border-bottom:1px solid var(--gray-100,#DBEAFE);margin-bottom:4px}
.service-dropdown-all{grid-column:1/-1;border-top:1px solid var(--gray-100,#DBEAFE);margin-top:4px}
/* Mega dropdown Tin tức */
.ndm-wrap{position:static!important}
.news-mega-dropdown{min-width:660px!important;padding:0!important;left:50%!important;transform:translateX(-50%) translateY(-8px)!important}
.nav-item.ndm-wrap:hover .news-mega-dropdown,.nav-item.ndm-wrap:focus-within .news-mega-dropdown{transform:translateX(-50%) translateY(0)!important;opacity:1;visibility:visible;pointer-events:auto}
.ndm-inner{display:flex}
.ndm-cats{width:190px;flex-shrink:0;padding:16px 12px;border-right:1px solid #f1f5f9}
.ndm-section-label{font-size:.67rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;padding:0 8px;margin-bottom:8px}
.ndm-cat-link{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:8px;font-size:.84rem;font-weight:600;color:#334155;transition:all .15s;text-decoration:none}
.ndm-cat-link:hover,.ndm-cat-link.ndm-cat-active{background:#EEF3FF;color:#1A56DB}
.ndm-cat-link:hover{transform:translateX(2px)}
.ndm-cat-icon{font-size:1rem;width:20px;text-align:center;flex-shrink:0}
.ndm-divider{width:1px;background:#f1f5f9;flex-shrink:0}
.ndm-posts{flex:1;padding:16px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}
.ndm-posts-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.ndm-post-item{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:8px;transition:all .15s;text-decoration:none;color:inherit}
.ndm-post-item:hover{background:#f8faff}
.ndm-post-item img{width:52px!important;height:40px!important;border-radius:5px;object-fit:cover;flex-shrink:0;background:#e2e8f0}
.ndm-post-info{min-width:0}
.ndm-post-title{font-size:.78rem;font-weight:700;color:#0F172A;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.ndm-post-item:hover .ndm-post-title{color:#1A56DB}
.ndm-post-date{font-size:.7rem;color:#94a3b8;margin-top:3px}
.ndm-view-all{display:flex;align-items:center;justify-content:center;padding:9px 14px;background:linear-gradient(90deg,#1A56DB,#1040B0);color:#fff;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;transition:opacity .15s;margin-top:4px}
.ndm-view-all:hover{opacity:.88}
/* Header actions & buttons */
.header-actions{display:flex;align-items:center;gap:10px;justify-self:end}
.btn-login{display:inline-flex;align-items:center;justify-content:center;padding:8px 18px;border:2px solid var(--primary,#1A56DB);border-radius:8px;font-size:.85rem;font-weight:700;color:var(--primary,#1A56DB);transition:all .2s;background:#fff}
.btn-login:hover{background:var(--primary,#1A56DB);color:#fff}
.btn-register{display:inline-flex;align-items:center;justify-content:center;padding:8px 18px;background:var(--accent,#FF6B00);border-radius:8px;font-size:.85rem;font-weight:700;color:#fff;transition:all .2s;box-shadow:0 4px 14px rgba(255,107,74,.35)}
.btn-register:hover{opacity:.9;transform:translateY(-1px)}
/* Hamburger */
.hamburger-btn{display:none;flex-direction:column;justify-content:center;gap:5px;grid-column:3;justify-self:end;width:40px;height:40px;background:none;border:none;cursor:pointer;padding:6px;border-radius:8px;transition:background .2s;flex-shrink:0}
.hamburger-btn:hover{background:var(--gray-50,#EEF3FF)}
.hamburger-btn span{display:block;width:22px;height:2.5px;background:var(--gray-600,#1E3A8A);border-radius:2px;transition:all .3s ease;transform-origin:center}
.hamburger-btn.open span:nth-child(1){transform:translateY(7.5px) rotate(45deg)}
.hamburger-btn.open span:nth-child(2){opacity:0;transform:scaleX(0)}
.hamburger-btn.open span:nth-child(3){transform:translateY(-7.5px) rotate(-45deg)}
/* Mobile menu */
.mobile-menu{display:none;position:fixed;top:72px;left:0;right:0;background:#fff;border-top:2px solid var(--primary,#1A56DB);box-shadow:0 8px 32px rgba(0,0,0,.12);z-index:998;padding:16px 20px 24px;max-height:calc(100vh - 72px);overflow-y:auto;animation:viai-slide-down .25s ease}
.mobile-menu.open{display:block}
@keyframes viai-slide-down{from{opacity:0;transform:translateY(-10px)}to{opacity:1;transform:translateY(0)}}
.mobile-nav-item{border-bottom:1px solid #f1f5f9}
.mobile-nav-link{display:flex;align-items:center;justify-content:space-between;width:100%;padding:14px 4px;font-size:.95rem;font-weight:700;color:var(--gray-600,#1E3A8A);cursor:pointer;background:none;border:none;font-family:inherit;text-align:left}
.mobile-nav-link .m-arrow{font-size:.65rem;transition:transform .2s;color:#6B93E8}
.mobile-nav-item.m-open .m-arrow{transform:rotate(180deg)}
.mobile-submenu{display:none;padding:0 0 8px 12px}
.mobile-nav-item.m-open .mobile-submenu{display:block}
.mobile-submenu a{display:flex;align-items:center;gap:10px;padding:10px 8px;font-size:.88rem;font-weight:500;color:var(--gray-600,#1E3A8A);border-radius:8px;transition:all .15s}
.mobile-submenu a:hover{background:#EEF3FF;color:#1A56DB}
.mobile-plain-link{display:block;padding:14px 4px;font-size:.95rem;font-weight:700;color:var(--gray-600,#1E3A8A);border-bottom:1px solid #f1f5f9}
.mobile-menu-actions{display:flex;flex-direction:column;gap:10px;margin-top:20px}
.mobile-menu-actions .btn-login{display:block;text-align:center;padding:12px;background:none}
.mobile-menu-actions .btn-register{display:block;text-align:center;padding:12px}
/* User dropdown */
.user-dropdown-wrap{position:relative;display:inline-block}
.user-trigger{display:flex;align-items:center;gap:8px;background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:8px;font-family:inherit}
.user-trigger:hover{background:#EEF3FF}
.user-avatar{width:34px;height:34px;border-radius:50%;background:linear-gradient(135deg,#1A56DB,#4B82F4);color:#fff;font-size:.78rem;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.user-name{font-size:.85rem;font-weight:700;color:#1E3A8A;max-width:120px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.user-caret{font-size:.6rem;color:#6B93E8}
.user-menu{display:none;position:absolute;top:calc(100% + 8px);right:0;background:#fff;border:1px solid #DBEAFE;border-radius:12px;box-shadow:0 16px 40px rgba(26,86,219,.12);padding:8px;min-width:180px;z-index:1000}
.user-menu.open{display:block}
.user-menu a,.user-menu button{display:flex;align-items:center;gap:10px;padding:10px 12px;border-radius:8px;font-size:.85rem;font-weight:600;color:#1E3A8A;background:none;border:none;cursor:pointer;width:100%;font-family:inherit;text-decoration:none;text-align:left;transition:background .15s}
.user-menu a:hover,.user-menu button:hover{background:#EEF3FF}
.user-menu .logout-btn{color:#E52222;border-top:1px solid #DBEAFE;margin-top:4px}
/* Responsive */
@media(max-width:960px){.main-nav,.header-actions{display:none!important}.hamburger-btn{display:flex!important}}
@media(max-width:760px){.header-inner{height:68px!important;padding:0 16px!important}.logo-img{height:58px!important}.mobile-menu{top:68px!important;max-height:calc(100vh - 68px)!important}}
</style>`;
}

async function renderSiteToolbar(active = '') {
  // Load tất cả blog posts cho dropdown interactive
  let allDropdownPosts = [], blogCategories = [];
  try {
    allDropdownPosts = await db.prepare("SELECT title, category, slug, published_at, image_url FROM blog_posts WHERE active=1 ORDER BY published_at DESC LIMIT 30").all();
    const catRows = await db.prepare("SELECT DISTINCT category FROM blog_posts WHERE active=1 AND category IS NOT NULL AND category != '' ORDER BY category ASC").all();
    blogCategories = catRows.map(r => r.category).filter(Boolean);
  } catch {}
  const latestBlogs = allDropdownPosts.slice(0, 4);

  const BLOG_IMG_POOL = [
    'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=400&q=70',
    'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=400&q=70',
    'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=400&q=70',
    'https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=400&q=70',
  ];
  const usedDdImgs = new Set();
  const blogPostCards = latestBlogs.map((b, i) => {
    let img = b.image_url || '';
    if (!img || usedDdImgs.has(img)) img = BLOG_IMG_POOL.find(u => !usedDdImgs.has(u)) || BLOG_IMG_POOL[i % 4];
    usedDdImgs.add(img);
    const d = (b.published_at || '').slice(0, 10);
    return `<a href="/blog/${escapeHtml(b.slug||'')}" class="ndm-post-item">
      <img src="${escapeHtml(img)}" alt="${escapeHtml(b.title)}" loading="lazy" onerror="this.style.display='none'" />
      <div class="ndm-post-info">
        <div class="ndm-post-title">${escapeHtml(b.title)}</div>
        <div class="ndm-post-date">${d}</div>
      </div>
    </a>`;
  }).join('');

  return `
  ${renderNavbarCSS()}
  <header class="site-header">
    <div class="header-inner">
      <a href="/" class="site-logo" aria-label="Về trang chủ ViAI">
        <img src="/anhlogo/logo2.png" alt="ViAI" class="logo-img" width="150" height="150" />
      </a>

      <nav class="main-nav" id="main-nav" aria-label="Điều hướng chính">
        <div class="nav-item"><a href="/#services-intro" class="nav-link">Giới thiệu</a></div>
        <div class="nav-item">
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
        <div class="nav-item"><a href="/#tech" class="nav-link">Công nghệ</a></div>
        <div class="nav-item ndm-wrap">
          <a href="/blog" class="nav-link">Tin tức <span class="arrow">▾</span></a>
          <div class="dropdown news-mega-dropdown">
            <div class="ndm-inner">
              <div class="ndm-cats">
                <div class="ndm-section-label">CHUYÊN MỤC</div>
                <a href="javascript:void(0)" class="ndm-cat-link ndm-cat-active" data-ddcat="all" onclick="__ddHover(this)" onmouseenter="__ddHover(this)"><span class="ndm-cat-icon">📋</span> Tất cả bài viết</a>
                ${blogCategories.length > 0
                  ? blogCategories.map(cat => `<a href="javascript:void(0)" class="ndm-cat-link" data-ddcat="${escapeHtml(cat)}" onclick="__ddHover(this)" onmouseenter="__ddHover(this)"><span class="ndm-cat-icon">•</span> ${escapeHtml(cat)}</a>`).join('')
                  : ''}
              </div>
              <div class="ndm-divider"></div>
              <div class="ndm-posts">
                <div class="ndm-section-label" id="ndm-right-label">BÀI VIẾT MỚI NHẤT</div>
                <div class="ndm-posts-grid" id="ndm-posts-grid">${blogPostCards || '<div style="color:#94a3b8;font-size:.82rem;padding:8px">Chưa có bài viết</div>'}</div>
                <a href="/blog" class="ndm-view-all" id="ndm-view-all-link">Xem tất cả tin tức →</a>
              </div>
            </div>
          </div>
        </div>
      </nav>

      <div class="header-actions">
        <div id="header-auth">
          <a href="/login.html" class="btn-login" id="btn-login-link">Đăng nhập</a>
        </div>
        <a href="/dung-thu.html" class="btn-register">Trải nghiệm ngay</a>
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
        <a href="/#blog" onclick="closeMobileMenu()"><span>📰</span> ViAI cam kết hiệu quả AI Agent</a>
        <a href="/#blog" onclick="closeMobileMenu()"><span>🤝</span> ViAI đồng hành cùng doanh nghiệp SME</a>
        <a href="/#blog" onclick="closeMobileMenu()"><span>🚀</span> AI Agent — xu hướng vận hành 2026</a>
        <a href="/blog/5-cach-ai-agent-giup-doanh-nghiep-sme-tiet-kiem-4-gio-moi-ngay" onclick="closeMobileMenu()"><span>💡</span> 5 cách AI Agent tiết kiệm 4 giờ/ngày</a>
        <a href="/blog/huong-dan-chon-ai-agent-cho-sales" onclick="closeMobileMenu()"><span>📋</span> Chọn AI Agent phù hợp cho đội sales</a>
        <a href="/blog/checklist-bao-mat-ai-du-lieu-khach-hang" onclick="closeMobileMenu()"><span>🔒</span> Checklist bảo mật AI & dữ liệu</a>
        <a href="/#blog" onclick="closeMobileMenu()"><span>↗</span> Xem tất cả tin tức</a>
      </div>
    </div>

    <div class="mobile-menu-actions">
      <a href="/login.html" class="btn-login">Đăng nhập</a>
      <a href="/dung-thu.html" class="btn-register">Trải nghiệm ngay</a>
    </div>
  </div>
  <script>window.__DD_POSTS = ${JSON.stringify(allDropdownPosts)};</script>`;
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
            '<button onclick="userLogout()" type="button" class="logout-btn">🚪 Đăng xuất</button>' +
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

    let __ddTimer = null;
    document.querySelectorAll('.nav-item').forEach(item => {
      item.addEventListener('mouseenter', () => { clearTimeout(__ddTimer); document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('dd-open')); item.classList.add('dd-open'); });
      item.addEventListener('mouseleave', () => { __ddTimer = setTimeout(() => item.classList.remove('dd-open'), 300); });
    });

    // ── Dropdown Tin tức: hover danh mục → cập nhật bài viết bên phải ──
    const __DD_IMG_POOL = [
      'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=400&q=70',
      'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=400&q=70',
      'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=400&q=70',
      'https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=400&q=70',
      'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=400&q=70',
      'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=400&q=70',
    ];
    function __ddRenderPosts(posts) {
      const used = new Set();
      return posts.slice(0, 4).map((p, i) => {
        let img = p.image_url || '';
        if (!img || used.has(img)) img = __DD_IMG_POOL.find(u => !used.has(u)) || __DD_IMG_POOL[i % __DD_IMG_POOL.length];
        used.add(img);
        return '<a href="/blog/' + (p.slug||'') + '" class="ndm-post-item">' +
          '<img src="' + img + '" alt="" loading="lazy" onerror="this.remove()" />' +
          '<div class="ndm-post-info">' +
            '<div class="ndm-post-title">' + (p.title||'') + '</div>' +
            '<div class="ndm-post-date">' + (p.published_at||'').slice(0,10) + '</div>' +
          '</div></a>';
      }).join('') || '<div style="color:#94a3b8;font-size:.82rem;padding:8px">Chưa có bài viết</div>';
    }
    function __ddHover(el) {
      document.querySelectorAll('.ndm-cat-link').forEach(a => a.classList.remove('ndm-cat-active'));
      el.classList.add('ndm-cat-active');
      const cat = el.dataset.ddcat;
      const grid = document.getElementById('ndm-posts-grid');
      const label = document.getElementById('ndm-right-label');
      const viewAll = document.getElementById('ndm-view-all-link');
      if (!grid || !window.__DD_POSTS) return;
      const filtered = cat === 'all' ? window.__DD_POSTS : window.__DD_POSTS.filter(p => p.category === cat);
      grid.innerHTML = __ddRenderPosts(filtered);
      if (label) label.textContent = cat === 'all' ? 'BÀI VIẾT MỚI NHẤT' : cat.toUpperCase();
      if (viewAll) viewAll.href = cat === 'all' ? '/blog' : '/blog?cat=' + encodeURIComponent(cat);
    }
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

async function renderProductDetailPage(product) {
  const siteUrl = SITE_URL;
  const absoluteUrl = `${siteUrl}/cong-cu/${product.slug}`;
  const title = `${product.name} | ViAI`;
  const desc = product.description;
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: product.name,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Web',
    description: desc,
    url: absoluteUrl,
    provider: { '@type': 'Organization', name: 'ViAI', url: siteUrl }
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
  <meta property="og:site_name" content="ViAI" />
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
    .product-hero{background:linear-gradient(135deg,#0F172A 0%,#1A56DB 62%,#FF6B00 100%);color:white;padding:76px 20px;position:relative;overflow:hidden}.product-hero::after{content:'';position:absolute;width:460px;height:460px;border-radius:50%;background:rgba(255,255,255,.08);right:-120px;top:-170px}.hero-inner{max-width:1180px;margin:0 auto;display:grid;grid-template-columns:minmax(0,1.05fr) 420px;gap:56px;align-items:center;position:relative;z-index:1}.eyebrow{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,.13);border:1px solid rgba(255,255,255,.22);border-radius:999px;padding:6px 14px;font-size:.78rem;font-weight:800;text-transform:uppercase;letter-spacing:.8px;margin-bottom:20px}.product-hero h1{font-size:clamp(2.1rem,4vw,4rem);line-height:1.1;font-weight:900;margin-bottom:18px}.lead{font-size:1.08rem;max-width:720px;color:rgba(255,255,255,.86)}.hero-actions{display:flex;gap:12px;flex-wrap:wrap;margin-top:28px}.primary-cta,.secondary-cta{display:inline-flex;align-items:center;justify-content:center;padding:13px 22px;border-radius:8px;font-weight:800;font-size:.92rem}.primary-cta{background:#FF6B00;color:white;box-shadow:0 10px 28px rgba(255,107,0,.35)}.secondary-cta{border:1.5px solid rgba(255,255,255,.42);color:white;background:rgba(255,255,255,.08)}
    .hero-panel{background:white;color:var(--gray-900);border-radius:14px;padding:24px;border:1px solid rgba(255,255,255,.5);box-shadow:0 30px 90px rgba(0,0,0,.22)}.panel-top{display:flex;align-items:center;gap:14px;margin-bottom:20px}.big-icon{width:64px;height:64px;border-radius:16px;background:linear-gradient(135deg,rgba(26,86,219,.12),rgba(255,107,0,.09));display:flex;align-items:center;justify-content:center;font-size:2rem}.panel-name{font-size:1.05rem;font-weight:900}.panel-cat{font-size:.78rem;color:var(--gray-300);font-weight:700}.stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.stat{background:var(--gray-50);border:1px solid var(--gray-100);border-radius:10px;padding:12px;text-align:center}.stat strong{display:block;font-size:1rem;color:var(--primary);line-height:1.1}.stat span{display:block;font-size:.68rem;color:var(--gray-600);line-height:1.35;margin-top:5px}
    .section{padding:72px 20px}.section.alt{background:#F7FAFF}.inner{max-width:1180px;margin:0 auto}.two-col{display:grid;grid-template-columns:.92fr 1.08fr;gap:56px;align-items:start}.section-tag{font-size:.75rem;font-weight:900;text-transform:uppercase;letter-spacing:1.2px;color:var(--primary);margin-bottom:10px}.section h2{font-size:clamp(1.55rem,2.4vw,2.35rem);line-height:1.18;margin-bottom:16px}.section p{color:#334155;font-size:.98rem}.feature-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:16px}.feature-card{border:1px solid var(--gray-100);border-radius:10px;padding:18px;background:white}.feature-card strong{display:block;color:var(--gray-900);font-size:.98rem;margin-bottom:6px}.feature-card p{font-size:.88rem}.list{display:grid;gap:12px;list-style:none}.list li{background:white;border:1px solid var(--gray-100);border-radius:10px;padding:14px 16px;color:#334155;font-weight:600}.workflow{counter-reset:step;display:grid;gap:14px}.workflow li{list-style:none;position:relative;background:white;border:1px solid var(--gray-100);border-radius:10px;padding:16px 16px 16px 56px;color:#334155}.workflow li::before{counter-increment:step;content:counter(step);position:absolute;left:16px;top:16px;width:26px;height:26px;border-radius:50%;background:var(--primary);color:white;font-size:.8rem;font-weight:900;display:flex;align-items:center;justify-content:center}.chips{display:flex;flex-wrap:wrap;gap:10px}.chip{border:1px solid var(--gray-100);background:white;color:var(--gray-600);font-size:.85rem;font-weight:700;padding:8px 12px;border-radius:999px}.cta-band{background:var(--gray-900);color:white;padding:58px 20px}.cta-inner{max-width:1180px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;gap:28px}.cta-inner h2{font-size:clamp(1.5rem,2.6vw,2.5rem);line-height:1.2}.cta-inner p{color:rgba(255,255,255,.72);margin-top:8px;max-width:640px}
    @media(max-width:960px){.main-nav,.header-actions{display:none}.hamburger-btn{display:flex}.hero-inner,.two-col{grid-template-columns:1fr}.hero-panel{max-width:520px}.cta-inner{flex-direction:column;align-items:flex-start}}
    @media(max-width:640px){.header-inner{padding:0 18px}.logo-img{height:120px}.product-hero{padding:52px 18px}.section{padding:52px 18px}.feature-grid,.stat-grid{grid-template-columns:1fr}.hero-actions{flex-direction:column}.primary-cta,.secondary-cta{width:100%}}
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
  ${await renderSiteToolbar('products')}
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
            <div class="panel-cat">ViAI AI Agent</div>
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
        <p>ViAI có thể khảo sát quy trình hiện tại và đề xuất cấu hình Agent phù hợp cho doanh nghiệp của bạn.</p>
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
  ${renderSolutionFooter()}
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
    desc: 'Với hơn 75 triệu người dùng Zalo tại Việt Nam, đây là kênh bán hàng quan trọng nhất của SME. ViAI Zalo Sales Agent tự động hóa toàn bộ quy trình tư vấn và chốt đơn — từ lúc khách nhắn tin đến khi đơn hàng được tạo.',
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
        { icon: '🔍', role: 'Tuần 1 — Khảo sát', msg: 'Đội ViAI phân tích quy trình: nhận đơn → phân công tài xế → theo dõi → báo cáo. Xác định 4 điểm tắc nghẽn chính' },
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
      { name: 'Anh Nguyễn Minh Tuấn', role: 'Chủ shop thời trang online 500 đơn/ngày', quote: 'Trước tôi cần 3 bạn trực Zalo chia ca, lương 30M/tháng. Giờ ViAI xử lý 95% tin nhắn tự động, chỉ giữ 1 bạn cho ca đặc biệt. Doanh thu tăng 38% vì không bỏ sót khách đêm khuya nữa.' },
      { name: 'Chị Lê Thu Hằng', role: 'Founder chuỗi mỹ phẩm 8 cửa hàng', quote: 'Bot trả lời đúng giá, đúng chính sách, đúng tone thương hiệu — khách còn không biết đang chat với AI. Tỷ lệ chốt đơn từ Zalo tăng từ 22% lên 41% sau 3 tháng.' },
    ],
    faq: [
      { q: 'ViAI Zalo Sales Agent có cần tôi viết kịch bản không?', a: 'Không. Bạn chỉ cần cung cấp danh sách sản phẩm, giá và chính sách. ViAI tự học và tạo kịch bản tư vấn phù hợp trong vòng 24 giờ.' },
      { q: 'Khách hỏi những câu hóc búa thì Agent xử lý thế nào?', a: 'Agent nhận ra câu hỏi phức tạp và tự động chuyển sang nhân viên thực, kèm toàn bộ lịch sử hội thoại. Khách không phải kể lại từ đầu.' },
      { q: 'Tích hợp vào Zalo OA của tôi mất bao lâu?', a: 'Thường 2-4 giờ. Đội ngũ ViAI hỗ trợ toàn bộ quá trình kết nối — bạn không cần biết kỹ thuật.' },
      { q: 'Dữ liệu khách hàng có được bảo mật không?', a: 'Có. Toàn bộ dữ liệu được mã hóa AES-256, lưu trên server tại Việt Nam. ViAI không bán hay chia sẻ dữ liệu của bạn với bên thứ ba.' },
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
      { q: 'Nếu tôi đang dùng phần mềm quản lý kho riêng thì sao?', a: 'ViAI tích hợp với hầu hết phần mềm kho phổ biến tại Việt Nam (Base, KiotViet, MISA). Trường hợp hệ thống riêng, đội kỹ thuật sẽ kết nối qua API.' },
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
      { q: 'Tôi có thể tùy chỉnh quy tắc chăm sóc không?', a: 'Có. Bạn tự thiết lập: sau bao nhiêu ngày nhắc, nội dung tin nhắn như thế nào, ưu đãi gì cho từng nhóm. Đội ViAI hỗ trợ cấu hình theo nghiệp vụ.' },
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
      { q: 'Tôi có thể tự thiết kế mẫu báo cáo không?', a: 'Có. Đội ViAI làm việc với bạn để tùy chỉnh mẫu báo cáo theo nhu cầu thực tế trong buổi onboarding.' },
      { q: 'Khi dữ liệu nguồn bị lỗi hoặc mất kết nối, Agent xử lý thế nào?', a: 'Agent gửi cảnh báo ngay và bỏ qua nguồn lỗi, vẫn tổng hợp từ các nguồn còn lại. Bạn nhận được báo cáo kèm ghi chú rõ ràng về nguồn không lấy được.' },
    ],
  },
  'facebook-ads-agent': {
    commitmentSpecific: { icon: '📊', title: 'Cam kết ROAS tăng tối thiểu 25%', desc: 'Sau 60 ngày dùng, ROAS trung bình tăng ít nhất 25% — không đạt → miễn phí phí ViAI tháng tiếp theo.' },
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
    commitmentSpecific: { icon: '📧', title: 'Cam kết open rate > 35%', desc: 'Email chiến dịch đầu tiên đạt open rate > 35% — không đạt → ViAI tối ưu lại miễn phí đến khi đạt.' },
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
      { q: 'Tôi có thể thiết kế template email đẹp không?', a: 'Có. ViAI cung cấp sẵn 20+ template tiếng Việt responsive. Bạn cũng có thể upload template HTML riêng hoặc dùng drag-and-drop editor.' },
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
      { name: 'Anh Đinh Văn Hải', role: 'CTO tập đoàn logistics 500 nhân viên', quote: 'ViAI khảo sát 3 tuần, hiểu nghiệp vụ phân công xe tải của chúng tôi sâu hơn cả vendor ERP đã làm việc 2 năm. Agent tự động phân công 400 đơn vận chuyển/ngày, tiết kiệm 8 giờ nhân công.' },
      { name: 'Bà Nguyễn Thị Lan', role: 'GĐ vận hành chuỗi bán lẻ 80 cửa hàng', quote: 'Chúng tôi có phần mềm riêng từ 2018 không kết nối được với gì. ViAI xây Agent bridge toàn bộ hệ thống trong 3 tuần. Giờ dữ liệu chạy thông suốt từ POS đến kế toán không cần người nhập tay.' },
    ],
    faq: [
      { q: 'Qui trình khảo sát và thiết kế mất bao lâu?', a: 'Thường 1-2 tuần cho nghiệp vụ tiêu chuẩn, 3-4 tuần cho hệ thống phức tạp nhiều bộ phận. Bạn sẽ nhận được tài liệu thiết kế trước khi bắt đầu code.' },
      { q: 'Hệ thống cũ của tôi không có API thì có kết nối được không?', a: 'Vẫn được trong hầu hết trường hợp. Đội ViAI có thể xây RPA (robotic process automation) để tương tác với giao diện cũ, hoặc kết nối trực tiếp database với quyền phù hợp.' },
      { q: 'Tôi có nhận được code nguồn không?', a: 'Tùy gói. Gói Enterprise Full bàn giao toàn bộ code nguồn, tài liệu và quyền tự vận hành. Gói SaaS thì ViAI vận hành và bảo trì, bạn trả phí hàng tháng.' },
      { q: 'Nếu cần thay đổi sau khi triển khai thì tính như thế nào?', a: 'Thay đổi nhỏ trong 3 tháng đầu miễn phí. Thay đổi lớn hoặc tính năng mới tính theo giờ công minh bạch. Không có phí ẩn.' },
    ],
  },
};

async function renderProductPage(product, detail, related = []) {
  const siteUrl = SITE_URL;
  const title = `${product.name} – ViAI AI Agent`;
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
  <meta property="og:site_name" content="ViAI" />
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
  ${await renderSiteToolbar('products')}

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
      <h2 class="sec-h2">Các AI Agent khác của ViAI</h2>
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

  ${renderSolutionFooter()}

  <!-- Sticky bottom bar (mobile only) -->
  <div class="sticky-bar" aria-hidden="true">
    <div class="sb-info">
      <div class="sb-lbl">${escapeHtml(product.name)}</div>
      <div class="sb-name">Dùng thử miễn phí 7 ngày</div>
    </div>
    <a href="/dung-thu.html" style="border:2px solid var(--primary);border-radius:8px;padding:8px 14px;font-size:.82rem;font-weight:700;color:var(--primary)">Dùng thử</a>
    <a href="/dung-thu.html" class="p-cta-main cta-glow" style="padding:9px 16px;font-size:.82rem">Đăng ký ngay</a>
  </div>

  ${renderSiteToolbarScript()}
</body>
</html>`;
}

async function renderBlogPage(post) {
  let faq = [];
  try { faq = JSON.parse(post.faq_json || '[]'); } catch {}
  const siteUrl = SITE_URL;
  const displayTitle = cleanSeoText(post.title);
  const title = cleanSeoText(post.seo_title || displayTitle);
  const pageTitle = /\bViAI\b/i.test(title) ? title : `${title} | ViAI`;
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
    author: { '@type': 'Organization', name: post.author || 'ViAI Team' },
    publisher: {
      '@type': 'Organization',
      name: 'ViAI',
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
    ? `<div class="faq-section">
        <h2 class="faq-title">❓ Câu hỏi thường gặp</h2>
        ${faq.map((item,i) => `
        <div class="faq-item" id="faq-${i}">
          <div class="faq-q" onclick="toggleFaq(${i})">
            <span>${escapeHtml(item.question||'')}</span>
            <span class="faq-icon">+</span>
          </div>
          <div class="faq-a">${escapeHtml(item.answer||'')}</div>
        </div>`).join('')}
      </div>`
    : '';

  // Lấy bài liên quan
  let relatedPosts = [];
  try {
    relatedPosts = await db.prepare("SELECT title,slug,image_url,category,published_at FROM blog_posts WHERE active=1 AND slug != ? ORDER BY published_at DESC LIMIT 3").all(post.slug||'');
  } catch {}

  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>${escapeHtml(pageTitle)}</title>
  <link rel="icon" type="image/png" href="/anhlogo/logo2.png"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
  <meta name="description" content="${escapeHtml(desc)}"/>
  <link rel="canonical" href="${escapeHtml(absoluteUrl)}"/>
  <meta property="og:type" content="article"/>
  <meta property="og:site_name" content="ViAI"/>
  <meta property="og:title" content="${escapeHtml(title)}"/>
  <meta property="og:description" content="${escapeHtml(desc)}"/>
  <meta property="og:url" content="${escapeHtml(absoluteUrl)}"/>
  <meta property="og:image" content="${escapeHtml(imageUrl)}"/>
  <meta name="twitter:card" content="summary_large_image"/>
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}"/>
  <script type="application/ld+json">${jsonLd(articleSchema)}</script>
  <script type="application/ld+json">${jsonLd(breadcrumbSchema)}</script>
  ${faqSchema ? `<script type="application/ld+json">${jsonLd(faqSchema)}</script>` : ''}
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--primary:#1A56DB;--primary-dark:#1040B0;--primary-light:#4B82F4;--accent:#FF6B00;--accent-light:#FF8C38;--gray-50:#EEF3FF;--gray-100:#DBEAFE;--gray-300:#6B93E8;--gray-600:#1E3A8A;--gray-900:#0F172A}
    html{scroll-behavior:smooth}
    body{font-family:'Be Vietnam Pro',Arial,sans-serif;background:#f0f4f8;color:#0f172a;line-height:1.75;overflow-x:hidden}
    a{text-decoration:none;color:inherit}
    /* ── HERO ── */
    .post-hero{position:relative;min-height:420px;display:flex;align-items:flex-end;overflow:hidden;background:#0f172a}
    .post-hero-bg{position:absolute;inset:0;background-size:cover;background-position:center;opacity:.35;filter:blur(2px);transform:scale(1.05)}
    .post-hero-overlay{position:absolute;inset:0;background:linear-gradient(0deg,rgba(10,20,60,.95) 0%,rgba(26,86,219,.4) 60%,transparent 100%)}
    .post-hero-content{position:relative;z-index:1;max-width:860px;margin:0 auto;padding:60px 24px 48px;width:100%}
    .post-breadcrumb{display:flex;align-items:center;gap:6px;font-size:.78rem;color:rgba(255,255,255,.55);margin-bottom:18px;flex-wrap:wrap}
    .post-breadcrumb a{color:rgba(255,255,255,.55);transition:color .2s}
    .post-breadcrumb a:hover{color:#FFB800}
    .post-breadcrumb span{font-size:.6rem;color:rgba(255,255,255,.3)}
    .post-cat{display:inline-block;background:var(--accent);color:white;font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;padding:4px 14px;border-radius:20px;margin-bottom:16px}
    .post-title{font-size:clamp(1.7rem,3.5vw,2.8rem);font-weight:900;color:white;line-height:1.2;margin-bottom:18px}
    .post-meta{display:flex;align-items:center;gap:16px;flex-wrap:wrap}
    .post-author{display:flex;align-items:center;gap:10px}
    .post-author-avatar{width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--accent));display:flex;align-items:center;justify-content:center;font-size:1rem;font-weight:900;color:white;flex-shrink:0}
    .post-author-name{font-size:.88rem;font-weight:700;color:rgba(255,255,255,.9)}
    .post-date{font-size:.82rem;color:rgba(255,255,255,.55)}
    .post-read-time{font-size:.82rem;color:rgba(255,255,255,.55);background:rgba(255,255,255,.1);padding:3px 10px;border-radius:20px}
    /* ── LAYOUT ── */
    .post-layout{max-width:860px;margin:0 auto;padding:40px 24px 80px}
    /* ── ARTICLE ── */
    .post-article{background:white;border-radius:20px;padding:40px 44px;box-shadow:0 4px 24px rgba(15,23,42,.07);border:1px solid #e8eef8;margin-bottom:28px}
    .post-article h2{font-size:1.4rem;font-weight:900;color:var(--primary);margin:36px 0 12px;padding-bottom:8px;border-bottom:2px solid #EEF3FF}
    .post-article h2:first-child{margin-top:0}
    .post-article h3{font-size:1.1rem;font-weight:800;color:#0f172a;margin:24px 0 8px}
    .post-article h4{font-size:1rem;font-weight:700;color:#334155;margin:18px 0 6px}
    .post-article p{font-size:1rem;color:#374151;line-height:1.85;margin-bottom:16px}
    .post-article a{color:var(--primary);font-weight:700}
    .post-article a:hover{text-decoration:underline}
    .post-article ul,.post-article ol{padding-left:24px;margin:10px 0 18px}
    .post-article li{margin:8px 0;color:#374151;line-height:1.7}
    .post-article blockquote.blog-quote{margin:24px 0;padding:18px 24px;border-left:4px solid var(--primary);background:#EEF3FF;border-radius:0 12px 12px 0;color:#1E3A8A;font-style:italic;font-size:.97rem;line-height:1.8}
    .post-article hr.blog-hr{border:none;border-top:2px solid #e8eef8;margin:32px 0}
    .post-article figure.blog-fig{margin:28px 0;border-radius:14px;overflow:hidden;border:1px solid #e8eef8}
    .post-article figure.blog-fig img{width:100%;max-height:480px;object-fit:cover;display:block}
    .post-article figure.blog-fig figcaption{padding:10px 16px;font-size:.82rem;color:#64748b;text-align:center;background:#f8faff}
    .tbl-wrap{overflow-x:auto;margin:20px 0 24px;border-radius:12px;border:1px solid #e8eef8;box-shadow:0 2px 8px rgba(0,0,0,.04)}
    .tbl-wrap table{width:100%;border-collapse:collapse;font-size:.9rem;min-width:400px}
    .tbl-wrap thead th{background:var(--primary);color:white;padding:12px 16px;text-align:left;font-weight:700;font-size:.82rem}
    .tbl-wrap tbody td{padding:10px 16px;border-bottom:1px solid #f1f5f9;color:#334155;vertical-align:top}
    .tbl-wrap tbody tr:last-child td{border-bottom:none}
    .tbl-wrap tbody tr:nth-child(even) td{background:#f8faff}
    .tbl-wrap tbody tr:hover td{background:#EEF3FF}
    /* ── FAQ ── */
    .faq-section{background:white;border-radius:20px;padding:32px 36px;box-shadow:0 4px 24px rgba(15,23,42,.07);border:1px solid #e8eef8;margin-bottom:28px}
    .faq-title{font-size:1.2rem;font-weight:900;color:#0f172a;margin-bottom:20px}
    .faq-item{border-top:1px solid #f1f5f9}
    .faq-item:first-of-type{border-top:none}
    .faq-q{display:flex;justify-content:space-between;align-items:center;padding:16px 0;cursor:pointer;font-weight:700;color:#0f172a;font-size:.95rem;gap:12px}
    .faq-q:hover{color:var(--primary)}
    .faq-icon{font-size:1.2rem;font-weight:400;color:var(--primary);flex-shrink:0;transition:transform .25s}
    .faq-item.open .faq-icon{transform:rotate(45deg)}
    .faq-a{display:none;padding:0 0 16px;color:#475569;font-size:.92rem;line-height:1.8}
    .faq-item.open .faq-a{display:block}
    /* ── AUTHOR BOX ── */
    .author-box{background:linear-gradient(135deg,#EEF3FF,#f0f7ff);border-radius:20px;padding:28px 32px;display:flex;gap:20px;align-items:center;margin-bottom:28px;border:1px solid #dbe8ff}
    .author-avatar{width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,var(--primary),var(--accent));display:flex;align-items:center;justify-content:center;font-size:1.6rem;flex-shrink:0}
    .author-info h4{font-size:1rem;font-weight:900;color:#0f172a;margin-bottom:4px}
    .author-info p{font-size:.85rem;color:#64748b;line-height:1.6}
    /* ── CTA ── */
    .post-cta{background:linear-gradient(135deg,#1040B0,#1A56DB 55%,#FF6B00 100%);border-radius:20px;padding:36px 40px;text-align:center;margin-bottom:28px;position:relative;overflow:hidden}
    .post-cta::before{content:'';position:absolute;width:300px;height:300px;background:rgba(255,255,255,.06);border-radius:50%;top:-150px;right:-80px}
    .post-cta h3{font-size:1.3rem;font-weight:900;color:white;margin-bottom:10px;position:relative;z-index:1}
    .post-cta p{color:rgba(255,255,255,.75);font-size:.9rem;margin-bottom:20px;position:relative;z-index:1}
    .post-cta-btn{display:inline-flex;align-items:center;gap:8px;background:var(--accent);color:white;font-weight:800;padding:12px 28px;border-radius:10px;font-size:.92rem;position:relative;z-index:1;transition:all .2s;box-shadow:0 6px 20px rgba(255,107,0,.4)}
    .post-cta-btn:hover{background:#e55a00;transform:translateY(-2px)}
    /* ── RELATED ── */
    .related-section h3{font-size:1.1rem;font-weight:900;color:#0f172a;margin-bottom:16px}
    .related-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}
    .related-card{background:white;border-radius:14px;overflow:hidden;border:1px solid #e8eef8;transition:all .25s;display:block}
    .related-card:hover{transform:translateY(-3px);box-shadow:0 8px 24px rgba(26,86,219,.1)}
    .related-card img{width:100%;height:130px;object-fit:cover;display:block;background:#EEF3FF}
    .related-card-body{padding:14px}
    .related-card-cat{font-size:.7rem;font-weight:800;text-transform:uppercase;color:var(--accent);letter-spacing:.8px;margin-bottom:6px}
    .related-card-title{font-size:.88rem;font-weight:700;color:#0f172a;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .related-card-date{font-size:.75rem;color:#94a3b8;margin-top:8px}
    .ndm-wrap{position:static!important}
    .news-mega-dropdown{min-width:660px!important;padding:0!important;left:50%!important;transform:translateX(-50%) translateY(-8px)!important}
    .nav-item.ndm-wrap:hover .news-mega-dropdown,.nav-item.ndm-wrap:focus-within .news-mega-dropdown{transform:translateX(-50%) translateY(0)!important}
    .ndm-inner{display:flex;gap:0}
    .ndm-cats{width:190px;flex-shrink:0;padding:16px 12px;border-right:1px solid #f1f5f9}
    .ndm-section-label{font-size:.67rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;padding:0 8px;margin-bottom:8px}
    .ndm-cat-link{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:8px;font-size:.84rem;font-weight:600;color:#334155;transition:all .15s;text-decoration:none;cursor:pointer}
    .ndm-cat-link:hover,.ndm-cat-link.ndm-cat-active{background:#EEF3FF;color:#1A56DB}
    .ndm-cat-icon{font-size:1rem;width:20px;text-align:center;flex-shrink:0}
    .ndm-divider{width:1px;background:#f1f5f9;flex-shrink:0}
    .ndm-posts{flex:1;padding:16px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}
    .ndm-posts-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .ndm-post-item{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:8px;transition:all .15s;text-decoration:none;color:inherit}
    .ndm-post-item:hover{background:#f8faff}
    .ndm-post-item img{width:52px!important;height:40px!important;border-radius:5px;object-fit:cover;flex-shrink:0;background:#e2e8f0}
    .ndm-post-info{min-width:0}
    .ndm-post-title{font-size:.78rem;font-weight:700;color:#0F172A;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    .ndm-post-item:hover .ndm-post-title{color:#1A56DB}
    .ndm-post-date{font-size:.7rem;color:#94a3b8;margin-top:3px}
    .ndm-view-all{display:flex;align-items:center;justify-content:center;padding:9px 14px;background:linear-gradient(90deg,#1A56DB,#1040B0);color:white;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;transition:opacity .15s;margin-top:4px}
    .ndm-view-all:hover{opacity:.88}
    @media(max-width:960px){.main-nav,.header-actions{display:none}.hamburger-btn{display:flex}}
    @media(max-width:768px){.post-article{padding:24px 22px}.related-grid{grid-template-columns:1fr 1fr}.author-box{flex-direction:column;text-align:center}.post-layout{padding:28px 16px 60px}}
    @media(max-width:480px){.related-grid{grid-template-columns:1fr}.post-hero-content{padding:40px 16px 36px}.post-cta{padding:28px 22px}}
    @media(max-width:700px){.ndm-inner{flex-direction:column}.ndm-cats{width:100%;border-right:none;border-bottom:1px solid #f1f5f9}.ndm-posts-grid{grid-template-columns:1fr}.news-mega-dropdown{min-width:320px!important;left:0!important;transform:none!important}}
  </style>
</head>
<body>
  ${await renderSiteToolbar('blog')}

  <!-- HERO -->
  <div class="post-hero">
    ${post.image_url ? `<div class="post-hero-bg" style="background-image:url('${escapeHtml(post.image_url)}')"></div>` : ''}
    <div class="post-hero-overlay"></div>
    <div class="post-hero-content">
      <nav class="post-breadcrumb">
        <a href="/">Trang chủ</a>
        <span>›</span>
        <a href="/blog">Blog</a>
        <span>›</span>
        <span style="color:rgba(255,255,255,.8)">${escapeHtml(post.category||'Bài viết')}</span>
      </nav>
      <div class="post-cat">${escapeHtml(post.category||'Kiến thức AI')}</div>
      <h1 class="post-title">${escapeHtml(displayTitle)}</h1>
      <div class="post-meta">
        <div class="post-author">
          <div class="post-author-avatar">V</div>
          <span class="post-author-name">${escapeHtml(post.author||'ViAI Team')}</span>
        </div>
        <span class="post-date">📅 ${escapeHtml(post.published_at||'')}</span>
        <span class="post-read-time">⏱ 5 phút đọc</span>
      </div>
    </div>
  </div>

  <!-- CONTENT -->
  <div class="post-layout">
    <div class="post-article">
      ${renderMarkdown(cleanContent, { skipH1: true })}
    </div>

    ${faqHtml}

    <!-- AUTHOR BOX -->
    <div class="author-box">
      <div class="author-avatar">🤖</div>
      <div class="author-info">
        <h4>${escapeHtml(post.author||'ViAI Team')}</h4>
        <p>Đội ngũ chuyên gia AI và công nghệ của ViAI — chia sẻ kiến thức thực tế về AI Agent, tự động hóa và chuyển đổi số cho doanh nghiệp Việt Nam.</p>
      </div>
    </div>

    <!-- CTA -->
    <div class="post-cta">
      <h3>Sẵn sàng ứng dụng AI vào doanh nghiệp?</h3>
      <p>Triển khai AI Agent trong 24 giờ · Không cần đội IT · Dùng thử miễn phí 14 ngày</p>
      <a href="/dung-thu.html" class="post-cta-btn">🚀 Dùng thử miễn phí ngay</a>
    </div>

    <!-- RELATED POSTS -->
    ${relatedPosts.length ? `
    <div class="related-section">
      <h3>📚 Bài viết liên quan</h3>
      <div class="related-grid">
        ${relatedPosts.map(r => `
        <a href="/blog/${escapeHtml(r.slug||'')}" class="related-card">
          ${r.image_url ? `<img src="${escapeHtml(r.image_url)}" alt="${escapeHtml(r.title)}" loading="lazy"/>` : `<div style="height:130px;background:linear-gradient(135deg,#1040B0,#1A56DB);display:flex;align-items:center;justify-content:center;font-size:2rem">📝</div>`}
          <div class="related-card-body">
            <div class="related-card-cat">${escapeHtml(r.category||'Blog')}</div>
            <div class="related-card-title">${escapeHtml(r.title)}</div>
            <div class="related-card-date">${escapeHtml((r.published_at||'').slice(0,10))}</div>
          </div>
        </a>`).join('')}
      </div>
      <div style="text-align:center;margin-top:24px">
        <a href="/blog" style="display:inline-flex;align-items:center;gap:8px;padding:12px 28px;border:2px solid #1A56DB;border-radius:10px;font-weight:700;color:#1A56DB;font-size:.9rem;transition:all .2s" onmouseover="this.style.background='#1A56DB';this.style.color='white'" onmouseout="this.style.background='';this.style.color='#1A56DB'">Xem tất cả bài viết →</a>
      </div>
    </div>` : ''}
  </div>

  ${renderSolutionFooter()}
  ${renderSiteToolbarScript()}
  <script>
    function toggleFaq(i) {
      const item = document.getElementById('faq-'+i);
      const isOpen = item.classList.contains('open');
      document.querySelectorAll('.faq-item.open').forEach(el=>el.classList.remove('open'));
      if(!isOpen) item.classList.add('open');
    }
  </script>
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

// ── No-cache cho HTML pages (tránh browser cache auth cũ) ────────────────
app.use((req, res, next) => {
  if (req.method === 'GET'
    && !req.path.startsWith('/api')
    && !req.path.startsWith('/admin')
    && !req.path.startsWith('/uploads')
    && !/\.(css|js|png|jpg|jpeg|ico|svg|woff|woff2|webp|gif|map|txt|xml)$/i.test(req.path)) {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
  }
  next();
});

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

app.get('/admin', (_req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.sendFile(path.join(__dirname, 'admin', 'index.html'));
});

// ── Footer dùng chung cho 3 trang giải pháp ──────────
function renderSolutionFooter() {
  return `
  <style>
    .viai-footer{background:#0A1F6E;color:rgba(255,255,255,.7);position:relative;overflow:hidden}
    .viai-footer::before{content:'';position:absolute;inset:0;background-image:radial-gradient(rgba(255,255,255,.06) 1px,transparent 1px);background-size:28px 28px;pointer-events:none}
    .vf-main{max-width:1240px;margin:0 auto;padding:40px 20px 32px;display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr 1fr;gap:36px;align-items:start;position:relative;z-index:1}
    .vf-brand p{font-size:.82rem;line-height:1.65;margin-bottom:16px;color:rgba(255,255,255,.65)}
    .vf-col h5{color:#FFB800;font-size:.82rem;font-weight:800;margin-bottom:12px;padding-bottom:8px;border-bottom:1px solid rgba(255,255,255,.1);text-transform:uppercase;letter-spacing:.8px}
    .vf-col ul{display:flex;flex-direction:column;gap:7px;list-style:none}
    .vf-col ul a{font-size:.82rem;color:rgba(255,255,255,.6);transition:color .2s;display:flex;align-items:center;gap:6px}
    .vf-col ul a:hover{color:white}
    .vf-col ul a::before{content:'›';color:#FFB800;font-weight:700}
    .vf-social-bar{max-width:1240px;margin:0 auto;padding:0 20px 36px;position:relative;z-index:1}
    .vf-social-inner{border-top:1px solid rgba(255,255,255,.08);padding-top:28px;display:flex;gap:16px;flex-wrap:wrap;justify-content:center}
    .vf-soc-btn{display:flex;align-items:center;gap:10px;padding:10px 20px;border-radius:12px;text-decoration:none;transition:all .25s;border:1px solid}
    .vf-bottom{border-top:1px solid rgba(255,255,255,.08);padding:20px;background:rgba(0,0,0,.2);position:relative;z-index:1}
    .vf-bottom-inner{max-width:1240px;margin:0 auto;display:flex;flex-direction:column;gap:12px;align-items:center}
    .vf-contacts{display:flex;justify-content:center;flex-wrap:wrap;gap:24px}
    .vf-ci{display:flex;align-items:center;gap:8px;font-size:.82rem}
    .vf-ci .lbl{color:rgba(255,255,255,.45);font-size:.72rem}
    .vf-ci .val{color:white;font-weight:700}
    .vf-copy-row{display:flex;align-items:center;justify-content:space-between;width:100%;flex-wrap:wrap;gap:8px}
    .vf-copy-row p{font-size:.78rem;color:rgba(255,255,255,.5)}
    .vf-copy-row a{color:rgba(255,255,255,.4);font-size:.78rem;transition:color .2s}
    .vf-copy-row a:hover{color:white}
    .vf-fsocial{display:flex;gap:10px}
    .vf-fs{display:flex;align-items:center;justify-content:center;width:30px;height:30px;border-radius:50%;background:rgba(255,255,255,.1);color:rgba(255,255,255,.6);transition:all .2s}
    .vf-fs:hover{background:rgba(255,255,255,.22);color:white}
    @media(max-width:900px){.vf-main{grid-template-columns:1fr 1fr}}
    @media(max-width:480px){.vf-main{grid-template-columns:1fr}.vf-social-inner{gap:10px}.vf-soc-btn{padding:9px 14px}}
  </style>
  <footer class="viai-footer">
    <div class="vf-main">
      <div class="vf-brand">
        <div style="margin-bottom:14px"><img src="/anhlogo/logo4.png" alt="ViAI" style="height:48px" /></div>
        <p>AI Agent Platform dành cho doanh nghiệp vừa và nhỏ Việt Nam. Tự động hóa thông minh – hiệu quả – dễ dùng.</p>
        <div style="display:flex;flex-direction:column;gap:7px">
          <div style="display:flex;align-items:flex-start;gap:8px;font-size:.82rem;color:rgba(255,255,255,.6)"><span>📍</span><span>Số 35, Lê Văn Thiêm, Thanh Xuân, Hà Nội</span></div>
          <div style="display:flex;align-items:center;gap:8px;font-size:.82rem;color:rgba(255,255,255,.6)"><span>✉️</span><a href="mailto:vitechgroup@gmail.com" style="color:rgba(255,255,255,.6);transition:color .2s" onmouseover="this.style.color='#FFB800'" onmouseout="this.style.color='rgba(255,255,255,.6)'">vitechgroup@gmail.com</a></div>
        </div>
      </div>
      <div class="vf-col">
        <h5>Phần mềm</h5>
        <ul>
          <li><a href="/san-pham/zalo-sales-agent">Zalo Sales Agent</a></li>
          <li><a href="/san-pham/order-management-agent">Order Agent</a></li>
          <li><a href="/san-pham/crm-automation-agent">CRM Agent</a></li>
          <li><a href="/san-pham/report-analytics-agent">Report Agent</a></li>
        </ul>
      </div>
      <div class="vf-col">
        <h5>Dịch vụ</h5>
        <ul>
          <li><a href="/phan-mem">Phần mềm AI Agent</a></li>
          <li><a href="/dich-vu">Triển khai Custom</a></li>
          <li><a href="/dao-tao">Khóa học AI Agent</a></li>
          <li><a href="/nen-tang-ai-agent">Nền tảng AI Agent</a></li>
        </ul>
      </div>
      <div class="vf-col">
        <h5>Khóa học</h5>
        <ul>
          <li><a href="/dao-tao">AI Agent cơ bản</a></li>
          <li><a href="/dao-tao">n8n Thực chiến</a></li>
          <li><a href="/dao-tao">Lịch khai giảng</a></li>
        </ul>
      </div>
      <div class="vf-col">
        <h5>Công ty</h5>
        <ul>
          <li><a href="/about.html">Về chúng tôi</a></li>
          <li><a href="/blog">Tin tức</a></li>
          <li><a href="/about.html#team">Tuyển dụng</a></li>
          <li><a href="/#lien-he">Liên hệ</a></li>
        </ul>
      </div>
    </div>
    <div class="vf-social-bar">
      <div class="vf-social-inner">
        <a href="#" class="vf-soc-btn" style="background:rgba(0,150,255,.15);border-color:rgba(0,150,255,.3)" onmouseover="this.style.background='rgba(0,150,255,.28)'" onmouseout="this.style.background='rgba(0,150,255,.15)'">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#1877F2"/><path d="M16 8h-2a1 1 0 00-1 1v2h3l-.5 3H13v7h-3v-7H8v-3h2V9a4 4 0 014-4h2v3z" fill="white"/></svg>
          <div><div style="font-size:.65rem;color:rgba(255,255,255,.5);font-weight:600;line-height:1">Facebook</div><div style="font-size:.82rem;color:white;font-weight:700">ViAI Official</div></div>
        </a>
        <a href="#" class="vf-soc-btn" style="background:rgba(0,180,100,.15);border-color:rgba(0,180,100,.3)" onmouseover="this.style.background='rgba(0,180,100,.28)'" onmouseout="this.style.background='rgba(0,180,100,.15)'">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#0068FF"/><path d="M12 3C6.5 3 2 7 2 12c0 2.8 1.3 5.3 3.4 7l-.9 3.3L8 21.1C9.3 21.7 10.6 22 12 22c5.5 0 10-4 10-9S17.5 3 12 3zm5.2 11.8c-.2.6-1.2 1.1-1.7 1.2-.4.1-.9.1-1.5-.1-.3-.1-.8-.3-1.4-.5-2.4-1-3.9-3.3-4-3.5-.1-.1-1-1.3-1-2.5s.6-1.8.9-2c.2-.2.5-.3.7-.3h.5c.2 0 .4.1.5.4l.7 1.7c.1.1.1.3 0 .4l-.4.5-.3.3c.1.2.5.8 1.2 1.4.8.7 1.5 1 1.7 1l.4-.5c.2-.2.5-.3.7-.2l1.7.8c.2.1.3.2.3.4v.6z" fill="white"/></svg>
          <div><div style="font-size:.65rem;color:rgba(255,255,255,.5);font-weight:600;line-height:1">Zalo OA</div><div style="font-size:.82rem;color:white;font-weight:700">Chat với ViAI</div></div>
        </a>
        <a href="#" class="vf-soc-btn" style="background:rgba(255,0,0,.12);border-color:rgba(255,0,0,.25)" onmouseover="this.style.background='rgba(255,0,0,.22)'" onmouseout="this.style.background='rgba(255,0,0,.12)'">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#FF0000"/><path d="M20.5 7.5s-.2-1.4-.9-2c-.8-.9-1.8-.9-2.2-.9C15 4.5 12 4.5 12 4.5s-3 0-5.4.1c-.4 0-1.4.1-2.2.9-.6.6-.9 2-.9 2S3 9.1 3 10.7v1.5c0 1.6.2 3.2.2 3.2s.2 1.4.9 2c.8.9 1.9.8 2.4.9C8 18.5 12 18.5 12 18.5s3 0 5.4-.1c.4 0 1.4-.1 2.2-.9.6-.6.9-2 .9-2s.2-1.6.2-3.2v-1.5c0-1.6-.2-3.2-.2-3.3zm-9.8 6.5V9.5l5.8 2.3-5.8 2.2z" fill="white"/></svg>
          <div><div style="font-size:.65rem;color:rgba(255,255,255,.5);font-weight:600;line-height:1">YouTube</div><div style="font-size:.82rem;color:white;font-weight:700">Kênh ViAI TV</div></div>
        </a>
        <a href="tel:19008686" class="vf-soc-btn" style="background:rgba(0,179,65,.15);border-color:rgba(0,179,65,.3)" onmouseover="this.style.background='rgba(0,179,65,.28)'" onmouseout="this.style.background='rgba(0,179,65,.15)'">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect width="24" height="24" rx="6" fill="#00B341"/><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.3 0 .7-.2 1L6.6 10.8z" fill="white"/></svg>
          <div><div style="font-size:.65rem;color:rgba(255,255,255,.5);font-weight:600;line-height:1">Hotline</div><div style="font-size:.82rem;color:white;font-weight:700">1900 8686 06</div></div>
        </a>
      </div>
    </div>
    <div class="vf-bottom">
      <div class="vf-bottom-inner">
        <div class="vf-contacts">
          <div class="vf-ci"><span>📍</span><div><div class="lbl">Địa chỉ</div><div class="val">Thanh Xuân, Hà Nội</div></div></div>
          <div class="vf-ci"><span>📞</span><div><div class="lbl">Hotline Miền Bắc</div><div class="val">1900 8686 06</div></div></div>
          <div class="vf-ci"><span>📞</span><div><div class="lbl">Hotline Miền Nam</div><div class="val">1900 8686 08</div></div></div>
          <div class="vf-ci"><span>✉️</span><div><div class="lbl">Email hỗ trợ</div><div class="val">support@ViAI.vn</div></div></div>
        </div>
        <div class="vf-copy-row">
          <p>© 2026 ViAI Technology. Bảo lưu mọi quyền. &nbsp;|&nbsp; <a href="/privacy.html">Chính sách bảo mật</a> &nbsp;|&nbsp; <a href="/terms.html">Điều khoản</a> &nbsp;|&nbsp; <a href="/cookies.html">Cookies</a></p>
          <div class="vf-fsocial">
            <a href="#" class="vf-fs" title="Facebook"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z"/></svg></a>
            <a href="#" class="vf-fs" title="YouTube"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M22.54 6.42a2.78 2.78 0 0 0-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46A2.78 2.78 0 0 0 1.46 6.42 29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58 2.78 2.78 0 0 0 1.95 1.96C5.12 20 12 20 12 20s6.88 0 8.59-.46a2.78 2.78 0 0 0 1.95-1.96A29 29 0 0 0 23 12a29 29 0 0 0-.46-5.58zM9.75 15.02V8.98L15.5 12l-5.75 3.02z"/></svg></a>
            <a href="#" class="vf-fs" title="LinkedIn"><svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6zM2 9h4v12H2z"/><circle cx="4" cy="4" r="2"/></svg></a>
          </div>
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
    /* Dropdown Tin tức — ảnh nhỏ */
    .ndm-inner{display:flex;min-width:600px}
    .ndm-cats{width:160px;flex-shrink:0;padding:12px 8px;border-right:1px solid #f1f5f9;display:flex;flex-direction:column;gap:2px}
    .ndm-section-label{font-size:.67rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;padding:0 8px;margin-bottom:8px}
    .ndm-cat-link{display:flex;align-items:center;gap:6px;padding:7px 8px;border-radius:8px;font-size:.82rem;font-weight:600;color:#475569;transition:all .15s;cursor:pointer;text-decoration:none}
    .ndm-cat-link:hover,.ndm-cat-link.ndm-cat-active{background:#EEF3FF;color:#1A56DB}
    .ndm-divider{width:1px;background:#f1f5f9;flex-shrink:0}
    .ndm-posts{flex:1;padding:16px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}
    .ndm-posts-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .ndm-post-item{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:8px;transition:all .15s;text-decoration:none;color:inherit}
    .ndm-post-item:hover{background:#f8faff}
    .ndm-post-item img{width:52px!important;height:40px!important;border-radius:5px;object-fit:cover;flex-shrink:0;background:#e2e8f0}
    .ndm-post-info{min-width:0}
    .ndm-post-title{font-size:.78rem;font-weight:700;color:#0F172A;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    .ndm-post-item:hover .ndm-post-title{color:#1A56DB}
    .ndm-post-date{font-size:.7rem;color:#94a3b8;margin-top:3px}
    .ndm-view-all{display:block;text-align:center;padding:8px;font-size:.8rem;font-weight:700;color:#1A56DB;border-top:1px solid #f1f5f9;margin-top:8px;transition:color .15s}
    .ndm-view-all:hover{color:#1040B0}
    .news-mega-dropdown{min-width:600px!important}
    /* Feature row: ảnh + text cạnh nhau */
    .feat-row{display:grid;grid-template-columns:1fr 1fr;gap:56px;align-items:center}
    .feat-row.rev{direction:rtl}.feat-row.rev>*{direction:ltr}
    .feat-img-area{border-radius:20px;overflow:hidden;box-shadow:0 16px 48px rgba(26,86,219,.14);background:#EEF3FF;display:flex;align-items:center;justify-content:center;min-height:340px}
    .feat-img-area img{width:100%;height:100%;object-fit:cover;display:block}
    .feat-img-dark{background:linear-gradient(135deg,#0d1c45,#1a3070)}
    .feat-text-area .sec-h2{margin-bottom:14px}
    .feat-list{list-style:none;display:flex;flex-direction:column;gap:12px;margin-top:20px}
    .feat-list li{display:flex;align-items:flex-start;gap:10px;font-size:.9rem;color:#374151;line-height:1.65}
    .feat-list li::before{content:'✓';flex-shrink:0;width:22px;height:22px;background:linear-gradient(135deg,var(--primary),var(--accent));color:white;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:.7rem;font-weight:900;margin-top:1px}
    /* Hero with image */
    .sol-hero-row{display:grid;grid-template-columns:1fr 480px;gap:48px;align-items:center}
    .sol-hero-img{border-radius:18px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.3)}
    .sol-hero-img img{width:100%;height:320px;object-fit:cover;display:block}
    /* Congnghe image grid */
    .demo-img-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:36px}
    .demo-img-card{border-radius:16px;overflow:hidden;box-shadow:0 8px 24px rgba(26,86,219,.1);background:#EEF3FF}
    .demo-img-card.dark-bg{background:linear-gradient(135deg,#0d1c45,#1a3070)}
    .demo-img-card img{width:100%;height:200px;object-fit:cover;display:block}
    .demo-img-label{padding:12px 16px;font-size:.82rem;font-weight:700;color:#1E3A8A;background:white}
    .demo-img-card.dark-bg .demo-img-label{background:#0d1c45;color:rgba(255,255,255,.85)}
    @media(max-width:900px){.sol-hero-row{grid-template-columns:1fr}.sol-hero-img{display:none}.feat-row,.feat-row.rev{grid-template-columns:1fr;direction:ltr}.demo-img-grid{grid-template-columns:1fr 1fr}}
    @media(max-width:768px){.card-grid,.card-grid-4,.commit-grid{grid-template-columns:repeat(2,1fr)}.step-grid{grid-template-columns:1fr 1fr;row-gap:28px}.step-grid::before{display:none}.faq-grid,.card-grid-2{grid-template-columns:1fr}.cta-band{flex-direction:column;padding:36px 24px;margin:40px 16px}.ex-results{flex-wrap:wrap}.ex-result-item{flex:1 0 40%}}
    @media(max-width:480px){.card-grid,.card-grid-4,.commit-grid{grid-template-columns:1fr}.sol-btns{flex-direction:column}.demo-img-grid{grid-template-columns:1fr}}
  </style>`;
}

// ── Page 1: /phan-mem ─────────────────────────────────
async function renderPhanMem() {
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
  <title>Phần mềm AI Agent đóng gói sẵn | ViAI</title>
  <meta name="description" content="8 AI Agent sẵn sàng triển khai cho doanh nghiệp Việt — Zalo Sales, Order, CRM, Report, Email, Ads, Booking. Triển khai trong 24 giờ, không cần kỹ thuật."/>
  <link rel="canonical" href="${SITE_URL}/phan-mem"/>
  <meta property="og:title" content="Phần mềm AI Agent | ViAI"/><meta property="og:description" content="8 AI Agent đóng gói sẵn cho doanh nghiệp Việt."/><meta property="og:url" content="${SITE_URL}/phan-mem"/>
  <link rel="icon" href="/anhlogo/logo2.png"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
  ${renderSolutionCSS()}
</head>
<body>
  ${await renderSiteToolbar()}
  <!-- HERO -->
  <section class="sol-hero">
    <div class="sol-inner sol-hero-row">
      <div>
        <nav class="sol-bc"><a href="/">Trang chủ</a><span class="sep">›</span><span style="color:rgba(255,255,255,.9)">Phần mềm AI Agent</span></nav>
        <div class="sol-tag">Phần mềm</div>
        <h1>AI Agent đóng gói sẵn<br>triển khai trong <em style="color:#FFB800;font-style:normal">24 giờ</em></h1>
        <p>8 AI Agent chuyên biệt, sẵn sàng kết nối với hệ thống của bạn. Không cần đội kỹ thuật, không cần viết code — ViAI lo toàn bộ cài đặt và bàn giao.</p>
        <div class="sol-btns">
          <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">🚀 Dùng thử miễn phí <span class="cta-arrow">→</span></a>
          <a href="#agents" class="sol-btn-out">Xem danh sách Agent ↓</a>
        </div>
      </div>
      <div class="sol-hero-img">
        <img src="/anhlogo/anh3.png" alt="Phần mềm AI Agent ViAI" />
      </div>
    </div>
  </section>

  <!-- SHOWCASE: GIAO DIỆN THỰC TẾ -->
  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="feat-row">
        <div class="feat-img-area feat-img-dark">
          <img src="/anhlogo/congnghe4.png" alt="Dashboard AI Agent ViAI" style="mix-blend-mode:normal;object-fit:contain;padding:16px" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Nền tảng thực tế</div>
          <h2 class="sec-h2">Bảng điều khiển trung tâm — giám sát toàn bộ AI Agent theo thời gian thực</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">Dashboard ViAI là trung tâm điều phối cho toàn bộ hệ thống AI Agent của doanh nghiệp. Chỉ với một màn hình duy nhất, người quản lý nhìn thấy trạng thái real-time của từng Agent, số tác vụ đã xử lý, doanh thu ghi nhận và cảnh báo bất thường — mà không cần kiến thức kỹ thuật hay hỏi qua nhân viên.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">Giao diện tiếng Việt, màu sắc trực quan: xanh là ổn, vàng là cần chú ý, đỏ là xử lý ngay. Mỗi sáng, bản tóm tắt hoạt động được gửi tự động qua Zalo hoặc email cho người quản lý — không cần chờ báo cáo cuối ngày. Phân quyền chi tiết theo vai trò đảm bảo từng thành viên chỉ thấy đúng thông tin cần thiết cho công việc của họ.</p>
          <ul class="feat-list">
            <li>Màn hình tổng quan real-time: trạng thái, tốc độ xử lý và cảnh báo của từng Agent</li>
            <li>Lịch sử tác vụ 90 ngày: xem lại mọi hội thoại và đơn hàng Agent đã thực hiện</li>
            <li>Cấu hình không cần code: thay đổi kịch bản và quy tắc ngay trên giao diện tiếng Việt</li>
            <li>Báo cáo tự động hàng ngày gửi Zalo/email: tổng hợp hiệu suất và ngoại lệ</li>
            <li>Phân quyền theo vai trò: admin, vận hành, xem báo cáo — kiểm soát chính xác ai thấy gì</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <!-- SHOWCASE: KHẢ NĂNG TÍCH HỢP -->
  <section class="sec">
    <div class="sec-inner">
      <div class="feat-row rev">
        <div class="feat-img-area feat-img-dark">
          <img src="/anhlogo/congnghe5.png" alt="Tích hợp AI Agent ViAI" style="mix-blend-mode:normal;object-fit:contain;padding:16px" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Khả năng tích hợp</div>
          <h2 class="sec-h2">Kết nối đồng thời 100+ ứng dụng — dữ liệu đồng bộ hai chiều tức thì</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">ViAI kết nối đồng thời với hơn 100 ứng dụng phổ biến mà doanh nghiệp Việt Nam đang dùng hàng ngày — từ kênh bán hàng, phần mềm quản lý đến hệ thống nội bộ. Doanh nghiệp không cần thay đổi hay từ bỏ bất kỳ công cụ nào đang hoạt động tốt.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">Kết nối hoạt động hai chiều và theo thời gian thực. Khi khách nhắn tin qua Zalo OA, Agent nhận và xử lý ngay, đồng thời cập nhật CRM, tạo đơn trong phần mềm kho và ghi vào Google Sheets — tất cả trong vài giây mà không cần nhân viên can thiệp. Hệ thống legacy không có API cũng tích hợp được qua kỹ thuật RPA.</p>
          <ul class="feat-list">
            <li>Zalo OA, Facebook Messenger, Website Chat: xử lý tin nhắn đa kênh trong một luồng thống nhất</li>
            <li>Shopee, Lazada, TikTok Shop: gom đơn đa sàn, cập nhật trạng thái và tồn kho đồng bộ</li>
            <li>MISA AMIS, Base.vn, Google Sheets: đồng bộ dữ liệu kế toán và vận hành tự động</li>
            <li>Hơn 400 ứng dụng qua n8n và webhook: kết nối bất kỳ nền tảng nào không giới hạn</li>
            <li>Hệ thống legacy qua RPA: tích hợp phần mềm cũ không có API</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <!-- SHOWCASE: BẢO MẬT -->
  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="feat-row">
        <div class="feat-img-area feat-img-dark">
          <img src="/anhlogo/congnghe6.png" alt="Bảo mật AI Agent ViAI" style="mix-blend-mode:normal;object-fit:contain;padding:16px" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Bảo mật & Tuân thủ</div>
          <h2 class="sec-h2">Kiến trúc bảo mật ngân hàng — dữ liệu doanh nghiệp được bảo vệ tuyệt đối</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">ViAI xây dựng kiến trúc bảo mật theo chuẩn ngân hàng để bảo vệ toàn bộ dữ liệu doanh nghiệp: thông tin khách hàng, lịch sử giao dịch và quy trình kinh doanh nội bộ. Đây là nền tảng niềm tin cho quan hệ hợp tác lâu dài.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">Toàn bộ dữ liệu được mã hóa AES-256 cả khi truyền tải (TLS 1.3) lẫn khi lưu trữ. Máy chủ đặt tại Viettel IDC Tier 3 trên lãnh thổ Việt Nam, tuân thủ Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân. Dữ liệu không bao giờ rời khỏi biên giới quốc gia hay chia sẻ với bên thứ ba khi không có văn bản đồng ý từ doanh nghiệp.</p>
          <ul class="feat-list">
            <li>Mã hóa AES-256 end-to-end: chuẩn bảo mật ngân hàng cho cả truyền tải và lưu trữ</li>
            <li>Server tại Viettel IDC Tier 3: dữ liệu 100% tại Việt Nam, tuân thủ NĐ 13/2023</li>
            <li>Xác thực hai yếu tố (2FA): bắt buộc cho tất cả tài khoản quản trị</li>
            <li>Audit log bất biến: ghi toàn bộ thao tác với timestamp và IP, không thể sửa hay xóa</li>
            <li>Backup tự động tại 2 vị trí địa lý: khôi phục trong vòng 4 giờ nếu sự cố</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <!-- TẠI SAO CHỌN -->
  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="sec-label">Lợi ích</div>
      <h2 class="sec-h2">Tại sao chọn phần mềm AI Agent của ViAI?</h2>
      <p class="sec-sub">Không phải chatbot — là AI Agent thực sự hành động: tạo đơn, cập nhật CRM, gửi báo cáo, chăm sóc khách hàng — hoàn toàn tự động.</p>
      <div class="card-grid">
        <div class="sol-card"><div class="sol-card-icon">⚡</div><h3>Triển khai trong 24 giờ</h3><p>Từ lúc ký hợp đồng đến khi Agent chạy thực tế chỉ mất một ngày làm việc. Đội ngũ ViAI hỗ trợ cài đặt toàn bộ.</p></div>
        <div class="sol-card"><div class="sol-card-icon">🔗</div><h3>Kết nối 100+ ứng dụng</h3><p>Zalo, Facebook, Shopee, Lazada, Google Sheets, MISA, Base.vn và hàng trăm ứng dụng khác — không cần viết code.</p></div>
        <div class="sol-card"><div class="sol-card-icon">🛡️</div><h3>Bảo mật dữ liệu tuyệt đối</h3><p>Dữ liệu lưu tại máy chủ Việt Nam, mã hóa end-to-end, tuân thủ tiêu chuẩn ISO 27001 và quy định PDPA.</p></div>
        <div class="sol-card"><div class="sol-card-icon">📞</div><h3>Hỗ trợ 1-1 tiếng Việt</h3><p>Chuyên gia thực sự hỗ trợ qua Zalo và hotline. Cam kết phản hồi trong 30 phút giờ hành chính.</p></div>
        <div class="sol-card"><div class="sol-card-icon">🔄</div><h3>Tự học và cải thiện</h3><p>Agent sử dụng dữ liệu thực tế của doanh nghiệp để liên tục tối ưu phản hồi và quy trình xử lý.</p></div>
        <div class="sol-card"><div class="sol-card-icon">💰</div><h3>Hoàn tiền 14 ngày</h3><p>Nếu không hài lòng trong 14 ngày đầu, ViAI hoàn 100% không hỏi lý do. Rủi ro bằng không.</p></div>
      </div>
    </div>
  </section>

  <!-- DANH SÁCH AGENT -->
  <section class="sec" id="agents">
    <div class="sec-inner">
      <div class="sec-label">Thư viện Agent</div>
      <h2 class="sec-h2">8 AI Agent sẵn sàng triển khai</h2>
      <p class="sec-sub">Chọn Agent phù hợp với nghiệp vụ — hoặc để đội ngũ ViAI tư vấn miễn phí Agent tối ưu nhất cho doanh nghiệp của bạn.</p>
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
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q1.</span>Tôi không biết lập trình, có dùng được không?</div><div class="faq-a">Hoàn toàn không cần kỹ thuật. Giao diện tiếng Việt, đội ViAI hỗ trợ cài đặt 1-1 từ đầu đến cuối trong 24 giờ.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q2.</span>Agent có hoạt động 24/7 không?</div><div class="faq-a">Có. Agent chạy liên tục không cần giám sát — kể cả cuối tuần, ngày lễ và 2 giờ sáng. Uptime cam kết 99.9%.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q3.</span>Tôi có thể dùng nhiều Agent cùng lúc không?</div><div class="faq-a">Có. Nhiều doanh nghiệp dùng 2-3 Agent cùng lúc (ví dụ Zalo Sales + CRM + Report). Giá ưu đãi khi combo.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q4.</span>Dữ liệu khách hàng có an toàn không?</div><div class="faq-a">Mã hóa AES-256, lưu trữ tại Việt Nam, tuân thủ ISO 27001. ViAI không bán hay chia sẻ dữ liệu với bên thứ ba.</div></div>
      </div>
    </div>
  </section>

  <!-- CTA -->
  <div class="cta-band">
    <div><h2>Sẵn sàng triển khai AI Agent?</h2><p>Bắt đầu với 7 ngày dùng thử miễn phí — không cần thẻ tín dụng, đội ViAI hỗ trợ cài đặt 1-1.</p></div>
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
async function renderDichVu() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Dịch vụ triển khai AI Agent trọn gói | ViAI</title>
  <meta name="description" content="ViAI tư vấn, cấu hình, tích hợp và bàn giao AI Agent trọn gói cho doanh nghiệp. Cam kết triển khai trong 30 ngày, SLA 99.9% uptime."/>
  <link rel="canonical" href="${SITE_URL}/dich-vu"/>
  <meta property="og:title" content="Dịch vụ triển khai AI Agent | ViAI"/><meta property="og:url" content="${SITE_URL}/dich-vu"/>
  <link rel="icon" href="/anhlogo/logo2.png"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
  ${renderSolutionCSS()}
</head>
<body>
  ${await renderSiteToolbar()}
  <!-- HERO -->
  <section class="sol-hero" style="background:linear-gradient(135deg,#0F172A 0%,#0D3B8E 55%,#1A56DB 100%)">
    <div class="sol-inner sol-hero-row">
      <div>
        <nav class="sol-bc"><a href="/">Trang chủ</a><span class="sep">›</span><span style="color:rgba(255,255,255,.9)">Dịch vụ triển khai</span></nav>
        <div class="sol-tag">Dịch vụ</div>
        <h1>Triển khai AI Agent<br><em style="color:#FFB800;font-style:normal">trọn gói</em> — bàn giao tận tay</h1>
        <p>Đội ngũ ViAI khảo sát quy trình, thiết kế giải pháp, cấu hình tích hợp và đào tạo team của bạn — cho đến khi Agent vận hành trơn tru và sinh ra kết quả thực tế.</p>
        <div class="sol-btns">
          <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">📞 Đặt lịch tư vấn miễn phí <span class="cta-arrow">→</span></a>
          <a href="#quy-trinh" class="sol-btn-out">Xem quy trình ↓</a>
        </div>
      </div>
      <div class="sol-hero-img">
        <img src="/anhlogo/anh1.png" alt="Chuyên gia ViAI triển khai AI Agent" style="object-fit:contain;background:white" />
      </div>
    </div>
  </section>

  <!-- SHOWCASE: PHƯƠNG PHÁP TRIỂN KHAI -->
  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="feat-row">
        <div class="feat-img-area" style="background:linear-gradient(180deg,#eef4ff,#fff)">
          <img src="/anhlogo/congnghe1.png" alt="Phương pháp triển khai AI Agent ViAI" style="mix-blend-mode:multiply;object-fit:contain;padding:16px;width:100%;height:100%" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Phương pháp làm việc</div>
          <h2 class="sec-h2">Không chỉ cài đặt — đồng hành đến khi Agent tạo ra kết quả thực tế</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">ViAI không bàn giao cho đến khi Agent thực sự vận hành ổn định và tạo ra giá trị đo lường được. Đội chuyên gia dành 2–5 ngày khảo sát nghiệp vụ trực tiếp: phỏng vấn team, quan sát quy trình thực tế và xác định các điểm tắc nghẽn cụ thể cần tự động hóa.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">Sau khảo sát, ViAI thiết kế kịch bản Agent riêng theo đặc thù từng doanh nghiệp — tone of voice, quy tắc xử lý ngoại lệ và danh sách sản phẩm đều được cấu hình riêng. Agent chạy song song với quy trình cũ 5–7 ngày trước khi go-live chính thức, đảm bảo mọi thứ hoạt động đúng kỳ vọng trước khi bàn giao.</p>
          <ul class="feat-list">
            <li>Khảo sát nghiệp vụ 2–5 ngày: phỏng vấn team và vẽ sơ đồ quy trình chi tiết</li>
            <li>Thiết kế kịch bản riêng: tone of voice và quy tắc xử lý theo đặc thù từng doanh nghiệp</li>
            <li>Chạy song song 5–7 ngày: Agent và quy trình cũ vận hành đồng thời trước khi go-live</li>
            <li>2 tuần đồng hành sau go-live: theo dõi, điều chỉnh và đào tạo team vận hành</li>
            <li>Tài liệu bàn giao đầy đủ: hướng dẫn vận hành tiếng Việt và quy trình xử lý ngoại lệ</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <!-- SHOWCASE: NĂNG LỰC KỸ THUẬT -->
  <section class="sec">
    <div class="sec-inner">
      <div class="feat-row rev">
        <div class="feat-img-area" style="background:linear-gradient(180deg,#eef4ff,#fff)">
          <img src="/anhlogo/congnghe2.png" alt="Năng lực kỹ thuật ViAI" style="mix-blend-mode:multiply;object-fit:contain;padding:16px;width:100%;height:100%" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Năng lực kỹ thuật</div>
          <h2 class="sec-h2">Đội ngũ kỹ thuật chuyên sâu — làm chủ hoàn toàn công nghệ AI Agent</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">Nền tảng kỹ thuật ViAI được xây dựng từ đầu cho đặc thù vận hành của doanh nghiệp Việt Nam — AI Engine được fine-tune riêng cho ngôn ngữ thương mại tiếng Việt, hiểu cách chat bán hàng đặc trưng mà các mô hình AI tổng quát thường gặp khó.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">Khi có sự cố, đội ngũ nội bộ xử lý trực tiếp trong vòng 30 phút đến 2 giờ — không cần mở ticket hay chờ vendor nước ngoài. Hạ tầng tại Viettel IDC với auto-scaling tự động tăng tài nguyên ngày sale, đảm bảo Agent không bị chậm lúc cao điểm.</p>
          <ul class="feat-list">
            <li>AI Engine fine-tune tiếng Việt thương mại: hiểu ngữ cảnh bán hàng và cách chat đặc trưng người Việt</li>
            <li>Auto-scaling infrastructure: tự tăng tài nguyên trong mùa sale, đảm bảo Agent không chậm lúc cao điểm</li>
            <li>Microservices architecture: cập nhật tính năng không gián đoạn hoạt động của Agent đang chạy</li>
            <li>Tích hợp legacy qua RPA: kết nối phần mềm cũ không có API mà không cần sửa code nguồn</li>
            <li>SLA uptime 99.9% kèm cam kết đền bù: không đạt → giảm phí tháng kế tiếp theo tỷ lệ tương ứng</li>
            <li>Đội support nội bộ tại Việt Nam: phản hồi Zalo 30 phút giờ hành chính, 2h ngoài giờ cho gói Pro+</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <!-- DỊCH VỤ BAO GỒM -->
  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="sec-label">Gói dịch vụ</div>
      <h2 class="sec-h2">Chúng tôi làm gì cho bạn?</h2>
      <p class="sec-sub">Từ khảo sát nghiệp vụ đến vận hành thực tế — ViAI đồng hành toàn bộ hành trình AI của doanh nghiệp.</p>
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
              <div class="ex-msg">Đội ViAI phân tích quy trình: nhận booking → phân nhân viên → nhắc hẹn → báo cáo. Xác định 4 điểm tắc nghẽn: lễ tân bận xác nhận lịch, khách hay quên hẹn, lịch nhân viên bị chồng, không có báo cáo tập trung.</div>
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
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q1.</span>Dịch vụ này khác gì so với tự mua phần mềm?</div><div class="faq-a">Phần mềm anh tự cài đặt. Dịch vụ trọn gói thì ViAI lo từ A-Z: khảo sát, cấu hình, đào tạo và bảo trì — phù hợp với doanh nghiệp không có đội kỹ thuật nội bộ.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q2.</span>Chi phí triển khai tính như thế nào?</div><div class="faq-a">Phí một lần cho giai đoạn triển khai + phí vận hành hàng tháng. Liên hệ để nhận báo giá chi tiết theo quy mô và số Agent cần triển khai.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q3.</span>Hệ thống cũ của tôi có tích hợp được không?</div><div class="faq-a">Trong hầu hết trường hợp — có. ViAI tích hợp qua API, webhook hoặc RPA. Trường hợp phức tạp hơn sẽ được đánh giá miễn phí trong buổi khảo sát.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q4.</span>Sau khi triển khai nếu cần thay đổi thì sao?</div><div class="faq-a">Thay đổi nhỏ trong 3 tháng đầu miễn phí. Thay đổi lớn tính theo giờ công minh bạch — không có phí ẩn.</div></div>
      </div>
    </div>
  </section>

  <!-- CTA -->
  <div class="cta-band">
    <div><h2>Đặt lịch tư vấn miễn phí</h2><p>30 phút khảo sát, ViAI sẽ đề xuất giải pháp phù hợp và báo giá cụ thể cho doanh nghiệp của bạn.</p></div>
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
async function renderDaoTao() {
  const courses = [
    { icon:'🤖', level:'Cơ bản', name:'AI Agent 101', desc:'Hiểu AI Agent là gì, cách hoạt động và cách chọn Agent phù hợp với nghiệp vụ doanh nghiệp. Dành cho người mới bắt đầu.', duration:'8 buổi', format:'Online + Video ghi lại', price:'3.990.000đ' },
    { icon:'⚙️', level:'Thực chiến', name:'n8n & Automation Thực chiến', desc:'Xây dựng workflow tự động hóa với n8n — kết nối Zalo, Google Sheets, CRM và hơn 400 ứng dụng. Không cần code.', duration:'12 buổi', format:'Online Live + Project thực tế', price:'6.990.000đ' },
    { icon:'🏆', level:'Nâng cao', name:'AI Agent for Business', desc:'Thiết kế và triển khai hệ thống AI Agent đa bước cho doanh nghiệp. Bao gồm quản lý prompt, đánh giá hiệu suất và scale.', duration:'16 buổi', format:'Online + 1-1 Mentoring', price:'12.990.000đ' },
  ];
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Khóa học AI Agent thực chiến | ViAI</title>
  <meta name="description" content="Khóa học AI Agent thực chiến cho doanh nghiệp Việt Nam — từ cơ bản đến nâng cao. Học n8n, automation, và cách triển khai AI Agent cho nghiệp vụ thực tế."/>
  <link rel="canonical" href="${SITE_URL}/dao-tao"/>
  <meta property="og:title" content="Khóa học AI Agent | ViAI"/><meta property="og:url" content="${SITE_URL}/dao-tao"/>
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
  ${await renderSiteToolbar()}
  <!-- HERO -->
  <section class="sol-hero" style="background:linear-gradient(135deg,#0F172A 0%,#1E3A8A 50%,#0F172A 100%)">
    <div class="sol-inner sol-hero-row">
      <div>
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
      <div class="sol-hero-img">
        <img src="/anhlogo/anh2.png" alt="Khóa học AI Agent ViAI" style="object-fit:contain;background:white" />
      </div>
    </div>
  </section>

  <!-- SHOWCASE: PHƯƠNG PHÁP HỌC -->
  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="feat-row">
        <div class="feat-img-area feat-img-dark">
          <img src="/anhlogo/congnghe3.png" alt="Phương pháp học AI Agent thực chiến" style="mix-blend-mode:normal;object-fit:cover" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Phương pháp học</div>
          <h2 class="sec-h2">Học bằng cách làm thật — trên dữ liệu thật của doanh nghiệp học viên</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">Mỗi buổi học có ít nhất 60% thời gian thực hành trực tiếp trên dữ liệu thật của học viên — không phải dataset mẫu hay môi trường sandbox được dọn sẵn. Đến buổi thứ tư của khóa n8n Thực chiến, phần lớn học viên đã có workflow đang chạy thật cho shop của mình ngay trong khi đang học.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">Giảng viên là người đang vận hành AI Agent trong doanh nghiệp thực tế, không phải trainer theo tài liệu cố định. Họ chia sẻ những lỗi thường gặp nhất, cách debug từ log và cách tối ưu Agent để tạo ra kết quả đo lường được — kiến thức chỉ có từ người thực sự trải qua.</p>
          <ul class="feat-list">
            <li>60% thời gian thực hành mỗi buổi học: làm việc trực tiếp trên dữ liệu thật của doanh nghiệp học viên</li>
            <li>Giảng viên thực chiến: người đang vận hành AI Agent thực tế, không phải trainer theo tài liệu cố định</li>
            <li>Lớp học giới hạn số lượng: đảm bảo giảng viên review từng project và phản hồi cá nhân hóa</li>
            <li>Video ghi lại toàn bộ: xem lại không giới hạn — đặc biệt hữu ích khi gặp vấn đề sau khóa học</li>
            <li>Project thực tế cuối khóa: một hệ thống đang chạy thật cho doanh nghiệp học viên, không phải bài tập giả định</li>
            <li>Cộng đồng thực hành trên Zalo: hàng trăm người vận hành AI Agent Việt — hỏi đáp và chia sẻ 24/7</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <!-- SHOWCASE: CÔNG CỤ SẼ HỌC -->
  <section class="sec">
    <div class="sec-inner">
      <div class="feat-row rev">
        <div class="feat-img-area" style="background:linear-gradient(180deg,#eef4ff,#fff)">
          <img src="/anhlogo/congnghe1.png" alt="Công cụ AI Agent học tại ViAI" style="mix-blend-mode:multiply;object-fit:contain;padding:16px;width:100%;height:100%" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Công cụ & Nền tảng</div>
          <h2 class="sec-h2">Làm chủ công cụ AI Agent thực tế — dùng được ngay trong vận hành</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">Khóa học đào tạo trên chính những công cụ mà học viên sẽ dùng hàng ngày trong vận hành thực tế — nền tảng ViAI, n8n, Zalo OA API và các công cụ AI phổ biến nhất đang được doanh nghiệp Việt Nam sử dụng. Sau khóa học, học viên có thể tự cấu hình và vận hành một AI Agent hoàn chỉnh trong một ngày làm việc.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">n8n là công cụ cốt lõi từ cấp Thực chiến trở lên: kết nối 400+ ứng dụng mà không cần code. Zalo OA API là kỹ năng quan trọng nhất — học từ đăng ký Official Account đến go-live Agent thực sự trên kênh bán hàng số 1 Việt Nam.</p>
          <ul class="feat-list">
            <li>Nền tảng ViAI: giao diện tiếng Việt, cấu hình Agent bằng form và kéo thả — không cần code</li>
            <li>n8n Automation: xây workflow kết nối 400+ ứng dụng, học cách debug và vận hành production thực tế</li>
            <li>Zalo OA API: tích hợp AI Agent vào kênh bán hàng số 1 Việt Nam — từ đăng ký OA đến go-live</li>
            <li>Google Sheets & Looker Studio: tự động thu thập dữ liệu, xây dashboard KPI và báo cáo không cần code</li>
            <li>OpenAI / Claude API (cấp Nâng cao): tích hợp LLM vào workflow, tối ưu prompt và kiểm soát chi phí</li>
            <li>Zapier / Make: nền tảng automation thay thế cho doanh nghiệp chưa sẵn sàng tự host n8n</li>
          </ul>
        </div>
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
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q2.</span>Học xong có được hỗ trợ triển khai thực tế không?</div><div class="faq-a">Có. Học viên được ưu đãi 20% khi dùng dịch vụ triển khai của ViAI và được mentor review project trong 30 ngày sau khi học xong.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q3.</span>Học online hay offline?</div><div class="faq-a">Chủ yếu online live qua Zoom, có ghi lại video để xem lại. Một số khóa có buổi workshop offline tại TP.HCM và Hà Nội.</div></div>
        <div class="faq-item"><div class="faq-q"><span class="faq-qn">Q4.</span>Có học phần mềm của ViAI trong khóa học không?</div><div class="faq-a">Có. Học viên được dùng thử toàn bộ nền tảng ViAI trong suốt khóa học để thực hành trên dữ liệu thực tế của doanh nghiệp mình.</div></div>
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

// ── Page 4: /nen-tang-ai-agent ───────────────────────
async function renderNenTang() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Nền tảng AI Agent — AI Brain xử lý tự động 24/7 | ViAI</title>
  <meta name="description" content="AI Brain tự động hóa toàn bộ quy trình kinh doanh 24/7 — trả lời khách, tạo đơn, cập nhật kho, báo cáo mà không cần nhân viên trực."/>
  <link rel="canonical" href="${SITE_URL}/nen-tang-ai-agent"/>
  <meta property="og:title" content="Nền tảng AI Agent | ViAI"/><meta property="og:url" content="${SITE_URL}/nen-tang-ai-agent"/>
  <link rel="icon" href="/anhlogo/logo2.png"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
  ${renderSolutionCSS()}
</head>
<body>
  ${await renderSiteToolbar()}
  <section class="sol-hero">
    <div class="sol-inner sol-hero-row">
      <div>
        <nav class="sol-bc"><a href="/">Trang chủ</a><span class="sep">›</span><span style="color:rgba(255,255,255,.9)">Nền tảng AI Agent</span></nav>
        <div class="sol-tag">Nền tảng</div>
        <h1>AI Brain xử lý dữ liệu<br>tự động hóa <em style="color:#FFB800;font-style:normal">toàn bộ quy trình</em> 24/7</h1>
        <p>Lõi AI thông minh tiếp nhận dữ liệu từ mọi kênh, phân tích ngữ cảnh và thực hiện hành động phù hợp — hoàn toàn tự động, không cần nhân viên trực.</p>
        <div class="sol-btns">
          <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">🚀 Dùng thử miễn phí <span class="cta-arrow">→</span></a>
          <a href="#vi-du" class="sol-btn-out">Xem ví dụ thực tế ↓</a>
        </div>
        <div style="display:flex;gap:24px;margin-top:28px;flex-wrap:wrap">
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">24/7</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Không nghỉ</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">&lt;3s</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Phản hồi</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">500+</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Doanh nghiệp</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">98%</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Chính xác</div></div>
        </div>
      </div>
      <div class="sol-hero-img"><img src="/anhlogo/anh1.png" alt="Nền tảng AI Agent ViAI" /></div>
    </div>
  </section>

  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="feat-row">
        <div class="feat-img-area feat-img-dark">
          <img src="/anhlogo/congnghe4.png" alt="AI Brain nền tảng AI Agent" style="mix-blend-mode:normal;object-fit:contain;padding:16px" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Giới thiệu</div>
          <h2 class="sec-h2">AI Brain — trung tâm xử lý thông minh cho doanh nghiệp</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">Nền tảng AI Agent ViAI được xây dựng xung quanh lõi AI Brain — hệ thống xử lý thông minh có khả năng tiếp nhận dữ liệu từ nhiều nguồn cùng lúc, phân tích ngữ cảnh và đưa ra quyết định hành động phù hợp mà không cần sự can thiệp của con người. Đây không phải chatbot đơn thuần mà là "nhân viên kỹ thuật số" có thể học, thích nghi và cải thiện theo thời gian.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">AI Brain xử lý đồng thời hàng trăm tác vụ mỗi giờ: trả lời tin nhắn khách hàng, cập nhật đơn hàng, tổng hợp báo cáo và kích hoạt các workflow tiếp theo. Toàn bộ quy trình từ lúc khách liên hệ đến khi đơn hoàn thành đều có thể tự động hóa hoàn toàn — 24 giờ mỗi ngày, 7 ngày mỗi tuần, không nghỉ lễ.</p>
          <ul class="feat-list">
            <li>Xử lý ngôn ngữ tự nhiên tiếng Việt: hiểu đúng ý khách dù viết tắt hay sai chính tả</li>
            <li>Bộ nhớ ngữ cảnh: nhớ lịch sử hội thoại và thông tin khách để phản hồi cá nhân hóa</li>
            <li>Ra quyết định đa bước: xử lý logic phức tạp với nhiều điều kiện, không chỉ trả lời cứng nhắc</li>
            <li>Tự học từ dữ liệu thực: Agent cải thiện độ chính xác theo thời gian dựa trên phản hồi thực tế</li>
            <li>Hoạt động 24/7: không nghỉ, không chậm, không bỏ sót yêu cầu nào của khách hàng</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="sec">
    <div class="sec-inner">
      <div class="feat-row rev">
        <div class="feat-img-area feat-img-dark">
          <img src="/anhlogo/congnghe5.png" alt="Khả năng tự động hóa AI Agent" style="mix-blend-mode:normal;object-fit:contain;padding:16px" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Khả năng vận hành</div>
          <h2 class="sec-h2">Tự động hóa toàn bộ quy trình từ đầu đến cuối</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">Khả năng của nền tảng AI Agent ViAI không dừng lại ở việc trả lời tin nhắn. Agent có thể thực hiện chuỗi hành động liên tiếp: tiếp nhận yêu cầu, tra cứu thông tin trong hệ thống, tạo đơn hàng, cập nhật kho, gửi xác nhận cho khách và báo cáo kết quả cho quản lý — tất cả trong một luồng liền mạch không cần nhân viên can thiệp.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">Mỗi Agent hoạt động như một chuyên gia trong lĩnh vực được phân công: Zalo Sales Agent tập trung tư vấn và chốt đơn, Order Agent xử lý đơn hàng và kho, Report Agent tổng hợp số liệu. Sự chuyên biệt hóa này giúp từng Agent hoạt động chính xác và hiệu quả hơn so với hệ thống đa năng dàn trải.</p>
          <ul class="feat-list">
            <li>Tự động tạo đơn: nhận thông tin từ chat → xác nhận → tạo đơn → cập nhật kho trong 5 giây</li>
            <li>Phân loại và ưu tiên: tự phân loại yêu cầu và chuyển cho đúng bộ phận xử lý</li>
            <li>Kích hoạt workflow chuỗi: một hành động của khách kích hoạt nhiều bước tự động phía sau</li>
            <li>Báo cáo tự động lúc 8h: tổng hợp KPI và gửi cho quản lý không cần thủ công</li>
            <li>Xử lý ngoại lệ thông minh: nhận biết tình huống bất thường và chuyển cho nhân viên khi cần</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="sec sec-alt" id="vi-du">
    <div class="sec-inner">
      <div class="sec-label">Ví dụ thực tế</div>
      <h2 class="sec-h2">AI Agent xử lý đơn hàng lúc 2 giờ sáng — không có nhân viên trực</h2>
      <p class="sec-sub">Shop thời trang online — khách nhắn Zalo lúc 02:17</p>
      <div class="ex-wrap">
        <div class="ex-label">📍 Shop thời trang online — 2 giờ sáng, không có nhân viên trực</div>
        <div class="ex-flow">
          <div class="ex-step"><div class="ex-avatar">👤</div><div class="ex-bubble"><div class="ex-role">Khách hàng · 02:17</div><div class="ex-msg">Áo phông cotton trắng size L còn không? Giá bao nhiêu vậy?</div></div></div>
          <div class="ex-step"><div class="ex-avatar">🤖</div><div class="ex-bubble ai"><div class="ex-role">Zalo Sales Agent · 2 giây</div><div class="ex-msg">Dạ còn ạ! Áo phông cotton trắng size L hiện còn 8 cái. 💛 Giá 185.000đ, freeship đơn từ 300k. Anh/chị order ngay không ạ?</div></div></div>
          <div class="ex-step"><div class="ex-avatar">👤</div><div class="ex-bubble"><div class="ex-role">Khách hàng</div><div class="ex-msg">Cho mình 2 cái nhé, ship về Bình Dương</div></div></div>
          <div class="ex-step"><div class="ex-avatar">🤖</div><div class="ex-bubble ai"><div class="ex-role">AI Agent · tự động xử lý</div><div class="ex-msg">✅ Đã tạo đơn <strong>#2041</strong> — 2 áo phông trắng L = <strong>370.000đ</strong> (freeship). Giao Bình Dương 2-3 ngày. Gửi link thanh toán nhé! 🛍️</div></div></div>
          <div class="ex-step"><div class="ex-avatar">📊</div><div class="ex-bubble ai"><div class="ex-role">Hệ thống · tự động cập nhật</div><div class="ex-msg">Kho: -2 áo phông trắng L (còn 6). Đã tạo vận đơn. Báo cáo 8h sáng: đêm qua 7 đơn · 2.4tr doanh thu · 0 nhân viên trực ✨</div></div></div>
        </div>
        <div class="ex-results">
          <div class="ex-result-item"><span class="ex-result-num">2s</span><span class="ex-result-lbl">Phản hồi tức thì</span></div>
          <div class="ex-result-item"><span class="ex-result-num">24/7</span><span class="ex-result-lbl">Không cần trực</span></div>
          <div class="ex-result-item"><span class="ex-result-num">100%</span><span class="ex-result-lbl">Tự động tạo đơn</span></div>
          <div class="ex-result-item"><span class="ex-result-num">0đ</span><span class="ex-result-lbl">Chi phí nhân sự đêm</span></div>
        </div>
      </div>
    </div>
  </section>

  <div class="cta-band">
    <div><h2>Trải nghiệm nền tảng AI Agent ngay hôm nay</h2><p>7 ngày dùng thử miễn phí — đội ViAI hỗ trợ cài đặt 1-1, không cần thẻ tín dụng.</p></div>
    <div class="cta-btns">
      <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">🚀 Dùng thử miễn phí</a>
      <a href="/phan-mem" class="sol-btn-out" style="border-color:rgba(255,255,255,.4)">Xem các AI Agent →</a>
    </div>
  </div>
  ${renderSolutionFooter()}
  ${renderSiteToolbarScript()}
</body>
</html>`;
}

// ── Page 5: /tich-hop-50-nen-tang ───────────────────────
async function renderTichHop() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Tích hợp 50+ nền tảng — Zalo, Facebook, CRM, ERP | ViAI</title>
  <meta name="description" content="Kết nối Zalo, Facebook, Shopee, Lazada, CRM, ERP và 50+ nền tảng chỉ vài phút — không cần lập trình, không cần thay đổi hệ thống đang dùng."/>
  <link rel="canonical" href="${SITE_URL}/tich-hop-50-nen-tang"/>
  <meta property="og:title" content="Tích hợp 50+ nền tảng | ViAI"/><meta property="og:url" content="${SITE_URL}/tich-hop-50-nen-tang"/>
  <link rel="icon" href="/anhlogo/logo2.png"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
  ${renderSolutionCSS()}
</head>
<body>
  ${await renderSiteToolbar()}
  <section class="sol-hero" style="background:linear-gradient(135deg,#0F172A 0%,#0D3B8E 55%,#1A56DB 100%)">
    <div class="sol-inner sol-hero-row">
      <div>
        <nav class="sol-bc"><a href="/">Trang chủ</a><span class="sep">›</span><span style="color:rgba(255,255,255,.9)">Tích hợp 50+ nền tảng</span></nav>
        <div class="sol-tag">Tích hợp</div>
        <h1>Kết nối <em style="color:#FFB800;font-style:normal">50+ nền tảng</em><br>chỉ vài phút — không cần lập trình</h1>
        <p>Zalo, Facebook, Shopee, Lazada, CRM, ERP và toàn bộ hệ sinh thái doanh nghiệp kết nối liền mạch qua một AI Agent. Dữ liệu đồng bộ hai chiều, không nhập tay, không sai sót.</p>
        <div class="sol-btns">
          <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">🔗 Kết nối ngay miễn phí <span class="cta-arrow">→</span></a>
          <a href="#vi-du" class="sol-btn-out">Xem demo tích hợp ↓</a>
        </div>
        <div style="display:flex;gap:24px;margin-top:28px;flex-wrap:wrap">
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">50+</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Nền tảng</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">5 phút</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Kết nối native</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">2 chiều</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Đồng bộ real-time</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">0 code</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Không lập trình</div></div>
        </div>
      </div>
      <div class="sol-hero-img"><img src="/anhlogo/anh2.png" alt="Tích hợp 50+ nền tảng ViAI" style="object-fit:contain;background:white" /></div>
    </div>
  </section>

  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="feat-row">
        <div class="feat-img-area" style="background:linear-gradient(180deg,#eef4ff,#fff)">
          <img src="/anhlogo/congnghe1.png" alt="Kết nối đa nền tảng ViAI" style="mix-blend-mode:multiply;object-fit:contain;padding:16px;width:100%;height:100%" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Giới thiệu</div>
          <h2 class="sec-h2">Một AI Agent — kết nối toàn bộ hệ sinh thái doanh nghiệp</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">Doanh nghiệp hiện đại thường dùng 5–10 ứng dụng cùng lúc: Zalo để bán hàng, Shopee để nhận đơn, Google Sheets để báo cáo, MISA để kế toán. Vấn đề là các ứng dụng này không "nói chuyện" với nhau — nhân viên phải copy dữ liệu thủ công từ app này sang app kia, mất thời gian và sinh ra sai sót.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">ViAI giải quyết bằng cách đặt AI Agent làm cầu nối trung tâm: tự động thu thập dữ liệu từ mọi nguồn, xử lý theo quy tắc nghiệp vụ và phân phối kết quả đúng nơi cần thiết. Một lần cài đặt, toàn bộ hệ sinh thái ứng dụng hoạt động đồng bộ và liền mạch.</p>
          <ul class="feat-list">
            <li>Zalo OA, Facebook Messenger, Instagram DM: nhận tin nhắn từ tất cả kênh vào một luồng xử lý</li>
            <li>Shopee, Lazada, TikTok Shop, WooCommerce: đồng bộ đơn hàng, tồn kho và vận chuyển</li>
            <li>MISA AMIS, Fast Accounting, Google Sheets: tự động cập nhật dữ liệu tài chính và vận hành</li>
            <li>Zalo ZNS, Email, SMS: gửi thông báo cho khách qua đúng kênh họ muốn</li>
            <li>Google Calendar, Calendly: quản lý lịch hẹn và nhắc nhở tự động không cần nhân viên</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="sec">
    <div class="sec-inner">
      <div class="feat-row rev">
        <div class="feat-img-area" style="background:linear-gradient(180deg,#eef4ff,#fff)">
          <img src="/anhlogo/congnghe2.png" alt="3 phương thức kết nối ViAI" style="mix-blend-mode:multiply;object-fit:contain;padding:16px;width:100%;height:100%" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Cách kết nối</div>
          <h2 class="sec-h2">Kết nối theo 3 phương thức — phù hợp mọi loại hệ thống</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">ViAI hỗ trợ ba phương thức kết nối để tích hợp được với mọi loại hệ thống, kể cả phần mềm legacy không có API. Với nền tảng phổ biến như Zalo, Shopee, Google, kết nối sẵn có chỉ cần kích hoạt trong vài phút. Với phần mềm có API như MISA, Base.vn, đội kỹ thuật ViAI thiết lập trong 1–2 ngày.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">Với hệ thống legacy không có API mở, ViAI dùng kỹ thuật RPA để tự động hóa thao tác giao diện — không cần sửa code nguồn, không cần vendor hỗ trợ, không ảnh hưởng đến hệ thống hiện tại.</p>
          <ul class="feat-list">
            <li>Kết nối native (1-click): Zalo OA, Facebook, Shopee, Lazada, Google — kích hoạt ngay không cần code</li>
            <li>Kết nối qua API: phần mềm có API REST như MISA, Base.vn, Salesforce — thiết lập trong 1-2 ngày</li>
            <li>Kết nối qua RPA: hệ thống legacy không có API — tích hợp mà không sửa code nguồn</li>
            <li>Webhook real-time: nhận sự kiện tức thì và kích hoạt Agent xử lý ngay lập tức</li>
            <li>Đồng bộ hai chiều: dữ liệu chảy cả hai hướng, không mất đồng bộ khi một bên thay đổi</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="sec sec-alt" id="vi-du">
    <div class="sec-inner">
      <div class="sec-label">Ví dụ thực tế</div>
      <h2 class="sec-h2">Kết nối Shopee + Zalo + Google Sheets — tự động hoàn toàn</h2>
      <p class="sec-sub">Shop quần áo — đơn từ Shopee tự động cập nhật qua 3 hệ thống trong 60 giây</p>
      <div class="ex-wrap">
        <div class="ex-label">📍 Shop quần áo online — nhận đơn Shopee, báo Zalo chủ shop, cập nhật tồn kho Sheet</div>
        <div class="ex-flow">
          <div class="ex-step"><div class="ex-avatar">🛍️</div><div class="ex-bubble"><div class="ex-role">Shopee · 14:23</div><div class="ex-msg">Đơn hàng mới #SP8821 — Váy hoa size M × 1 · Khách: Nguyễn Thị Lan · TP.HCM · 320.000đ</div></div></div>
          <div class="ex-step"><div class="ex-avatar">🤖</div><div class="ex-bubble ai"><div class="ex-role">AI Agent · 3 giây — xác nhận đơn</div><div class="ex-msg">Kiểm tra kho: còn 4 cái ✅. Tự động xác nhận đơn trên Shopee. Trạng thái → "Đang chuẩn bị hàng".</div></div></div>
          <div class="ex-step"><div class="ex-avatar">📊</div><div class="ex-bubble ai"><div class="ex-role">Google Sheets · tự động cập nhật</div><div class="ex-msg">Sheet tồn kho: Váy hoa M: 5 → 4. Sheet đơn hàng: thêm dòng #SP8821. Doanh thu hôm nay: +320.000đ.</div></div></div>
          <div class="ex-step"><div class="ex-avatar">💬</div><div class="ex-bubble"><div class="ex-role">Zalo chủ shop · 14:23</div><div class="ex-msg">🛍️ Đơn mới #SP8821 — Váy hoa M × 1 = 320.000đ. Tồn kho còn 4. Cần chuẩn bị đóng gói! 📦</div></div></div>
        </div>
        <div class="ex-results">
          <div class="ex-result-item"><span class="ex-result-num">3</span><span class="ex-result-lbl">Hệ thống đồng bộ</span></div>
          <div class="ex-result-item"><span class="ex-result-num">60s</span><span class="ex-result-lbl">Xử lý hoàn chỉnh</span></div>
          <div class="ex-result-item"><span class="ex-result-num">0</span><span class="ex-result-lbl">Thao tác thủ công</span></div>
          <div class="ex-result-item"><span class="ex-result-num">24/7</span><span class="ex-result-lbl">Không cần giám sát</span></div>
        </div>
      </div>
    </div>
  </section>

  <div class="cta-band">
    <div><h2>Bắt đầu kết nối hệ sinh thái doanh nghiệp</h2><p>Kết nối nền tảng đầu tiên miễn phí — đội ViAI hỗ trợ thiết lập 1-1 trong vòng 24 giờ.</p></div>
    <div class="cta-btns">
      <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">🔗 Kết nối ngay miễn phí</a>
      <a href="/dich-vu" class="sol-btn-out" style="border-color:rgba(255,255,255,.4)">Xem dịch vụ triển khai →</a>
    </div>
  </div>
  ${renderSolutionFooter()}
  ${renderSiteToolbarScript()}
</body>
</html>`;
}

// ── Page 6: /bao-mat-doanh-nghiep ───────────────────────
async function renderBaoMat() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Bảo mật chuẩn doanh nghiệp — ISO 27001, AES-256 | ViAI</title>
  <meta name="description" content="Kiến trúc bảo mật 5 lớp theo chuẩn ISO 27001, mã hóa AES-256, dữ liệu lưu 100% tại Việt Nam. Bảo vệ dữ liệu doanh nghiệp như ngân hàng."/>
  <link rel="canonical" href="${SITE_URL}/bao-mat-doanh-nghiep"/>
  <meta property="og:title" content="Bảo mật chuẩn doanh nghiệp | ViAI"/><meta property="og:url" content="${SITE_URL}/bao-mat-doanh-nghiep"/>
  <link rel="icon" href="/anhlogo/logo2.png"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
  ${renderSolutionCSS()}
</head>
<body>
  ${await renderSiteToolbar()}
  <section class="sol-hero" style="background:linear-gradient(135deg,#0A1628 0%,#0D2144 60%,#0A1628 100%)">
    <div class="sol-inner sol-hero-row">
      <div>
        <nav class="sol-bc"><a href="/">Trang chủ</a><span class="sep">›</span><span style="color:rgba(255,255,255,.9)">Bảo mật doanh nghiệp</span></nav>
        <div class="sol-tag">Bảo mật</div>
        <h1>Bảo mật chuẩn <em style="color:#FFB800;font-style:normal">ISO 27001</em><br>dữ liệu tuyệt đối an toàn tại Việt Nam</h1>
        <p>Mã hóa AES-256, Zero Trust Architecture, dữ liệu lưu 100% tại Viettel IDC trên lãnh thổ Việt Nam. Kiến trúc bảo mật 5 lớp — không có điểm thất bại đơn.</p>
        <div class="sol-btns">
          <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">🛡️ Dùng thử an toàn <span class="cta-arrow">→</span></a>
          <a href="#vi-du" class="sol-btn-out">Xem cơ chế bảo vệ ↓</a>
        </div>
        <div style="display:flex;gap:24px;margin-top:28px;flex-wrap:wrap">
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">AES-256</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Mã hóa</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">ISO 27001</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Tiêu chuẩn</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">99.9%</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Uptime SLA</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">0</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Rò rỉ dữ liệu</div></div>
        </div>
      </div>
      <div class="sol-hero-img"><img src="/anhlogo/anh3.png" alt="Bảo mật chuẩn doanh nghiệp ViAI" style="object-fit:contain" /></div>
    </div>
  </section>

  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="feat-row">
        <div class="feat-img-area feat-img-dark">
          <img src="/anhlogo/congnghe6.png" alt="Kiến trúc bảo mật 5 lớp ViAI" style="mix-blend-mode:normal;object-fit:contain;padding:16px" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Kiến trúc bảo mật</div>
          <h2 class="sec-h2">Bảo mật 5 lớp — dữ liệu được bảo vệ như ngân hàng</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">Khi triển khai AI Agent, doanh nghiệp tin tưởng hệ thống tiếp cận dữ liệu quan trọng nhất: thông tin khách hàng, lịch sử giao dịch và quy trình kinh doanh nội bộ. ViAI xây dựng kiến trúc bảo mật 5 lớp — đảm bảo dù có sự cố ở một lớp, dữ liệu vẫn được bảo vệ bởi các lớp còn lại, không có điểm thất bại đơn.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">Mọi dữ liệu được mã hóa AES-256 — cùng chuẩn mà các ngân hàng Việt Nam áp dụng — cả khi truyền tải (TLS 1.3) lẫn khi lưu trữ. Ngay cả đội ngũ kỹ thuật ViAI cũng không thể đọc nội dung dữ liệu doanh nghiệp ở dạng bản rõ.</p>
          <ul class="feat-list">
            <li>Lớp 1 — Mã hóa: AES-256 cho lưu trữ, TLS 1.3 cho truyền tải</li>
            <li>Lớp 2 — Xác thực: 2FA bắt buộc, OAuth 2.0, không lưu mật khẩu dạng plain text</li>
            <li>Lớp 3 — Zero Trust: mọi yêu cầu đều xác thực, không tự động tin tưởng bất kỳ thiết bị nào</li>
            <li>Lớp 4 — Giám sát: phát hiện bất thường real-time, cảnh báo ngay khi có truy cập đáng ngờ</li>
            <li>Lớp 5 — Phục hồi: backup tự động hàng ngày tại 2 vị trí địa lý, RTO &lt; 4 giờ</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="sec">
    <div class="sec-inner">
      <div class="feat-row rev">
        <div class="feat-img-area feat-img-dark">
          <img src="/anhlogo/congnghe3.png" alt="Tuân thủ chuẩn bảo mật quốc tế ViAI" style="mix-blend-mode:normal;object-fit:cover" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Tuân thủ & Chứng nhận</div>
          <h2 class="sec-h2">Đạt chuẩn quốc tế — tuân thủ quy định pháp lý Việt Nam</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">ViAI tuân thủ đồng thời tiêu chuẩn bảo mật quốc tế và quy định pháp lý Việt Nam. Hạ tầng máy chủ đặt tại Viettel IDC Tier 3, hoàn toàn trên lãnh thổ Việt Nam. Dữ liệu không bao giờ rời khỏi biên giới quốc gia, phù hợp với Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">Hệ thống audit log ghi lại toàn bộ mọi thao tác: ai truy cập dữ liệu gì, lúc mấy giờ, từ IP nào, thay đổi gì. Log này không thể chỉnh sửa hay xóa — đảm bảo tính toàn vẹn cho kiểm toán nội bộ và yêu cầu từ cơ quan quản lý.</p>
          <ul class="feat-list">
            <li>ISO/IEC 27001: tiêu chuẩn quản lý an toàn thông tin được công nhận toàn cầu</li>
            <li>Nghị định 13/2023/NĐ-CP: tuân thủ quy định bảo vệ dữ liệu cá nhân của Việt Nam</li>
            <li>Server Viettel IDC Tier 3: uptime 99.9%, không lưu dữ liệu ngoài lãnh thổ</li>
            <li>Audit log bất biến: ghi toàn bộ thao tác, không thể sửa, xuất được cho kiểm toán</li>
            <li>Penetration test định kỳ: kiểm tra bảo mật hàng quý bởi đội ngũ security độc lập</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="sec sec-alt" id="vi-du">
    <div class="sec-inner">
      <div class="sec-label">Ví dụ thực tế</div>
      <h2 class="sec-h2">Phát hiện và chặn truy cập bất thường — tự động trong tích tắc</h2>
      <p class="sec-sub">Tài khoản admin bị đăng nhập từ IP nước ngoài lúc 2 giờ sáng — hệ thống tự xử lý</p>
      <div class="ex-wrap">
        <div class="ex-label">🔒 Tài khoản quản trị — đăng nhập từ IP Singapore lúc 02:14</div>
        <div class="ex-flow">
          <div class="ex-step"><div class="ex-avatar">⚠️</div><div class="ex-bubble"><div class="ex-role">Hệ thống phát hiện · 02:14:07</div><div class="ex-msg">Đăng nhập vào tài khoản admin từ IP 103.x.x.x (Singapore) — không thuộc whitelist. Thiết bị lạ, chưa từng đăng nhập trước đó.</div></div></div>
          <div class="ex-step"><div class="ex-avatar">🛡️</div><div class="ex-bubble ai"><div class="ex-role">Hệ thống bảo vệ · 0 giây</div><div class="ex-msg">✅ Tự động chặn phiên đăng nhập. Yêu cầu xác thực 2FA bổ sung. Tài khoản tạm khóa đến khi admin xác nhận.</div></div></div>
          <div class="ex-step"><div class="ex-avatar">🔔</div><div class="ex-bubble ai"><div class="ex-role">Cảnh báo · gửi ngay qua Zalo + email</div><div class="ex-msg">⚠️ CẢNH BÁO BẢO MẬT: Đăng nhập bất thường vào tài khoản admin từ IP lạ đã bị chặn. Có phải bạn không? [Đúng là tôi] [Báo cáo xâm nhập]</div></div></div>
          <div class="ex-step"><div class="ex-avatar">📋</div><div class="ex-bubble"><div class="ex-role">Audit log · ghi nhận đầy đủ</div><div class="ex-msg">02:14:07 | IP: 103.x.x.x | Thiết bị: Windows/Chrome | Hành động: Đăng nhập → Chặn tự động | Dữ liệu truy cập: Không có ✅</div></div></div>
        </div>
        <div class="ex-results">
          <div class="ex-result-item"><span class="ex-result-num">0s</span><span class="ex-result-lbl">Phát hiện tức thì</span></div>
          <div class="ex-result-item"><span class="ex-result-num">Tự động</span><span class="ex-result-lbl">Chặn không cần người</span></div>
          <div class="ex-result-item"><span class="ex-result-num">Real-time</span><span class="ex-result-lbl">Cảnh báo qua Zalo</span></div>
          <div class="ex-result-item"><span class="ex-result-num">0 byte</span><span class="ex-result-lbl">Dữ liệu bị lộ</span></div>
        </div>
      </div>
    </div>
  </section>

  <div class="cta-band">
    <div><h2>Triển khai AI Agent với bảo mật chuẩn doanh nghiệp</h2><p>Dữ liệu được bảo vệ từ ngày đầu tiên — 7 ngày dùng thử miễn phí, không cần thẻ tín dụng.</p></div>
    <div class="cta-btns">
      <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">🛡️ Dùng thử an toàn</a>
      <a href="/phan-mem" class="sol-btn-out" style="border-color:rgba(255,255,255,.4)">Xem các AI Agent →</a>
    </div>
  </div>
  ${renderSolutionFooter()}
  ${renderSiteToolbarScript()}
</body>
</html>`;
}

// ── Page 7: /ai-agent-thong-minh ───────────────────────
async function renderAiAgent() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>AI Agent Thông Minh — Vượt xa chatbot, hành động như nhân viên thực thụ | ViAI</title>
  <meta name="description" content="AI Agent ViAI hiểu ngữ cảnh, tự ra quyết định và thực hiện hành động — không chỉ trả lời mà còn tạo đơn, cập nhật kho, gửi báo cáo tự động 24/7."/>
  <link rel="canonical" href="${SITE_URL}/ai-agent-thong-minh"/>
  <meta property="og:title" content="AI Agent Thông Minh | ViAI"/><meta property="og:url" content="${SITE_URL}/ai-agent-thong-minh"/>
  <link rel="icon" href="/anhlogo/logo2.png"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
  ${renderSolutionCSS()}
</head>
<body>
  ${await renderSiteToolbar()}
  <section class="sol-hero" style="background:linear-gradient(135deg,#0a0f1e 0%,#0d1b3e 50%,#091428 100%)">
    <div class="sol-inner sol-hero-row">
      <div>
        <nav class="sol-bc"><a href="/">Trang chủ</a><span class="sep">›</span><span style="color:rgba(255,255,255,.9)">AI Agent Thông Minh</span></nav>
        <div class="sol-tag">Công nghệ cốt lõi</div>
        <h1>AI Agent thông minh<br>vượt xa chatbot — <em style="color:#FFB800;font-style:normal">hành động như nhân viên thực thụ</em></h1>
        <p>Không chỉ trả lời câu hỏi, AI Agent ViAI hiểu ngữ cảnh, tự ra quyết định và thực hiện chuỗi hành động phức tạp — từ tư vấn đến tạo đơn, cập nhật kho và gửi báo cáo hoàn toàn tự động.</p>
        <div class="sol-btns">
          <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">🚀 Dùng thử miễn phí <span class="cta-arrow">→</span></a>
          <a href="#vi-du" class="sol-btn-out">Xem ví dụ thực tế ↓</a>
        </div>
        <div style="display:flex;gap:24px;margin-top:28px;flex-wrap:wrap">
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">500+</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Doanh nghiệp dùng</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">24/7</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Không nghỉ</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">98%</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Chính xác</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#FFB800">&lt;2s</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Phản hồi</div></div>
        </div>
      </div>
      <div class="sol-hero-img"><img src="/anhlogo/anh1.png" alt="AI Agent thông minh ViAI" /></div>
    </div>
  </section>

  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="feat-row">
        <div class="feat-img-area" style="background:linear-gradient(180deg,#eef4ff,#fff)">
          <img src="/anhlogo/congnghe1.png" alt="AI Agent thông minh ViAI" style="mix-blend-mode:multiply;object-fit:contain;padding:16px" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Giới thiệu</div>
          <h2 class="sec-h2">Không phải chatbot — là nhân viên kỹ thuật số thực sự</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">AI Agent ViAI được xây dựng trên nền tảng xử lý ngôn ngữ tự nhiên thế hệ mới, cho phép hiểu ý định người dùng vượt ra ngoài từ ngữ thuần túy. Khi khách hàng nhắn "cho mình hỏi còn hàng không", Agent không chỉ trả lời mà còn tra kho thật, kiểm tra tồn, đề xuất sản phẩm phù hợp và hướng dẫn đặt hàng — tất cả trong một luồng liền mạch.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">Điểm khác biệt cốt lõi là khả năng nhớ ngữ cảnh hội thoại và ra quyết định đa bước. Agent nhớ khách đã mua gì, thích gì, từng phàn nàn gì — để mỗi cuộc trò chuyện tiếp theo đều cảm giác được cá nhân hóa như nhân viên quen thuộc, không phải bot lạnh lùng bắt đầu lại từ đầu.</p>
          <ul class="feat-list">
            <li>Hiểu tiếng Việt tự nhiên: viết tắt, sai chính tả, phương ngữ — Agent vẫn hiểu đúng ý</li>
            <li>Bộ nhớ ngữ cảnh: nhớ lịch sử khách hàng để cá nhân hóa mỗi tương tác</li>
            <li>Ra quyết định đa bước: xử lý logic phức tạp với nhiều điều kiện if-then</li>
            <li>Phân loại ý định: tự nhận biết đây là hỏi hàng, khiếu nại, hay muốn hoàn trả</li>
            <li>Chuyển tiếp thông minh: biết khi nào nên chuyển cho nhân viên người thật</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="sec">
    <div class="sec-inner">
      <div class="feat-row rev">
        <div class="feat-img-area" style="background:linear-gradient(180deg,#eef4ff,#fff)">
          <img src="/anhlogo/congnghe2.png" alt="Khả năng AI Agent ViAI" style="mix-blend-mode:multiply;object-fit:contain;padding:16px" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Khả năng vận hành</div>
          <h2 class="sec-h2">Thực hiện hành động thật — không chỉ nói chuyện</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">Chatbot thông thường chỉ đưa ra câu trả lời. AI Agent ViAI còn kết nối với các hệ thống thực tế để thực hiện hành động: tạo đơn trong phần mềm quản lý, cập nhật tồn kho, ghi nhận thanh toán, gửi thông báo Zalo cho quản lý và lập lịch follow-up tự động. Một khách hàng nhắn tin đặt hàng lúc 2 giờ sáng được xử lý hoàn toàn tự động.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">Agent có thể được triển khai song song trên nhiều kênh: Zalo OA, Facebook Messenger, website live chat, và cả Telegram — tất cả dùng chung một bộ não, đảm bảo thông tin nhất quán. Doanh nghiệp quản lý tập trung từ một bảng điều khiển duy nhất, không cần mở từng kênh riêng lẻ.</p>
          <ul class="feat-list">
            <li>Tạo đơn hàng tự động: nhận thông tin từ chat → xác nhận → tạo đơn trong 5 giây</li>
            <li>Cập nhật tồn kho real-time: trừ kho ngay khi đơn được xác nhận, không cần nhập tay</li>
            <li>Gửi thông báo đa kênh: tự động báo khách, báo kho, báo quản lý theo từng bước</li>
            <li>Báo cáo tự động 8h sáng: tổng hợp KPI đêm qua gửi cho quản lý không cần thủ công</li>
            <li>Chạy đa kênh song song: Zalo, Facebook, web — một não, nhiều cánh tay</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="sec sec-alt" id="vi-du">
    <div class="sec-inner">
      <div class="sec-label">Ví dụ thực tế</div>
      <h2 class="sec-h2">AI Agent tư vấn, chốt đơn và cập nhật kho — lúc 2 giờ sáng không có nhân viên</h2>
      <p class="sec-sub">Khách hàng nhắn Zalo lúc 02:23 — AI Agent xử lý hoàn toàn tự động</p>
      <div class="ex-wrap">
        <div class="ex-label">📍 Shop mỹ phẩm online — 2 giờ sáng, không ai trực</div>
        <div class="ex-flow">
          <div class="ex-step"><div class="ex-avatar">👤</div><div class="ex-bubble"><div class="ex-role">Khách hàng · 02:23</div><div class="ex-msg">Kem dưỡng ẩm cho da dầu còn không bạn? Da mình hay nổi mụn lắm</div></div></div>
          <div class="ex-step"><div class="ex-avatar">🤖</div><div class="ex-bubble ai"><div class="ex-role">AI Agent · 1.8 giây</div><div class="ex-msg">Dạ còn ạ! Cho da dầu hay mụn em gợi ý <strong>Kem Niacinamide 10%</strong> — kiểm soát dầu, mờ thâm, không bít lỗ chân lông. Giá 285.000đ, đang có deal freeship hôm nay. Anh/chị muốn xem thêm thành phần không ạ? 😊</div></div></div>
          <div class="ex-step"><div class="ex-avatar">👤</div><div class="ex-bubble"><div class="ex-role">Khách hàng</div><div class="ex-msg">Oke đặt 1 cái đi, ship Hà Nội</div></div></div>
          <div class="ex-step"><div class="ex-avatar">🤖</div><div class="ex-bubble ai"><div class="ex-role">AI Agent · tự động xử lý</div><div class="ex-msg">✅ Đã tạo đơn <strong>#MX4892</strong> — Kem Niacinamide 10% × 1 = <strong>285.000đ</strong> (freeship). Giao Hà Nội 1-2 ngày. Gửi link thanh toán QR nhé! 💳</div></div></div>
          <div class="ex-step"><div class="ex-avatar">📊</div><div class="ex-bubble ai"><div class="ex-role">Hệ thống · tự động</div><div class="ex-msg">Kho: -1 Kem Niacinamide (còn 23). Quản lý được báo Zalo. Tổng đêm nay: 11 đơn · 3.2tr · 0 nhân viên trực ✨</div></div></div>
        </div>
        <div class="ex-results">
          <div class="ex-result-item"><span class="ex-result-num">1.8s</span><span class="ex-result-lbl">Phản hồi tức thì</span></div>
          <div class="ex-result-item"><span class="ex-result-num">24/7</span><span class="ex-result-lbl">Không cần trực</span></div>
          <div class="ex-result-item"><span class="ex-result-num">100%</span><span class="ex-result-lbl">Tự động tạo đơn</span></div>
          <div class="ex-result-item"><span class="ex-result-num">0đ</span><span class="ex-result-lbl">Chi phí nhân sự đêm</span></div>
        </div>
      </div>
    </div>
  </section>

  <div class="cta-band">
    <div><h2>Trải nghiệm AI Agent thông minh ngay hôm nay</h2><p>7 ngày dùng thử miễn phí — đội ViAI hỗ trợ cài đặt 1-1, không cần thẻ tín dụng.</p></div>
    <div class="cta-btns">
      <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">🚀 Dùng thử miễn phí</a>
      <a href="/nen-tang-ai-agent" class="sol-btn-out" style="border-color:rgba(255,255,255,.4)">Xem nền tảng AI Agent →</a>
    </div>
  </div>
  ${renderSolutionFooter()}
  ${renderSiteToolbarScript()}
</body>
</html>`;
}

// ── Page 8: /kien-truc-api-mo ───────────────────────
async function renderKienTrucApi() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Kiến Trúc API Mở — Kết nối bất kỳ hệ thống nào trong vài phút | ViAI</title>
  <meta name="description" content="Hệ thống API chuẩn REST, webhook linh hoạt — kết nối Zalo, CRM, ERP, Shopee, Google Sheets và 50+ nền tảng chỉ vài phút, không cần lập trình."/>
  <link rel="canonical" href="${SITE_URL}/kien-truc-api-mo"/>
  <meta property="og:title" content="Kiến Trúc API Mở | ViAI"/><meta property="og:url" content="${SITE_URL}/kien-truc-api-mo"/>
  <link rel="icon" href="/anhlogo/logo2.png"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
  ${renderSolutionCSS()}
</head>
<body>
  ${await renderSiteToolbar()}
  <section class="sol-hero" style="background:linear-gradient(135deg,#0c1a3a 0%,#0f2460 50%,#091830 100%)">
    <div class="sol-inner sol-hero-row">
      <div>
        <nav class="sol-bc"><a href="/">Trang chủ</a><span class="sep">›</span><span style="color:rgba(255,255,255,.9)">Kiến Trúc API Mở</span></nav>
        <div class="sol-tag">Tích hợp hệ thống</div>
        <h1>Kiến trúc API mở<br>kết nối <em style="color:#38BDF8;font-style:normal">bất kỳ hệ thống nào</em> trong vài phút</h1>
        <p>Chuẩn REST API và webhook linh hoạt cho phép ViAI kết nối với toàn bộ hệ sinh thái phần mềm doanh nghiệp — từ Zalo, Shopee đến CRM, ERP nội bộ — mà không cần viết một dòng code nào.</p>
        <div class="sol-btns">
          <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">🚀 Dùng thử miễn phí <span class="cta-arrow">→</span></a>
          <a href="#vi-du" class="sol-btn-out">Xem ví dụ thực tế ↓</a>
        </div>
        <div style="display:flex;gap:24px;margin-top:28px;flex-wrap:wrap">
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#38BDF8">REST</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Chuẩn API</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#38BDF8">50+</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Nền tảng tích hợp</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#38BDF8">5 phút</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Kết nối xong</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#38BDF8">99.9%</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Uptime</div></div>
        </div>
      </div>
      <div class="sol-hero-img"><img src="/anhlogo/anh2.png" alt="Kiến trúc API mở ViAI" style="background:#fff;border-radius:16px;padding:8px" /></div>
    </div>
  </section>

  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="feat-row">
        <div class="feat-img-area" style="background:linear-gradient(180deg,#eef4ff,#fff)">
          <img src="/anhlogo/congnghe2.png" alt="Kiến trúc API ViAI" style="mix-blend-mode:multiply;object-fit:contain;padding:16px" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Giới thiệu</div>
          <h2 class="sec-h2">Hệ sinh thái mở — kết nối linh hoạt, không bị khoá nền tảng</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">Vấn đề lớn nhất của các giải pháp AI trên thị trường là chỉ chạy tốt trong hệ sinh thái riêng của họ. ViAI được xây dựng theo kiến trúc API mở từ đầu — nghĩa là bất kỳ phần mềm nào có API đều có thể kết nối, bất kể đó là phần mềm Việt hay quốc tế, cloud hay on-premise.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">Webhook hai chiều cho phép dữ liệu chạy liên tục theo thời gian thực: khi có đơn mới trên Shopee, ViAI nhận ngay và kích hoạt quy trình xử lý; khi Agent tạo đơn xong, hệ thống tự push kết quả về phần mềm kho của doanh nghiệp. Mọi thứ đều tự động, không cần ai ngồi copy-paste giữa các phần mềm.</p>
          <ul class="feat-list">
            <li>Chuẩn REST API: tài liệu đầy đủ, dễ tích hợp với mọi ngôn ngữ lập trình</li>
            <li>Webhook real-time: nhận và gửi sự kiện ngay lập tức, không cần polling</li>
            <li>OAuth 2.0: xác thực an toàn, không cần chia sẻ mật khẩu hệ thống</li>
            <li>Sandbox môi trường test: thử nghiệm tích hợp mà không ảnh hưởng dữ liệu thật</li>
            <li>Không vendor lock-in: chuyển đổi hoặc mở rộng thêm nền tảng bất kỳ lúc nào</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="sec">
    <div class="sec-inner">
      <div class="feat-row rev">
        <div class="feat-img-area" style="background:linear-gradient(180deg,#eef4ff,#fff)">
          <img src="/anhlogo/congnghe1.png" alt="Tích hợp API ViAI" style="mix-blend-mode:multiply;object-fit:contain;padding:16px" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Khả năng tích hợp</div>
          <h2 class="sec-h2">Kết nối toàn bộ hệ sinh thái — 3 phương thức linh hoạt</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">ViAI cung cấp ba phương thức tích hợp để phù hợp với mọi loại hệ thống: tích hợp native cho các nền tảng phổ biến (Zalo, Shopee, Facebook — chỉ cần điền API key, xong trong 5 phút), tích hợp qua REST API cho các phần mềm có tài liệu API, và tích hợp qua RPA cho các hệ thống cũ không có API.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">Đặc biệt, bảng điều khiển tích hợp trực quan cho phép nhân viên không biết code cũng có thể thiết lập luồng dữ liệu theo dạng drag-and-drop. Kéo thả "Khi có đơn Shopee → cập nhật Google Sheets → gửi Zalo cho kho" — xong trong 10 phút mà không cần gọi IT.</p>
          <ul class="feat-list">
            <li>Native connector: Zalo OA, Facebook, Shopee, Lazada, TikTok Shop, Google Workspace</li>
            <li>API connector: kết nối bất kỳ phần mềm nào có REST API — MISA, KiotViet, Sapo...</li>
            <li>RPA connector: tự động hóa phần mềm cũ không có API bằng công nghệ screen automation</li>
            <li>Drag-and-drop flow builder: thiết kế luồng tích hợp trực quan, không cần code</li>
            <li>Monitoring tích hợp: theo dõi trạng thái kết nối, cảnh báo khi có lỗi đồng bộ</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="sec sec-alt" id="vi-du">
    <div class="sec-inner">
      <div class="sec-label">Ví dụ thực tế</div>
      <h2 class="sec-h2">Đơn Shopee tự chạy xuyên qua 4 hệ thống — không ai nhập tay</h2>
      <p class="sec-sub">Chuỗi tích hợp tự động: Shopee → ViAI → Google Sheets → Zalo</p>
      <div class="ex-wrap">
        <div class="ex-label">📍 Shop thời trang — đơn mới lúc 14:37</div>
        <div class="ex-flow">
          <div class="ex-step"><div class="ex-avatar">🛒</div><div class="ex-bubble"><div class="ex-role">Shopee · 14:37:02</div><div class="ex-msg">Đơn mới <strong>#SP9934</strong> — Áo khoác denim size M × 1 = 450.000đ. Khách: Nguyễn Thị Hoa, TP.HCM</div></div></div>
          <div class="ex-step"><div class="ex-avatar">🤖</div><div class="ex-bubble ai"><div class="ex-role">ViAI API · 0.3 giây</div><div class="ex-msg">Webhook nhận đơn → Tra kho: Áo khoác denim M còn 12 cái ✅ → Xác nhận đơn tự động → Tạo vận đơn GHTK</div></div></div>
          <div class="ex-step"><div class="ex-avatar">📊</div><div class="ex-bubble ai"><div class="ex-role">Google Sheets · tự động cập nhật</div><div class="ex-msg">Sheet "Đơn hàng tháng 5": thêm dòng #SP9934 | Áo khoác denim M | 450k | Đang giao | GHTK-2847...</div></div></div>
          <div class="ex-step"><div class="ex-avatar">📱</div><div class="ex-bubble ai"><div class="ex-role">Zalo kho hàng · tự động báo</div><div class="ex-msg">📦 Đơn mới #SP9934 — Áo khoác denim M × 1. Vui lòng đóng gói và bàn giao GHTK trước 17h hôm nay.</div></div></div>
        </div>
        <div class="ex-results">
          <div class="ex-result-item"><span class="ex-result-num">0.3s</span><span class="ex-result-lbl">Xử lý tức thì</span></div>
          <div class="ex-result-item"><span class="ex-result-num">4</span><span class="ex-result-lbl">Hệ thống liên kết</span></div>
          <div class="ex-result-item"><span class="ex-result-num">0</span><span class="ex-result-lbl">Thao tác thủ công</span></div>
          <div class="ex-result-item"><span class="ex-result-num">24/7</span><span class="ex-result-lbl">Tự động liên tục</span></div>
        </div>
      </div>
    </div>
  </section>

  <div class="cta-band">
    <div><h2>Kết nối hệ thống của anh với ViAI ngay hôm nay</h2><p>7 ngày dùng thử miễn phí — kỹ thuật ViAI hỗ trợ tích hợp 1-1, không cần thẻ tín dụng.</p></div>
    <div class="cta-btns">
      <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">🚀 Dùng thử miễn phí</a>
      <a href="/tich-hop-50-nen-tang" class="sol-btn-out" style="border-color:rgba(255,255,255,.4)">Xem 50+ tích hợp →</a>
    </div>
  </div>
  ${renderSolutionFooter()}
  ${renderSiteToolbarScript()}
</body>
</html>`;
}

// ── Page 9: /ha-tang-bao-mat-cao ───────────────────────
async function renderHaTang() {
  return `<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Hạ Tầng Bảo Mật Cao — Mã hóa end-to-end, phòng thủ đa lớp | ViAI</title>
  <meta name="description" content="Hệ thống bảo mật end-to-end, mã hóa AES-256, phòng thủ đa lớp — dữ liệu doanh nghiệp được bảo vệ tuyệt đối, lưu trữ tại Việt Nam theo chuẩn ISO 27001."/>
  <link rel="canonical" href="${SITE_URL}/ha-tang-bao-mat-cao"/>
  <meta property="og:title" content="Hạ Tầng Bảo Mật Cao | ViAI"/><meta property="og:url" content="${SITE_URL}/ha-tang-bao-mat-cao"/>
  <link rel="icon" href="/anhlogo/logo2.png"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
  ${renderSolutionCSS()}
</head>
<body>
  ${await renderSiteToolbar()}
  <section class="sol-hero" style="background:linear-gradient(135deg,#060d1a 0%,#0a1628 50%,#040a14 100%)">
    <div class="sol-inner sol-hero-row">
      <div>
        <nav class="sol-bc"><a href="/">Trang chủ</a><span class="sep">›</span><span style="color:rgba(255,255,255,.9)">Hạ Tầng Bảo Mật Cao</span></nav>
        <div class="sol-tag">Bảo mật & Hạ tầng</div>
        <h1>Hạ tầng bảo mật cao<br>mã hóa end-to-end — <em style="color:#22D3EE;font-style:normal">phòng thủ đa lớp</em></h1>
        <p>Kiến trúc bảo mật nhiều lớp với mã hóa AES-256, xác thực đa yếu tố và hệ thống giám sát 24/7 — dữ liệu doanh nghiệp được bảo vệ tuyệt đối, lưu trữ tại Việt Nam.</p>
        <div class="sol-btns">
          <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">🚀 Dùng thử miễn phí <span class="cta-arrow">→</span></a>
          <a href="#vi-du" class="sol-btn-out">Xem ví dụ thực tế ↓</a>
        </div>
        <div style="display:flex;gap:24px;margin-top:28px;flex-wrap:wrap">
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#22D3EE">AES-256</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Mã hóa</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#22D3EE">99.9%</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Uptime</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#22D3EE">ISO</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">27001 chuẩn</div></div>
          <div style="text-align:center"><div style="font-size:1.8rem;font-weight:900;color:#22D3EE">VN</div><div style="font-size:.75rem;color:rgba(255,255,255,.65)">Lưu trữ trong nước</div></div>
        </div>
      </div>
      <div class="sol-hero-img"><img src="/anhlogo/anh3.png" alt="Hạ tầng bảo mật ViAI" /></div>
    </div>
  </section>

  <section class="sec sec-alt">
    <div class="sec-inner">
      <div class="feat-row">
        <div class="feat-img-area feat-img-dark">
          <img src="/anhlogo/congnghe3.png" alt="Hạ tầng bảo mật ViAI" style="mix-blend-mode:normal;object-fit:contain;padding:16px" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Giới thiệu</div>
          <h2 class="sec-h2">Bảo mật nhiều lớp — dữ liệu an toàn từ điểm đầu đến điểm cuối</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">Khi doanh nghiệp triển khai AI Agent, dữ liệu khách hàng — tên, số điện thoại, lịch sử mua hàng, tài chính — đều đi qua hệ thống. ViAI xây dựng hạ tầng bảo mật theo mô hình Defense-in-Depth: nhiều lớp phòng thủ độc lập, một lớp bị vượt qua thì các lớp sau vẫn chặn được. Không có điểm thất bại đơn lẻ nào có thể đánh sập toàn bộ hệ thống.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">Toàn bộ dữ liệu được mã hóa AES-256 cả khi lưu trữ lẫn khi truyền tải — chuẩn mã hóa được Bộ Quốc phòng Mỹ và ngân hàng thế giới tin dùng. Hệ thống lưu trữ đặt tại data center Việt Nam đạt chuẩn Tier III, tuân thủ Nghị định 13/2023/NĐ-CP về bảo vệ dữ liệu cá nhân.</p>
          <ul class="feat-list">
            <li>Mã hóa AES-256: bảo vệ dữ liệu cả khi lưu trữ lẫn truyền tải qua mạng</li>
            <li>Zero-trust architecture: mọi request đều được xác thực, không tin mặc định</li>
            <li>Data center Tier III tại Việt Nam: tuân thủ pháp luật, không chuyển dữ liệu ra nước ngoài</li>
            <li>Backup tự động mỗi 6 giờ: dữ liệu không bao giờ bị mất dù có sự cố</li>
            <li>Tuân thủ NĐ 13/2023: đầy đủ cam kết bảo vệ dữ liệu cá nhân theo luật Việt Nam</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="sec">
    <div class="sec-inner">
      <div class="feat-row rev">
        <div class="feat-img-area feat-img-dark">
          <img src="/anhlogo/congnghe6.png" alt="Khả năng bảo mật ViAI" style="mix-blend-mode:normal;object-fit:contain;padding:16px" />
        </div>
        <div class="feat-text-area">
          <div class="sec-label">Khả năng bảo vệ</div>
          <h2 class="sec-h2">Giám sát 24/7 — phát hiện và chặn mọi mối đe dọa tự động</h2>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:16px">Hệ thống AI Security của ViAI giám sát liên tục 24/7 toàn bộ luồng truy cập và hành vi trong hệ thống. Mọi bất thường — đăng nhập từ IP lạ, truy xuất dữ liệu bất thường, lượng request tăng đột biến — đều bị phát hiện trong vài giây và kích hoạt quy trình phản ứng tự động: chặn truy cập, cảnh báo admin và ghi nhật ký toàn bộ.</p>
          <p style="color:#475569;font-size:.95rem;line-height:1.75;margin-bottom:20px">Kiểm soát phân quyền chi tiết cho phép doanh nghiệp quy định chính xác ai được xem gì, làm gì trong hệ thống. Nhân viên bán hàng chỉ thấy dữ liệu khách của mình, kế toán chỉ truy cập được báo cáo tài chính, admin mới có quyền cấu hình Agent. Toàn bộ hành động được ghi audit log đầy đủ theo chuẩn ISO 27001.</p>
          <ul class="feat-list">
            <li>AI threat detection: phát hiện tấn công brute-force, SQL injection, anomaly trong &lt;5 giây</li>
            <li>Phân quyền theo vai trò: RBAC chi tiết, mỗi user chỉ thấy đúng dữ liệu cần thiết</li>
            <li>Audit log đầy đủ: mọi hành động đều được ghi lại, không thể xóa hay sửa</li>
            <li>2FA bắt buộc: xác thực hai yếu tố cho mọi tài khoản admin</li>
            <li>Penetration testing định kỳ: đội security ViAI kiểm tra lỗ hổng mỗi quý</li>
          </ul>
        </div>
      </div>
    </div>
  </section>

  <section class="sec sec-alt" id="vi-du">
    <div class="sec-inner">
      <div class="sec-label">Ví dụ thực tế</div>
      <h2 class="sec-h2">Hệ thống phát hiện và chặn tấn công trong 3 giây — không cần admin can thiệp</h2>
      <p class="sec-sub">Sự cố bảo mật thực tế — hệ thống AI xử lý tự động hoàn toàn</p>
      <div class="ex-wrap">
        <div class="ex-label">📍 Công ty logistics — 03:41 sáng thứ Sáu</div>
        <div class="ex-flow">
          <div class="ex-step"><div class="ex-avatar">⚠️</div><div class="ex-bubble"><div class="ex-role">Hệ thống phát hiện · 03:41:07</div><div class="ex-msg">Cảnh báo: 847 lần đăng nhập thất bại từ IP <strong>103.x.x.x</strong> (Singapore) trong 60 giây — nghi ngờ brute-force attack</div></div></div>
          <div class="ex-step"><div class="ex-avatar">🛡️</div><div class="ex-bubble ai"><div class="ex-role">AI Security · 0 giây tự động</div><div class="ex-msg">✅ Đã chặn IP 103.x.x.x — thêm vào blacklist tự động. Kích hoạt rate limiting toàn hệ thống. Đóng tạm session đăng nhập từ nước ngoài.</div></div></div>
          <div class="ex-step"><div class="ex-avatar">📱</div><div class="ex-bubble ai"><div class="ex-role">Zalo Admin · 03:41:10</div><div class="ex-msg">🚨 Cảnh báo bảo mật: phát hiện brute-force từ IP Singapore lúc 03:41. Đã chặn tự động. Audit log đầy đủ tại dashboard. Anh xem xét không cần can thiệp gấp.</div></div></div>
          <div class="ex-step"><div class="ex-avatar">📋</div><div class="ex-bubble ai"><div class="ex-role">Audit Log · tự động ghi nhận</div><div class="ex-msg">Event #AUD-9923: Brute-force detected | IP: 103.x.x.x | Attempts: 847 | Action: AUTO-BLOCK | Duration: 3s | Data breach: NONE | Status: RESOLVED ✅</div></div></div>
        </div>
        <div class="ex-results">
          <div class="ex-result-item"><span class="ex-result-num">3s</span><span class="ex-result-lbl">Phát hiện & chặn</span></div>
          <div class="ex-result-item"><span class="ex-result-num">Tự động</span><span class="ex-result-lbl">Không cần admin</span></div>
          <div class="ex-result-item"><span class="ex-result-num">Real-time</span><span class="ex-result-lbl">Cảnh báo tức thì</span></div>
          <div class="ex-result-item"><span class="ex-result-num">0 byte</span><span class="ex-result-lbl">Dữ liệu bị rò</span></div>
        </div>
      </div>
    </div>
  </section>

  <div class="cta-band">
    <div><h2>Bảo vệ dữ liệu doanh nghiệp với hạ tầng bảo mật cấp cao</h2><p>7 ngày dùng thử miễn phí — đội ViAI hỗ trợ cài đặt 1-1, không cần thẻ tín dụng.</p></div>
    <div class="cta-btns">
      <a href="/dung-thu.html" class="sol-btn-main cta-pulse cta-shimmer cta-glow">🚀 Dùng thử miễn phí</a>
      <a href="/bao-mat-doanh-nghiep" class="sol-btn-out" style="border-color:rgba(255,255,255,.4)">Xem bảo mật doanh nghiệp →</a>
    </div>
  </div>
  ${renderSolutionFooter()}
  ${renderSiteToolbarScript()}
</body>
</html>`;
}

// ── Routes cho 3 trang giải pháp ─────────────────────
app.get('/phan-mem', async (_req, res) => { res.setHeader('Content-Type','text/html;charset=utf-8'); res.send(await renderPhanMem()); });
app.get('/dich-vu',  async (_req, res) => { res.setHeader('Content-Type','text/html;charset=utf-8'); res.send(await renderDichVu()); });
app.get('/dao-tao',  async (_req, res) => { res.setHeader('Content-Type','text/html;charset=utf-8'); res.send(await renderDaoTao()); });
app.get('/nen-tang-ai-agent',   async (_req, res) => { res.setHeader('Content-Type','text/html;charset=utf-8'); res.send(await renderNenTang()); });
app.get('/tich-hop-50-nen-tang', async (_req, res) => { res.setHeader('Content-Type','text/html;charset=utf-8'); res.send(await renderTichHop()); });
app.get('/bao-mat-doanh-nghiep', async (_req, res) => { res.setHeader('Content-Type','text/html;charset=utf-8'); res.send(await renderBaoMat()); });
app.get('/ai-agent-thong-minh', async (_req, res) => { res.setHeader('Content-Type','text/html;charset=utf-8'); res.send(await renderAiAgent()); });
app.get('/kien-truc-api-mo',    async (_req, res) => { res.setHeader('Content-Type','text/html;charset=utf-8'); res.send(await renderKienTrucApi()); });
app.get('/ha-tang-bao-mat-cao', async (_req, res) => { res.setHeader('Content-Type','text/html;charset=utf-8'); res.send(await renderHaTang()); });

app.get('/cong-cu', (_req, res) => res.redirect('/#products'));

app.get('/cong-cu/:slug', async (req, res) => {
  const product = PRODUCT_DETAIL_BY_SLUG[req.params.slug];
  if (!product) return res.status(404).sendFile(path.join(__dirname, '404.html'));
  res.send(await renderProductDetailPage(product));
});

// API endpoint cho trang chủ fetch bài viết thật từ DB
app.get('/api/blog-posts', async (_req, res) => {
  try {
    const posts = await db.prepare("SELECT id,title,excerpt,image_url,category,author,slug,published_at FROM blog_posts WHERE active=1 ORDER BY published_at DESC LIMIT 20").all();
    res.json(posts);
  } catch (err) {
    res.status(500).json([]);
  }
});

app.get('/blog', async (_req, res) => {
  const posts = await db.prepare("SELECT id,title,excerpt,image_url,category,author,slug,published_at FROM blog_posts WHERE active=1 ORDER BY published_at DESC").all();
  const siteUrl = SITE_URL;
  res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Blog – Kiến thức AI Agent cho doanh nghiệp | ViAI</title>
  <meta name="description" content="Kiến thức thực tế về AI Agent, tự động hóa và chuyển đổi số cho doanh nghiệp Việt Nam. Hướng dẫn, tin tức và case study từ ViAI."/>
  <link rel="canonical" href="${siteUrl}/blog"/>
  <link rel="icon" href="/anhlogo/logo2.png"/>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    :root{--primary:#1A56DB;--primary-dark:#1040B0;--primary-light:#4B82F4;--accent:#FF6B00;--gray-50:#EEF3FF;--gray-100:#DBEAFE;--gray-300:#6B93E8;--gray-600:#1E3A8A;--gray-900:#0F172A}
    html{scroll-behavior:smooth}
    body{font-family:'Be Vietnam Pro',Arial,sans-serif;background:#f0f4f8;color:#0f172a;line-height:1.75;overflow-x:hidden}
    a{text-decoration:none;color:inherit}
    /* ── PAGE ── */
    .blog-hero{background:linear-gradient(135deg,#0F172A 0%,#1A56DB 60%,#FF6B00 100%);padding:60px 20px;text-align:center;color:white}
    .blog-hero h1{font-size:clamp(1.8rem,3vw,2.8rem);font-weight:900;margin-bottom:12px}
    .blog-hero p{font-size:1rem;color:rgba(255,255,255,.75);max-width:560px;margin:0 auto}
    .blog-filters{max-width:1200px;margin:32px auto 0;padding:0 20px;display:flex;gap:10px;flex-wrap:wrap}
    .filter-btn{padding:7px 18px;border-radius:50px;font-size:.82rem;font-weight:700;border:1.5px solid #dbe8ff;background:white;color:var(--primary);cursor:pointer;transition:all .2s}
    .filter-btn.active,.filter-btn:hover{background:var(--primary);color:white;border-color:var(--primary)}
    .blog-wrap{max-width:1200px;margin:32px auto 80px;padding:0 20px}
    .blog-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:28px}
    .blog-card{background:white;border-radius:16px;overflow:hidden;border:1px solid #e8eef8;transition:all .25s;display:flex;flex-direction:column}
    .blog-card:hover{transform:translateY(-4px);box-shadow:0 12px 32px rgba(26,86,219,.1)}
    .blog-card-img{width:100%;height:200px;object-fit:cover;display:block;background:#EEF3FF}
    .blog-card-img-placeholder{width:100%;height:200px;background:linear-gradient(135deg,#1040B0,#1A56DB);display:flex;align-items:center;justify-content:center;font-size:2.5rem}
    .blog-card-body{padding:20px 22px 24px;flex:1;display:flex;flex-direction:column}
    .blog-cat{font-size:.72rem;font-weight:800;text-transform:uppercase;letter-spacing:1px;color:var(--accent);margin-bottom:10px}
    .blog-title{font-size:1rem;font-weight:800;color:#0f172a;line-height:1.45;margin-bottom:10px;flex:1}
    .blog-title:hover{color:var(--primary)}
    .blog-excerpt{font-size:.84rem;color:#64748b;line-height:1.7;margin-bottom:16px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
    .blog-meta{display:flex;align-items:center;justify-content:space-between;font-size:.78rem;color:#94a3b8;border-top:1px solid #f1f5f9;padding-top:14px;margin-top:auto}
    .blog-read-more{font-size:.82rem;font-weight:700;color:var(--primary)}
    .empty-state{text-align:center;padding:80px 20px;color:#94a3b8}
    .service-dropdown-all{grid-column:1/-1!important}
    .service-dropdown-all span:first-child{background:#EEF3FF!important;border-color:#dbe8ff!important}
    .ndm-wrap{position:static!important}
    .news-mega-dropdown{min-width:660px!important;padding:0!important;left:50%!important;transform:translateX(-50%) translateY(-8px)!important}
    .nav-item.ndm-wrap:hover .news-mega-dropdown,.nav-item.ndm-wrap:focus-within .news-mega-dropdown{transform:translateX(-50%) translateY(0)!important}
    .ndm-inner{display:flex;gap:0}
    .ndm-cats{width:190px;flex-shrink:0;padding:16px 12px;border-right:1px solid #f1f5f9}
    .ndm-section-label{font-size:.67rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:#94a3b8;padding:0 8px;margin-bottom:8px}
    .ndm-cat-link{display:flex;align-items:center;gap:8px;padding:9px 10px;border-radius:8px;font-size:.84rem;font-weight:600;color:#334155;transition:all .15s;text-decoration:none;cursor:pointer}
    .ndm-cat-link:hover,.ndm-cat-link.ndm-cat-active{background:#EEF3FF;color:#1A56DB}
    .ndm-cat-icon{font-size:1rem;width:20px;text-align:center;flex-shrink:0}
    .ndm-divider{width:1px;background:#f1f5f9;flex-shrink:0}
    .ndm-posts{flex:1;padding:16px 14px;display:flex;flex-direction:column;gap:10px;min-width:0}
    .ndm-posts-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}
    .ndm-post-item{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:8px;transition:all .15s;text-decoration:none;color:inherit}
    .ndm-post-item:hover{background:#f8faff}
    .ndm-post-item img{width:52px!important;height:40px!important;border-radius:5px;object-fit:cover;flex-shrink:0;background:#e2e8f0}
    .ndm-post-info{min-width:0}
    .ndm-post-title{font-size:.78rem;font-weight:700;color:#0F172A;line-height:1.35;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
    .ndm-post-item:hover .ndm-post-title{color:#1A56DB}
    .ndm-post-date{font-size:.7rem;color:#94a3b8;margin-top:3px}
    .ndm-view-all{display:flex;align-items:center;justify-content:center;padding:9px 14px;background:linear-gradient(90deg,#1A56DB,#1040B0);color:white;border-radius:8px;font-size:.82rem;font-weight:700;text-decoration:none;transition:opacity .15s;margin-top:4px}
    .ndm-view-all:hover{opacity:.88}
    @media(max-width:960px){.main-nav,.header-actions{display:none}.hamburger-btn{display:flex}}
    @media(max-width:700px){.ndm-inner{flex-direction:column}.ndm-cats{width:100%;border-right:none;border-bottom:1px solid #f1f5f9}.ndm-posts-grid{grid-template-columns:1fr}.news-mega-dropdown{min-width:320px!important;left:0!important;transform:none!important}}
    @media(max-width:640px){.blog-grid{grid-template-columns:1fr}.header-inner{padding:0 18px}}
  </style>
</head>
<body>
  ${await renderSiteToolbar('blog')}
  <div class="blog-hero">
    <h1>Blog <span style="color:#FFB800">ViAI</span></h1>
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
              <span>${escapeHtml(p.author||'ViAI Team')} · ${p.published_at ? p.published_at.slice(0,10) : ''}</span>
              <span class="blog-read-more">Đọc thêm →</span>
            </div>
          </div>
        </a>`).join('')}
    </div>`}
  </div>

  ${renderSolutionFooter()}
  ${renderSiteToolbarScript()}
  <script>
    function filterCat(cat, el) {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      if (el) el.classList.add('active');
      document.querySelectorAll('.blog-card').forEach(card => {
        card.style.display = (cat === 'all' || card.dataset.cat === cat) ? '' : 'none';
      });
      const count = [...document.querySelectorAll('.blog-card')].filter(c => c.style.display !== 'none').length;
      const empty = document.getElementById('blog-empty');
      if (empty) empty.style.display = count === 0 ? '' : 'none';
    }

    // Khi ở trang /blog: click danh mục trong nav dropdown → filter tại chỗ
    window.__blogFilterCat = function(e, cat) {
      e.preventDefault();
      const btn = [...document.querySelectorAll('.filter-btn')].find(b => b.textContent.trim() === cat);
      filterCat(cat, btn || null);
      history.pushState(null, '', '/blog?cat=' + encodeURIComponent(cat));
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return false;
    };

    // Đọc ?cat= từ URL khi load trang
    const _urlCat = new URLSearchParams(location.search).get('cat');
    if (_urlCat) {
      const _btn = [...document.querySelectorAll('.filter-btn')].find(b => b.textContent.trim() === _urlCat);
      filterCat(_urlCat, _btn || null);
    }
  </script>
</body>
</html>`);
});

app.get('/blog/:slug', async (req, res) => {
  const post = await db.prepare('SELECT * FROM blog_posts WHERE slug = ? AND active = 1').get(req.params.slug);
  if (!post) return res.status(404).sendFile(path.join(__dirname, '404.html'));
  res.send(await renderBlogPage(post));
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
  res.send(await renderProductPage(product, detail, related));
});

// ── Dynamic pages từ DB ────────────────────────────────
app.get('/:slug([a-z0-9][a-z0-9-]*)', async (req, res, next) => {
  try {
    const page = await db.prepare('SELECT * FROM pages WHERE slug=? AND active=1').get(req.params.slug);
    if (!page) return next();
    const toolbar = await renderSiteToolbar();
    const footer  = renderSolutionFooter();
    res.setHeader('Content-Type', 'text/html;charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="vi">
<head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>${escapeHtml(page.seo_title || page.title)}</title>
  <meta name="description" content="${escapeHtml(page.meta_desc || '')}"/>
  <link rel="canonical" href="${SITE_URL}/${escapeHtml(page.slug)}"/>
  <meta property="og:title" content="${escapeHtml(page.seo_title || page.title)}"/>
  <meta property="og:description" content="${escapeHtml(page.meta_desc || '')}"/>
  <meta property="og:url" content="${SITE_URL}/${escapeHtml(page.slug)}"/>
  <link rel="icon" href="/anhlogo/logo2.png"/>
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin/>
  <link href="https://fonts.googleapis.com/css2?family=Be+Vietnam+Pro:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet"/>
  ${renderSolutionCSS()}
  <style>
    .dyn-page{max-width:960px;margin:0 auto;padding:40px 20px 80px}
    .page-hero{background:linear-gradient(135deg,#0A1F6E 0%,#1A56DB 100%);color:white;padding:60px 40px;border-radius:20px;margin-bottom:40px}
    .page-hero h1{font-size:clamp(1.6rem,4vw,2.4rem);font-weight:800;margin-bottom:14px}
    .page-hero p{font-size:1.05rem;opacity:.88;line-height:1.7;max-width:640px}
    .page-section{margin-bottom:40px}
    .page-section h2{font-size:1.4rem;font-weight:800;color:#0A1F6E;margin-bottom:20px}
    .benefit-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:20px}
    .benefit-card{background:#F8FAFF;border:1.5px solid #e2e8f0;border-radius:14px;padding:24px;transition:box-shadow .2s}
    .benefit-card:hover{box-shadow:0 4px 20px rgba(26,86,219,.12)}
    .benefit-card .bc-icon{font-size:2rem;margin-bottom:10px}
    .benefit-card h3{font-size:1rem;font-weight:700;color:#0A1F6E;margin-bottom:6px}
    .benefit-card p{font-size:.88rem;color:#475569;line-height:1.6}
    .feature-list{display:flex;flex-direction:column;gap:10px;padding:0;list-style:none}
    .feature-list li{display:flex;align-items:flex-start;gap:10px;padding:12px 16px;background:#F8FAFF;border-radius:10px;font-size:.92rem;color:#334155}
    .feature-list li::before{content:'✓';color:#1A56DB;font-weight:900;flex-shrink:0;margin-top:1px}
    .cta-section{background:linear-gradient(135deg,#FF6B00,#ff8c00);border-radius:16px;padding:40px;text-align:center;color:white}
    .cta-section h2{font-size:1.5rem;font-weight:800;margin-bottom:8px}
    .cta-section p{opacity:.9;margin-bottom:24px}
    .cta-btn{display:inline-block;background:white;color:#FF6B00;padding:14px 32px;border-radius:50px;font-weight:800;font-size:1rem;text-decoration:none;transition:transform .2s,box-shadow .2s}
    .cta-btn:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.2)}
    .dyn-bc{font-size:.82rem;color:#94a3b8;margin-bottom:24px}
    .dyn-bc a{color:#1A56DB;text-decoration:none}
    .dyn-bc a:hover{text-decoration:underline}
  </style>
</head>
<body>
  ${toolbar}
  <div class="dyn-page">
    <nav class="dyn-bc"><a href="/">Trang chủ</a> › <span>${escapeHtml(page.title)}</span></nav>
    ${page.content || `<div style="text-align:center;padding:80px 20px;color:#94a3b8"><h2>${escapeHtml(page.title)}</h2><p>Nội dung đang được cập nhật...</p></div>`}
  </div>
  ${footer}
  ${renderSolutionFooterScript ? renderSolutionFooterScript() : ''}
  ${renderSiteToolbarScript()}
</body>
</html>`);
  } catch(e) { next(e); }
});

// 404 — bắt tất cả route không khớp
app.use((_req, res) =>
  res.status(404).sendFile(path.join(__dirname, '404.html'))
);

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  initDb().then(() => {
    app.listen(PORT, () => {
      console.log(`ViAI CMS running → http://localhost:${PORT}`);
      try { tg.sendMessage('🚀 <b>ViAI Server đã khởi động!</b>'); } catch {}
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
