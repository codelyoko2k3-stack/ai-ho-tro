const https = require('https');

const TOKEN   = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.TELEGRAM_CHAT_ID;

function sendMessage(text) {
  if (!TOKEN || !CHAT_ID) return;
  const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: 'HTML' });
  const req = https.request({
    hostname: 'api.telegram.org',
    path: `/bot${TOKEN}/sendMessage`,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  });
  req.on('error', (err) => console.warn('Telegram notification failed:', err.message));
  req.write(body);
  req.end();
}

function notifyNewProduct(name, category) {
  sendMessage(`🤖 <b>Sản phẩm mới!</b>\n📦 <b>${name}</b>\n🏷️ Danh mục: ${category}`);
}

function notifyNewNews(title, source) {
  sendMessage(`📰 <b>Tin tức mới!</b>\n📝 ${title}\n🔗 Nguồn: ${source}`);
}

function notifyNewWhy(title) {
  sendMessage(`✅ <b>Lý do mới được thêm:</b>\n${title}`);
}

async function sendDailyReport(db) {
  try {
    const [products, news, gallery, why] = await Promise.all([
      db.prepare('SELECT COUNT(*) as c FROM products WHERE active=1').get(),
      db.prepare('SELECT COUNT(*) as c FROM news_posts WHERE active=1').get(),
      db.prepare('SELECT COUNT(*) as c FROM gallery_images WHERE active=1').get(),
      db.prepare('SELECT COUNT(*) as c FROM why_items WHERE active=1').get(),
    ]);
    sendMessage(
      `📊 <b>Báo cáo VIAi – ${new Date().toLocaleDateString('vi-VN')}</b>\n\n` +
      `📦 Sản phẩm: <b>${products.c}</b>\n` +
      `📰 Tin tức: <b>${news.c}</b>\n` +
      `🖼️ Thư viện ảnh: <b>${gallery.c}</b>\n` +
      `✅ Lý do chọn VIAi: <b>${why.c}</b>\n\n` +
      `🌐 Admin: https://phanmemaiagent.net/admin`
    );
  } catch {}
}

module.exports = { sendMessage, notifyNewProduct, notifyNewNews, notifyNewWhy, sendDailyReport };
