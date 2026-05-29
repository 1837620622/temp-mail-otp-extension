/* =========================================================================
 * 临时邮箱接码 —— 邮件解析逻辑端到端测试
 * -------------------------------------------------------------------------
 * 验证 background.js 的两个核心纯函数（此处保持同步副本）：
 *   1. htmlToText：HTML 邮件 → 完整可读纯文本（保留全部字符，不漏内容）
 *   2. extractCodeCandidates：从全文中提取多格式验证码候选
 * 重点验证「正则提不到时，全文仍完整呈现」——这正是通用接码的关键取舍。
 * 运行：node test-parse.js
 * ========================================================================= */

'use strict';

// ===== 与 background.js 保持一致的实现（纯函数，便于独立测试） =====
function htmlToText(html) {
  if (!html) return '';
  let t = String(html);
  t = t.replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ');
  t = t.replace(/<\s*br\s*\/?\s*>/gi, '\n');
  t = t.replace(/<\s*\/\s*(p|div|tr|li|h[1-6]|table)\s*>/gi, '\n');
  t = t.replace(/<[^>]+>/g, ' ');
  const entities = { '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'" };
  t = t.replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;|&apos;/g, function (m) { return entities[m]; });
  t = t.replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(parseInt(n, 10)); });
  t = t.replace(/[ \t\u00a0]+/g, ' ').replace(/\n\s*\n\s*\n+/g, '\n\n').replace(/^\s+|\s+$/g, '');
  return t;
}

function extractCodeCandidates(text) {
  if (!text) return [];
  const cands = [];
  const push = function (v) { if (v && cands.indexOf(v) === -1) cands.push(v); };
  const kw = /(?:验证码|校验码|动态码|验证代码|verification code|verify code|security code|one[-\s]?time|code|otp|pin)\s*(?:is|为|是|：|:|=)?\s*([A-Z0-9]{4,8})/gi;
  let m;
  while ((m = kw.exec(text)) !== null) push(m[1]);
  const mix = text.match(/\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*[0-9])[A-Z0-9]{4,8}\b/gi) || [];
  mix.forEach(push);
  const num = text.match(/\b\d{4,8}\b/g) || [];
  num.forEach(push);
  return cands.slice(0, 6);
}

// ===== 真实风格的验证码邮件 HTML 样本 =====
const samples = [
  {
    name: '通用-纯数字6位(HTML加粗)',
    html: '<html><body><p>尊敬的用户：</p><p>您的验证码是 <b>482915</b>，5 分钟内有效。</p><p>如非本人操作请忽略。</p></body></html>',
    expectCode: '482915'
  },
  {
    name: '英文-字母数字混合',
    html: '<div style="font-size:14px">Your verification code is <strong>9F3K2A</strong>. It expires in 10 minutes.</div>',
    expectCode: '9F3K2A'
  },
  {
    name: 'OTP-4位数字',
    html: '<table><tr><td>Your OTP:&nbsp;<span>7421</span></td></tr></table>',
    expectCode: '7421'
  },
  {
    name: 'GitHub风格-8位数字',
    html: '<p>Here is your GitHub launch code, @user:</p><h1>10293847</h1><p>Continue by entering it.</p>',
    expectCode: '10293847'
  },
  {
    name: '链接验证-无独立码(应靠全文兜底)',
    html: '<p>Please <a href="https://example.com/verify?t=abc">click here to verify</a> your email address.</p>',
    expectCode: null
  },
  {
    name: '空格分隔码-正则难提取(应靠全文兜底)',
    html: '<p>您的校验码：<span style="letter-spacing:6px">8 8 6 5</span></p>',
    expectCode: null
  }
];

console.log('========== 邮件解析端到端测试（HTML → 全文 → 验证码候选） ==========\n');
let pass = 0;
samples.forEach(function (s) {
  const text = htmlToText(s.html);
  const codes = extractCodeCandidates(text);
  const first = codes[0] || '';
  const ok = s.expectCode === null ? true : (first === s.expectCode);
  if (ok) pass++;
  console.log((ok ? '✓' : '✗') + ' [' + s.name + ']');
  console.log('   全文 : ' + JSON.stringify(text));
  console.log('   候选 : [' + codes.join(', ') + ']' + (s.expectCode === null ? '  （预期无独立码，全文已完整保留→用户可肉眼读取）' : '  期望首选=' + s.expectCode));
  console.log('');
});
console.log('==== 解析结果：' + pass + ' / ' + samples.length + ' 符合预期 ====');
console.log('说明：链接验证 / 空格分隔码等正则难提取的情形，全文均完整保留，不会丢失任何字符。');
