const express   = require('express');
const router    = express.Router();
const { db }    = require('../db');
const bcrypt    = require('bcryptjs');
const jwt       = require('jsonwebtoken');
const tg        = require('../telegram');
const multer    = require('multer');
const rateLimit = require('express-rate-limit');
const speakeasy = require('speakeasy');
const QRCode    = require('qrcode');
const path      = require('path');
const fs        = require('fs');
const https     = require('https');
const http      = require('http');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) throw new Error('JWT_SECRET chưa được cấu hình trong .env');
const DEFAULT_ANTHROPIC_MODEL = 'claude-haiku-4-5-20251001';
const MIN_ANTHROPIC_KEY_LENGTH = 40;

// Rate limit riêng cho login: 10 lần/15 phút
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'Đăng nhập thất bại quá nhiều lần. Vui lòng thử lại sau 15 phút.' },
  standardHeaders: true,
  legacyHeaders: false,
});

// ── Upload setup ──────────────────────────────────────
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext  = path.extname(file.originalname).toLowerCase();
    const name = Date.now() + '-' + Math.round(Math.random() * 1e6) + ext;
    cb(null, name);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (/^image\//.test(file.mimetype)) cb(null, true);
    else cb(new Error('Chỉ cho phép upload ảnh'));
  }
});

function auth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });
  try { req.user = jwt.verify(token, SECRET); next(); }
  catch { res.status(401).json({ error: 'Token không hợp lệ' }); }
}

function cleanEnvValue(name) {
  let value = String(process.env[name] || '').trim();
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1).trim();
  }
  return value;
}

function createAiConfigError(message, statusCode = 503) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.aiConfigError = true;
  return err;
}

function getAnthropicApiKey() {
  const apiKey = cleanEnvValue('ANTHROPIC_API_KEY') || cleanEnvValue('CLAUDE_API_KEY');
  if (!apiKey) {
    throw createAiConfigError('Chưa cấu hình ANTHROPIC_API_KEY trong .env');
  }
  if (!apiKey.startsWith('sk-ant-') || apiKey.length < MIN_ANTHROPIC_KEY_LENGTH) {
    throw createAiConfigError('ANTHROPIC_API_KEY không hợp lệ hoặc bị thiếu ký tự', 401);
  }
  return apiKey;
}

function shouldUseTemplateFallback(err) {
  const mode = cleanEnvValue('AI_FALLBACK_MODE').toLowerCase();
  return mode !== 'off' && (err?.aiConfigError || /invalid x-api-key/i.test(err?.message || ''));
}

function toSlug(text) {
  return String(text || 'ViAI-ai-ho-tro')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'ViAI-ai-ho-tro';
}

function normalizeBrandText(text) {
  return String(text || '')
    .replace(/\bViAI\b/gi, 'ViAI')
    .replace(/\bai\b/g, 'AI')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanRepeatedSeoText(text) {
  return normalizeBrandText(text)
    .replace(/(ViAI\s+hỗ trợ)\s+hỗ trợ/gi, '$1')
    .replace(/hỗ trợ\s+hỗ trợ/gi, 'hỗ trợ')
    .replace(/(AI\s+hỗ trợ)\s+hỗ trợ/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTopicSubject(text, fallback = 'bán hàng') {
  let value = cleanRepeatedSeoText(text || fallback);
  value = value
    .replace(/^ViAI\s*[:\-]?\s*/i, '')
    .replace(/^AI\s+hỗ trợ\s+/i, '')
    .replace(/^hỗ trợ\s+/i, '')
    .replace(/^giải pháp\s+/i, '')
    .replace(/^ứng dụng\s+/i, '')
    .trim();
  return value || fallback;
}

function buildSeoTitleFromTopic(topic, fallback = 'bán hàng') {
  const subject = cleanTopicSubject(topic, fallback);
  let value = `ViAI hỗ trợ ${subject} bằng AI`;
  if (!/(doanh nghiệp|công ty|đội ngũ|kinh doanh)/i.test(subject)) {
    value += ' cho doanh nghiệp';
  }
  return cleanRepeatedSeoText(value);
}

function normalizeBrandMarkdown(text) {
  return String(text || '')
    .replace(/\bViAI\b/gi, 'ViAI')
    .replace(/\bai\b/g, 'AI')
    .trim();
}

function stripMarkdownTitle(text, title = '') {
  let value = String(text || '').replace(/^\s*#\s+.+(?:\r?\n)+/, '').trim();
  const expected = normalizeBrandText(title).toLowerCase();
  if (expected) {
    const lines = value.split(/\r?\n/);
    if (normalizeBrandText(lines[0]).toLowerCase() === expected) {
      value = lines.slice(1).join('\n').trim();
    }
  }
  return value;
}

function ensureSentence(text, fallback) {
  const value = cleanRepeatedSeoText(text);
  return value || fallback;
}

function ensureMetaDescription(meta, keyword, topic) {
  let value = cleanRepeatedSeoText(meta);
  if (value.length < 140) {
    const subject = cleanTopicSubject(topic || keyword || 'bán hàng', 'bán hàng');
    value = `ViAI giúp doanh nghiệp ứng dụng AI vào ${subject} để tư vấn khách hàng nhanh hơn, tự động hóa quy trình, chăm sóc khách hàng và tối ưu vận hành hiệu quả.`;
  }
  if (value.length < 140) value += ' Phù hợp đội ngũ kinh doanh tại Việt Nam.';
  if (value.length > 160) value = value.slice(0, 160).replace(/\s+\S*$/, '');
  return value;
}

function ensureSeoTitle(title, topic) {
  let value = cleanRepeatedSeoText(title);
  if (!value) value = buildSeoTitleFromTopic(topic || 'bán hàng');
  value = value.replace(/\s*\|\s*ViAI$/i, '');
  value = cleanRepeatedSeoText(value);
  if (!/\bViAI\b/.test(value)) value = `ViAI: ${value}`;
  if (
    value.length < 45 &&
    /\bbằng AI$/i.test(value) &&
    !/(doanh nghiệp|công ty|đội ngũ|kinh doanh)/i.test(value)
  ) {
    value += ' cho doanh nghiệp';
  }
  if (value.length > 60) value = value.slice(0, 60).replace(/\s+\S*$/, '');
  return value;
}

// Chuẩn hóa heading: # → ## (H1 không được xuất hiện trong body, chỉ dùng làm title bên ngoài)
function normalizeHeadings(content) {
  return String(content || '')
    .replace(/^# (?!#)/gm, '## ')   // # heading → ## heading
    .replace(/^## (?!#)/gm, '## ')  // giữ nguyên ## (no-op, for clarity)
    .replace(/^### (?!#)/gm, '### ') // giữ nguyên ###
    .replace(/^#### (?!#)/gm, '#### '); // giữ nguyên ####
}

// Cải thiện bài có sẵn: thêm ảnh sau H2, in đậm từ khóa, thêm CTA — KHÔNG sửa cấu trúc
function improveExistingContent(content, keyword, topic, sectionImages) {
  const mainKeyword = normalizeBrandText(keyword || topic || '');
  const shuffled = [...IMG_POOL].sort(() => Math.random() - 0.5);
  const userImgs = Array.isArray(sectionImages) ? sectionImages.filter(Boolean) : [];
  const imgQueue = [...userImgs, ...shuffled.filter(u => !userImgs.includes(u))];
  const usedImgs = new Set();
  let imgIdx = 0;

  function nextImg(alt) {
    while (imgIdx < imgQueue.length && usedImgs.has(imgQueue[imgIdx])) imgIdx++;
    const img = imgQueue[imgIdx] || IMG_POOL[imgIdx % IMG_POOL.length];
    usedImgs.add(img); imgIdx++;
    return `![${alt || mainKeyword}](${img})`;
  }

  // Chỉ thêm ảnh sau H2 có sẵn trong bài, KHÔNG convert plain text thành heading
  const lines = content.split('\n').map(l => l.trimEnd());
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    out.push(line);
    if (/^##\s/.test(line)) {
      let nextNonEmpty = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim()) { nextNonEmpty = lines[j].trim(); break; }
      }
      if (!nextNonEmpty.startsWith('![')) {
        const alt = line.replace(/^##\s*/, '').trim();
        out.push('');
        out.push(nextImg(alt));
      }
    }
  }

  let result = normalizeHeadings(out.join('\n'));

  // Bước 3: in đậm từ khóa chính lần đầu (nếu chưa bold)
  if (mainKeyword && mainKeyword.length > 3) {
    const escaped = mainKeyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<!\\*)(${escaped})(?!\\*)`, 'i');
    result = result.replace(re, '**$1**');
  }

  // Bước 4: thêm CTA nếu chưa có
  if (!result.includes('/dung-thu')) {
    result += `\n\n---\n\nSẵn sàng để AI làm việc thay bạn? [Dùng thử miễn phí 14 ngày](/dung-thu.html) — không cần thẻ tín dụng.`;
  }

  return result.trim();
}

function ensureBlogContent(content, title, keyword, topic, audience) {
  let value = normalizeHeadings(stripMarkdownTitle(normalizeBrandMarkdown(content), title));
  const mainTopic = normalizeBrandText(topic || keyword || 'AI hỗ trợ bán hàng');
  if (!value) {
    value = buildTemplateBlogDraft({ keyword, topic, audience }).content;
  }
  const wordCount = value.split(/\s+/).filter(Boolean).length;
  if (wordCount < 1200) {
    const extraImg1 = IMG_POOL[Math.floor(Math.random() * 10) + 10];
    const extraImg2 = IMG_POOL[Math.floor(Math.random() * 10) + 20];
    value += `

## Lợi ích khi triển khai đúng cách

![Lợi ích triển khai AI Agent đúng cách](${extraImg1})

Để AI tạo ra kết quả thực tế, doanh nghiệp nên bắt đầu từ **một quy trình cụ thể** thay vì triển khai dàn trải. Điểm khởi đầu phù hợp thường là:

- Tư vấn và phản hồi khách hàng tự động
- Nhắc lịch chăm sóc sau bán
- Tổng hợp báo cáo doanh thu hàng ngày

Khi quy trình đầu tiên vận hành ổn định, mở rộng dần sang marketing, vận hành và báo cáo quản trị. Đây là cách **giảm rủi ro** và dễ đo hiệu quả hơn so với triển khai toàn bộ cùng lúc.

## Doanh nghiệp nên chuẩn bị gì?

![Chuẩn bị trước khi triển khai AI Agent ViAI](${extraImg2})

Trước khi bắt đầu, hãy chuẩn bị:

- [ ] Danh sách sản phẩm/dịch vụ và bảng giá
- [ ] 10-20 câu hỏi khách hàng hay hỏi nhất
- [ ] Chính sách bán hàng, đổi trả, bảo hành
- [ ] Quy trình xử lý đơn hàng hiện tại
- [ ] Tài khoản Zalo OA hoặc Facebook Page

Khi dữ liệu đầu vào rõ ràng, AI phản hồi chính xác hơn và dễ đo lường hiệu quả hơn ngay từ tuần đầu.`;
  }
  return value.trim();
}

function buildTemplateExcerpt(title, excerpt) {
  const base = excerpt || 'ViAI hỗ trợ doanh nghiệp ứng dụng AI vào bán hàng, chăm sóc khách hàng và vận hành hằng ngày.';
  return `${title || 'ViAI'} giúp doanh nghiệp tận dụng AI để xử lý các công việc lặp lại nhanh hơn, từ tư vấn khách hàng đến tổng hợp dữ liệu. ${base} Giải pháp phù hợp với đội ngũ muốn bắt đầu tự động hóa mà không cần triển khai hệ thống phức tạp.`;
}

function buildTemplateSeoResult({ mode, keyword, topic, audience, intent, tone, draft }) {
  const mainKeyword = keyword || topic || 'ViAI AI hỗ trợ';
  const mainTopic = topic || keyword || 'AI hỗ trợ doanh nghiệp';
  const title = `ViAI: ${mainTopic}`;
  const slug = toSlug(mainTopic);

  if (mode === 'audit') {
    return `Lưu ý: Đây là bản kiểm tra mẫu vì server chưa có ANTHROPIC_API_KEY hợp lệ.

1. Điểm SEO /100
Điểm đề xuất: ${draft ? '72/100' : '45/100'}.
${draft ? 'Bài đã có nền nội dung để tối ưu, nhưng cần kiểm tra lại cấu trúc heading, từ khóa chính, CTA và FAQ.' : 'Bạn chưa dán nội dung bài viết, nên chỉ có thể đánh giá theo từ khóa/chủ đề.'}

2. Các lỗi quan trọng cần sửa ngay
- Làm rõ từ khóa chính: "${mainKeyword}" trong tiêu đề, đoạn mở bài và ít nhất một heading H2.
- Bổ sung CTA cuối bài để dẫn người đọc sang tư vấn, dùng thử hoặc liên hệ ViAI.
- Thêm FAQ để tăng khả năng hiển thị với truy vấn dạng câu hỏi.
- Kiểm tra lại meta description để nằm trong khoảng 140-160 ký tự.

3. Tiêu đề SEO, slug, meta description đề xuất
SEO Title: ${title}
Slug: ${slug}
Meta description: ViAI cung cấp AI hỗ trợ doanh nghiệp tự động hóa bán hàng, chăm sóc khách hàng và vận hành hiệu quả hơn.

4. Checklist
H1: Nên có đúng 1 H1 chứa chủ đề chính.
H2/H3: Nên chia theo lợi ích, cách hoạt động, ứng dụng và lý do chọn ViAI.
Mật độ từ khóa: Dùng tự nhiên, tránh lặp quá nhiều.
Internal link: Thêm link tới trang sản phẩm, bảng giá hoặc đăng ký dùng thử.
External link: Có thể dẫn tới nguồn uy tín về AI/automation nếu phù hợp.
Alt ảnh: Mô tả rõ hình ảnh và có ngữ cảnh ViAI.
FAQ: Nên có 4-5 câu hỏi ngắn.
CTA: Có lời mời hành động cụ thể ở cuối bài.

5. Đoạn mở bài tối ưu hơn
Trong bối cảnh doanh nghiệp cần phản hồi khách hàng nhanh hơn và giảm việc thủ công, ${mainKeyword} trở thành một giải pháp đáng cân nhắc. ViAI giúp đội ngũ bán hàng, marketing và vận hành ứng dụng AI vào các quy trình thực tế mà không cần bắt đầu bằng một hệ thống phức tạp.

6. FAQ nên thêm
- ViAI hỗ trợ doanh nghiệp những công việc nào?
- ViAI có phù hợp với doanh nghiệp nhỏ không?
- AI hỗ trợ có thay thế nhân viên không?
- Bao lâu có thể triển khai ViAI?
- Doanh nghiệp cần chuẩn bị gì trước khi dùng ViAI?`;
  }

  return `Lưu ý: Đây là bài viết mẫu vì server chưa có ANTHROPIC_API_KEY hợp lệ. Khi có key thật, Claude sẽ tạo nội dung linh hoạt hơn.

1. SEO Title
${title}

2. Slug URL
${slug}

3. Meta description
ViAI cung cấp AI hỗ trợ doanh nghiệp tự động hóa bán hàng, chăm sóc khách hàng và vận hành hiệu quả hơn.

4. Dàn ý H1, H2, H3
H1: ${title}
H2: AI hỗ trợ doanh nghiệp là gì?
H2: ViAI giúp gì cho bán hàng và chăm sóc khách hàng?
H2: Ứng dụng ViAI trong vận hành hằng ngày
H2: Vì sao doanh nghiệp nên cân nhắc ViAI?
H2: Kết luận và bước tiếp theo

5. Bài viết hoàn chỉnh

# ${title}

Trong bối cảnh chi phí nhân sự, quảng cáo và vận hành ngày càng tăng, nhiều doanh nghiệp Việt đang tìm kiếm một giải pháp giúp làm việc nhanh hơn nhưng không làm phức tạp hệ thống hiện tại. Đây là lý do ${mainKeyword} ngày càng được quan tâm, đặc biệt với các đội ngũ bán hàng, marketing và chăm sóc khách hàng.

ViAI được xây dựng để hỗ trợ doanh nghiệp ứng dụng AI vào các công việc thực tế. Thay vì chỉ dừng ở việc trả lời tin nhắn đơn giản, ViAI có thể hỗ trợ tư vấn khách hàng, phân loại nhu cầu, ghi nhận thông tin, tạo báo cáo và giảm bớt các thao tác lặp lại trong ngày.

## AI hỗ trợ doanh nghiệp là gì?

AI hỗ trợ doanh nghiệp là việc sử dụng trí tuệ nhân tạo để xử lý một phần công việc thường xuyên lặp lại. Ví dụ, khi khách hàng nhắn hỏi sản phẩm, AI có thể phản hồi nhanh theo dữ liệu đã được thiết lập. Khi có nhiều yêu cầu giống nhau, AI giúp đội ngũ tiết kiệm thời gian và giảm nguy cơ bỏ sót thông tin.

Điểm quan trọng là AI không nhất thiết thay thế con người. Trong nhiều trường hợp, AI đóng vai trò như một trợ lý vận hành, giúp nhân viên tập trung vào các việc cần tư duy, đàm phán hoặc xử lý tình huống phức tạp hơn.

## ViAI giúp gì cho bán hàng và chăm sóc khách hàng?

Với hoạt động bán hàng, ViAI có thể hỗ trợ phản hồi khách hàng nhanh hơn trên các kênh online. Khi khách để lại thông tin, AI có thể ghi nhận nhu cầu, đề xuất hướng tư vấn và chuyển dữ liệu cho đội ngũ phụ trách. Điều này đặc biệt hữu ích với doanh nghiệp có nhiều khách hỏi nhưng chưa đủ nhân sự trực liên tục.

Ở khâu chăm sóc khách hàng, ViAI có thể hỗ trợ nhắc lịch, gửi hướng dẫn, phân loại phản hồi và tạo kịch bản chăm sóc sau bán. Nhờ đó, doanh nghiệp giữ được sự chuyên nghiệp mà không cần tăng quá nhiều chi phí vận hành.

## Ứng dụng ViAI trong vận hành hằng ngày

Ngoài bán hàng, ViAI còn có thể hỗ trợ tổng hợp dữ liệu và báo cáo. Thay vì mất thời gian gom thông tin thủ công, doanh nghiệp có thể dùng AI để chuẩn hóa dữ liệu, tóm tắt tình hình và gợi ý các điểm cần theo dõi.

Khi dữ liệu được tổ chức tốt hơn, chủ doanh nghiệp và đội ngũ quản lý có thêm cơ sở để ra quyết định. Đây là lợi ích quan trọng của ${mainKeyword}: không chỉ làm nhanh hơn, mà còn giúp doanh nghiệp nhìn rõ hơn các điểm nghẽn trong quy trình.

## Vì sao doanh nghiệp nên cân nhắc ViAI?

ViAI phù hợp với doanh nghiệp muốn bắt đầu ứng dụng AI theo từng bước nhỏ. Thay vì triển khai một hệ thống lớn ngay từ đầu, doanh nghiệp có thể chọn một quy trình cụ thể như tư vấn khách hàng, chăm sóc sau bán hoặc báo cáo tự động. Cách tiếp cận này giúp giảm rủi ro và dễ đo hiệu quả hơn.

Với đối tượng đọc là ${audience || 'chủ doanh nghiệp và đội ngũ marketing tại Việt Nam'}, giải pháp AI cần dễ hiểu, dễ triển khai và gắn với kết quả kinh doanh thực tế. ViAI hướng tới đúng nhu cầu đó: hỗ trợ đội ngũ làm việc hiệu quả hơn mà không yêu cầu kiến thức kỹ thuật phức tạp.

## Kết luận

${mainTopic} không còn là xu hướng xa vời. Với ViAI, doanh nghiệp có thể bắt đầu tự động hóa những công việc lặp lại, phản hồi khách hàng nhanh hơn và xây dựng quy trình vận hành rõ ràng hơn. Nếu doanh nghiệp của bạn đang cân nhắc ứng dụng AI, hãy bắt đầu từ một nhu cầu cụ thể và đo hiệu quả từng bước.

CTA: Liên hệ ViAI để được tư vấn giải pháp AI hỗ trợ phù hợp với quy trình bán hàng, marketing và vận hành của doanh nghiệp bạn.

6. FAQ

ViAI có phải chatbot không?
ViAI không chỉ là chatbot. ViAI được định hướng như trợ lý AI hỗ trợ nhiều quy trình trong doanh nghiệp.

Doanh nghiệp nhỏ có dùng ViAI được không?
Có. ViAI phù hợp với doanh nghiệp vừa và nhỏ muốn bắt đầu tự động hóa từng phần công việc.

ViAI hỗ trợ những bộ phận nào?
ViAI có thể hỗ trợ bán hàng, marketing, chăm sóc khách hàng, vận hành và báo cáo.

AI có thay thế nhân viên không?
Không nhất thiết. AI giúp giảm việc lặp lại để nhân viên tập trung vào công việc quan trọng hơn.

Khi nào nên dùng ViAI?
Khi doanh nghiệp có nhiều khách hàng, nhiều tin nhắn, nhiều dữ liệu hoặc nhiều thao tác thủ công cần tối ưu.

7. Internal link anchor text
- Giải pháp AI Agent cho doanh nghiệp
- Đăng ký dùng thử ViAI
- Bảng giá ViAI

8. Alt text ảnh
- Giao diện ViAI hỗ trợ doanh nghiệp quản lý khách hàng
- AI hỗ trợ bán hàng và chăm sóc khách hàng tự động
      - Dashboard báo cáo vận hành doanh nghiệp bằng ViAI`;
}

function normalizeFaq(faq) {
  if (!Array.isArray(faq)) return [];
  return faq
    .map(item => {
      if (typeof item === 'string') return { question: item, answer: '' };
      return {
        question: String(item?.question || '').trim(),
        answer: String(item?.answer || '').trim()
      };
    })
    .filter(item => item.question)
    .slice(0, 8);
}

function normalizeBlogDraft(raw, fallbackInput = {}) {
  const keyword = fallbackInput.keyword || fallbackInput.topic || 'ViAI AI hỗ trợ';
  const topic = fallbackInput.topic || fallbackInput.keyword || 'AI hỗ trợ doanh nghiệp';
  const title = ensureSeoTitle(raw?.title || raw?.seo_title, topic);
  const content = ensureBlogContent(raw?.content || raw?.article || '', title, keyword, topic, fallbackInput.audience);
  const excerpt = ensureSentence(raw?.excerpt || raw?.summary || content.split(/\n+/).find(Boolean), `ViAI giúp doanh nghiệp ứng dụng AI vào ${cleanTopicSubject(topic, 'bán hàng')} để phản hồi khách hàng nhanh hơn, giảm việc thủ công và tối ưu vận hành.`);
  const slug = toSlug(raw?.slug || title);
  return {
    title,
    seo_title: ensureSeoTitle(raw?.seo_title || title, topic),
    slug,
    meta_description: ensureMetaDescription(raw?.meta_description, keyword, topic),
    excerpt: excerpt.slice(0, 420),
    content,
    faq: normalizeFaq(raw?.faq),
    image_prompt: normalizeBrandText(raw?.image_prompt || `Ảnh minh họa ${topic}, phong cách công nghệ AI hiện đại cho doanh nghiệp Việt Nam`),
    image_alt: normalizeBrandText(raw?.image_alt || `${topic} cùng ViAI`),
    image_url: String(raw?.image_url || 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=900&q=80').trim(),
    category: normalizeBrandText(raw?.category || 'Kiến thức AI'),
    author: normalizeBrandText(raw?.author || 'ViAI Team')
  };
}

// Pool 30 ảnh đa dạng để không bị trùng
const IMG_POOL = [
  'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=900&q=80',
  'https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=900&q=80',
  'https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=900&q=80',
  'https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=900&q=80',
  'https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=900&q=80',
  'https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=900&q=80',
  'https://images.unsplash.com/photo-1563986768609-322da13575f3?w=900&q=80',
  'https://images.unsplash.com/photo-1596526131083-e8c633c948d2?w=900&q=80',
  'https://images.unsplash.com/photo-1576091160399-112ba8d25d1d?w=900&q=80',
  'https://images.unsplash.com/photo-1553877522-43269d4ea984?w=900&q=80',
  'https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=900&q=80',
  'https://images.unsplash.com/photo-1512941937669-90a1b58e7e9c?w=900&q=80',
  'https://images.unsplash.com/photo-1559526324-4b87b5e36e44?w=900&q=80',
  'https://images.unsplash.com/photo-1664575602554-2087b04935a5?w=900&q=80',
  'https://images.unsplash.com/photo-1518770660439-4636190af475?w=900&q=80',
  'https://images.unsplash.com/photo-1499750310107-5fef28a66643?w=900&q=80',
  'https://images.unsplash.com/photo-1600880292203-757bb62b4baf?w=900&q=80',
  'https://images.unsplash.com/photo-1579389083078-4e7018379f7e?w=900&q=80',
  'https://images.unsplash.com/photo-1556742049-0cfed4f6a45d?w=900&q=80',
  'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=900&q=80',
  'https://images.unsplash.com/photo-1593642632559-0c6d3fc62b89?w=900&q=80',
  'https://images.unsplash.com/photo-1542744173-8e7e53415bb0?w=900&q=80',
  'https://images.unsplash.com/photo-1551434678-e076c223a692?w=900&q=80',
  'https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=900&q=80',
  'https://images.unsplash.com/photo-1571171637578-41bc2dd41cd2?w=900&q=80',
  'https://images.unsplash.com/photo-1573164713714-d95e436ab8d6?w=900&q=80',
  'https://images.unsplash.com/photo-1586281380349-632531db7ed4?w=900&q=80',
  'https://images.unsplash.com/photo-1504868584819-f8e8b4b6d7e3?w=900&q=80',
  'https://images.unsplash.com/photo-1555421689-491a97ff2040?w=900&q=80',
  'https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=900&q=80',
];

function buildTemplateBlogDraft(input) {
  const { keyword, topic, audience, intent, tone } = input;
  const mainKeyword = cleanRepeatedSeoText(keyword || topic || 'ViAI AI hỗ trợ');
  const mainTopic = cleanRepeatedSeoText(topic || keyword || 'AI hỗ trợ doanh nghiệp');
  const title = buildSeoTitleFromTopic(mainTopic, 'doanh nghiệp');

  // Dùng ảnh anh cung cấp, hoặc random từ pool 30 ảnh không trùng
  const userImgs = Array.isArray(input.section_images) && input.section_images.length > 0
    ? input.section_images : [];
  const shuffled = [...IMG_POOL].sort(() => Math.random() - 0.5);
  const usedUrls = new Set(userImgs);
  const freshPool = shuffled.filter(u => !usedUrls.has(u));
  const imgs = [...userImgs, ...freshPool]; // ảnh anh upload ưu tiên trước

  const content = `Mỗi ngày doanh nghiệp của bạn đang mất bao nhiêu giờ cho những công việc lặp đi lặp lại — trả lời tin nhắn, xử lý đơn hàng, tổng hợp báo cáo? Nếu câu trả lời là hơn 3 tiếng, **${mainKeyword}** chính là giải pháp bạn cần đọc hôm nay.

Nhiều chủ doanh nghiệp vừa và nhỏ tại Việt Nam đang đối mặt với bài toán quen thuộc: đội ngũ không đủ, lượng công việc ngày càng tăng, nhưng chi phí tuyển dụng lại vượt quá khả năng. Trong bối cảnh đó, ứng dụng AI vào vận hành không còn là xa xỉ — mà là lựa chọn thực tế để giữ tốc độ tăng trưởng mà không cần nhân sự thêm.

![Doanh nghiệp ứng dụng AI để tăng hiệu quả vận hành](${imgs[0]||IMG_POOL[0]})

## ${mainTopic} là gì và tại sao quan trọng?

![AI Agent hoạt động trong doanh nghiệp](${imgs[1]||IMG_POOL[1]})

**${mainTopic}** không phải chatbot trả lời theo kịch bản cố định. Đây là hệ thống AI thế hệ mới, có khả năng hiểu ngữ cảnh, học từ dữ liệu thực tế và thực hiện hành động thay con người trong quy trình kinh doanh.

### Khác biệt so với chatbot thông thường

Khác với các công cụ tự động hóa truyền thống chỉ làm theo luật cứng nhắc, AI Agent có thể:

- Hiểu ngữ cảnh hội thoại và phản hồi linh hoạt theo từng khách hàng
- Tự động thực hiện hành động: tạo đơn, gửi báo cáo, cập nhật CRM
- Kết nối đồng thời nhiều kênh: Zalo, Facebook, Website, email
- Hoạt động 24/7 không cần người trực, không mệt mỏi, không sai sót

### Tại sao AI học ngày càng thông minh hơn?

Điều khiến AI Agent trở nên quan trọng là khả năng **học và cải thiện theo thời gian**. Càng nhiều dữ liệu tương tác, hệ thống càng phản hồi chính xác và phù hợp hơn với đặc thù ngành của từng doanh nghiệp.

> Theo khảo sát McKinsey, **70% công việc lặp lại** trong doanh nghiệp SME có thể được tự động hóa bằng AI Agent, giải phóng nhân sự để tập trung vào các công việc sáng tạo và có giá trị cao hơn.

## Doanh nghiệp được gì khi ứng dụng ${mainTopic}?

![Kết quả kinh doanh sau khi dùng AI Agent ViAI](${imgs[2]||IMG_POOL[2]})

### Tiết kiệm thời gian và chi phí vận hành

Lợi ích không chỉ dừng lại ở tiết kiệm thời gian. Khi AI đảm nhận phần việc lặp lại, toàn bộ đội ngũ có thêm bandwidth để tập trung vào chiến lược, sáng tạo và xây dựng quan hệ khách hàng sâu hơn.

| Tiêu chí | Trước khi dùng AI | Sau khi dùng ViAI |
|----------|-------------------|-------------------|
| Thời gian phản hồi | 30 phút – 2 tiếng | Dưới 5 giây |
| Hoạt động ngoài giờ | ❌ Không | ✅ 24/7 |
| Xử lý nhiều kênh cùng lúc | Tối đa 1-2 người | Không giới hạn |
| Chi phí nhân sự | 100% | Giảm 30-50% |
| Tỷ lệ bỏ lỡ khách | Cao | Gần bằng 0 |

Bên cạnh hiệu quả vận hành, doanh nghiệp còn có thêm **dữ liệu khách hàng chất lượng cao**: mỗi cuộc hội thoại được ghi lại, phân tích và chuyển thành insight giúp cải thiện sản phẩm, dịch vụ và chiến lược marketing.

### Dữ liệu khách hàng chất lượng cao

Bên cạnh hiệu quả vận hành, doanh nghiệp còn có thêm **dữ liệu khách hàng chất lượng cao**: mỗi cuộc hội thoại được ghi lại, phân tích và chuyển thành insight giúp cải thiện sản phẩm, dịch vụ và chiến lược marketing.

## Ví dụ thực tế: Shop Thời Trang Minh Anh

![Chủ doanh nghiệp sử dụng AI Agent ViAI](${imgs[3]||IMG_POOL[3]})

Chị Minh Anh — chủ shop thời trang online tại TP.HCM — nhận **150-200 tin nhắn Zalo mỗi ngày**. Trước đây chị mất 5-6 tiếng chỉ để trả lời khách hỏi giá, hỏi size và xác nhận đơn. Vào mùa cao điểm như lễ Tết hay 11/11, số tin nhắn tăng gấp đôi khiến chị gần như không thể nghỉ ngơi.

Sau khi triển khai ViAI Zalo Sales Agent chỉ trong một buổi sáng, toàn bộ quy trình tư vấn và chốt đơn được tự động hóa. Kết quả sau 30 ngày đầu:

- ⏱ Tiết kiệm **5 giờ/ngày** — tương đương 1 nhân viên bán thời gian
- 📦 Đơn hàng tăng **35%** nhờ không bỏ lỡ khách nhắn đêm hoặc giờ nghỉ trưa
- 😴 Chị có thể nghỉ ngơi đúng giờ mà doanh thu vẫn tiếp tục chạy
- 📊 Dữ liệu hội thoại giúp chị biết khách hay hỏi gì và điều chỉnh kho hàng phù hợp hơn

> *"Giờ khách nhắn lúc 2 giờ sáng cũng được trả lời ngay. Tháng đầu doanh thu tăng gần 30%, quan trọng hơn là tôi không còn cảm giác bị 'dính điện thoại' suốt ngày."* — Chị Minh Anh, chủ shop thời trang

## Lợi ích khi triển khai đúng cách

![Lợi ích triển khai AI Agent đúng cách](${imgs[4]||IMG_POOL[4]})

### Bắt đầu từ một quy trình cụ thể

Để AI tạo ra kết quả thực tế, doanh nghiệp nên bắt đầu từ **một quy trình cụ thể** thay vì triển khai dàn trải. Điểm khởi đầu phù hợp với hầu hết doanh nghiệp SME thường là:

- Tư vấn và phản hồi khách hàng tự động qua Zalo hoặc Facebook
- Nhắc lịch chăm sóc sau bán và thu thập đánh giá
- Tổng hợp báo cáo doanh thu hàng ngày gửi tự động cho quản lý

Khi quy trình đầu tiên vận hành ổn định — thường sau 2-4 tuần — mở rộng dần sang marketing tự động, vận hành kho và báo cáo quản trị. Đây là cách **giảm rủi ro** và dễ đo hiệu quả hơn so với triển khai toàn bộ cùng lúc. Quan trọng là luôn có người theo dõi kết quả và điều chỉnh kịch bản AI theo phản hồi thực tế từ khách.

## Doanh nghiệp nên chuẩn bị gì?

![Chuẩn bị trước khi triển khai AI Agent ViAI](${imgs[5]||IMG_POOL[5]})

### Dữ liệu đầu vào — nền tảng để AI hoạt động tốt

Một trong những lý do khiến nhiều doanh nghiệp triển khai AI không hiệu quả là thiếu dữ liệu đầu vào rõ ràng. AI chỉ phản hồi tốt khi được cung cấp đủ thông tin về sản phẩm, quy trình và khách hàng. Trước khi bắt đầu, hãy chuẩn bị:

- [ ] Danh sách sản phẩm/dịch vụ đầy đủ và bảng giá cập nhật
- [ ] 10-20 câu hỏi khách hàng hay hỏi nhất kèm câu trả lời chuẩn
- [ ] Chính sách bán hàng, đổi trả, bảo hành chi tiết
- [ ] Quy trình xử lý đơn hàng hiện tại từng bước
- [ ] Tài khoản Zalo OA, Facebook Page hoặc Website đã hoạt động

Khi dữ liệu đầu vào rõ ràng và nhất quán, AI phản hồi chính xác hơn ngay từ tuần đầu, giảm đáng kể thời gian tinh chỉnh và chi phí vận hành.

## Checklist: Bắt Đầu Với ${mainTopic} Trong 24 Giờ

- [ ] Xác định 1 quy trình lặp lại tốn thời gian nhất
- [ ] Đăng ký dùng thử ViAI miễn phí 14 ngày
- [ ] Kết nối kênh Zalo OA hoặc Website (mất 15 phút)
- [ ] Cài đặt kịch bản phản hồi cơ bản với dữ liệu sản phẩm
- [ ] Chạy thử 7 ngày và đo kết quả: số tin nhắn xử lý, tỷ lệ chuyển đổi
- [ ] Đánh giá và tinh chỉnh kịch bản dựa trên phản hồi thực tế
- [ ] Mở rộng sang quy trình tiếp theo

## Vì Sao Chọn ViAI Thay Vì Tự Xây?

Tự xây hệ thống AI tốn 6-12 tháng và hàng trăm triệu đồng chi phí kỹ thuật, chưa kể thời gian đào tạo và bảo trì. ViAI triển khai trong **24 giờ**, không cần đội kỹ thuật riêng, không cần kiến thức lập trình.

- ✅ Hỗ trợ 1-1 từ đội ngũ ViAI trong suốt quá trình triển khai
- ✅ Tích hợp 50+ ứng dụng phổ biến: Zalo, Facebook, Google Sheets, CRM
- ✅ Cập nhật tính năng liên tục, không mất phí nâng cấp
- ✅ Hoàn tiền 100% trong 7 ngày nếu không hài lòng
- ✅ Không ràng buộc hợp đồng dài hạn, linh hoạt theo quy mô doanh nghiệp

Với doanh nghiệp SME Việt Nam đang cần tăng tốc mà không muốn gánh thêm rủi ro kỹ thuật, ViAI là con đường ngắn nhất từ ý tưởng đến kết quả thực tế.

---

Sẵn sàng để AI làm việc thay bạn? [Dùng thử miễn phí 14 ngày](/dung-thu.html) — không cần thẻ tín dụng. Hoặc [xem các AI Agent phù hợp với ngành của bạn](/san-pham.html).`;

  return normalizeBlogDraft({
    title,
    seo_title: ensureSeoTitle(title, mainTopic),
    slug: toSlug(mainTopic),
    meta_description: ensureMetaDescription('', mainKeyword, mainTopic),
    excerpt: `ViAI giúp doanh nghiệp tận dụng AI để xử lý các công việc lặp lại nhanh hơn, từ tư vấn khách hàng đến tổng hợp dữ liệu.`,
    content,
    faq: [
      { question: 'ViAI có phải chatbot không?', answer: 'ViAI không chỉ là chatbot. ViAI được định hướng như trợ lý AI hỗ trợ nhiều quy trình trong doanh nghiệp.' },
      { question: 'Doanh nghiệp nhỏ có dùng ViAI được không?', answer: 'Có. ViAI phù hợp với doanh nghiệp vừa và nhỏ muốn bắt đầu tự động hóa từng phần công việc.' },
      { question: 'ViAI hỗ trợ những bộ phận nào?', answer: 'ViAI có thể hỗ trợ bán hàng, marketing, chăm sóc khách hàng, vận hành và báo cáo.' },
      { question: 'AI có thay thế nhân viên không?', answer: 'Không nhất thiết. AI giúp giảm việc lặp lại để nhân viên tập trung vào công việc quan trọng hơn.' },
      { question: 'Khi nào nên dùng ViAI?', answer: 'Khi doanh nghiệp có nhiều khách hàng, nhiều tin nhắn, nhiều dữ liệu hoặc nhiều thao tác thủ công cần tối ưu.' }
    ],
    image_prompt: `Ảnh minh họa ${mainTopic}, giao diện công nghệ AI hiện đại, doanh nghiệp Việt Nam, màu xanh dương và cam`,
    image_alt: `${mainTopic} cùng ViAI`
  }, input);
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch {}
  }
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    return JSON.parse(raw.slice(start, end + 1));
  }
  throw new Error('AI không trả về JSON hợp lệ');
}

async function uniqueSlug(baseSlug) {
  const base = toSlug(baseSlug);
  let slug = base;
  let i = 2;
  while (
    await db.prepare('SELECT id FROM blog_posts WHERE slug = ?').get(slug) ||
    await db.prepare('SELECT id FROM news_posts WHERE source_url = ?').get(`/blog/${slug}`)
  ) {
    slug = `${base}-${i++}`;
  }
  return slug;
}

function runAnthropicPrompt(prompt, maxTokens = 1200) {
  const apiKey = getAnthropicApiKey();

  const body = JSON.stringify({
    model: cleanEnvValue('ANTHROPIC_MODEL') || DEFAULT_ANTHROPIC_MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  });

  return new Promise((resolve, reject) => {
    const req2 = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const result = JSON.parse(d || '{}');
          if (r.statusCode >= 400 || result.error) {
            const rawMessage = result.error?.message || `Anthropic API error ${r.statusCode}`;
            const err = new Error(/invalid x-api-key/i.test(rawMessage)
              ? 'ANTHROPIC_API_KEY không hợp lệ hoặc đã bị thu hồi'
              : rawMessage);
            err.statusCode = r.statusCode >= 400 ? r.statusCode : 500;
            if (/invalid x-api-key/i.test(rawMessage)) err.aiConfigError = true;
            return reject(err);
          }
          const text = (result.content || [])
            .map(part => part.text || '')
            .join('\n')
            .trim();
          if (!text) return reject(new Error('AI không trả về nội dung'));
          resolve(text);
        } catch (e) {
          reject(e);
        }
      });
    });
    req2.on('error', reject);
    req2.setTimeout(45000, () => req2.destroy(new Error('AI phản hồi quá lâu, vui lòng thử lại')));
    req2.write(body);
    req2.end();
  });
}

// Gọi Claude Vision API với ảnh (base64 hoặc URL)
function runAnthropicWithImage(imageUrl, textPrompt, maxTokens = 200) {
  const apiKey = getAnthropicApiKey();

  const buildContent = () => {
    let imageBlock;
    if (imageUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, '..', imageUrl);
      const fileBuffer = fs.readFileSync(filePath);
      const base64 = fileBuffer.toString('base64');
      const ext = path.extname(imageUrl).toLowerCase().slice(1);
      const mediaType = ext === 'png' ? 'image/png'
        : ext === 'gif' ? 'image/gif'
        : ext === 'webp' ? 'image/webp'
        : 'image/jpeg';
      imageBlock = { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
    } else if (imageUrl.startsWith('http')) {
      imageBlock = { type: 'image', source: { type: 'url', url: imageUrl } };
    } else {
      throw new Error('URL ảnh không hợp lệ');
    }
    return [imageBlock, { type: 'text', text: textPrompt }];
  };

  return new Promise((resolve, reject) => {
    let content;
    try { content = buildContent(); } catch (e) { return reject(e); }

    const body = JSON.stringify({
      model: cleanEnvValue('ANTHROPIC_MODEL') || DEFAULT_ANTHROPIC_MODEL,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content }]
    });

    const req2 = https.request({
      hostname: 'api.anthropic.com',
      path: '/v1/messages',
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body)
      }
    }, (r) => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        try {
          const result = JSON.parse(d || '{}');
          if (r.statusCode >= 400 || result.error) return reject(new Error(result.error?.message || `API error ${r.statusCode}`));
          const text = (result.content || []).map(p => p.text || '').join('\n').trim();
          if (!text) return reject(new Error('Empty response'));
          resolve(text);
        } catch (e) { reject(e); }
      });
    });
    req2.on('error', reject);
    req2.setTimeout(45000, () => req2.destroy(new Error('AI timeout')));
    req2.write(body);
    req2.end();
  });
}

// ── Auth ──────────────────────────────────────────────
router.post('/login', loginLimiter, async (req, res) => {
  const { username, password, totp_code } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });
  try {
    const user = await db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      try { await db.prepare('INSERT INTO login_logs (username, ip, success, note) VALUES (?, ?, 0, ?)').run(username, req.headers['x-forwarded-for'] || req.ip || '', 'Sai mật khẩu'); } catch {}
      return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
    }

    if (user.totp_enabled && user.totp_secret) {
      if (!totp_code)
        return res.status(206).json({ require2fa: true, message: 'Vui lòng nhập mã xác thực 2FA' });
      const valid = speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: totp_code, window: 1 });
      if (!valid)
        return res.status(401).json({ error: 'Mã 2FA không đúng hoặc đã hết hạn' });
    }

    const token = jwt.sign({ id: user.id, username }, SECRET, { expiresIn: '24h' });
    try { await db.prepare('INSERT INTO login_logs (username, ip, success) VALUES (?, ?, 1)').run(username, req.headers['x-forwarded-for'] || req.ip || ''); } catch {}
    res.json({ token });
  } catch {
    res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' });
  }
});

// ── 2FA Setup ─────────────────────────────────────────
router.post('/2fa/setup', auth, async (req, res) => {
  try {
    const user = await db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.user?.id || 1);
    const secret = speakeasy.generateSecret({ name: `ViAI Admin (${user.username})` });
    await db.prepare('UPDATE admin_users SET totp_secret = ? WHERE id = ?').run(secret.base32, user.id);
    const qrUrl = await QRCode.toDataURL(secret.otpauth_url);
    res.json({ secret: secret.base32, qr: qrUrl });
  } catch (e) { res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

router.post('/2fa/enable', auth, async (req, res) => {
  try {
    const { code } = req.body;
    const user = await db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.user?.id || 1);
    if (!user.totp_secret) return res.status(400).json({ error: 'Chưa setup 2FA' });
    const valid = speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: code, window: 1 });
    if (!valid) return res.status(400).json({ error: 'Mã không đúng, vui lòng thử lại' });
    await db.prepare('UPDATE admin_users SET totp_enabled = 1 WHERE id = ?').run(user.id);
    res.json({ success: true, message: '2FA đã được bật thành công!' });
  } catch { res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

router.post('/2fa/disable', auth, async (req, res) => {
  try {
    const user = await db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.user?.id || 1);
    await db.prepare('UPDATE admin_users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(user.id);
    res.json({ success: true, message: '2FA đã được tắt' });
  } catch { res.status(500).json({ error: 'Lỗi máy chủ' }); }
});

router.get('/2fa/status', auth, async (req, res) => {
  const user = await db.prepare('SELECT totp_enabled FROM admin_users WHERE id = ?').get(req.user?.id || 1);
  res.json({ enabled: !!user?.totp_enabled });
});

// ── Site Settings (Homepage Globals) ─────────────────
router.get('/site-settings', auth, async (req, res) => {
  try {
    const rows = await db.prepare('SELECT key, value FROM site_settings').all();
    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json(settings);
  } catch(e) { res.status(500).json({ error: 'Lỗi lấy cài đặt' }); }
});

router.put('/site-settings', auth, async (req, res) => {
  try {
    for (const [k, v] of Object.entries(req.body)) {
      await db.prepare("INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value, updated_at=EXCLUDED.updated_at")
        .run(k, String(v ?? ''), new Date().toISOString().slice(0,19).replace('T',' '));
    }
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Lỗi lưu cài đặt' }); }
});

// ── Pricing Plans ─────────────────────────────────────
router.get('/pricing', auth, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM pricing_plans ORDER BY order_index ASC').all();
  rows.forEach(r => { try { r.features = JSON.parse(r.features || '[]'); } catch { r.features = []; } });
  res.json(rows);
});

router.post('/pricing', auth, async (req, res) => {
  const { name, icon, subtitle, price_month, price_year, highlight, badge, cta_text, features, order_index } = req.body;
  const r = await db.prepare(`INSERT INTO pricing_plans (name,icon,subtitle,price_month,price_year,highlight,badge,cta_text,features,order_index)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(name, icon||'🌱', subtitle||'', price_month, price_year||'', highlight?1:0, badge||null, cta_text||'Dùng thử miễn phí', JSON.stringify(features||[]), order_index||0);
  res.json({ id: r.lastInsertRowid });
});

router.put('/pricing/:id', auth, async (req, res) => {
  const { name, icon, subtitle, price_month, price_year, highlight, badge, cta_text, features, order_index, active } = req.body;
  await db.prepare(`UPDATE pricing_plans SET name=?,icon=?,subtitle=?,price_month=?,price_year=?,highlight=?,badge=?,cta_text=?,features=?,order_index=?,active=? WHERE id=?`)
    .run(name, icon||'🌱', subtitle||'', price_month, price_year||'', highlight?1:0, badge||null, cta_text||'Dùng thử miễn phí', JSON.stringify(features||[]), order_index||0, active?1:0, req.params.id);
  res.json({ success: true });
});

router.delete('/pricing/:id', auth, async (req, res) => {
  await db.prepare('DELETE FROM pricing_plans WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Admin Profile ─────────────────────────────────────
router.get('/profile', auth, async (req, res) => {
  const u = await db.prepare('SELECT id, username, display_name, email, avatar_url FROM admin_users WHERE id=?').get(req.user.id || 1);
  res.json(u || {});
});

router.put('/profile', auth, async (req, res) => {
  const { display_name, email } = req.body;
  await db.prepare('UPDATE admin_users SET display_name=?, email=? WHERE id=?').run(display_name || null, email || null, req.user.id || 1);
  res.json({ success: true });
});

router.put('/profile/password', auth, async (req, res) => {
  const { current_password, new_password } = req.body;
  if (!current_password || !new_password)
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });
  if (new_password.length < 6)
    return res.status(400).json({ error: 'Mật khẩu mới phải ít nhất 6 ký tự' });
  const u = await db.prepare('SELECT * FROM admin_users WHERE id=?').get(req.user.id || 1);
  if (!bcrypt.compareSync(current_password, u.password_hash))
    return res.status(400).json({ error: 'Mật khẩu hiện tại không đúng' });
  await db.prepare('UPDATE admin_users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(new_password, 10), u.id);
  res.json({ success: true });
});

router.post('/upload-avatar', auth, upload.single('avatar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Không có file ảnh' });
  const url = `/uploads/${req.file.filename}`;
  await db.prepare('UPDATE admin_users SET avatar_url=? WHERE id=?').run(url, req.user.id || 1);
  res.json({ url });
});

// ── Analytics: page views & login logs ───────────────
router.get('/analytics', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const week7  = new Date(Date.now() - 7*86400000).toISOString().slice(0,19).replace('T',' ');
    const week14 = new Date(Date.now() - 14*86400000).toISOString().slice(0,19).replace('T',' ');
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0,10);

    const [tv, tdv, wv, tp, dv, lg, ls, lf, lt] = await Promise.all([
      db.prepare("SELECT COUNT(*) as c FROM page_views").get(),
      db.prepare("SELECT COUNT(*) as c FROM page_views WHERE SUBSTRING(created_at,1,10)=?").get(today),
      db.prepare("SELECT COUNT(*) as c FROM page_views WHERE created_at >= ?").get(week7),
      db.prepare("SELECT path, COUNT(*) as views FROM page_views GROUP BY path ORDER BY views DESC LIMIT 10").all(),
      db.prepare("SELECT SUBSTRING(created_at,1,10) as day, COUNT(*) as views FROM page_views WHERE created_at >= ? GROUP BY day ORDER BY day ASC").all(week14),
      db.prepare("SELECT id, username, ip, success, note, created_at FROM login_logs ORDER BY created_at DESC LIMIT 50").all(),
      db.prepare("SELECT COUNT(*) as c FROM login_logs WHERE success=1").get(),
      db.prepare("SELECT COUNT(*) as c FROM login_logs WHERE success=0").get(),
      db.prepare("SELECT COUNT(*) as c FROM login_logs WHERE success=1 AND SUBSTRING(created_at,1,10)=?").get(today),
    ]);

    const allPaths = (await db.prepare("SELECT DISTINCT path FROM page_views ORDER BY path ASC").all()).map(r => r.path);
    const week6 = new Date(Date.now() - 6*86400000).toISOString().slice(0,19).replace('T',' ');
    const pageDetails = await Promise.all(allPaths.map(async path => {
      const [total, todayRow, weekRow, yestRow, trend] = await Promise.all([
        db.prepare("SELECT COUNT(*) as c FROM page_views WHERE path=?").get(path),
        db.prepare("SELECT COUNT(*) as c FROM page_views WHERE path=? AND SUBSTRING(created_at,1,10)=?").get(path, today),
        db.prepare("SELECT COUNT(*) as c FROM page_views WHERE path=? AND created_at>=?").get(path, week7),
        db.prepare("SELECT COUNT(*) as c FROM page_views WHERE path=? AND SUBSTRING(created_at,1,10)=?").get(path, yesterday),
        db.prepare("SELECT SUBSTRING(created_at,1,10) as day, COUNT(*) as v FROM page_views WHERE path=? AND created_at>=? GROUP BY day ORDER BY day ASC").all(path, week6),
      ]);
      const trendArr = [];
      for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const key = d.toISOString().slice(0, 10);
        const found = trend.find(t => t.day === key);
        trendArr.push(found ? Number(found.v) : 0);
      }
      return { path, total: Number(total.c), today: Number(todayRow.c), week: Number(weekRow.c), yesterday: Number(yestRow.c), trend: trendArr };
    }));
    pageDetails.sort((a, b) => b.total - a.total);

    res.json({ totalViews: Number(tv.c), todayViews: Number(tdv.c), weekViews: Number(wv.c), topPages: tp, dailyViews: dv, logins: lg, loginSuccess: Number(ls.c), loginFailed: Number(lf.c), loginToday: Number(lt.c), pageDetails });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Dashboard stats ───────────────────────────────────
router.get('/stats', auth, async (req, res) => {
  try {
    const today = new Date().toISOString().slice(0,10);
    const [bt, bd, bp, pr, nw, cu, cun, us, ga, wh, rp, rc] = await Promise.all([
      db.prepare("SELECT COUNT(*) as c FROM blog_posts").get(),
      db.prepare("SELECT COUNT(*) as c FROM blog_posts WHERE active=0").get(),
      db.prepare("SELECT COUNT(*) as c FROM blog_posts WHERE active=1").get(),
      db.prepare("SELECT COUNT(*) as c FROM products WHERE active=1").get(),
      db.prepare("SELECT COUNT(*) as c FROM news_posts WHERE active=1").get(),
      db.prepare("SELECT COUNT(*) as c FROM customers").get(),
      db.prepare("SELECT COUNT(*) as c FROM customers WHERE SUBSTRING(created_at,1,10)=?").get(today),
      db.prepare("SELECT COUNT(*) as c FROM users").get(),
      db.prepare("SELECT COUNT(*) as c FROM gallery_images WHERE active=1").get(),
      db.prepare("SELECT COUNT(*) as c FROM why_items WHERE active=1").get(),
      db.prepare("SELECT id,title,slug,published_at FROM blog_posts WHERE active=1 ORDER BY created_at DESC LIMIT 5").all(),
      db.prepare("SELECT id,name,phone,company,created_at FROM customers ORDER BY created_at DESC LIMIT 5").all(),
    ]);
    res.json({
      blog_total: Number(bt.c), blog_draft: Number(bd.c), blog_pub: Number(bp.c),
      products: Number(pr.c), news: Number(nw.c),
      customers: Number(cu.c), customers_new: Number(cun.c),
      users: Number(us.c), gallery: Number(ga.c), why: Number(wh.c),
      recent_posts: rp, recent_customers: rc,
    });
  } catch(e) { res.status(500).json({ error: 'Lỗi lấy thống kê' }); }
});

// ── Products ──────────────────────────────────────────
router.get('/products', auth, async (req, res) => {
  res.json(await db.prepare('SELECT * FROM products ORDER BY order_index ASC').all());
});

router.post('/products', auth, async (req, res) => {
  const { name, description, icon, icon_color, badge, badge_type, category, users_count, link, active, order_index } = req.body;
  const r = await db.prepare(`
    INSERT INTO products (name, description, icon, icon_color, badge, badge_type, category, users_count, link, active, order_index)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, description, icon||'🤖', icon_color||'blue', badge||null, badge_type||null,
        category||'all', users_count||0, link||'#', active?1:0, order_index||0);
  const newProd = await db.prepare('SELECT * FROM products WHERE id = ?').get(r.lastInsertRowid);
  tg.notifyNewProduct(newProd.name, newProd.category);
  res.json(newProd);
});

router.put('/products/:id', auth, async (req, res) => {
  const { name, description, icon, icon_color, badge, badge_type, category, users_count, link, active, order_index } = req.body;
  await db.prepare(`
    UPDATE products SET name=?, description=?, icon=?, icon_color=?, badge=?, badge_type=?,
    category=?, users_count=?, link=?, active=?, order_index=? WHERE id=?`
  ).run(name, description, icon, icon_color, badge||null, badge_type||null,
        category, users_count, link, active?1:0, order_index, req.params.id);
  res.json(await db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
});

router.delete('/products/:id', auth, async (req, res) => {
  await db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── News ──────────────────────────────────────────────
router.get('/news', auth, async (req, res) => {
  res.json(await db.prepare('SELECT * FROM news_posts ORDER BY published_at DESC').all());
});

router.post('/news', auth, async (req, res) => {
  const { title, excerpt, image_url, source_name, source_tag, source_url, published_at, active } = req.body;
  const r = await db.prepare(`
    INSERT INTO news_posts (title, excerpt, image_url, source_name, source_tag, source_url, published_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title, excerpt, image_url, source_name, source_tag, source_url, published_at, active?1:0);
  const newNews = await db.prepare('SELECT * FROM news_posts WHERE id = ?').get(r.lastInsertRowid);
  tg.notifyNewNews(newNews.title, newNews.source_name);
  res.json(newNews);
});

router.put('/news/:id', auth, async (req, res) => {
  const { title, excerpt, image_url, source_name, source_tag, source_url, published_at, active } = req.body;
  await db.prepare(`
    UPDATE news_posts SET title=?, excerpt=?, image_url=?, source_name=?, source_tag=?,
    source_url=?, published_at=?, active=? WHERE id=?`
  ).run(title, excerpt, image_url, source_name, source_tag, source_url, published_at, active?1:0, req.params.id);
  res.json(await db.prepare('SELECT * FROM news_posts WHERE id = ?').get(req.params.id));
});

router.delete('/news/:id', auth, async (req, res) => {
  await db.prepare('DELETE FROM news_posts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Blog Posts ────────────────────────────────────────
router.get('/blog-posts', auth, async (req, res) => {
  res.json(await db.prepare('SELECT * FROM blog_posts ORDER BY published_at DESC').all());
});

router.post('/blog-posts', auth, async (req, res) => {
  const { title, excerpt, content, seo_title, meta_description, faq_json, image_url, image_alt, category, author, published_at, active } = req.body;
  if (!title) return res.status(400).json({ error: 'Tiêu đề không được để trống' });
  const finalSlug = req.body.slug ? await uniqueSlug(req.body.slug) : await uniqueSlug(toSlug(title));
  const r = await db.prepare(`
    INSERT INTO blog_posts (title, excerpt, content, seo_title, meta_description, faq_json, image_url, image_alt, category, author, slug, published_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title, excerpt, content||null, seo_title||null, meta_description||null, faq_json||'[]', image_url||null, image_alt||null, category||'Tin tức', author||'ViAI Team', finalSlug, published_at||new Date().toISOString().slice(0,10), active?1:0);
  res.json(await db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(r.lastInsertRowid));
});

router.put('/blog-posts/:id', auth, async (req, res) => {
  const { title, excerpt, content, seo_title, meta_description, faq_json, image_url, image_alt, category, author, published_at, active } = req.body;
  if (!title) return res.status(400).json({ error: 'Tiêu đề không được để trống' });
  const existing = await db.prepare('SELECT slug FROM blog_posts WHERE id=?').get(req.params.id);
  const finalSlug = req.body.slug || existing?.slug || await uniqueSlug(toSlug(title));
  await db.prepare(`
    UPDATE blog_posts SET title=?, excerpt=?, content=?, seo_title=?, meta_description=?, faq_json=?, image_url=?, image_alt=?, category=?, author=?, slug=?, published_at=?, active=?
    WHERE id=?`
  ).run(title, excerpt, content||null, seo_title||null, meta_description||null, faq_json||'[]', image_url||null, image_alt||null, category, author, finalSlug, published_at, active?1:0, req.params.id);
  res.json(await db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(req.params.id));
});

router.delete('/blog-posts/:id', auth, async (req, res) => {
  await db.prepare('DELETE FROM blog_posts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Why Items ─────────────────────────────────────────
router.get('/why', auth, async (req, res) => res.json(await db.prepare('SELECT * FROM why_items ORDER BY order_index ASC').all()));

router.post('/why', auth, async (req, res) => {
  const { icon, icon_color, title, description, order_index, active } = req.body;
  const r = await db.prepare('INSERT INTO why_items (icon,icon_color,title,description,order_index,active) VALUES (?,?,?,?,?,?)').run(icon||'⭐',icon_color||'blue',title,description,order_index||0,active?1:0);
  res.json(await db.prepare('SELECT * FROM why_items WHERE id=?').get(r.lastInsertRowid));
});

router.put('/why/:id', auth, async (req, res) => {
  const { icon, icon_color, title, description, order_index, active } = req.body;
  await db.prepare('UPDATE why_items SET icon=?,icon_color=?,title=?,description=?,order_index=?,active=? WHERE id=?').run(icon,icon_color,title,description,order_index,active?1:0,req.params.id);
  res.json(await db.prepare('SELECT * FROM why_items WHERE id=?').get(req.params.id));
});

router.delete('/why/:id', auth, async (req, res) => { await db.prepare('DELETE FROM why_items WHERE id=?').run(req.params.id); res.json({success:true}); });

// ── How Steps ─────────────────────────────────────────
router.get('/how-steps', auth, async (req, res) => {
  const rows = await db.prepare('SELECT * FROM how_steps ORDER BY order_index ASC').all();
  rows.forEach(r => { r.features = JSON.parse(r.features||'[]'); r.mockup_bars = JSON.parse(r.mockup_bars||'[]'); });
  res.json(rows);
});

router.post('/how-steps', auth, async (req, res) => {
  const { step_number, title, short_desc, panel_title, panel_desc, features, mockup_bars, order_index, active } = req.body;
  const r = await db.prepare('INSERT INTO how_steps (step_number,title,short_desc,panel_title,panel_desc,features,mockup_bars,order_index,active) VALUES (?,?,?,?,?,?,?,?,?)').run(step_number,title,short_desc,panel_title,panel_desc,JSON.stringify(features||[]),JSON.stringify(mockup_bars||[]),order_index||0,active?1:0);
  const row = await db.prepare('SELECT * FROM how_steps WHERE id=?').get(r.lastInsertRowid);
  row.features = JSON.parse(row.features||'[]'); row.mockup_bars = JSON.parse(row.mockup_bars||'[]');
  res.json(row);
});

router.put('/how-steps/:id', auth, async (req, res) => {
  const { step_number, title, short_desc, panel_title, panel_desc, features, mockup_bars, order_index, active } = req.body;
  await db.prepare('UPDATE how_steps SET step_number=?,title=?,short_desc=?,panel_title=?,panel_desc=?,features=?,mockup_bars=?,order_index=?,active=? WHERE id=?').run(step_number,title,short_desc,panel_title,panel_desc,JSON.stringify(features||[]),JSON.stringify(mockup_bars||[]),order_index,active?1:0,req.params.id);
  const row = await db.prepare('SELECT * FROM how_steps WHERE id=?').get(req.params.id);
  row.features = JSON.parse(row.features||'[]'); row.mockup_bars = JSON.parse(row.mockup_bars||'[]');
  res.json(row);
});

router.delete('/how-steps/:id', auth, async (req, res) => { await db.prepare('DELETE FROM how_steps WHERE id=?').run(req.params.id); res.json({success:true}); });

// ── Tech Items ────────────────────────────────────────
router.get('/tech', auth, async (req, res) => res.json(await db.prepare('SELECT * FROM tech_items ORDER BY order_index ASC').all()));

router.post('/tech', auth, async (req, res) => {
  const { image_url, title, description, is_featured, order_index, active } = req.body;
  const r = await db.prepare('INSERT INTO tech_items (image_url,title,description,is_featured,order_index,active) VALUES (?,?,?,?,?,?)').run(image_url,title,description,is_featured?1:0,order_index||0,active?1:0);
  res.json(await db.prepare('SELECT * FROM tech_items WHERE id=?').get(r.lastInsertRowid));
});

router.put('/tech/:id', auth, async (req, res) => {
  const { image_url, title, description, is_featured, order_index, active } = req.body;
  await db.prepare('UPDATE tech_items SET image_url=?,title=?,description=?,is_featured=?,order_index=?,active=? WHERE id=?').run(image_url,title,description,is_featured?1:0,order_index,active?1:0,req.params.id);
  res.json(await db.prepare('SELECT * FROM tech_items WHERE id=?').get(req.params.id));
});

router.delete('/tech/:id', auth, async (req, res) => { await db.prepare('DELETE FROM tech_items WHERE id=?').run(req.params.id); res.json({success:true}); });

// ── Gallery ───────────────────────────────────────────
router.get('/gallery', auth, async (req, res) => res.json(await db.prepare('SELECT * FROM gallery_images ORDER BY order_index ASC').all()));

router.post('/gallery', auth, async (req, res) => {
  const { image_url, alt_text, caption, order_index, active } = req.body;
  const r = await db.prepare('INSERT INTO gallery_images (image_url,alt_text,caption,order_index,active) VALUES (?,?,?,?,?)').run(image_url,alt_text,caption,order_index||0,active?1:0);
  res.json(await db.prepare('SELECT * FROM gallery_images WHERE id=?').get(r.lastInsertRowid));
});

router.put('/gallery/:id', auth, async (req, res) => {
  const { image_url, alt_text, caption, order_index, active } = req.body;
  await db.prepare('UPDATE gallery_images SET image_url=?,alt_text=?,caption=?,order_index=?,active=? WHERE id=?').run(image_url,alt_text,caption,order_index,active?1:0,req.params.id);
  res.json(await db.prepare('SELECT * FROM gallery_images WHERE id=?').get(req.params.id));
});

router.delete('/gallery/:id', auth, async (req, res) => { await db.prepare('DELETE FROM gallery_images WHERE id=?').run(req.params.id); res.json({success:true}); });

// ── Registered Users ─────────────────────────────────
router.get('/users', auth, async (req, res) => {
  const { status, q } = req.query;
  const today = new Date().toISOString().slice(0,10);
  const week7 = new Date(Date.now() - 7*86400000).toISOString().slice(0,19).replace('T',' ');
  let sql = 'SELECT id, name, email, phone, status, source_page, last_login, created_at FROM users';
  const params = [];
  const where = [];
  if (status && status !== 'all') { where.push('status=?'); params.push(status); }
  if (q) { where.push('(name LIKE ? OR email LIKE ? OR phone LIKE ?)'); params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
  sql += ' ORDER BY created_at DESC';
  const [rows, total, newToday, newWeek, blocked, byPage] = await Promise.all([
    db.prepare(sql).all(...params),
    db.prepare("SELECT COUNT(*) as c FROM users").get(),
    db.prepare("SELECT COUNT(*) as c FROM users WHERE SUBSTRING(created_at,1,10)=?").get(today),
    db.prepare("SELECT COUNT(*) as c FROM users WHERE created_at>=?").get(week7),
    db.prepare("SELECT COUNT(*) as c FROM users WHERE status='blocked'").get(),
    db.prepare("SELECT COALESCE(source_page,'(Không rõ)') as page, COUNT(*) as cnt FROM users GROUP BY source_page ORDER BY cnt DESC").all(),
  ]);
  res.json({ rows, stats: { total: Number(total.c), newToday: Number(newToday.c), newWeek: Number(newWeek.c), blocked: Number(blocked.c) }, byPage });
});

router.put('/users/:id/status', auth, async (req, res) => {
  const { status } = req.body;
  if (!['active','blocked'].includes(status)) return res.status(400).json({ error: 'Trạng thái không hợp lệ' });
  await db.prepare('UPDATE users SET status=? WHERE id=?').run(status, req.params.id);
  res.json({ success: true });
});

router.put('/users/:id/reset-password', auth, async (req, res) => {
  const { new_password } = req.body;
  if (!new_password || new_password.length < 6) return res.status(400).json({ error: 'Mật khẩu tối thiểu 6 ký tự' });
  await db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(new_password, 10), req.params.id);
  res.json({ success: true });
});

router.delete('/users/:id', auth, async (req, res) => {
  await db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Customers ─────────────────────────────────────────
router.get('/customers', auth, async (req, res) => {
  res.json(await db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all());
});

router.put('/customers/:id', auth, async (req, res) => {
  const { status } = req.body;
  await db.prepare('UPDATE customers SET status=? WHERE id=?').run(status, req.params.id);
  res.json(await db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id));
});

router.delete('/customers/:id', auth, async (req, res) => {
  await db.prepare('DELETE FROM customers WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── AI gợi ý tóm tắt ─────────────────────────────────
router.post('/ai-suggest', auth, async (req, res) => {
  const { title, excerpt } = req.body;
  const clean = (v) => String(v || '').trim();
  const titleText = clean(title);
  const excerptText = clean(excerpt).slice(0, 4000);
  if (!titleText && !excerptText) {
    return res.status(400).json({ error: 'Vui lòng nhập tiêu đề hoặc tóm tắt trước khi gọi AI' });
  }

  const prompt = `Bạn là trợ lý viết nội dung marketing tiếng Việt cho doanh nghiệp AI.
Viết lại đoạn tóm tắt bài báo sau cho ngắn gọn, hấp dẫn, đúng ngữ cảnh (2-3 câu, tối đa 120 từ).
Tiêu đề: ${titleText}
${excerptText ? `Tóm tắt gốc: ${excerptText}` : ''}
Chỉ trả về đoạn tóm tắt mới, không giải thích thêm.`;

  try {
    const result = await runAnthropicPrompt(prompt, 300);
    res.json({ result });
  } catch (e) {
    if (shouldUseTemplateFallback(e)) {
      return res.json({
        result: buildTemplateExcerpt(titleText, excerptText),
        fallback: true,
        warning: e.message || 'Đang dùng nội dung mẫu vì chưa cấu hình AI'
      });
    }
    res.status(e.statusCode || 500).json({ error: e.message || 'Lỗi AI' });
  }
});

// ── Upload ảnh ────────────────────────────────────────
// AI SEO Assistant
router.post('/seo-assistant', auth, async (req, res) => {
  const clean = (v) => String(v || '').trim();
  const mode = clean(req.body.mode) === 'audit' ? 'audit' : 'generate';
  const keyword = clean(req.body.keyword);
  const topic = clean(req.body.topic);
  const audience = clean(req.body.audience) || 'chủ doanh nghiệp và đội ngũ marketing tại Việt Nam';
  const intent = clean(req.body.intent) || 'tìm hiểu và cân nhắc giải pháp';
  const tone = clean(req.body.tone) || 'chuyên nghiệp, rõ ràng, dễ hiểu';
  const draft = clean(req.body.draft).slice(0, 15000);

  if (!keyword && !topic && !draft) {
    return res.status(400).json({ error: 'Vui lòng nhập từ khóa, chủ đề hoặc nội dung bài viết' });
  }

  const prompt = mode === 'audit'
    ? `Bạn là chuyên gia SEO tiếng Việt cho website B2B về AI Agent.
Hãy kiểm tra bài viết dưới đây theo tiêu chuẩn SEO on-page thực tế.

Từ khóa chính: ${keyword || '(chưa cung cấp)'}
Chủ đề: ${topic || '(chưa cung cấp)'}
Đối tượng đọc: ${audience}
Search intent: ${intent}

Bài viết cần kiểm tra:
${draft || '(người dùng chưa dán bài viết, hãy đánh giá dựa trên từ khóa/chủ đề và nêu phần còn thiếu)'}

Trả về bằng tiếng Việt, có cấu trúc rõ ràng:
1. Điểm SEO /100 và lý do ngắn.
2. Các lỗi quan trọng cần sửa ngay.
3. Tiêu đề SEO đề xuất, slug, meta description 140-160 ký tự.
4. Checklist: H1, H2/H3, mật độ từ khóa, internal link, external link, alt ảnh, FAQ, CTA.
5. Phiên bản đoạn mở bài tối ưu hơn.
6. 5 câu hỏi FAQ nên thêm.`
    : `Bạn là trợ lý viết bài SEO tiếng Việt cho website ViAI, sản phẩm AI Agent cho doanh nghiệp.
Hãy tạo một bài viết chuẩn SEO, tự nhiên, không nhồi nhét từ khóa và phù hợp độc giả Việt Nam.

Từ khóa chính: ${keyword || topic}
Chủ đề: ${topic || keyword}
Đối tượng đọc: ${audience}
Search intent: ${intent}
Giọng văn: ${tone}

Trả về bằng tiếng Việt, theo cấu trúc:
1. SEO Title tối đa 60 ký tự.
2. Slug URL ngắn, không dấu.
3. Meta description 140-160 ký tự.
4. Dàn ý H1, H2, H3.
5. Bài viết hoàn chỉnh khoảng 900-1200 từ, có mở bài, thân bài, CTA cuối bài.
6. 5 FAQ ngắn.
7. Gợi ý 3 internal link anchor text.
8. Gợi ý 3 alt text ảnh.`;

  try {
    const result = await runAnthropicPrompt(prompt, mode === 'audit' ? 1800 : 2600);
    res.json({ result, mode });
  } catch (e) {
    if (shouldUseTemplateFallback(e)) {
      return res.json({
        result: buildTemplateSeoResult({ mode, keyword, topic, audience, intent, tone, draft }),
        mode,
        fallback: true,
        warning: e.message || 'Đang dùng nội dung mẫu vì chưa cấu hình AI'
      });
    }
    res.status(e.statusCode || 500).json({ error: e.message || 'Lỗi AI' });
  }
});

router.post('/ai-blog-draft', auth, async (req, res) => {
  const clean = (v) => String(v || '').trim();
  const input = {
    mode: 'generate',
    keyword: clean(req.body.keyword),
    topic: clean(req.body.topic),
    audience: clean(req.body.audience) || 'chủ doanh nghiệp và đội ngũ marketing tại Việt Nam',
    intent: clean(req.body.intent) || 'tìm hiểu và cân nhắc giải pháp',
    tone: clean(req.body.tone) || 'chuyên nghiệp, rõ ràng, dễ hiểu',
    request: clean(req.body.request).slice(0, 4000),
    image_url: clean(req.body.image_url),
    section_images: Array.isArray(req.body.section_images) ? req.body.section_images.map(u => String(u || '').trim()).filter(Boolean) : [],
    secondary_keywords: clean(req.body.secondary_keywords),
    preset_title: clean(req.body.preset_title),
    preset_meta: clean(req.body.preset_meta),
    internal_links: clean(req.body.internal_links) || '/san-pham.html, /dung-thu.html',
    existing_content: clean(req.body.existing_content).slice(0, 8000),
    improve_request: clean(req.body.improve_request).slice(0, 1000),
    mode: clean(req.body.mode) === 'improve' ? 'improve' : 'generate'
  };

  if (!input.keyword && !input.topic && !input.request) {
    return res.status(400).json({ error: 'Vui lòng nhập yêu cầu, từ khóa hoặc chủ đề bài viết' });
  }

  const prompt = input.mode === 'improve' ? `Bạn là chuyên gia Content Website với 7 năm kinh nghiệm thực chiến, chuyên cải thiện và tối ưu bài viết cho ViAI — nền tảng AI Agent dành cho doanh nghiệp SME Việt Nam.

NHIỆM VỤ: Cải thiện bài viết có sẵn dưới đây. GIỮ NGUYÊN ý chính, chỉ nâng cấp về:
- Cấu trúc heading chuẩn SEO: ## (H2 — section lớn), ### (H3 — mục nhỏ trong H2), #### (H4 — phụ đề). H1 đã là tiêu đề bài viết ở trên, trong nội dung ưu tiên dùng ## trở xuống
- Mỗi section H2 nên có ít nhất 1 H3 bên trong để tạo cấu trúc phân cấp rõ ràng
- SEO (hook mạnh hơn, từ khóa tự nhiên, meta chuẩn)
- Hình ảnh (thêm ảnh sau mỗi H2 nếu chưa có)
- Bảng so sánh hoặc checklist nếu phù hợp
- CTA cuối bài rõ ràng
- Đoạn văn dài → tách nhỏ ≤3 câu, dễ đọc lướt

Từ khóa chính: ${input.keyword || input.topic || '(trích từ bài)'}
${input.secondary_keywords ? `Từ khóa phụ: ${input.secondary_keywords}` : ''}
Hướng dẫn cải thiện: ${input.improve_request || 'Chuẩn SEO, thêm ảnh, cải thiện hook và CTA'}
Internal links cần chèn: ${input.internal_links}

${input.section_images && input.section_images.length > 0
  ? `Ảnh để dùng cho các section (theo thứ tự):\n${input.section_images.map((u,i) => `  * Section ${i+1}: ${u}`).join('\n')}`
  : `Ảnh mặc định:\n  * https://images.unsplash.com/photo-1677442136019-21780ecad995?w=900&q=80\n  * https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=900&q=80\n  * https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=900&q=80`}

BÀI VIẾT GỐC:
---
${input.existing_content}
---

Chỉ trả về JSON hợp lệ, không thêm text ngoài JSON:
{
  "title": "Tiêu đề cải thiện (có từ khóa, hấp dẫn hơn bản gốc)",
  "seo_title": "SEO title tối đa 60 ký tự | ViAI",
  "slug": "slug-khong-dau",
  "meta_description": "140-160 ký tự",
  "excerpt": "2-3 câu tóm tắt hấp dẫn",
  "content": "Nội dung markdown đã cải thiện — giữ ý chính, thêm ảnh, cấu trúc rõ, CTA cuối bài",
  "faq": [{"question":"Câu hỏi thực tế","answer":"Câu trả lời ngắn gọn"}],
  "image_alt": "Mô tả ảnh thumbnail",
  "category": "Kiến thức AI",
  "author": "ViAI Team"
}` : `Bạn là chuyên gia Content Website với 7 năm kinh nghiệm thực chiến, chuyên viết nội dung cho lĩnh vực phần mềm, công nghệ và dịch vụ Digital Marketing — hiện đang viết cho ViAI, nền tảng AI Agent dành cho doanh nghiệp SME Việt Nam.

Vai trò: Tạo bài blog chất lượng cao, chuẩn SEO, đúng insight khách hàng, hỗ trợ tăng tỷ lệ chuyển đổi.
Phong cách: HubSpot / Notion blog — hiện đại, dễ đọc, thực chiến. KHÔNG viết như textbook hay bài SEO nhàm, không lan man, không nhồi nhét từ khóa, không dùng văn phong máy móc.

THÔNG TIN BÀI VIẾT:
- Từ khóa chính: ${input.keyword || input.topic}
- Chủ đề: ${input.topic || input.keyword}
${input.secondary_keywords ? `- Từ khóa phụ / LSI: ${input.secondary_keywords} — dùng tự nhiên trong bài, không nhồi nhét` : ''}
- Đối tượng: ${input.audience} — KHÔNG giả định họ hiểu kỹ thuật AI, giải thích thuật ngữ ngắn gọn nếu cần
- Mục tiêu content: ${input.intent} (SEO / lead gen / chuyển đổi)
- Giọng văn: ${input.tone} — chuyên nghiệp nhưng gần gũi, tránh corporate cứng nhắc
- Yêu cầu thêm: ${input.request || '(không có)'}
${input.preset_title ? `- SEO Title BẮT BUỘC dùng: "${input.preset_title}"` : ''}
${input.preset_meta ? `- Meta Description BẮT BUỘC dùng: "${input.preset_meta}"` : ''}

CẤU TRÚC NỘI DUNG CHUẨN (theo framework service content):
  Vấn đề khách hàng đang gặp → Giải pháp ViAI cung cấp → Lợi ích cụ thể → Quy trình triển khai → Lý do nên chọn ViAI → CTA rõ ràng

CHUẨN VIẾT BẮT BUỘC:

1. HOOK MỞ ĐẦU = CÂU HỎI GÂY ĐAU
   - Dòng đầu PHẢI là câu hỏi chỉ ra vấn đề thực tế của độc giả
   - VD: "Bạn đang mất bao nhiêu giờ mỗi ngày chỉ để trả lời tin nhắn Zalo?"
   - KHÔNG bắt đầu bằng định nghĩa như "AI Agent là..."

2. CẤU TRÚC RÕ RÀNG — DỄ ĐỌC LƯỚT
   - Paragraph tối đa 3 câu — ngắn, dễ scan trên mobile
   - Dùng **bold** cho từ quan trọng, điểm mạnh dịch vụ, con số nổi bật
   - Có bullet points, ordered list, checklist (- [ ] Việc cần làm)
   - Có ít nhất 1 bảng so sánh markdown: | Tiêu chí | Thủ công | ViAI |
   - HEADING — CẤU TRÚC CHUẨN SEO:
     * ## = H2 — tiêu đề section lớn (3–6 section/bài)
     * ### = H3 — tiêu đề mục nhỏ BÊN TRONG mỗi H2 (mỗi H2 nên có ít nhất 1 H3)
     * #### = H4 — phụ đề chi tiết (dùng khi cần)
     * Lưu ý: # (H1) đã là tiêu đề bài viết nằm ở trên — trong nội dung ưu tiên dùng ## trở xuống
     * Heading bám sát lợi ích — không đặt heading chung chung như "Giới thiệu", "Kết luận"

3. ẢNH SAU MỖI H2 SECTION (BẮT BUỘC)
   - Mỗi H2 PHẢI có 1 ảnh ngay sau heading hoặc sau đoạn đầu của section đó
   - Cú pháp: ![Mô tả tiếng Việt phù hợp section](URL)
   - Dùng ảnh Unsplash khác nhau, không lặp lại:
${input.section_images && input.section_images.length > 0
  ? `   QUAN TRỌNG — Dùng ĐÚNG CÁC ẢNH NÀY theo thứ tự cho từng section:
${input.section_images.map((u,i) => `     * Section ${i+1}: ${u}`).join('\n')}`
  : `   * AI/tech: https://images.unsplash.com/photo-1677442136019-21780ecad995?w=900&q=80
     * Robot: https://images.unsplash.com/photo-1620712943543-bcc4688e7485?w=900&q=80
     * Analytics: https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=900&q=80
     * Team: https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=900&q=80
     * Laptop: https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=900&q=80
     * Mobile: https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=900&q=80
     * Security: https://images.unsplash.com/photo-1563986768609-322da13575f3?w=900&q=80
     * Growth: https://images.unsplash.com/photo-1553877522-43269d4ea984?w=900&q=80
     * Meeting: https://images.unsplash.com/photo-1454165804606-c3d57bc86b40?w=900&q=80
     * Business: https://images.unsplash.com/photo-1542744173-8e7e53415bb0?w=900&q=80
     * Tech2: https://images.unsplash.com/photo-1516321318423-f06f85e504b3?w=900&q=80`}

4. VÍ DỤ THỰC TẾ — CASE STUDY (bắt buộc 1 case)
   - Dùng tên doanh nghiệp Việt Nam cụ thể: shop thời trang, phòng khám, F&B, logistics...
   - Có số liệu trước/sau rõ ràng (VD: từ 2 tiếng phản hồi → dưới 5 giây)
   - Có quote thực tế: > "Câu nói của người dùng..." — Tên, chức danh
   - KHÔNG bịa số liệu phi thực tế, KHÔNG dùng ngôn từ cường điệu quá mức

5. SEO TỰ NHIÊN
   - SEO title 50-60 ký tự, có từ khóa + ViAI
   - Meta description 140-160 ký tự, kết thúc bằng câu đầy đủ
   - Từ khóa chính + phụ xuất hiện tự nhiên, KHÔNG nhồi nhét
   - Internal links BẮT BUỘC chèn vào bài: ${input.internal_links}

6. CTA CUỐI BÀI
   - Lời kêu gọi hành động cụ thể, tự nhiên, không ép buộc
   - Link rõ ràng đến /dung-thu.html hoặc sản phẩm phù hợp

TUYỆT ĐỐI TRÁNH:
- Bịa thông tin kỹ thuật, số liệu hoặc case study không có cơ sở
- Dùng từ ngữ cường điệu quá mức, thiếu thực tế
- Viết nội dung chung chung, giống hàng loạt website khác
- Lạm dụng thuật ngữ chuyên ngành mà không giải thích
- Viết đoạn văn dài quá 4 câu, khó đọc lướt

Chỉ trả về JSON hợp lệ, không thêm text ngoài JSON:
{
  "title": "Tiêu đề bài viết (có từ khóa, hấp dẫn, phản ánh lợi ích thực tế)",
  "seo_title": "SEO title tối đa 60 ký tự | ViAI",
  "slug": "slug-khong-dau-viet-hoa",
  "meta_description": "140-160 ký tự, có từ khóa, kết thúc bằng câu đầy đủ",
  "excerpt": "2-3 câu tóm tắt, có pain point, nêu lợi ích chính",
  "content": "Nội dung markdown đầy đủ: hook câu hỏi → vấn đề → giải pháp (mỗi H2 có ảnh) → lợi ích cụ thể → quy trình → ví dụ thực tế → checklist → lý do chọn ViAI → CTA. Tối thiểu 1200 từ.",
  "faq": [{"question":"Câu hỏi thực tế độc giả hay hỏi về chủ đề này","answer":"Câu trả lời ngắn gọn, hữu ích, không lan man"}],
  "image_alt": "Mô tả ảnh thumbnail phù hợp chủ đề",
  "category": "Kiến thức AI",
  "author": "ViAI Team"
}`;

  try {
    const text = await runAnthropicPrompt(prompt, 5200);
    const draft = normalizeBlogDraft(extractJsonObject(text), input);
    // Ưu tiên ảnh thumbnail user cung cấp (trước hoặc sau khi tạo draft)
    if (input.image_url) draft.image_url = input.image_url;
    // Post-process: thay section images bằng URL user cung cấp (đừng nhờ Claude)
    if (input.section_images && input.section_images.length > 0 && draft.content) {
      let idx = 0;
      draft.content = draft.content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
        if (idx < input.section_images.length) {
          return `![${alt}](${input.section_images[idx++]})`;
        }
        return match;
      });
    }
    res.json({ draft, fallback: false });
  } catch (e) {
    if (shouldUseTemplateFallback(e)) {
      let draft;
      // Nếu mode improve + có nội dung gốc → dùng nội dung anh paste, không tạo template mới
      if (input.mode === 'improve' && input.existing_content) {
        const mainTopic = input.topic || input.keyword || 'ViAI AI Agent';
        const improvedContent = improveExistingContent(
          input.existing_content, input.keyword, input.topic, input.section_images
        );
        draft = normalizeBlogDraft({
          title: buildSeoTitleFromTopic(mainTopic, 'doanh nghiệp'),
          seo_title: ensureSeoTitle('', mainTopic),
          slug: toSlug(mainTopic),
          meta_description: ensureMetaDescription('', input.keyword || mainTopic, mainTopic),
          excerpt: `${mainTopic} — bài viết thực chiến dành cho doanh nghiệp Việt Nam.`,
          content: improvedContent,
          faq: [],
          category: 'Kiến thức AI',
          author: 'ViAI Team'
        }, input);
      } else {
        draft = buildTemplateBlogDraft(input);
      }
      if (input.image_url) draft.image_url = input.image_url;
      if (input.section_images && input.section_images.length > 0 && draft.content) {
        let idx = 0;
        draft.content = draft.content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
          if (idx < input.section_images.length) return `![${alt}](${input.section_images[idx++]})`;
          return match;
        });
      }
      return res.json({
        draft,
        fallback: true,
        warning: 'Đang dùng bản nháp từ nội dung của bạn. Thêm Anthropic key để AI cải thiện tốt hơn.'
      });
    }
    res.status(e.statusCode || 500).json({ error: e.message || 'Lỗi AI' });
  }
});

router.post('/ai-blog-publish', auth, async (req, res) => {
  try {
    const draft = normalizeBlogDraft(req.body.draft || req.body);
    if (!draft.title || !draft.content) {
      return res.status(400).json({ error: 'Bản nháp thiếu tiêu đề hoặc nội dung bài viết' });
    }

    const slug = await uniqueSlug(draft.slug || draft.title);
    const publishedAt = new Date().toISOString().slice(0, 10);
    const imageUrl = draft.image_url || 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=900&q=80';

    const blogResult = await db.prepare(`
      INSERT INTO blog_posts
        (title, excerpt, content, seo_title, meta_description, faq_json, image_alt, image_url, category, author, slug, published_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      draft.title, draft.excerpt, draft.content, draft.seo_title, draft.meta_description,
      JSON.stringify(draft.faq || []), draft.image_alt, imageUrl,
      draft.category || 'Kiến thức AI', draft.author || 'ViAI Team', slug, publishedAt, 1
    );

    const sourceUrl = `/blog/${slug}`;
    const newsResult = await db.prepare(`
      INSERT INTO news_posts (title, excerpt, image_url, source_name, source_tag, source_url, published_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(draft.title, draft.excerpt, imageUrl, 'ViAI Blog', 'ViAI', sourceUrl, publishedAt, 1);

    res.json({
      success: true,
      url: sourceUrl,
      blog: await db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(blogResult.lastInsertRowid),
      news: await db.prepare('SELECT * FROM news_posts WHERE id = ?').get(newsResult.lastInsertRowid)
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Không đăng được bài viết' });
  }
});

// ── AI gợi ý emoji icon cho Agent ─────────────────────
router.post('/suggest-emoji', auth, async (req, res) => {
  const name = String(req.body.name || '').trim().slice(0, 100);
  const desc = String(req.body.desc || '').trim().slice(0, 200);
  if (!name) return res.status(400).json({ error: 'Thiếu tên Agent' });

  // Fallback nhanh: map từ khóa → emoji (không cần Claude)
  const map = [
    { keys: ['zalo','chat','tin nhắn','message','nhắn','hội thoại'], emojis: ['💬','📱','🗨️','🤝','📲'] },
    { keys: ['sales','bán hàng','chốt đơn','tư vấn bán','telesales'], emojis: ['🛒','💰','🎯','🤝','📞'] },
    { keys: ['order','đơn hàng','quản lý đơn','xử lý đơn'], emojis: ['📋','🗂️','✅','📌','🔖'] },
    { keys: ['đóng gói','đóng hàng','packing','pack','gói hàng','bao bì'], emojis: ['📦','🎁','📫','🏷️','📮'] },
    { keys: ['vận chuyển','ship','giao hàng','logistics','giao vận','delivery'], emojis: ['🚚','🚛','📦','🗺️','⏱️'] },
    { keys: ['kho','warehouse','tồn kho','inventory','nhập kho','xuất kho'], emojis: ['🏭','📦','🗃️','🔢','📊'] },
    { keys: ['crm','khách hàng','customer','chăm sóc khách','loyalty'], emojis: ['🤝','💼','👥','❤️','🌟'] },
    { keys: ['report','báo cáo','analytics','phân tích','thống kê','dashboard'], emojis: ['📊','📈','📉','🔍','💹'] },
    { keys: ['email','mail','marketing email'], emojis: ['✉️','📧','📨','📣','🎯'] },
    { keys: ['marketing','quảng cáo','campaign','content','thương hiệu'], emojis: ['📣','🎨','🌐','💡','🎯'] },
    { keys: ['booking','lịch','appointment','đặt hẹn','hẹn','lịch hẹn'], emojis: ['📅','🗓️','⏰','🔔','📌'] },
    { keys: ['facebook','fb ads','ads','paid ads'], emojis: ['📣','🎯','📱','💰','📈'] },
    { keys: ['enterprise','custom','doanh nghiệp lớn','tập đoàn'], emojis: ['🏢','💼','🔧','⚙️','🌐'] },
    { keys: ['tuyển dụng','hr','nhân sự','recruitment','phỏng vấn'], emojis: ['👥','🤝','📋','🏆','💼'] },
    { keys: ['security','bảo mật','an ninh','xác thực','bảo vệ'], emojis: ['🔒','🛡️','🔐','✅','⚠️'] },
    { keys: ['thanh toán','payment','invoice','hoá đơn','thu tiền'], emojis: ['💳','💰','🧾','✅','🏦'] },
    { keys: ['hỗ trợ','support','helpdesk','chăm sóc 24','trợ lý'], emojis: ['🎧','💬','🆘','🤖','⚡'] },
    { keys: ['sản xuất','manufacturing','nhà máy','quy trình','dây chuyền'], emojis: ['🏭','⚙️','🔩','📊','✅'] },
    { keys: ['tài chính','finance','kế toán','accounting','chi phí'], emojis: ['💰','📊','🧮','💹','📋'] },
    { keys: ['giáo dục','education','đào tạo','training','học'], emojis: ['🎓','📚','✏️','💡','🏫'] },
    { keys: ['y tế','health','bệnh viện','clinic','sức khoẻ'], emojis: ['🏥','💊','🩺','❤️','🩻'] },
    { keys: ['ăn uống','nhà hàng','restaurant','food','thực phẩm','menu'], emojis: ['🍽️','🛒','🧑‍🍳','📋','⭐'] },
    { keys: ['ai','robot','tự động','automation','auto'], emojis: ['🤖','⚡','🔮','🧠','💻'] },
  ];

  const text = (name + ' ' + desc).toLowerCase();
  let suggested = null;
  for (const { keys, emojis } of map) {
    if (keys.some(k => text.includes(k))) { suggested = emojis; break; }
  }

  // Nếu không match → thử Claude với prompt rõ ràng hơn
  if (!suggested) {
    try {
      const prompt = `Bạn là chuyên gia UX đang chọn emoji icon cho một AI Agent.
Tên Agent: "${name}"
Mô tả: "${desc || 'không có'}"

Yêu cầu:
- Chọn đúng 5 emoji liên quan TRỰC TIẾP đến nghĩa/chức năng của tên Agent
- KHÔNG dùng emoji chung chung như 🤖💡⚡🎯🚀 trừ khi thật sự phù hợp
- Ưu tiên emoji mô tả vật thể/hành động cụ thể liên quan đến lĩnh vực đó
- Ví dụ: "đóng gói" → 📦🎁🏷️📮📫, "vận chuyển" → 🚚🚛🗺️⏱️📍

Chỉ trả về JSON array, không giải thích: ["emoji1","emoji2","emoji3","emoji4","emoji5"]`;
      const out = await runAnthropicPrompt(prompt, 80);
      const match = out.match(/\[[\s\S]*?\]/);
      if (match) suggested = JSON.parse(match[0]).slice(0, 5);
    } catch (_) {}
  }

  if (!suggested) suggested = ['📋','⚡','🎯','💼','✅'];
  res.json({ emojis: suggested });
});

// ── AI caption & alt cho gallery ──────────────────────
router.post('/ai-gallery-caption', auth, async (req, res) => {
  const filename = String(req.body.filename || '').trim().slice(0, 100);
  const imageUrl = String(req.body.url || '').trim();

  const visionPrompt = `Bạn đang xem ảnh của công ty ViAI (cung cấp AI Agent cho doanh nghiệp Việt Nam).
Quan sát ảnh và tạo:
- caption: 5-8 từ tiếng Việt mô tả nội dung ảnh cụ thể (người, địa điểm, hoạt động...)
- alt: 8-12 từ tiếng Việt cho SEO, bắt đầu bằng "ViAI -"
Chỉ trả về JSON: {"caption":"...","alt":"..."}`;

  // Thử Vision API nếu có URL ảnh
  if (imageUrl) {
    try {
      const text = await runAnthropicWithImage(imageUrl, visionPrompt, 150);
      const match = text.match(/\{[\s\S]*?\}/);
      if (match) {
        const data = JSON.parse(match[0]);
        if (data.caption) {
          // Đảm bảo alt không bị double prefix "ViAI - ViAI -"
          let alt = data.alt || `ViAI - ${data.caption}`;
          if (alt.toLowerCase().startsWith('viai - viai')) alt = alt.replace(/^viai\s*-\s*/i, '');
          return res.json({ caption: data.caption, alt });
        }
      }
    } catch (_) {}
  }

  // Fallback text-only nếu vision lỗi
  const raw = filename.replace(/\.[^.]+$/, '').replace(/[-_]/g, ' ').trim();
  const hasWords = /[a-zA-ZÀ-ỹ]{3,}/.test(raw);
  if (hasWords) {
    try {
      const prompt = `Tên file ảnh: "${raw}". Đây là ảnh công ty ViAI (AI Agent cho doanh nghiệp Việt).
Tạo caption 5-8 từ và alt text SEO 8-12 từ tiếng Việt.
Chỉ trả về JSON: {"caption":"...","alt":"..."}`;
      const text = await runAnthropicPrompt(prompt, 120);
      const match = text.match(/\{[\s\S]*?\}/);
      if (match) {
        const data = JSON.parse(match[0]);
        if (data.caption) {
          let alt = data.alt || `ViAI - ${data.caption}`;
          if (alt.toLowerCase().startsWith('viai - viai')) alt = alt.replace(/^viai\s*-\s*/i, '');
          return res.json({ caption: data.caption, alt });
        }
      }
    } catch (_) {}
  }

  // Fallback cuối
  const fallbacks = ['Sự kiện ViAI 2026', 'Workshop AI doanh nghiệp', 'Đội ngũ ViAI', 'Hoạt động ViAI'];
  const caption = fallbacks[Math.floor(Math.random() * fallbacks.length)];
  res.json({ caption, alt: `ViAI - ${caption}` });
});

router.post('/upload', auth, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Không có file' });
  res.json({ url: `/uploads/${req.file.filename}` });
});

// ── Fetch metadata từ URL bài báo ─────────────────────
router.post('/fetch-url', auth, (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'Thiếu URL' });

  const protocol = url.startsWith('https') ? https : http;
  const options = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ViAI-bot/1.0)' } };

  protocol.get(url, options, (resp) => {
    if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
      return res.json({ error: 'Redirect – vui lòng dùng URL trực tiếp' });
    }
    let html = '';
    resp.setEncoding('utf8');
    resp.on('data', chunk => { if (html.length < 200000) html += chunk; });
    resp.on('end', () => {
      const getMeta = (prop) => {
        const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`, 'i'))
                || html.match(new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`, 'i'));
        return m ? m[1].trim() : '';
      };
      const getTitle = () => {
        const m = html.match(/<title[^>]*>([^<]+)<\/title>/i);
        return m ? m[1].trim() : '';
      };
      const getDate = () => {
        // Thử nhiều nguồn khác nhau
        const raw = getMeta('article:published_time')
                 || getMeta('og:article:published_time')
                 || getMeta('datePublished')
                 || getMeta('date');
        if (raw) return raw.slice(0, 10); // lấy YYYY-MM-DD
        // Tìm trong JSON-LD
        const ld = html.match(/"datePublished"\s*:\s*"([^"]+)"/i);
        if (ld) return ld[1].slice(0, 10);
        return '';
      };

      const title    = getMeta('og:title')       || getTitle();
      const excerpt  = getMeta('og:description') || getMeta('description');
      const image    = getMeta('og:image');
      const siteName = getMeta('og:site_name');
      const date     = getDate();

      res.json({ title, excerpt, image, siteName, date });
    });
  }).on('error', (e) => res.status(500).json({ error: e.message }));
});

module.exports = router;
