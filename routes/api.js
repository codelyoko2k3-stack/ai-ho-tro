const express    = require('express');
const router     = express.Router();
const { db }     = require('../db');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const crypto     = require('crypto');
const nodemailer = require('nodemailer');
const rateLimit  = require('express-rate-limit');
const SECRET     = process.env.JWT_SECRET || 'viai-fallback-change-me';

// Rate limiter: tối đa 5 lần đăng ký / IP / giờ
const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Quá nhiều lần đăng ký. Vui lòng thử lại sau 60 phút.' },
});

// Rate limiter: tối đa 10 lần verify OTP / IP / giờ
const otpLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: { error: 'Quá nhiều lần xác thực. Vui lòng thử lại sau.' },
});

function getMailer() {
  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS },
  });
}

function otpEmailHtml(name, otp) {
  return `<!DOCTYPE html><html><head><meta charset="UTF-8"/></head>
<body style="font-family:'Segoe UI',Arial,sans-serif;background:#f0f4f8;padding:40px 20px;margin:0">
  <div style="max-width:480px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.1)">
    <div style="background:linear-gradient(135deg,#0F172A,#1A56DB);padding:32px;text-align:center">
      <h1 style="color:white;margin:0;font-size:1.6rem;font-weight:900">ViAI</h1>
      <p style="color:rgba(255,255,255,.7);margin:6px 0 0;font-size:.88rem">AI Agent for SMEs Việt Nam</p>
    </div>
    <div style="padding:32px">
      <h2 style="color:#0F172A;margin:0 0 12px;font-size:1.15rem">Xin chào ${name}! 👋</h2>
      <p style="color:#475569;line-height:1.65;margin:0 0 24px;font-size:.95rem">Mã xác thực đăng ký tài khoản ViAI của bạn:</p>
      <div style="background:#EEF3FF;border:2px dashed #1A56DB;border-radius:14px;padding:22px;text-align:center;margin:0 0 24px">
        <span style="font-size:2.6rem;font-weight:900;color:#1A56DB;letter-spacing:10px">${otp}</span>
      </div>
      <p style="color:#64748b;font-size:.84rem;line-height:1.65;margin:0 0 6px">⏱️ Mã có hiệu lực trong <strong>10 phút</strong></p>
      <p style="color:#64748b;font-size:.84rem;line-height:1.65;margin:0 0 6px">🔒 Không chia sẻ mã này với bất kỳ ai</p>
      <p style="color:#64748b;font-size:.84rem;line-height:1.65;margin:0">Nếu bạn không thực hiện đăng ký, hãy bỏ qua email này.</p>
    </div>
    <div style="background:#f8faff;padding:16px 32px;text-align:center;border-top:1px solid #e8eef8">
      <p style="color:#94a3b8;font-size:.76rem;margin:0">© 2026 ViAI Technology · phanmemaiagent.net</p>
    </div>
  </div>
</body></html>`;
}

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

function userAuth(req, res, next) {
  const token = (req.headers['authorization']||'').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });
  try { req.user = jwt.verify(token, SECRET); next(); }
  catch { res.status(401).json({ error: 'Token không hợp lệ' }); }
}

router.post('/auth/register', registerLimiter, async (req, res) => {
  const { name, email, phone, password } = req.body;
  if (!name || !password || (!email && !phone))
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });
  if (password.length < 6)
    return res.status(400).json({ error: 'Mật khẩu phải có ít nhất 6 ký tự' });
  try {
    const exists = await db.prepare('SELECT id FROM users WHERE email=? OR phone=?').get(email||'', phone||'');
    if (exists) return res.status(400).json({ error: 'Email hoặc số điện thoại đã được đăng ký' });

    const hash     = bcrypt.hashSync(password, 10);
    const otp      = Math.floor(100000 + Math.random() * 900000).toString();
    const token    = crypto.randomUUID();
    const expiresAt = Date.now() + 10 * 60 * 1000;
    const userData = JSON.stringify({ name, email: email||null, phone: phone||null, password_hash: hash });

    // Xóa OTP cũ nếu có (cùng email/phone)
    await db.prepare('DELETE FROM otp_verifications WHERE target=?').run(email || phone);

    await db.prepare(
      'INSERT INTO otp_verifications (token,target,target_type,otp,user_data,expires_at) VALUES (?,?,?,?,?,?)'
    ).run(token, email||phone, email ? 'email' : 'phone', otp, userData, expiresAt);

    // Gửi OTP qua email nếu có email và cấu hình SMTP
    if (email && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      try {
        await getMailer().sendMail({
          from: `"ViAI" <${process.env.EMAIL_USER}>`,
          to: email,
          subject: `[ViAI] Mã xác thực đăng ký: ${otp}`,
          html: otpEmailHtml(name, otp),
        });
      } catch (mailErr) {
        console.error('Gửi email OTP thất bại:', mailErr.message);
        // Fallback: tạo tài khoản ngay nếu không gửi được mail
        const sourcePage = req.headers['referer'] ? new URL(req.headers['referer']).pathname : null;
        const r = await db.prepare('INSERT INTO users (name,email,phone,password_hash,source_page) VALUES (?,?,?,?,?)').run(name, email||null, phone||null, hash, sourcePage);
        const jwtToken = jwt.sign({ id: r.lastInsertRowid, name }, SECRET, { expiresIn: '30d' });
        return res.json({ token: jwtToken, name });
      }
      const maskedEmail = email.replace(/(.{2})(.*)(@.*)/, (_, a, b, c) => a + '*'.repeat(Math.max(1, b.length)) + c);
      return res.json({ step: 'verify', token, target: maskedEmail, targetType: 'email' });
    }

    // Phone-only hoặc chưa cấu hình email: tạo tài khoản ngay
    const sourcePage = req.headers['referer'] ? new URL(req.headers['referer']).pathname : null;
    const r = await db.prepare('INSERT INTO users (name,email,phone,password_hash,source_page) VALUES (?,?,?,?,?)').run(name, email||null, phone||null, hash, sourcePage);
    const jwtToken = jwt.sign({ id: r.lastInsertRowid, name }, SECRET, { expiresIn: '30d' });
    res.json({ token: jwtToken, name });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' });
  }
});

router.post('/auth/verify-otp', otpLimiter, async (req, res) => {
  const { token, otp } = req.body;
  if (!token || !otp) return res.status(400).json({ error: 'Thiếu thông tin xác thực' });
  try {
    const record = await db.prepare('SELECT * FROM otp_verifications WHERE token=?').get(token);
    if (!record) return res.status(400).json({ error: 'Phiên xác thực không tồn tại hoặc đã hết hạn' });

    if (Date.now() > Number(record.expires_at)) {
      await db.prepare('DELETE FROM otp_verifications WHERE token=?').run(token);
      return res.status(400).json({ error: 'Mã OTP đã hết hạn. Vui lòng đăng ký lại.' });
    }
    if (record.attempts >= 3) {
      await db.prepare('DELETE FROM otp_verifications WHERE token=?').run(token);
      return res.status(400).json({ error: 'Quá nhiều lần nhập sai. Vui lòng đăng ký lại.' });
    }
    if (record.otp !== otp.trim()) {
      await db.prepare('UPDATE otp_verifications SET attempts=attempts+1 WHERE token=?').run(token);
      const remaining = 2 - record.attempts;
      return res.status(400).json({ error: `Mã không đúng. Còn ${remaining} lần thử.` });
    }

    // OTP đúng → tạo user
    const ud = JSON.parse(record.user_data);
    const r  = await db.prepare('INSERT INTO users (name,email,phone,password_hash) VALUES (?,?,?,?)').run(ud.name, ud.email, ud.phone, ud.password_hash);
    await db.prepare('DELETE FROM otp_verifications WHERE token=?').run(token);

    const jwtToken = jwt.sign({ id: r.lastInsertRowid, name: ud.name }, SECRET, { expiresIn: '30d' });
    res.json({ token: jwtToken, name: ud.name });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' });
  }
});

router.post('/auth/resend-otp', otpLimiter, async (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Thiếu token' });
  try {
    const record = await db.prepare('SELECT * FROM otp_verifications WHERE token=?').get(token);
    if (!record) return res.status(400).json({ error: 'Phiên xác thực không tồn tại' });

    const ud     = JSON.parse(record.user_data);
    const newOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const newExp = Date.now() + 10 * 60 * 1000;

    await db.prepare('UPDATE otp_verifications SET otp=?,attempts=0,expires_at=? WHERE token=?').run(newOtp, newExp, token);

    if (record.target_type === 'email' && process.env.EMAIL_USER && process.env.EMAIL_PASS) {
      await getMailer().sendMail({
        from: `"ViAI" <${process.env.EMAIL_USER}>`,
        to: record.target,
        subject: `[ViAI] Mã xác thực mới: ${newOtp}`,
        html: otpEmailHtml(ud.name, newOtp),
      });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Không gửi được mã mới.' });
  }
});

router.get('/auth/me', userAuth, async (req, res) => {
  const u = await db.prepare('SELECT id,name,email,phone,created_at FROM users WHERE id=?').get(req.user.id);
  if (!u) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  res.json(u);
});

router.put('/auth/update', userAuth, async (req, res) => {
  const { name, phone, email } = req.body;
  if (!name) return res.status(400).json({ error: 'Tên không được để trống' });
  await db.prepare('UPDATE users SET name=?,phone=?,email=? WHERE id=?').run(name, phone||null, email||null, req.user.id);
  res.json({ success: true });
});

router.put('/auth/change-password', userAuth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  const u = await db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  if (!bcrypt.compareSync(oldPassword, u.password_hash))
    return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng' });
  if (newPassword.length < 6)
    return res.status(400).json({ error: 'Mật khẩu mới phải có ít nhất 6 ký tự' });
  await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(newPassword, 10), req.user.id);
  res.json({ success: true });
});

router.post('/auth/login', async (req, res) => {
  const { emailOrPhone, password } = req.body;
  if (!emailOrPhone || !password)
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });
  try {
    const user = await db.prepare('SELECT * FROM users WHERE email=? OR phone=?').get(emailOrPhone, emailOrPhone);
    if (!user || !bcrypt.compareSync(password, user.password_hash))
      return res.status(401).json({ error: 'Sai thông tin đăng nhập' });
    const token = jwt.sign({ id: user.id, name: user.name }, SECRET, { expiresIn: '30d' });
    try { await db.prepare('UPDATE users SET last_login=$1 WHERE id=$2').run(new Date().toISOString(), user.id); } catch {}
    res.json({ token, name: user.name });
  } catch (err) { res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' }); }
});

router.get('/products', async (req, res) => {
  try {
    const rows = await db.prepare('SELECT * FROM products WHERE active = 1 ORDER BY order_index ASC').all();
    rows.forEach(row => { if (PRODUCT_DETAIL_LINKS[row.name]) row.link = PRODUCT_DETAIL_LINKS[row.name]; });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' }); }
});

router.get('/news', async (req, res) => {
  try {
    const rows = await db.prepare('SELECT * FROM news_posts WHERE active = 1 ORDER BY published_at DESC').all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' }); }
});

router.get('/blog-posts', async (req, res) => {
  try {
    const rows = await db.prepare('SELECT * FROM blog_posts WHERE active = 1 ORDER BY published_at DESC').all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' }); }
});

router.get('/why', async (req, res) => {
  try { res.json(await db.prepare('SELECT * FROM why_items WHERE active=1 ORDER BY order_index ASC').all()); }
  catch (err) { res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' }); }
});

router.get('/how-steps', async (req, res) => {
  try {
    const rows = await db.prepare('SELECT * FROM how_steps WHERE active=1 ORDER BY order_index ASC').all();
    rows.forEach(r => { r.features = JSON.parse(r.features||'[]'); r.mockup_bars = JSON.parse(r.mockup_bars||'[]'); });
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' }); }
});

router.get('/tech', async (req, res) => {
  try { res.json(await db.prepare('SELECT * FROM tech_items WHERE active=1 ORDER BY order_index ASC').all()); }
  catch (err) { res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' }); }
});

router.get('/gallery', async (req, res) => {
  try { res.json(await db.prepare('SELECT * FROM gallery_images WHERE active=1 ORDER BY order_index ASC').all()); }
  catch (err) { res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' }); }
});

router.get('/pages', async (req, res) => {
  try { res.json(await db.prepare('SELECT id,title,slug,seo_title,meta_desc,source_type,active,created_at FROM pages WHERE active=1 ORDER BY created_at DESC').all()); }
  catch (err) { res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

router.get('/solution-cards', async (req, res) => {
  try { res.json(await db.prepare('SELECT * FROM solution_cards WHERE active=1 ORDER BY order_index ASC').all()); }
  catch (err) { res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' }); }
});

router.get('/feature-cards', async (req, res) => {
  try { res.json(await db.prepare('SELECT * FROM feature_cards WHERE active=1 ORDER BY order_index ASC').all()); }
  catch (err) { res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' }); }
});

router.post('/contact', async (req, res) => {
  try {
    const { name, phone, email, company, message } = req.body;
    if (!name || !phone) return res.status(400).json({ error: 'Vui lòng nhập họ tên và số điện thoại' });
    const r = await db.prepare(
      'INSERT INTO customers (name, phone, email, company, message, source) VALUES (?,?,?,?,?,?)'
    ).run(name, phone, email||'', company||'', message||'', 'website');
    const tg = require('../telegram');
    tg.sendMessage(
      `📩 <b>Khách hàng mới!</b>\n👤 <b>${name}</b>\n📞 ${phone}${email?'\n📧 '+email:''}${company?'\n🏢 '+company:''}\n💬 ${message||'Không có tin nhắn'}`
    );
    res.json({ success: true, id: r.lastInsertRowid });
  } catch (err) { res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' }); }
});

module.exports = router;
