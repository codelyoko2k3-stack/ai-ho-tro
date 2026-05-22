const express   = require('express');
const router    = express.Router();
const db        = require('../db');
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
  return String(text || 'viai-ai-ho-tro')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70) || 'viai-ai-ho-tro';
}

function normalizeBrandText(text) {
  return String(text || '')
    .replace(/\bviai\b/gi, 'VIAi')
    .replace(/\bai\b/g, 'AI')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanRepeatedSeoText(text) {
  return normalizeBrandText(text)
    .replace(/(VIAi\s+hỗ trợ)\s+hỗ trợ/gi, '$1')
    .replace(/hỗ trợ\s+hỗ trợ/gi, 'hỗ trợ')
    .replace(/(AI\s+hỗ trợ)\s+hỗ trợ/gi, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanTopicSubject(text, fallback = 'bán hàng') {
  let value = cleanRepeatedSeoText(text || fallback);
  value = value
    .replace(/^VIAi\s*[:\-]?\s*/i, '')
    .replace(/^AI\s+hỗ trợ\s+/i, '')
    .replace(/^hỗ trợ\s+/i, '')
    .replace(/^giải pháp\s+/i, '')
    .replace(/^ứng dụng\s+/i, '')
    .trim();
  return value || fallback;
}

function buildSeoTitleFromTopic(topic, fallback = 'bán hàng') {
  const subject = cleanTopicSubject(topic, fallback);
  let value = `VIAi hỗ trợ ${subject} bằng AI`;
  if (!/(doanh nghiệp|công ty|đội ngũ|kinh doanh)/i.test(subject)) {
    value += ' cho doanh nghiệp';
  }
  return cleanRepeatedSeoText(value);
}

function normalizeBrandMarkdown(text) {
  return String(text || '')
    .replace(/\bviai\b/gi, 'VIAi')
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
    value = `VIAi giúp doanh nghiệp ứng dụng AI vào ${subject} để tư vấn khách hàng nhanh hơn, tự động hóa quy trình, chăm sóc khách hàng và tối ưu vận hành hiệu quả.`;
  }
  if (value.length < 140) value += ' Phù hợp đội ngũ kinh doanh tại Việt Nam.';
  if (value.length > 160) value = value.slice(0, 160).replace(/\s+\S*$/, '');
  return value;
}

function ensureSeoTitle(title, topic) {
  let value = cleanRepeatedSeoText(title);
  if (!value) value = buildSeoTitleFromTopic(topic || 'bán hàng');
  value = value.replace(/\s*\|\s*VIAi$/i, '');
  value = cleanRepeatedSeoText(value);
  if (!/\bVIAi\b/.test(value)) value = `VIAi: ${value}`;
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

function ensureBlogContent(content, title, keyword, topic, audience) {
  let value = stripMarkdownTitle(normalizeBrandMarkdown(content), title);
  const mainTopic = normalizeBrandText(topic || keyword || 'AI hỗ trợ bán hàng');
  if (!value) {
    value = buildTemplateBlogDraft({ keyword, topic, audience }).content;
  }
  const wordCount = value.split(/\s+/).filter(Boolean).length;
  if (wordCount < 850) {
    value += `

## Lợi ích khi triển khai đúng cách

Để AI tạo ra kết quả thực tế, doanh nghiệp nên bắt đầu từ một quy trình cụ thể thay vì triển khai dàn trải. Với ${mainTopic}, điểm khởi đầu phù hợp thường là tư vấn khách hàng, phân loại nhu cầu, nhắc lịch chăm sóc hoặc tổng hợp dữ liệu bán hàng. Khi quy trình đầu tiên vận hành ổn định, doanh nghiệp có thể mở rộng sang marketing, vận hành và báo cáo quản trị.

Một lợi ích quan trọng khác là khả năng chuẩn hóa trải nghiệm khách hàng. Thay vì mỗi nhân viên trả lời theo một cách khác nhau, VIAi giúp doanh nghiệp xây dựng kịch bản phản hồi nhất quán, dễ kiểm soát và có thể cải thiện theo dữ liệu thực tế. Điều này giúp đội ngũ mới vào việc nhanh hơn, đồng thời giảm rủi ro bỏ sót khách hàng tiềm năng.

## Doanh nghiệp nên chuẩn bị gì?

Trước khi dùng VIAi, doanh nghiệp nên xác định rõ mục tiêu chính: muốn tăng tốc phản hồi, giảm việc thủ công, tăng tỷ lệ chuyển đổi hay cải thiện chăm sóc sau bán. Sau đó, hãy chuẩn bị các thông tin cơ bản như danh sách sản phẩm, câu hỏi thường gặp, chính sách bán hàng, quy trình xử lý đơn và tiêu chí chuyển khách cho nhân viên.

Khi dữ liệu đầu vào rõ ràng, AI sẽ hỗ trợ chính xác hơn và dễ đo lường hiệu quả hơn. Đây là cách tiếp cận thực tế để doanh nghiệp ứng dụng AI mà không cần thay đổi toàn bộ hệ thống ngay từ đầu.`;
  }
  return value.trim();
}

function buildTemplateExcerpt(title, excerpt) {
  const base = excerpt || 'VIAi hỗ trợ doanh nghiệp ứng dụng AI vào bán hàng, chăm sóc khách hàng và vận hành hằng ngày.';
  return `${title || 'VIAi'} giúp doanh nghiệp tận dụng AI để xử lý các công việc lặp lại nhanh hơn, từ tư vấn khách hàng đến tổng hợp dữ liệu. ${base} Giải pháp phù hợp với đội ngũ muốn bắt đầu tự động hóa mà không cần triển khai hệ thống phức tạp.`;
}

function buildTemplateSeoResult({ mode, keyword, topic, audience, intent, tone, draft }) {
  const mainKeyword = keyword || topic || 'VIAi AI hỗ trợ';
  const mainTopic = topic || keyword || 'AI hỗ trợ doanh nghiệp';
  const title = `VIAi: ${mainTopic}`;
  const slug = toSlug(mainTopic);

  if (mode === 'audit') {
    return `Lưu ý: Đây là bản kiểm tra mẫu vì server chưa có ANTHROPIC_API_KEY hợp lệ.

1. Điểm SEO /100
Điểm đề xuất: ${draft ? '72/100' : '45/100'}.
${draft ? 'Bài đã có nền nội dung để tối ưu, nhưng cần kiểm tra lại cấu trúc heading, từ khóa chính, CTA và FAQ.' : 'Bạn chưa dán nội dung bài viết, nên chỉ có thể đánh giá theo từ khóa/chủ đề.'}

2. Các lỗi quan trọng cần sửa ngay
- Làm rõ từ khóa chính: "${mainKeyword}" trong tiêu đề, đoạn mở bài và ít nhất một heading H2.
- Bổ sung CTA cuối bài để dẫn người đọc sang tư vấn, dùng thử hoặc liên hệ VIAi.
- Thêm FAQ để tăng khả năng hiển thị với truy vấn dạng câu hỏi.
- Kiểm tra lại meta description để nằm trong khoảng 140-160 ký tự.

3. Tiêu đề SEO, slug, meta description đề xuất
SEO Title: ${title}
Slug: ${slug}
Meta description: VIAi cung cấp AI hỗ trợ doanh nghiệp tự động hóa bán hàng, chăm sóc khách hàng và vận hành hiệu quả hơn.

4. Checklist
H1: Nên có đúng 1 H1 chứa chủ đề chính.
H2/H3: Nên chia theo lợi ích, cách hoạt động, ứng dụng và lý do chọn VIAi.
Mật độ từ khóa: Dùng tự nhiên, tránh lặp quá nhiều.
Internal link: Thêm link tới trang sản phẩm, bảng giá hoặc đăng ký dùng thử.
External link: Có thể dẫn tới nguồn uy tín về AI/automation nếu phù hợp.
Alt ảnh: Mô tả rõ hình ảnh và có ngữ cảnh VIAi.
FAQ: Nên có 4-5 câu hỏi ngắn.
CTA: Có lời mời hành động cụ thể ở cuối bài.

5. Đoạn mở bài tối ưu hơn
Trong bối cảnh doanh nghiệp cần phản hồi khách hàng nhanh hơn và giảm việc thủ công, ${mainKeyword} trở thành một giải pháp đáng cân nhắc. VIAi giúp đội ngũ bán hàng, marketing và vận hành ứng dụng AI vào các quy trình thực tế mà không cần bắt đầu bằng một hệ thống phức tạp.

6. FAQ nên thêm
- VIAi hỗ trợ doanh nghiệp những công việc nào?
- VIAi có phù hợp với doanh nghiệp nhỏ không?
- AI hỗ trợ có thay thế nhân viên không?
- Bao lâu có thể triển khai VIAi?
- Doanh nghiệp cần chuẩn bị gì trước khi dùng VIAi?`;
  }

  return `Lưu ý: Đây là bài viết mẫu vì server chưa có ANTHROPIC_API_KEY hợp lệ. Khi có key thật, Claude sẽ tạo nội dung linh hoạt hơn.

1. SEO Title
${title}

2. Slug URL
${slug}

3. Meta description
VIAi cung cấp AI hỗ trợ doanh nghiệp tự động hóa bán hàng, chăm sóc khách hàng và vận hành hiệu quả hơn.

4. Dàn ý H1, H2, H3
H1: ${title}
H2: AI hỗ trợ doanh nghiệp là gì?
H2: VIAi giúp gì cho bán hàng và chăm sóc khách hàng?
H2: Ứng dụng VIAi trong vận hành hằng ngày
H2: Vì sao doanh nghiệp nên cân nhắc VIAi?
H2: Kết luận và bước tiếp theo

5. Bài viết hoàn chỉnh

# ${title}

Trong bối cảnh chi phí nhân sự, quảng cáo và vận hành ngày càng tăng, nhiều doanh nghiệp Việt đang tìm kiếm một giải pháp giúp làm việc nhanh hơn nhưng không làm phức tạp hệ thống hiện tại. Đây là lý do ${mainKeyword} ngày càng được quan tâm, đặc biệt với các đội ngũ bán hàng, marketing và chăm sóc khách hàng.

VIAi được xây dựng để hỗ trợ doanh nghiệp ứng dụng AI vào các công việc thực tế. Thay vì chỉ dừng ở việc trả lời tin nhắn đơn giản, VIAi có thể hỗ trợ tư vấn khách hàng, phân loại nhu cầu, ghi nhận thông tin, tạo báo cáo và giảm bớt các thao tác lặp lại trong ngày.

## AI hỗ trợ doanh nghiệp là gì?

AI hỗ trợ doanh nghiệp là việc sử dụng trí tuệ nhân tạo để xử lý một phần công việc thường xuyên lặp lại. Ví dụ, khi khách hàng nhắn hỏi sản phẩm, AI có thể phản hồi nhanh theo dữ liệu đã được thiết lập. Khi có nhiều yêu cầu giống nhau, AI giúp đội ngũ tiết kiệm thời gian và giảm nguy cơ bỏ sót thông tin.

Điểm quan trọng là AI không nhất thiết thay thế con người. Trong nhiều trường hợp, AI đóng vai trò như một trợ lý vận hành, giúp nhân viên tập trung vào các việc cần tư duy, đàm phán hoặc xử lý tình huống phức tạp hơn.

## VIAi giúp gì cho bán hàng và chăm sóc khách hàng?

Với hoạt động bán hàng, VIAi có thể hỗ trợ phản hồi khách hàng nhanh hơn trên các kênh online. Khi khách để lại thông tin, AI có thể ghi nhận nhu cầu, đề xuất hướng tư vấn và chuyển dữ liệu cho đội ngũ phụ trách. Điều này đặc biệt hữu ích với doanh nghiệp có nhiều khách hỏi nhưng chưa đủ nhân sự trực liên tục.

Ở khâu chăm sóc khách hàng, VIAi có thể hỗ trợ nhắc lịch, gửi hướng dẫn, phân loại phản hồi và tạo kịch bản chăm sóc sau bán. Nhờ đó, doanh nghiệp giữ được sự chuyên nghiệp mà không cần tăng quá nhiều chi phí vận hành.

## Ứng dụng VIAi trong vận hành hằng ngày

Ngoài bán hàng, VIAi còn có thể hỗ trợ tổng hợp dữ liệu và báo cáo. Thay vì mất thời gian gom thông tin thủ công, doanh nghiệp có thể dùng AI để chuẩn hóa dữ liệu, tóm tắt tình hình và gợi ý các điểm cần theo dõi.

Khi dữ liệu được tổ chức tốt hơn, chủ doanh nghiệp và đội ngũ quản lý có thêm cơ sở để ra quyết định. Đây là lợi ích quan trọng của ${mainKeyword}: không chỉ làm nhanh hơn, mà còn giúp doanh nghiệp nhìn rõ hơn các điểm nghẽn trong quy trình.

## Vì sao doanh nghiệp nên cân nhắc VIAi?

VIAi phù hợp với doanh nghiệp muốn bắt đầu ứng dụng AI theo từng bước nhỏ. Thay vì triển khai một hệ thống lớn ngay từ đầu, doanh nghiệp có thể chọn một quy trình cụ thể như tư vấn khách hàng, chăm sóc sau bán hoặc báo cáo tự động. Cách tiếp cận này giúp giảm rủi ro và dễ đo hiệu quả hơn.

Với đối tượng đọc là ${audience || 'chủ doanh nghiệp và đội ngũ marketing tại Việt Nam'}, giải pháp AI cần dễ hiểu, dễ triển khai và gắn với kết quả kinh doanh thực tế. VIAi hướng tới đúng nhu cầu đó: hỗ trợ đội ngũ làm việc hiệu quả hơn mà không yêu cầu kiến thức kỹ thuật phức tạp.

## Kết luận

${mainTopic} không còn là xu hướng xa vời. Với VIAi, doanh nghiệp có thể bắt đầu tự động hóa những công việc lặp lại, phản hồi khách hàng nhanh hơn và xây dựng quy trình vận hành rõ ràng hơn. Nếu doanh nghiệp của bạn đang cân nhắc ứng dụng AI, hãy bắt đầu từ một nhu cầu cụ thể và đo hiệu quả từng bước.

CTA: Liên hệ VIAi để được tư vấn giải pháp AI hỗ trợ phù hợp với quy trình bán hàng, marketing và vận hành của doanh nghiệp bạn.

6. FAQ

VIAi có phải chatbot không?
VIAi không chỉ là chatbot. VIAi được định hướng như trợ lý AI hỗ trợ nhiều quy trình trong doanh nghiệp.

Doanh nghiệp nhỏ có dùng VIAi được không?
Có. VIAi phù hợp với doanh nghiệp vừa và nhỏ muốn bắt đầu tự động hóa từng phần công việc.

VIAi hỗ trợ những bộ phận nào?
VIAi có thể hỗ trợ bán hàng, marketing, chăm sóc khách hàng, vận hành và báo cáo.

AI có thay thế nhân viên không?
Không nhất thiết. AI giúp giảm việc lặp lại để nhân viên tập trung vào công việc quan trọng hơn.

Khi nào nên dùng VIAi?
Khi doanh nghiệp có nhiều khách hàng, nhiều tin nhắn, nhiều dữ liệu hoặc nhiều thao tác thủ công cần tối ưu.

7. Internal link anchor text
- Giải pháp AI Agent cho doanh nghiệp
- Đăng ký dùng thử VIAi
- Bảng giá VIAi

8. Alt text ảnh
- Giao diện VIAi hỗ trợ doanh nghiệp quản lý khách hàng
- AI hỗ trợ bán hàng và chăm sóc khách hàng tự động
      - Dashboard báo cáo vận hành doanh nghiệp bằng VIAi`;
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
  const keyword = fallbackInput.keyword || fallbackInput.topic || 'VIAi AI hỗ trợ';
  const topic = fallbackInput.topic || fallbackInput.keyword || 'AI hỗ trợ doanh nghiệp';
  const title = ensureSeoTitle(raw?.title || raw?.seo_title, topic);
  const content = ensureBlogContent(raw?.content || raw?.article || '', title, keyword, topic, fallbackInput.audience);
  const excerpt = ensureSentence(raw?.excerpt || raw?.summary || content.split(/\n+/).find(Boolean), `VIAi giúp doanh nghiệp ứng dụng AI vào ${cleanTopicSubject(topic, 'bán hàng')} để phản hồi khách hàng nhanh hơn, giảm việc thủ công và tối ưu vận hành.`);
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
    image_alt: normalizeBrandText(raw?.image_alt || `${topic} cùng VIAi`),
    image_url: String(raw?.image_url || 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=900&q=80').trim(),
    category: normalizeBrandText(raw?.category || 'Kiến thức AI'),
    author: normalizeBrandText(raw?.author || 'VIAi Team')
  };
}

function buildTemplateBlogDraft(input) {
  const { keyword, topic, audience, intent, tone } = input;
  const mainKeyword = cleanRepeatedSeoText(keyword || topic || 'VIAi AI hỗ trợ');
  const mainTopic = cleanRepeatedSeoText(topic || keyword || 'AI hỗ trợ doanh nghiệp');
  const title = buildSeoTitleFromTopic(mainTopic, 'doanh nghiệp');
  const content = `Trong bối cảnh chi phí nhân sự, quảng cáo và vận hành ngày càng tăng, nhiều doanh nghiệp Việt đang tìm kiếm một giải pháp giúp làm việc nhanh hơn nhưng không làm phức tạp hệ thống hiện tại. Đây là lý do ${mainKeyword} ngày càng được quan tâm, đặc biệt với các đội ngũ bán hàng, marketing và chăm sóc khách hàng.

VIAi được xây dựng để hỗ trợ doanh nghiệp ứng dụng AI vào các công việc thực tế. Thay vì chỉ dừng ở việc trả lời tin nhắn đơn giản, VIAi có thể hỗ trợ tư vấn khách hàng, phân loại nhu cầu, ghi nhận thông tin, tạo báo cáo và giảm bớt các thao tác lặp lại trong ngày.

## AI hỗ trợ doanh nghiệp là gì?

AI hỗ trợ doanh nghiệp là việc sử dụng trí tuệ nhân tạo để xử lý một phần công việc thường xuyên lặp lại. Ví dụ, khi khách hàng nhắn hỏi sản phẩm, AI có thể phản hồi nhanh theo dữ liệu đã được thiết lập. Khi có nhiều yêu cầu giống nhau, AI giúp đội ngũ tiết kiệm thời gian và giảm nguy cơ bỏ sót thông tin.

Điểm quan trọng là AI không nhất thiết thay thế con người. Trong nhiều trường hợp, AI đóng vai trò như một trợ lý vận hành, giúp nhân viên tập trung vào các việc cần tư duy, đàm phán hoặc xử lý tình huống phức tạp hơn.

## VIAi giúp gì cho bán hàng và chăm sóc khách hàng?

Với hoạt động bán hàng, VIAi có thể hỗ trợ phản hồi khách hàng nhanh hơn trên các kênh online. Khi khách để lại thông tin, AI có thể ghi nhận nhu cầu, đề xuất hướng tư vấn và chuyển dữ liệu cho đội ngũ phụ trách. Điều này đặc biệt hữu ích với doanh nghiệp có nhiều khách hỏi nhưng chưa đủ nhân sự trực liên tục.

Ở khâu chăm sóc khách hàng, VIAi có thể hỗ trợ nhắc lịch, gửi hướng dẫn, phân loại phản hồi và tạo kịch bản chăm sóc sau bán. Nhờ đó, doanh nghiệp giữ được sự chuyên nghiệp mà không cần tăng quá nhiều chi phí vận hành.

## Ứng dụng VIAi trong vận hành hằng ngày

Ngoài bán hàng, VIAi còn có thể hỗ trợ tổng hợp dữ liệu và báo cáo. Thay vì mất thời gian gom thông tin thủ công, doanh nghiệp có thể dùng AI để chuẩn hóa dữ liệu, tóm tắt tình hình và gợi ý các điểm cần theo dõi.

Khi dữ liệu được tổ chức tốt hơn, chủ doanh nghiệp và đội ngũ quản lý có thêm cơ sở để ra quyết định. Đây là lợi ích quan trọng của ${mainKeyword}: không chỉ làm nhanh hơn, mà còn giúp doanh nghiệp nhìn rõ hơn các điểm nghẽn trong quy trình.

## Vì sao doanh nghiệp nên cân nhắc VIAi?

VIAi phù hợp với doanh nghiệp muốn bắt đầu ứng dụng AI theo từng bước nhỏ. Thay vì triển khai một hệ thống lớn ngay từ đầu, doanh nghiệp có thể chọn một quy trình cụ thể như tư vấn khách hàng, chăm sóc sau bán hoặc báo cáo tự động. Cách tiếp cận này giúp giảm rủi ro và dễ đo hiệu quả hơn.

Với đối tượng đọc là ${audience || 'chủ doanh nghiệp và đội ngũ marketing tại Việt Nam'}, giải pháp AI cần dễ hiểu, dễ triển khai và gắn với kết quả kinh doanh thực tế. VIAi hướng tới đúng nhu cầu đó: hỗ trợ đội ngũ làm việc hiệu quả hơn mà không yêu cầu kiến thức kỹ thuật phức tạp.

## Kết luận

${mainTopic} không còn là xu hướng xa vời. Với VIAi, doanh nghiệp có thể bắt đầu tự động hóa những công việc lặp lại, phản hồi khách hàng nhanh hơn và xây dựng quy trình vận hành rõ ràng hơn. Nếu doanh nghiệp của bạn đang cân nhắc ứng dụng AI, hãy bắt đầu từ một nhu cầu cụ thể và đo hiệu quả từng bước.

Xem thêm [giải pháp AI Agent cho doanh nghiệp](/#products) hoặc [đăng ký tư vấn VIAi](/dung-thu.html) để được gợi ý cách áp dụng AI phù hợp với quy trình bán hàng, marketing và vận hành của doanh nghiệp bạn.`;

  return normalizeBlogDraft({
    title,
    seo_title: ensureSeoTitle(title, mainTopic),
    slug: toSlug(mainTopic),
    meta_description: ensureMetaDescription('', mainKeyword, mainTopic),
    excerpt: `VIAi giúp doanh nghiệp tận dụng AI để xử lý các công việc lặp lại nhanh hơn, từ tư vấn khách hàng đến tổng hợp dữ liệu.`,
    content,
    faq: [
      { question: 'VIAi có phải chatbot không?', answer: 'VIAi không chỉ là chatbot. VIAi được định hướng như trợ lý AI hỗ trợ nhiều quy trình trong doanh nghiệp.' },
      { question: 'Doanh nghiệp nhỏ có dùng VIAi được không?', answer: 'Có. VIAi phù hợp với doanh nghiệp vừa và nhỏ muốn bắt đầu tự động hóa từng phần công việc.' },
      { question: 'VIAi hỗ trợ những bộ phận nào?', answer: 'VIAi có thể hỗ trợ bán hàng, marketing, chăm sóc khách hàng, vận hành và báo cáo.' },
      { question: 'AI có thay thế nhân viên không?', answer: 'Không nhất thiết. AI giúp giảm việc lặp lại để nhân viên tập trung vào công việc quan trọng hơn.' },
      { question: 'Khi nào nên dùng VIAi?', answer: 'Khi doanh nghiệp có nhiều khách hàng, nhiều tin nhắn, nhiều dữ liệu hoặc nhiều thao tác thủ công cần tối ưu.' }
    ],
    image_prompt: `Ảnh minh họa ${mainTopic}, giao diện công nghệ AI hiện đại, doanh nghiệp Việt Nam, màu xanh dương và cam`,
    image_alt: `${mainTopic} cùng VIAi`
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

function uniqueSlug(baseSlug) {
  const base = toSlug(baseSlug);
  let slug = base;
  let i = 2;
  while (
    db.prepare('SELECT id FROM blog_posts WHERE slug = ?').get(slug) ||
    db.prepare('SELECT id FROM news_posts WHERE source_url = ?').get(`/blog/${slug}`)
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

// ── Auth ──────────────────────────────────────────────
router.post('/login', loginLimiter, (req, res) => {
  const { username, password, totp_code } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Vui lòng nhập đầy đủ thông tin' });
  try {
    const user = db.prepare('SELECT * FROM admin_users WHERE username = ?').get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      try { db.prepare('INSERT INTO login_logs (username, ip, success, note) VALUES (?, ?, 0, ?)').run(username, req.headers['x-forwarded-for'] || req.ip || '', 'Sai mật khẩu'); } catch {}
      return res.status(401).json({ error: 'Sai tên đăng nhập hoặc mật khẩu' });
    }

    // Kiểm tra 2FA nếu đã bật
    if (user.totp_enabled && user.totp_secret) {
      if (!totp_code)
        return res.status(206).json({ require2fa: true, message: 'Vui lòng nhập mã xác thực 2FA' });
      const valid = speakeasy.totp.verify({
        secret: user.totp_secret,
        encoding: 'base32',
        token: totp_code,
        window: 1,
      });
      if (!valid)
        return res.status(401).json({ error: 'Mã 2FA không đúng hoặc đã hết hạn' });
    }

    const token = jwt.sign({ id: user.id, username }, SECRET, { expiresIn: '24h' });
    try { db.prepare('INSERT INTO login_logs (username, ip, success) VALUES (?, ?, 1)').run(username, req.headers['x-forwarded-for'] || req.ip || ''); } catch {}
    res.json({ token });
  } catch {
    res.status(500).json({ error: 'Lỗi máy chủ, vui lòng thử lại.' });
  }
});

// ── 2FA Setup ─────────────────────────────────────────
router.post('/2fa/setup', auth, async (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.user?.id || 1);
    const secret = speakeasy.generateSecret({ name: `VIAi Admin (${user.username})` });
    db.prepare('UPDATE admin_users SET totp_secret = ? WHERE id = ?').run(secret.base32, user.id);
    const qrUrl = await QRCode.toDataURL(secret.otpauth_url);
    res.json({ secret: secret.base32, qr: qrUrl });
  } catch (e) {
    res.status(500).json({ error: 'Lỗi máy chủ' });
  }
});

router.post('/2fa/enable', auth, (req, res) => {
  try {
    const { code } = req.body;
    const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.user?.id || 1);
    if (!user.totp_secret) return res.status(400).json({ error: 'Chưa setup 2FA' });
    const valid = speakeasy.totp.verify({ secret: user.totp_secret, encoding: 'base32', token: code, window: 1 });
    if (!valid) return res.status(400).json({ error: 'Mã không đúng, vui lòng thử lại' });
    db.prepare('UPDATE admin_users SET totp_enabled = 1 WHERE id = ?').run(user.id);
    res.json({ success: true, message: '2FA đã được bật thành công!' });
  } catch {
    res.status(500).json({ error: 'Lỗi máy chủ' });
  }
});

router.post('/2fa/disable', auth, (req, res) => {
  try {
    const user = db.prepare('SELECT * FROM admin_users WHERE id = ?').get(req.user?.id || 1);
    db.prepare('UPDATE admin_users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(user.id);
    res.json({ success: true, message: '2FA đã được tắt' });
  } catch {
    res.status(500).json({ error: 'Lỗi máy chủ' });
  }
});

router.get('/2fa/status', auth, (req, res) => {
  const user = db.prepare('SELECT totp_enabled FROM admin_users WHERE id = ?').get(req.user?.id || 1);
  res.json({ enabled: !!user?.totp_enabled });
});

// ── Site Settings (Homepage Globals) ─────────────────
router.get('/site-settings', auth, (req, res) => {
  try {
    const rows = db.prepare('SELECT key, value FROM site_settings').all();
    const settings = Object.fromEntries(rows.map(r => [r.key, r.value]));
    res.json(settings);
  } catch(e) { res.status(500).json({ error: 'Lỗi lấy cài đặt' }); }
});

router.put('/site-settings', auth, (req, res) => {
  try {
    const upd = db.prepare("INSERT INTO site_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
    const trx = db.transaction((data) => {
      Object.entries(data).forEach(([k, v]) => upd.run(k, String(v ?? '')));
    });
    trx(req.body);
    res.json({ success: true });
  } catch(e) { res.status(500).json({ error: 'Lỗi lưu cài đặt' }); }
});

// ── Pricing Plans ─────────────────────────────────────
router.get('/pricing', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM pricing_plans ORDER BY order_index ASC').all();
  rows.forEach(r => { try { r.features = JSON.parse(r.features || '[]'); } catch { r.features = []; } });
  res.json(rows);
});

router.post('/pricing', auth, (req, res) => {
  const { name, icon, subtitle, price_month, price_year, highlight, badge, cta_text, features, order_index } = req.body;
  const r = db.prepare(`INSERT INTO pricing_plans (name,icon,subtitle,price_month,price_year,highlight,badge,cta_text,features,order_index)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(name, icon||'🌱', subtitle||'', price_month, price_year||'', highlight?1:0, badge||null, cta_text||'Dùng thử miễn phí', JSON.stringify(features||[]), order_index||0);
  res.json({ id: r.lastInsertRowid });
});

router.put('/pricing/:id', auth, (req, res) => {
  const { name, icon, subtitle, price_month, price_year, highlight, badge, cta_text, features, order_index, active } = req.body;
  db.prepare(`UPDATE pricing_plans SET name=?,icon=?,subtitle=?,price_month=?,price_year=?,highlight=?,badge=?,cta_text=?,features=?,order_index=?,active=? WHERE id=?`)
    .run(name, icon||'🌱', subtitle||'', price_month, price_year||'', highlight?1:0, badge||null, cta_text||'Dùng thử miễn phí', JSON.stringify(features||[]), order_index||0, active?1:0, req.params.id);
  res.json({ success: true });
});

router.delete('/pricing/:id', auth, (req, res) => {
  db.prepare('DELETE FROM pricing_plans WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Analytics: page views & login logs ───────────────
router.get('/analytics', auth, (req, res) => {
  try {
    const totalViews   = db.prepare("SELECT COUNT(*) as c FROM page_views").get().c;
    const todayViews   = db.prepare("SELECT COUNT(*) as c FROM page_views WHERE date(created_at)=date('now')").get().c;
    const weekViews    = db.prepare("SELECT COUNT(*) as c FROM page_views WHERE created_at >= datetime('now','-7 days')").get().c;
    const topPages     = db.prepare("SELECT path, COUNT(*) as views FROM page_views GROUP BY path ORDER BY views DESC LIMIT 10").all();
    const dailyViews   = db.prepare("SELECT date(created_at) as day, COUNT(*) as views FROM page_views WHERE created_at >= datetime('now','-14 days') GROUP BY day ORDER BY day ASC").all();
    const logins       = db.prepare("SELECT id, username, ip, success, note, created_at FROM login_logs ORDER BY created_at DESC LIMIT 50").all();
    const loginSuccess = db.prepare("SELECT COUNT(*) as c FROM login_logs WHERE success=1").get().c;
    const loginFailed  = db.prepare("SELECT COUNT(*) as c FROM login_logs WHERE success=0").get().c;
    const loginToday   = db.prepare("SELECT COUNT(*) as c FROM login_logs WHERE success=1 AND date(created_at)=date('now')").get().c;
    res.json({ totalViews, todayViews, weekViews, topPages, dailyViews, logins, loginSuccess, loginFailed, loginToday });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ── Dashboard stats ───────────────────────────────────
router.get('/stats', auth, (req, res) => {
  try {
    const stats = {
      blog_total:    db.prepare("SELECT COUNT(*) as c FROM blog_posts").get().c,
      blog_draft:    db.prepare("SELECT COUNT(*) as c FROM blog_posts WHERE active=0").get().c,
      blog_pub:      db.prepare("SELECT COUNT(*) as c FROM blog_posts WHERE active=1").get().c,
      products:      db.prepare("SELECT COUNT(*) as c FROM products WHERE active=1").get().c,
      news:          db.prepare("SELECT COUNT(*) as c FROM news_posts WHERE active=1").get().c,
      customers:     db.prepare("SELECT COUNT(*) as c FROM customers").get().c,
      customers_new: db.prepare("SELECT COUNT(*) as c FROM customers WHERE date(created_at)=date('now')").get().c,
      users:         db.prepare("SELECT COUNT(*) as c FROM users").get().c,
      gallery:       db.prepare("SELECT COUNT(*) as c FROM gallery_images WHERE active=1").get().c,
      why:           db.prepare("SELECT COUNT(*) as c FROM why_items WHERE active=1").get().c,
      // Lượt xem gần đây từ server log (đơn giản)
      recent_posts: db.prepare("SELECT id,title,slug,published_at FROM blog_posts WHERE active=1 ORDER BY created_at DESC LIMIT 5").all(),
      recent_customers: db.prepare("SELECT id,name,phone,company,created_at FROM customers ORDER BY created_at DESC LIMIT 5").all(),
    };
    res.json(stats);
  } catch(e) { res.status(500).json({ error: 'Lỗi lấy thống kê' }); }
});

// ── Products ──────────────────────────────────────────
router.get('/products', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY order_index ASC').all());
});

router.post('/products', auth, (req, res) => {
  const { name, description, icon, icon_color, badge, badge_type, category, users_count, link, active, order_index } = req.body;
  const r = db.prepare(`
    INSERT INTO products (name, description, icon, icon_color, badge, badge_type, category, users_count, link, active, order_index)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(name, description, icon||'🤖', icon_color||'blue', badge||null, badge_type||null,
        category||'all', users_count||0, link||'#', active===false?0:1, order_index||0);
  const newProd = db.prepare('SELECT * FROM products WHERE id = ?').get(r.lastInsertRowid);
  tg.notifyNewProduct(newProd.name, newProd.category);
  res.json(newProd);
});

router.put('/products/:id', auth, (req, res) => {
  const { name, description, icon, icon_color, badge, badge_type, category, users_count, link, active, order_index } = req.body;
  db.prepare(`
    UPDATE products SET name=?, description=?, icon=?, icon_color=?, badge=?, badge_type=?,
    category=?, users_count=?, link=?, active=?, order_index=? WHERE id=?`
  ).run(name, description, icon, icon_color, badge||null, badge_type||null,
        category, users_count, link, active===false?0:1, order_index, req.params.id);
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
});

router.delete('/products/:id', auth, (req, res) => {
  db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── News ──────────────────────────────────────────────
router.get('/news', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM news_posts ORDER BY published_at DESC').all());
});

router.post('/news', auth, (req, res) => {
  const { title, excerpt, image_url, source_name, source_tag, source_url, published_at, active } = req.body;
  const r = db.prepare(`
    INSERT INTO news_posts (title, excerpt, image_url, source_name, source_tag, source_url, published_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title, excerpt, image_url, source_name, source_tag, source_url, published_at, active===false?0:1);
  const newNews = db.prepare('SELECT * FROM news_posts WHERE id = ?').get(r.lastInsertRowid);
  tg.notifyNewNews(newNews.title, newNews.source_name);
  res.json(newNews);
});

router.put('/news/:id', auth, (req, res) => {
  const { title, excerpt, image_url, source_name, source_tag, source_url, published_at, active } = req.body;
  db.prepare(`
    UPDATE news_posts SET title=?, excerpt=?, image_url=?, source_name=?, source_tag=?,
    source_url=?, published_at=?, active=? WHERE id=?`
  ).run(title, excerpt, image_url, source_name, source_tag, source_url, published_at, active===false?0:1, req.params.id);
  res.json(db.prepare('SELECT * FROM news_posts WHERE id = ?').get(req.params.id));
});

router.delete('/news/:id', auth, (req, res) => {
  db.prepare('DELETE FROM news_posts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Blog Posts ────────────────────────────────────────
router.get('/blog-posts', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM blog_posts ORDER BY published_at DESC').all());
});

router.post('/blog-posts', auth, (req, res) => {
  const { title, excerpt, content, seo_title, meta_description, faq_json, image_url, image_alt, category, author, slug, published_at, active } = req.body;
  const r = db.prepare(`
    INSERT INTO blog_posts (title, excerpt, content, seo_title, meta_description, faq_json, image_url, image_alt, category, author, slug, published_at, active)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(title, excerpt, content||null, seo_title||null, meta_description||null, faq_json||'[]', image_url, image_alt||null, category||'Tin tức', author||'VIAi Team', slug||null, published_at, active===false?0:1);
  res.json(db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(r.lastInsertRowid));
});

router.put('/blog-posts/:id', auth, (req, res) => {
  const { title, excerpt, content, seo_title, meta_description, faq_json, image_url, image_alt, category, author, slug, published_at, active } = req.body;
  db.prepare(`
    UPDATE blog_posts SET title=?, excerpt=?, content=?, seo_title=?, meta_description=?, faq_json=?, image_url=?, image_alt=?, category=?, author=?, slug=?, published_at=?, active=?
    WHERE id=?`
  ).run(title, excerpt, content||null, seo_title||null, meta_description||null, faq_json||'[]', image_url, image_alt||null, category, author, slug||null, published_at, active===false?0:1, req.params.id);
  res.json(db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(req.params.id));
});

router.delete('/blog-posts/:id', auth, (req, res) => {
  db.prepare('DELETE FROM blog_posts WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ── Why Items ─────────────────────────────────────────
router.get('/why', auth, (req, res) => res.json(db.prepare('SELECT * FROM why_items ORDER BY order_index ASC').all()));

router.post('/why', auth, (req, res) => {
  const { icon, icon_color, title, description, order_index, active } = req.body;
  const r = db.prepare('INSERT INTO why_items (icon,icon_color,title,description,order_index,active) VALUES (?,?,?,?,?,?)').run(icon||'⭐',icon_color||'blue',title,description,order_index||0,active===false?0:1);
  res.json(db.prepare('SELECT * FROM why_items WHERE id=?').get(r.lastInsertRowid));
});

router.put('/why/:id', auth, (req, res) => {
  const { icon, icon_color, title, description, order_index, active } = req.body;
  db.prepare('UPDATE why_items SET icon=?,icon_color=?,title=?,description=?,order_index=?,active=? WHERE id=?').run(icon,icon_color,title,description,order_index,active===false?0:1,req.params.id);
  res.json(db.prepare('SELECT * FROM why_items WHERE id=?').get(req.params.id));
});

router.delete('/why/:id', auth, (req, res) => { db.prepare('DELETE FROM why_items WHERE id=?').run(req.params.id); res.json({success:true}); });

// ── How Steps ─────────────────────────────────────────
router.get('/how-steps', auth, (req, res) => {
  const rows = db.prepare('SELECT * FROM how_steps ORDER BY order_index ASC').all();
  rows.forEach(r => { r.features = JSON.parse(r.features||'[]'); r.mockup_bars = JSON.parse(r.mockup_bars||'[]'); });
  res.json(rows);
});

router.post('/how-steps', auth, (req, res) => {
  const { step_number, title, short_desc, panel_title, panel_desc, features, mockup_bars, order_index, active } = req.body;
  const r = db.prepare('INSERT INTO how_steps (step_number,title,short_desc,panel_title,panel_desc,features,mockup_bars,order_index,active) VALUES (?,?,?,?,?,?,?,?,?)').run(step_number,title,short_desc,panel_title,panel_desc,JSON.stringify(features||[]),JSON.stringify(mockup_bars||[]),order_index||0,active===false?0:1);
  const row = db.prepare('SELECT * FROM how_steps WHERE id=?').get(r.lastInsertRowid);
  row.features = JSON.parse(row.features||'[]'); row.mockup_bars = JSON.parse(row.mockup_bars||'[]');
  res.json(row);
});

router.put('/how-steps/:id', auth, (req, res) => {
  const { step_number, title, short_desc, panel_title, panel_desc, features, mockup_bars, order_index, active } = req.body;
  db.prepare('UPDATE how_steps SET step_number=?,title=?,short_desc=?,panel_title=?,panel_desc=?,features=?,mockup_bars=?,order_index=?,active=? WHERE id=?').run(step_number,title,short_desc,panel_title,panel_desc,JSON.stringify(features||[]),JSON.stringify(mockup_bars||[]),order_index,active===false?0:1,req.params.id);
  const row = db.prepare('SELECT * FROM how_steps WHERE id=?').get(req.params.id);
  row.features = JSON.parse(row.features||'[]'); row.mockup_bars = JSON.parse(row.mockup_bars||'[]');
  res.json(row);
});

router.delete('/how-steps/:id', auth, (req, res) => { db.prepare('DELETE FROM how_steps WHERE id=?').run(req.params.id); res.json({success:true}); });

// ── Tech Items ────────────────────────────────────────
router.get('/tech', auth, (req, res) => res.json(db.prepare('SELECT * FROM tech_items ORDER BY order_index ASC').all()));

router.post('/tech', auth, (req, res) => {
  const { image_url, title, description, is_featured, order_index, active } = req.body;
  const r = db.prepare('INSERT INTO tech_items (image_url,title,description,is_featured,order_index,active) VALUES (?,?,?,?,?,?)').run(image_url,title,description,is_featured?1:0,order_index||0,active===false?0:1);
  res.json(db.prepare('SELECT * FROM tech_items WHERE id=?').get(r.lastInsertRowid));
});

router.put('/tech/:id', auth, (req, res) => {
  const { image_url, title, description, is_featured, order_index, active } = req.body;
  db.prepare('UPDATE tech_items SET image_url=?,title=?,description=?,is_featured=?,order_index=?,active=? WHERE id=?').run(image_url,title,description,is_featured?1:0,order_index,active===false?0:1,req.params.id);
  res.json(db.prepare('SELECT * FROM tech_items WHERE id=?').get(req.params.id));
});

router.delete('/tech/:id', auth, (req, res) => { db.prepare('DELETE FROM tech_items WHERE id=?').run(req.params.id); res.json({success:true}); });

// ── Gallery ───────────────────────────────────────────
router.get('/gallery', auth, (req, res) => res.json(db.prepare('SELECT * FROM gallery_images ORDER BY order_index ASC').all()));

router.post('/gallery', auth, (req, res) => {
  const { image_url, alt_text, caption, order_index, active } = req.body;
  const r = db.prepare('INSERT INTO gallery_images (image_url,alt_text,caption,order_index,active) VALUES (?,?,?,?,?)').run(image_url,alt_text,caption,order_index||0,active===false?0:1);
  res.json(db.prepare('SELECT * FROM gallery_images WHERE id=?').get(r.lastInsertRowid));
});

router.put('/gallery/:id', auth, (req, res) => {
  const { image_url, alt_text, caption, order_index, active } = req.body;
  db.prepare('UPDATE gallery_images SET image_url=?,alt_text=?,caption=?,order_index=?,active=? WHERE id=?').run(image_url,alt_text,caption,order_index,active===false?0:1,req.params.id);
  res.json(db.prepare('SELECT * FROM gallery_images WHERE id=?').get(req.params.id));
});

router.delete('/gallery/:id', auth, (req, res) => { db.prepare('DELETE FROM gallery_images WHERE id=?').run(req.params.id); res.json({success:true}); });

// ── Registered Users ─────────────────────────────────
router.get('/users', auth, (req, res) => {
  const rows = db.prepare('SELECT id, name, email, phone, created_at FROM users ORDER BY created_at DESC').all();
  res.json(rows);
});

router.delete('/users/:id', auth, (req, res) => {
  db.prepare('DELETE FROM users WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Customers ─────────────────────────────────────────
router.get('/customers', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM customers ORDER BY created_at DESC').all());
});

router.put('/customers/:id', auth, (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE customers SET status=? WHERE id=?').run(status, req.params.id);
  res.json(db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id));
});

router.delete('/customers/:id', auth, (req, res) => {
  db.prepare('DELETE FROM customers WHERE id=?').run(req.params.id);
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
    : `Bạn là trợ lý viết bài SEO tiếng Việt cho website VIAi, sản phẩm AI Agent cho doanh nghiệp.
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
    image_url: clean(req.body.image_url)
  };

  if (!input.keyword && !input.topic && !input.request) {
    return res.status(400).json({ error: 'Vui lòng nhập yêu cầu, từ khóa hoặc chủ đề bài viết' });
  }

  const prompt = `Bạn là trợ lý AI SEO cho website VIAi, sản phẩm AI Agent cho doanh nghiệp Việt Nam.
Hãy tạo một bài blog phong phú, trực quan, có thể đăng ngay. Giọng văn ${input.tone}.

Yêu cầu của người dùng: ${input.request || '(không có yêu cầu thêm)'}
Từ khóa chính: ${input.keyword || input.topic}
Chủ đề: ${input.topic || input.keyword}
Đối tượng đọc: ${input.audience}
Search intent: ${input.intent}

Quy chuẩn SEO & nội dung bắt buộc:
- Dùng đúng thương hiệu "VIAi", không viết thường "viai".
- SEO title 50-60 ký tự, có từ khóa chính và VIAi. Không lặp từ.
- Meta description 140-160 ký tự, kết thúc bằng câu đầy đủ.
- Content 1100-1400 từ. KHÔNG dùng H1 ở đầu content; chỉ dùng đoạn mở, H2 và H3.
- Từ khóa chính xuất hiện trong mở bài, ít nhất 1 H2, và kết luận.
- Có ít nhất 2 internal link markdown tới /san-pham.html và /dung-thu.html.
- CTA rõ ở cuối bài, FAQ 4-6 câu hỏi.
- Không bịa số liệu cụ thể, không cam kết quá mức.

Yêu cầu HÌNH ẢNH (quan trọng):
- Chèn 2-3 ảnh trong bài dùng cú pháp markdown: ![Mô tả ảnh tiếng Việt](URL_ảnh)
- Dùng ảnh Unsplash thật, ví dụ: https://images.unsplash.com/photo-1677442136019-21780ecad995?w=900&q=80
- Các URL Unsplash phổ biến cho chủ đề AI/business:
  * AI công nghệ: https://images.unsplash.com/photo-1677442136019-21780ecad995?w=900&q=80
  * Dữ liệu/analytics: https://images.unsplash.com/photo-1551288049-bebda4e38f71?w=900&q=80
  * Team làm việc: https://images.unsplash.com/photo-1522071820081-009f0129c71c?w=900&q=80
  * Laptop/digital: https://images.unsplash.com/photo-1460925895917-afdab827c52f?w=900&q=80
  * Mobile/Zalo: https://images.unsplash.com/photo-1611162617213-7d7a39e9b1d7?w=900&q=80
- Đặt ảnh sau mỗi H2 lớn hoặc sau đoạn giới thiệu.

Yêu cầu BẢNG DỮ LIỆU (nếu phù hợp với chủ đề):
- Dùng markdown table để trình bày dữ liệu so sánh, danh sách, checklist.
- Ví dụ: | Tính năng | Thủ công | VIAi AI Agent |
- Nếu bài có thể có bảng thì bắt buộc phải có ít nhất 1 bảng.

Yêu cầu ĐỊNH DẠNG bổ sung:
- Dùng ordered list (1. 2. 3.) cho các bước hướng dẫn.
- Dùng > blockquote cho số liệu/trích dẫn nổi bật.
- Dùng --- để ngăn cách giữa các phần lớn (tùy chọn).

Chỉ trả về JSON hợp lệ, không thêm giải thích ngoài JSON. Schema:
{
  "title": "Tiêu đề bài viết",
  "seo_title": "SEO title tối đa 60 ký tự",
  "slug": "slug-khong-dau",
  "meta_description": "140-160 ký tự",
  "excerpt": "Tóm tắt 2-3 câu",
  "content": "Bài viết markdown 1000-1300 từ, không có H1, có H2/H3, internal link và CTA cuối bài",
  "faq": [{"question":"...","answer":"..."}],
  "image_prompt": "Prompt tạo ảnh thumbnail",
  "image_alt": "Alt ảnh thumbnail",
  "category": "Kiến thức AI",
  "author": "VIAi Team"
}`;

  try {
    const text = await runAnthropicPrompt(prompt, 5200);
    const draft = normalizeBlogDraft(extractJsonObject(text), input);
    if (input.image_url) draft.image_url = input.image_url;
    res.json({ draft, fallback: false });
  } catch (e) {
    if (shouldUseTemplateFallback(e)) {
      const draft = buildTemplateBlogDraft(input);
      if (input.image_url) draft.image_url = input.image_url;
      return res.json({
        draft,
        fallback: true,
        warning: e.message || 'Đang dùng bản nháp mẫu vì chưa cấu hình AI'
      });
    }
    res.status(e.statusCode || 500).json({ error: e.message || 'Lỗi AI' });
  }
});

router.post('/ai-blog-publish', auth, (req, res) => {
  try {
    const draft = normalizeBlogDraft(req.body.draft || req.body);
    if (!draft.title || !draft.content) {
      return res.status(400).json({ error: 'Bản nháp thiếu tiêu đề hoặc nội dung bài viết' });
    }

    const slug = uniqueSlug(draft.slug || draft.title);
    const publishedAt = new Date().toISOString().slice(0, 10);
    const imageUrl = draft.image_url || 'https://images.unsplash.com/photo-1677442136019-21780ecad995?w=900&q=80';

    const blogResult = db.prepare(`
      INSERT INTO blog_posts
        (title, excerpt, content, seo_title, meta_description, faq_json, image_alt, image_url, category, author, slug, published_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      draft.title,
      draft.excerpt,
      draft.content,
      draft.seo_title,
      draft.meta_description,
      JSON.stringify(draft.faq || []),
      draft.image_alt,
      imageUrl,
      draft.category || 'Kiến thức AI',
      draft.author || 'VIAi Team',
      slug,
      publishedAt,
      1
    );

    const sourceUrl = `/blog/${slug}`;
    const newsResult = db.prepare(`
      INSERT INTO news_posts (title, excerpt, image_url, source_name, source_tag, source_url, published_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      draft.title,
      draft.excerpt,
      imageUrl,
      'VIAi Blog',
      'viai',
      sourceUrl,
      publishedAt,
      1
    );

    res.json({
      success: true,
      url: sourceUrl,
      blog: db.prepare('SELECT * FROM blog_posts WHERE id = ?').get(blogResult.lastInsertRowid),
      news: db.prepare('SELECT * FROM news_posts WHERE id = ?').get(newsResult.lastInsertRowid)
    });
  } catch (e) {
    res.status(500).json({ error: e.message || 'Không đăng được bài viết' });
  }
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
  const options = { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VIAi-bot/1.0)' } };

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
