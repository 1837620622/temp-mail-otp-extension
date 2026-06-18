/* =========================================================================
 * 临时邮箱接码 —— 后台服务脚本 (Service Worker)
 * -------------------------------------------------------------------------
 * 职责：
 *   1. 多家临时邮箱服务的统一适配（mail.tm / mail.gw / Guerrilla / TempMail.lol / TempMail.plus）
 *   2. 创建/生成邮箱、列出可选域名
 *   3. 收件箱轮询：完整保留邮件正文全文 + 智能提取多格式验证码候选
 *   4. 收到新验证码时弹出桌面通知
 *   5. 全局状态持久化（chrome.storage.local），worker 被回收后可恢复
 *
 * 说明：service worker 拥有 host_permissions，fetch 各家接口不受 CORS 限制，
 *       因此所有网络请求统一在此发起，popup 仅负责展示与交互。
 * ========================================================================= */

'use strict';

/* ============================== 常量与服务定义 ============================== */

// mail.tm / mail.gw 登录用的固定密码（仅用于这两家需要账户的服务）
const MAIL_PW = 'TmcMail2024!x';

// DustMail API 密钥（从 https://dustmail.net/dashboard 获取）
const DUSTMAIL_API_KEY = 'dm_live_uTDY_0KGHvyqiytV9pEPmmtIJgqAVhZ9';

// 各服务元信息：key 唯一标识，selectableLogin 表示是否支持自定义用户名
// DustMail 放在首位作为首发默认邮箱服务
const SERVICES = [
  { key: 'dust',      name: 'DustMail',       base: 'https://dustmail.net/api/v1',          selectableLogin: false, needAccount: false },
  { key: 'tm',        name: 'Mail.tm',        base: 'https://api.mail.tm',                 selectableLogin: true,  needAccount: true  },
  { key: 'gw',        name: 'Mail.gw',        base: 'https://api.mail.gw',                 selectableLogin: true,  needAccount: true  },
  { key: 'guerrilla', name: 'Guerrilla Mail', base: 'https://api.guerrillamail.com/ajax.php', selectableLogin: true,  needAccount: false },
  { key: 'tmlol',     name: 'TempMail.lol',   base: 'https://api.tempmail.lol',            selectableLogin: false, needAccount: false },
  { key: 'tmplus',    name: 'TempMail.plus',  base: 'https://tempmail.plus/api',           selectableLogin: true,  needAccount: false }
];

// TempMail.plus 的可选域名（该服务不提供「列域名」接口，用已知固定列表）
// 注：Guerrilla 实测无法通过 API 切换域名（set_email_user 的 domain 参数被忽略），故不在此列域名。
const STATIC_DOMAINS = {
  tmplus: ['mailto.plus', 'fexpost.com', 'fexbox.org', 'rover.info', 'chitthi.in', 'fextemp.com', 'any.pink', 'merepost.com']
};

function getService(key) {
  return SERVICES.find(function (s) { return s.key === key; }) || SERVICES[0];
}

/* ============================== 全局状态 ============================== */

let state = {
  service: 'dust',   // 当前服务 key（默认首选 DustMail）
  domain: '',        // 当前邮箱域名
  email: '',         // 当前邮箱地址
  token: '',         // mail.tm/gw 与 tmlol 的访问令牌
  sidToken: '',      // guerrilla 的会话令牌
  accountId: '',     // mail.tm/gw 的账户 id（SSE 备用）
  messages: [],      // 归一化后的收件箱：[{id, from, subject, date, text, codes}]
  monitoring: false, // 是否处于自动监测中
  lastCode: '',      // 最近一次识别到的验证码（用于新码通知去重）
  createdAt: 0       // 邮箱创建时间戳（用于有效期展示）
};

// worker 可能随时被回收，关键状态同步写入 storage；启动时异步恢复
const stateReady = new Promise(function (resolve) {
  chrome.storage.local.get('tmc_state', function (r) {
    if (r && r.tmc_state) state = Object.assign(state, r.tmc_state);
    resolve();
  });
});

function saveState() {
  chrome.storage.local.set({ tmc_state: state });
}

// 邮件正文详情缓存（内存级，按邮件 id 缓存归一化结果），避免轮询时对同一封邮件重复拉取详情。
// 仅在切换/重建邮箱时清空，不写入 storage，防止体积膨胀。
let detailCache = {};

/* ============================== 通用工具 ============================== */

// 随机用户名（小写字母+数字，避免特殊字符被服务端拒绝）
function randomLogin() {
  return 'tmc' + Date.now().toString(36) + Math.floor(Math.random() * 900 + 100);
}

// 带超时的 fetch，返回 { status, ok, json, text }
async function http(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, timeoutMs || 12000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (_) {}
    return { status: r.status, ok: r.ok, json: json, text: text };
  } finally {
    clearTimeout(timer);
  }
}

// HTML 转纯文本：去脚本/样式、标签转换行、解码常见实体，保留完整可读全文
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

// 解码 RFC 2047 编码的主题行（如 =?UTF-8?B?6Zi/6YeM?=）
function decodeSubject(subject) {
  if (!subject || subject.indexOf('=?') === -1) return subject || '(无主题)';
  try {
    return subject.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, function (_, charset, encoding, text) {
      if (encoding.toUpperCase() === 'B') {
        const bytes = Uint8Array.from(atob(text), function (c) { return c.charCodeAt(0); });
        return new TextDecoder(charset).decode(bytes);
      }
      if (encoding.toUpperCase() === 'Q') {
        return text.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, function (_, h) {
          return String.fromCharCode(parseInt(h, 16));
        });
      }
      return text;
    });
  } catch (e) {
    return subject;
  }
}

// 通用验证码候选提取：通用网站验证码格式各异（纯数字/字母数字/各长度），
// 因此优先匹配“关键词+紧随的码”，再退化为字母数字串、纯数字串；返回去重候选数组。
// 注意：扩展会完整展示邮件全文，这里只是“快捷复制候选”，不替代全文。
function extractCodeCandidates(text) {
  if (!text) return [];
  const cands = [];
  const push = function (v) { if (v && cands.indexOf(v) === -1) cands.push(v); };
  const kw = /(?:验证码|验证数字|验证數[字]?|校验码|动态码|验证代码|verification code|verify code|security code|one[-\s]?time|code|otp|pin)\s*(?:is|为|是|：|:|=)?\s*([A-Z0-9]{4,8})/gi;
  let m;
  while ((m = kw.exec(text)) !== null) push(m[1]);
  // 字母数字混合（同时含字母与数字，4-8 位）
  const mix = text.match(/\b(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*[0-9])[A-Z0-9]{4,8}\b/gi) || [];
  mix.forEach(push);
  // 纯数字 4-8 位
  const num = text.match(/\b\d{4,8}\b/g) || [];
  num.forEach(push);
  return cands.slice(0, 6);
}

/* ============================== 各服务适配层 ============================== */
/* 每个适配器实现两个语义：
 *   listDomains()                -> Promise<string[]>
 *   create({domain, login})      -> 写入 state（email/token/sid 等），返回 {ok,email,error}
 *   inbox()                      -> Promise<归一化消息数组>
 * 收件统一归一化为 {id, from, subject, date, text, codes}
 */

// ---------- mail.tm / mail.gw（API Platform 风格，需创建账户 + token） ----------
const tmAdapter = {
  async listDomains(base) {
    const r = await http(base + '/domains?page=1', { headers: { Accept: 'application/ld+json' } });
    return ((r.json && r.json['hydra:member']) || []).map(function (x) { return x.domain; });
  },
  async create(svc, domain, login) {
    const base = svc.base;
    const address = (login || randomLogin()) + '@' + domain;
    // 创建账户（422 表示已存在，可直接登录）
    const a = await http(base + '/accounts', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/ld+json' },
      body: JSON.stringify({ address: address, password: MAIL_PW })
    });
    if (!a.ok && a.status !== 422) return { ok: false, error: '创建账户失败 (HTTP ' + a.status + ')' };
    const t = await http(base + '/token', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/ld+json' },
      body: JSON.stringify({ address: address, password: MAIL_PW })
    });
    if (!t.json || !t.json.token) return { ok: false, error: '获取令牌失败 (HTTP ' + t.status + ')' };
    state.email = address; state.token = t.json.token;
    state.accountId = (a.json && a.json.id) || '';
    return { ok: true, email: address };
  },
  async inbox(svc) {
    const base = svc.base;
    const headers = { Authorization: 'Bearer ' + state.token, Accept: 'application/ld+json' };
    let r = await http(base + '/messages', { headers: headers });
    if (r.status === 401) { // 令牌过期，刷新重试
      const t = await http(base + '/token', {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/ld+json' },
        body: JSON.stringify({ address: state.email, password: MAIL_PW })
      });
      if (t.json && t.json.token) { state.token = t.json.token; saveState(); }
      r = await http(base + '/messages', { headers: { Authorization: 'Bearer ' + state.token, Accept: 'application/ld+json' } });
    }
    const msgs = (r.json && r.json['hydra:member']) || [];
    const list = [];
    for (const msg of msgs) {
      const id = String(msg.id);
      if (detailCache[id]) { list.push(detailCache[id]); continue; } // 命中缓存，跳过详情请求
      let detail = null;
      try {
        const d = await http(base + '/messages/' + msg.id, { headers: { Authorization: 'Bearer ' + state.token, Accept: 'application/ld+json' } });
        if (d.ok) detail = d.json;
      } catch (_) {}
      const src = detail || msg;
      const htmlStr = Array.isArray(src.html) ? src.html.join('\n') : (src.html || '');
      const text = (src.text && src.text.trim()) ? src.text : htmlToText(htmlStr);
      const item = {
        id: id,
        from: (src.from && (src.from.address || src.from.name)) || '',
        subject: src.subject || '(无主题)',
        date: src.createdAt || src.date || '',
        text: text || (src.intro || ''),
        codes: extractCodeCandidates(text || src.intro || '')
      };
      detailCache[id] = item;
      list.push(item);
    }
    return list;
  }
};

// ---------- Guerrilla Mail（会话机制，无需账户；域名由服务分配，仅可自定义用户名） ----------
const guerrillaAdapter = {
  // 实测：Guerrilla 的 set_email_user 只能改用户名，domain 参数被忽略（始终返回服务分配域名），
  // 因此不提供域名选择，统一交由服务分配，避免给用户造成「选了却没生效」的错觉。
  async listDomains() { return []; },
  async create(svc, domain, login) {
    const base = svc.base;
    const g = await http(base + '?f=get_email_address&lang=en&sid_token=' + encodeURIComponent(state.sidToken || ''));
    if (!g.json || !g.json.email_addr) return { ok: false, error: '获取邮箱失败 (HTTP ' + g.status + ')' };
    state.sidToken = g.json.sid_token || state.sidToken;
    let email = g.json.email_addr;
    // 仅自定义用户名（域名由服务分配，无法通过 API 更改）
    if (login) {
      const s = await http(base + '?f=set_email_user&email_user=' + encodeURIComponent(login) +
        '&lang=en&sid_token=' + encodeURIComponent(state.sidToken));
      if (s.json && s.json.email_addr) email = s.json.email_addr;
    }
    state.email = email;
    return { ok: true, email: email };
  },
  async inbox(svc) {
    const base = svc.base;
    // 用实测验证过的 check_email（seq=0 拉取全部），返回 { list: [...] }
    const r = await http(base + '?f=check_email&seq=0&sid_token=' + encodeURIComponent(state.sidToken));
    const arr = (r.json && r.json.list) || [];
    const list = [];
    for (const m of arr) {
      const id = String(m.mail_id);
      if (detailCache[id]) { list.push(detailCache[id]); continue; } // 命中缓存，跳过 fetch_email
      let body = m.mail_excerpt || '';
      try {
        const d = await http(base + '?f=fetch_email&email_id=' + encodeURIComponent(m.mail_id) + '&sid_token=' + encodeURIComponent(state.sidToken));
        if (d.json && d.json.mail_body) body = d.json.mail_body;
      } catch (_) {}
      const text = htmlToText(body);
      const item = {
        id: id,
        from: m.mail_from || '',
        subject: m.mail_subject || '(无主题)',
        date: m.mail_timestamp ? new Date(m.mail_timestamp * 1000).toISOString() : (m.mail_date || ''),
        text: text,
        codes: extractCodeCandidates(text)
      };
      detailCache[id] = item;
      list.push(item);
    }
    return list;
  }
};

// ---------- TempMail.lol（随机域名，无需账户） ----------
const tmlolAdapter = {
  async listDomains() { return state.domain ? [state.domain] : []; }, // 域名随机，创建后才知道
  async create(svc) {
    const base = svc.base;
    const g = await http(base + '/generate');
    if (!g.json || !g.json.address) return { ok: false, error: '生成邮箱失败 (HTTP ' + g.status + '，可能已改为付费 key)' };
    state.email = g.json.address; state.token = g.json.token;
    state.domain = g.json.address.split('@')[1];
    return { ok: true, email: g.json.address };
  },
  async inbox(svc) {
    const base = svc.base;
    const r = await http(base + '/auth/' + encodeURIComponent(state.token));
    const arr = (r.json && r.json.email) || [];
    return arr.map(function (m, i) {
      const text = (m.body && m.body.trim()) ? m.body : htmlToText(m.html || '');
      return {
        id: 'lol_' + String(m.date || '') + '_' + String(m.subject || '').slice(0, 24),
        from: m.from || '',
        subject: m.subject || '(无主题)',
        date: m.date ? new Date(m.date).toISOString() : '',
        text: text,
        codes: extractCodeCandidates(text)
      };
    });
  }
};

// ---------- TempMail.plus（自选 login@domain，无需账户） ----------
const tmplusAdapter = {
  async listDomains() { return STATIC_DOMAINS.tmplus.slice(); },
  async create(svc, domain, login) {
    state.email = (login || randomLogin()) + '@' + domain;
    return { ok: true, email: state.email };
  },
  async inbox(svc) {
    const base = svc.base;
    const r = await http(base + '/mails?email=' + encodeURIComponent(state.email) + '&limit=20&epin=');
    const arr = (r.json && r.json.mail_list) || [];
    const list = [];
    for (const m of arr) {
      const id = String(m.mail_id);
      if (detailCache[id]) { list.push(detailCache[id]); continue; } // 命中缓存，跳过详情请求
      let text = '';
      try {
        const d = await http(base + '/mails/' + encodeURIComponent(m.mail_id) + '?email=' + encodeURIComponent(state.email) + '&epin=');
        if (d.json) text = (d.json.text && d.json.text.trim()) ? d.json.text : htmlToText(d.json.html || '');
      } catch (_) {}
      if (!text) text = m.subject || '';
      const item = {
        id: id,
        from: m.from_mail || m.from_name || '',
        subject: m.subject || '(无主题)',
        date: m.time || '',
        text: text,
        codes: extractCodeCandidates(text)
      };
      detailCache[id] = item;
      list.push(item);
    }
    return list;
  }
};

// ---------- DustMail（官方 API v1，需 API Key，无需账户） ----------
const dustAdapter = {
  async listDomains() { return ['dustmail.net']; },
  async create(svc) {
    const base = svc.base;
    const r = await http(base + '/inbox', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + DUSTMAIL_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });
    if (!r.json || !r.json.success || !r.json.data || !r.json.data.email) {
      return { ok: false, error: 'DustMail 创建收件箱失败 (HTTP ' + r.status + ')' };
    }
    state.email = r.json.data.email;
    state.token = r.json.data.id;  // 用 token 字段存 inboxId
    state.sidToken = '';
    return { ok: true, email: state.email };
  },
  async inbox(svc) {
    const base = svc.base;
    if (!state.token) return [];
    const r = await http(base + '/inbox/' + encodeURIComponent(state.token), {
      headers: { 'Authorization': 'Bearer ' + DUSTMAIL_API_KEY }
    });
    const emails = (r.json && r.json.success && r.json.data && r.json.data.emails) || [];
    const list = [];
    for (const m of emails) {
      const id = String(m.id || (m.received_at || '') + '|' + (m.from || '') + '|' + (m.subject || '') + '|' + Math.random().toString(36).slice(2, 6));
      if (detailCache[id]) { list.push(detailCache[id]); continue; }
      const text = (m.text && m.text.trim()) ? m.text : htmlToText(m.html || '');
      const item = {
        id: id,
        from: m.from || '',
        subject: decodeSubject(m.subject),
        date: m.received_at || '',
        text: text,
        codes: extractCodeCandidates(text)
      };
      detailCache[id] = item;
      list.push(item);
    }
    return list;
  }
};

const ADAPTERS = { tm: tmAdapter, gw: tmAdapter, guerrilla: guerrillaAdapter, tmlol: tmlolAdapter, tmplus: tmplusAdapter, dust: dustAdapter };

/* ============================== 高层操作 ============================== */

// 列出某服务可选域名
async function listDomains(serviceKey) {
  const svc = getService(serviceKey);
  try {
    const domains = await ADAPTERS[svc.key].listDomains(svc.base);
    return { ok: true, domains: domains, selectableLogin: svc.selectableLogin };
  } catch (e) {
    return { ok: false, domains: [], error: e.message };
  }
}

// 创建/生成邮箱
async function createMailbox(serviceKey, domain, login) {
  const svc = getService(serviceKey);
  // 重置当前会话相关状态
  state.service = svc.key; state.domain = domain || '';
  state.token = ''; state.sidToken = ''; state.accountId = '';
  state.messages = []; state.lastCode = '';
  detailCache = {}; // 换邮箱时清空详情缓存，避免串号
  try {
    const r = await ADAPTERS[svc.key].create(svc, domain, login);
    if (!r.ok) return r;
    state.domain = state.email.split('@')[1] || domain || '';
    state.createdAt = Date.now();
    saveState();
    return { ok: true, email: state.email, service: svc.key, domain: state.domain };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// 拉取收件箱并归一化；发现新验证码时弹通知
async function fetchInbox() {
  if (!state.email) return { ok: false, error: '尚未生成邮箱', messages: [] };
  const svc = getService(state.service);
  try {
    const list = await ADAPTERS[svc.key].inbox(svc);
    // 按时间倒序（新邮件在前）
    list.sort(function (a, b) { return (b.date || '').localeCompare(a.date || ''); });
    state.messages = list;

    // 取最新一封带验证码的，作为「当前验证码」；与上次不同则通知
    const withCode = list.find(function (m) { return m.codes && m.codes.length; });
    const newest = withCode ? withCode.codes[0] : '';
    if (newest && newest !== state.lastCode) {
      state.lastCode = newest;
      notifyNewCode(newest, withCode.from);
    }
    saveState();
    return { ok: true, messages: list, code: newest };
  } catch (e) {
    return { ok: false, error: e.message, messages: state.messages };
  }
}

// 桌面通知：收到新验证码
function notifyNewCode(code, from) {
  try {
    chrome.notifications.create('tmc_code_' + Date.now(), {
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: '收到新验证码：' + code,
      message: '来自 ' + (from || '未知发件人') + '\n点击扩展图标查看完整邮件',
      priority: 2
    });
  } catch (_) {}
}

/* ============================== 自动监测（轮询） ============================== */

let pollTimer = null;

function startMonitor() {
  state.monitoring = true; saveState();
  if (pollTimer) clearInterval(pollTimer);
  fetchInbox(); // 立即查一次
  pollTimer = setInterval(fetchInbox, 5000); // 活跃期每 5 秒
  // worker 可能被回收，用 alarms 兜底唤醒（最小约 1 分钟）
  chrome.alarms.create('tmc_poll', { periodInMinutes: 1 });
}

function stopMonitor() {
  state.monitoring = false; saveState();
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  chrome.alarms.clear('tmc_poll');
}

// alarms 唤醒：若仍在监测则查一次并重建高频定时器
chrome.alarms.onAlarm.addListener(function (alarm) {
  if (alarm.name !== 'tmc_poll') return;
  stateReady.then(function () {
    if (!state.monitoring) return;
    fetchInbox();
    if (!pollTimer) pollTimer = setInterval(fetchInbox, 5000);
  });
});

/* ============================== 消息处理 ============================== */

function publicState() {
  return {
    service: state.service, domain: state.domain, email: state.email,
    messages: state.messages, monitoring: state.monitoring,
    lastCode: state.lastCode, createdAt: state.createdAt, services: SERVICES
  };
}

async function handleMessage(msg) {
  await stateReady;
  switch (msg.type) {
    case 'GET_STATE':     return publicState();
    case 'GET_SERVICES':  return { ok: true, services: SERVICES, current: state.service };
    case 'GET_DOMAINS':   return await listDomains(msg.service);
    case 'CREATE_MAILBOX': {
      const r = await createMailbox(msg.service, msg.domain, msg.login);
      if (r.ok) startMonitor(); // 生成后自动开始监测
      return r;
    }
    case 'FETCH_INBOX':   return await fetchInbox();
    case 'START_MONITOR': startMonitor(); return { ok: true };
    case 'STOP_MONITOR':  stopMonitor();  return { ok: true };
    default:              return { ok: false, error: '未知消息类型: ' + msg.type };
  }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  handleMessage(msg).then(sendResponse).catch(function (e) {
    sendResponse({ ok: false, error: e.message });
  });
  return true; // 异步响应
});

// worker 重启后，若之前在监测则自动恢复
stateReady.then(function () {
  if (state.monitoring && state.email) startMonitor();
});
