const express = require('express');
const router  = express.Router();
const db      = require('../db');
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const SECRET  = process.env.JWT_SECRET || 'viai-fallback-change-me';

const PRODUCT_DETAIL_LINKS = {
  'Zalo Sales Agent':        '/san-pham/zalo-sales-agent',
  'Order Management Agent':  '/san-pham/order-management-agent',
  'CRM Automation Agent':    '/san-pham/crm-automation-agent',
  'Report & Analytics Agent':'/san-pham/report-analytics-agent',
  'Email Marketing Agent':   '/san-pham/email-marketing-agent',
  'Facebook Ads Agent':      '/san-pham/facebook-ads-agent',
  'Booking & Appointment':   '/san-pham/booking-appointment',
  'Custom Enterprise Agent': '/san-pham/custom-enterprise-agent',
};

// ── Auth middleware cho user ──────────────────────────
function userAuth(req, res, next) {
  const token = (req.headers['authorization']||'').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });
  try { req.user = jwt.verify(token, SECRET); next(); }
  catch { res.status(401).json({ error: 'Token không hợp lệ' }); }
}

// ── Đăng ký khách hàng ────────────────────────────────
router.post('/auth/register', (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !password || (!email && !phone))
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });
  try {
    const exists = db.prepare('SELECT id FROM users WHERE email=? OR phone=?').get(email||'', phone||'');
    if (exists) return res.status(400).json({ error: 'Email hoặc số điện thoại đã được đăng ký' });
    const hash = bcrypt.hashSync(password, 10);
    const sourcePage = req.headers['referer'] ? new URL(req.headers['referer']).pathname : null;
    const r = db.prepare('INSERT INTO users (name,email,phone,password_hash,source_page) VALUES (?,?,?,?,?)').run(name, email||null, phone||null, hash, sourcePage);
    const token = jwt.sign({ id: r.lastInsertRowid, name }, SECRET, { expiresIn: '30d' });
    res.json({ token, name });
  } catch (err) { res.status(500).json({ error: "Lỗi máy chủ, vui lòng thử lại." }); }
});

// ── Lấy thông tin cá nhân ────────────────────────────
router.get('/auth/me', userAuth, (req, res) => {
  const u = db.prepare('SELECT id,name,email,phone,created_at FROM users WHERE id=?').get(req.user.id);
  if (!u) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  res.json(u);
});

// ── Cập nhật thông tin ────────────────────────────────
router.put('/auth/update', userAuth, (req, res) => {
  const { name, phone, email } = req.body;
  if (!name) return res.status(400).json({ error: 'Tên không được để trống' });
  db.prepare('UPDATE users SET name=?,phone=?,email=? WHERE id=?').run(name, phone||null, email||null, req.user.id);
  res.json({ success: true });
});

// ── Đổi mật khẩu ─────────────────────────────────────
router.put('/auth/change-password', userAuth, (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(oldPassword, u.password_hash))
    return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng' });
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 6 ký tự' });
  db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), req.user.id);
  res.json({ success: true });
});

// ── Đăng nhập khách hàng ──────────────────────────────
router.post('/auth/login', (req, res) => {
  const { emailOrPhone, password } = req.body;
  if (!emailOrPhone || !password)
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });
  try {
    const user = db.prepare('SELECT * FROM users WHERE email=? OR phone=?').get(emailOrPhone, emailOrPhone);
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Sai thông tin đăng nhập' });
    const token = jwt.sign({ id: user.id, name: user.name }, SECRET, { expiresIn: '30d' });
    try { db.prepare("UPDATE users SET last_login=datetime('now') WHERE id=?").run(user.id); } catch {}
    res.json({ token, name: user.name });
  } catch (err) { res.status(500).json({ error: "Lỗi máy chủ, vui lòng thử lại." }); }
});

router.get('/products', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY order_index ASC').all();
    rows.forEach(row => {
      if (PRODUCT_DETAIL_LINKS[row.name]) row.link = PRODUCT_DETAIL_LINKS[row.name];
    });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Lỗi máy chủ, vui lòng thử lại." });
  }
});

router.get('/news', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM news_posts WHERE active = 1 ORDER BY published_at DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Lỗi máy chủ, vui lòng thử lại." });
  }
});

router.get('/blog-posts', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM blog_posts WHERE active = 1 ORDER BY published_at DESC').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Lỗi máy chủ, vui lòng thử lại." });
  }
});

router.get('/why', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM why_items WHERE active=1 ORDER BY order_index ASC').all()); }
  catch (err) { res.status(500).json({ error: "Lỗi máy chủ, vui lòng thử lại." }); }
});

router.get('/how-steps', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM how_steps WHERE active=1 ORDER BY order_index ASC').all();
    rows.forEach(r => { r.features = JSON.parse(r.features||'[]'); r.mockup_bars = JSON.parse(r.mockup_bars||'[]'); });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: "Lỗi máy chủ, vui lòng thử lại." }); }
});

router.get('/tech', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM tech_items WHERE active=1 ORDER BY order_index ASC').all()); }
  catch (err) { res.status(500).json({ error: "Lỗi máy chủ, vui lòng thử lại." }); }
});

router.get('/gallery', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM gallery_images WHERE active=1 ORDER BY order_index ASC').all()); }
  catch (err) { res.status(500).json({ error: "Lỗi máy chủ, vui lòng thử lại." }); }
});

// Form liên hệ từ trang chủ gửi vào
router.post('/contact', (req, res) => {
  try {
    const { name, phone, email, company, message } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Vui lòng nhập họ tên và số điện thoại' });
    const db2 = require('../db');
    const r = db2.prepare(
      'INSERT INTO customers (name, phone, email, company, message, source) VALUES (?,?,?,?,?,?)'
    ).run(name, phone, email||'', company||'', message||'', 'website');
    const tg = require('../telegram');
    tg.sendMessage(
      `📩 <b>Khách hàng mới!</b>\n👤 <b>${name}</b>\n📞 ${phone}${email?'\n📧 '+email:''}${company?'\n🏢 '+company:''}\n💬 ${message||'Không có tin nhắn'}`
    );
    res.json({ success: true, id: r.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: "Lỗi máy chủ, vui lòng thử lại." });
  }
});

module.exports = router;
