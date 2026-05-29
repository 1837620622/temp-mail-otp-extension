/* =========================================================================
 * 临时邮箱接码 —— 各家临时邮箱 API 连通性实测脚本
 * -------------------------------------------------------------------------
 * 目的：在对接进扩展之前，先验证全网主流免费临时邮箱服务是否真的可用：
 *       1) 能否列出可选域名
 *       2) 能否拿到一个邮箱地址（创建或随机生成）
 *       3) 能否正常查询收件箱（空收件箱也算通，说明链路打通）
 *
 * 运行：node test-apis.js   （需要 Node 18+，内置 fetch）
 * 说明：脚本只做只读查询与一次性临时邮箱创建，无任何破坏性操作。
 * ========================================================================= */

'use strict';

// ------------------------- 运行环境检查 -------------------------
if (typeof fetch === 'undefined') {
  console.error('需要 Node 18+（内置 fetch）。当前版本：' + process.version);
  process.exit(1);
}

// 统一请求封装：返回状态码、解析后的 json、以及截断的原始文本（便于排查）
async function req(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000); // 12 秒超时，避免卡死
  try {
    const r = await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: r.status, ok: r.ok, json: json, text: (text || '').slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

const rid = () => 'tmc' + Date.now().toString(36) + Math.floor(Math.random() * 900 + 100);

/* ===================== 各家服务的连通性测试 ===================== */

// mail.tm / mail.gw：同一套 REST API，仅域名不同（需创建账户 + 取 token）
async function testMailTMFamily(base, name) {
  const out = { name: name, base: base, domains: [], email: '', inbox: null, ok: false };
  try {
    const d = await req(base + '/domains', { headers: { Accept: 'application/ld+json' } });
    out.domains = ((d.json && d.json['hydra:member']) || []).map(function (x) { return x.domain; });
    if (!out.domains.length) throw new Error('域名列表为空 (HTTP ' + d.status + ')');

    const addr = rid() + '@' + out.domains[0];
    const pw = 'TmcPass123!';
    await req(base + '/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/ld+json' },
      body: JSON.stringify({ address: addr, password: pw })
    });
    const t = await req(base + '/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/ld+json' },
      body: JSON.stringify({ address: addr, password: pw })
    });
    const token = t.json && t.json.token;
    if (!token) throw new Error('获取 token 失败 (HTTP ' + t.status + ')');
    out.email = addr;

    const inbox = await req(base + '/messages', { headers: { Authorization: 'Bearer ' + token, Accept: 'application/ld+json' } });
    out.inbox = (inbox.json && inbox.json['hydra:member']) ? inbox.json['hydra:member'].length : 0;
    out.ok = inbox.ok;
  } catch (e) { out.error = e.message; }
  return out;
}

// 1secmail：无需账户，自选 login@domain，直接查收件箱
async function test1secmail() {
  const out = { name: '1secmail', base: 'https://www.1secmail.com/api/v1/', domains: [], email: '', inbox: null, ok: false };
  try {
    const d = await req('https://www.1secmail.com/api/v1/?action=getDomainList');
    out.domains = Array.isArray(d.json) ? d.json : [];
    if (!out.domains.length) throw new Error('域名列表为空 (HTTP ' + d.status + ') ' + d.text);
    const login = rid();
    const domain = out.domains[0];
    out.email = login + '@' + domain;
    const inbox = await req('https://www.1secmail.com/api/v1/?action=getMessages&login=' + login + '&domain=' + domain);
    out.inbox = Array.isArray(inbox.json) ? inbox.json.length : null;
    out.ok = Array.isArray(inbox.json);
  } catch (e) { out.error = e.message; }
  return out;
}

// Guerrilla Mail：session 机制，get_email_address 拿地址 + sid_token
async function testGuerrilla() {
  const out = { name: 'guerrillamail', base: 'https://api.guerrillamail.com/ajax.php', domains: [], email: '', inbox: null, ok: false };
  try {
    const r = await req('https://api.guerrillamail.com/ajax.php?f=get_email_address&lang=en');
    out.email = r.json && r.json.email_addr;
    const sid = r.json && r.json.sid_token;
    if (!out.email) throw new Error('获取邮箱失败 (HTTP ' + r.status + ') ' + r.text);
    out.domains = ['guerrillamail.com', 'sharklasers.com', 'grr.la', 'guerrillamail.net', 'guerrillamail.org', 'pokemail.net', 'spam4.me'];
    const inbox = await req('https://api.guerrillamail.com/ajax.php?f=check_email&seq=0&sid_token=' + encodeURIComponent(sid));
    out.inbox = (inbox.json && inbox.json.list) ? inbox.json.list.length : null;
    out.ok = !!(inbox.json && inbox.json.list !== undefined);
  } catch (e) { out.error = e.message; }
  return out;
}

// Dropmail.me：GraphQL，随机 token 即开一个会话，无需 key
async function testDropmail() {
  const out = { name: 'dropmail', base: 'https://dropmail.me/api/graphql/', domains: [], email: '', inbox: null, ok: false };
  try {
    const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    const query = '{ introduceSession { id expiresAt addresses { address } mails { id } } }';
    const r = await req('https://dropmail.me/api/graphql/' + token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query })
    });
    const s = r.json && r.json.data && r.json.data.introduceSession;
    if (!s) throw new Error('开会话失败 (HTTP ' + r.status + ') ' + r.text);
    out.email = s.addresses && s.addresses[0] && s.addresses[0].address;
    out.domains = (s.addresses || []).map(function (a) { return a.address.split('@')[1]; });
    out.inbox = s.mails ? s.mails.length : 0;
    out.ok = !!out.email;
  } catch (e) { out.error = e.message; }
  return out;
}

// TempMail.lol：/generate 拿地址 + token，/auth/{token} 查收件箱（新版可能需付费 key）
async function testTempmailLol() {
  const out = { name: 'tempmail.lol', base: 'https://api.tempmail.lol', domains: [], email: '', inbox: null, ok: false };
  try {
    const r = await req('https://api.tempmail.lol/generate');
    out.email = r.json && r.json.address;
    const token = r.json && r.json.token;
    if (!out.email) throw new Error('生成邮箱失败 (HTTP ' + r.status + '，可能已改为付费 key) ' + r.text);
    out.domains = [out.email.split('@')[1]];
    const inbox = await req('https://api.tempmail.lol/auth/' + token);
    out.inbox = (inbox.json && inbox.json.email) ? inbox.json.email.length : 0;
    out.ok = true;
  } catch (e) { out.error = e.message; }
  return out;
}

// TempMail.plus：自选 login@domain，GET /api/mails 查收件箱，无需 key
async function testTempmailPlus() {
  const out = { name: 'tempmail.plus', base: 'https://tempmail.plus/api', domains: [], email: '', inbox: null, ok: false };
  try {
    out.domains = ['mailto.plus', 'fexpost.com', 'fexbox.org', 'rover.info', 'chitthi.in', 'fextemp.com', 'any.pink', 'merepost.com'];
    const login = rid();
    const domain = out.domains[0];
    out.email = login + '@' + domain;
    const inbox = await req('https://tempmail.plus/api/mails?email=' + encodeURIComponent(out.email) + '&limit=20&epin=');
    // 返回结构 { result: true/false, mail_list: [...] }
    out.inbox = (inbox.json && Array.isArray(inbox.json.mail_list)) ? inbox.json.mail_list.length : null;
    out.ok = !!(inbox.json && (inbox.json.result === true || Array.isArray(inbox.json.mail_list)));
    if (!out.ok) out.error = 'HTTP ' + inbox.status + ' ' + inbox.text;
  } catch (e) { out.error = e.message; }
  return out;
}

/* ===================== 通用验证码提取（多格式）样本验证 ===================== */
// 通用网站验证码格式各异：纯数字、字母数字混合、各种长度。
// 思路：优先匹配“关键词 + 紧随的码”，再退化为独立的数字串 / 字母数字串；
//       但最终扩展里会完整展示邮件全文，下面只是“快捷复制候选”的提取演示。
function extractCodeCandidates(text) {
  const cands = [];
  const push = function (v) { if (v && cands.indexOf(v) === -1) cands.push(v); };
  const kw = /(?:验证码|校验码|动态码|验证代码|verification code|verify code|security code|one[-\s]?time|code|otp|pin)\s*(?:is|为|是|：|:|=)?\s*([A-Z0-9]{4,8})/gi;
  let m;
  while ((m = kw.exec(text)) !== null) push(m[1]);
  // 字母数字混合（同时含字母和数字，4-8 位）
  const mix = text.match(/\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*[0-9])[A-Z0-9]{4,8}\b/gi) || [];
  mix.forEach(push);
  // 纯数字 4-8 位
  const num = text.match(/\b\d{4,8}\b/g) || [];
  num.forEach(push);
  return cands;
}

function testExtract() {
  const samples = [
    ['纯数字6位', '【某网站】您的验证码是 482915，5分钟内有效。', '482915'],
    ['英文code', 'Your verification code is 9F3K2A. It expires in 10 minutes.', '9F3K2A'],
    ['OTP4位', 'Your OTP: 7421', '7421'],
    ['字母数字混合', 'Please use code ABC123 to verify your email.', 'ABC123'],
    ['8位数字', 'Confirmation number: 10293847', '10293847']
  ];
  console.log('\n========== 通用验证码提取（多格式）样本测试 ==========');
  samples.forEach(function (s) {
    const got = extractCodeCandidates(s[1]);
    const hit = got[0] === s[2] ? '✓' : '?';
    console.log('  ' + hit + ' [' + s[0] + '] 期望=' + s[2] + ' 候选=[' + got.join(', ') + ']');
  });
}

/* ============================== 主流程 ============================== */
(async function () {
  console.log('开始实测各家临时邮箱 API（Node ' + process.version + '）…\n');
  const tasks = [
    testMailTMFamily('https://api.mail.tm', 'mail.tm'),
    testMailTMFamily('https://api.mail.gw', 'mail.gw'),
    test1secmail(),
    testGuerrilla(),
    testDropmail(),
    testTempmailLol(),
    testTempmailPlus()
  ];
  const results = await Promise.all(tasks.map(function (p) {
    return p.catch(function (e) { return { name: '未知', ok: false, error: e.message }; });
  }));

  let okCount = 0;
  results.forEach(function (r) {
    if (r.ok) okCount++;
    console.log('===== ' + r.name + ' =====');
    console.log('  结果   : ' + (r.ok ? '✓ 跑通' : '✗ 失败'));
    console.log('  域名数 : ' + ((r.domains && r.domains.length) || 0) +
      (r.domains && r.domains.length ? '  例: ' + r.domains.slice(0, 5).join(', ') + (r.domains.length > 5 ? ' …' : '') : ''));
    console.log('  邮箱   : ' + (r.email || '-'));
    console.log('  收件箱 : ' + (r.inbox === null || r.inbox === undefined ? '查询失败' : r.inbox + ' 封'));
    if (r.error) console.log('  错误   : ' + r.error);
    console.log('');
  });
  console.log('==== 汇总：' + okCount + ' / ' + results.length + ' 家可用 ====');

  testExtract();
})();
