/* =========================================================================
 * 临时邮箱接码 —— 弹窗交互逻辑
 * 职责：与 background 通信（生成邮箱、列域名、查收件箱、监测开关），
 *       渲染邮箱/验证码/邮件全文，处理复制与实时轮询。
 * ========================================================================= */

'use strict';

const $ = function (sel) { return document.querySelector(sel); };

// ---------------- 与后台通信（Promise 封装，带错误兜底） ----------------
function send(msg) {
  return new Promise(function (resolve) {
    try {
      chrome.runtime.sendMessage(msg, function (resp) {
        if (chrome.runtime.lastError) { resolve({ ok: false, error: chrome.runtime.lastError.message }); return; }
        resolve(resp || { ok: false, error: '后台无响应' });
      });
    } catch (e) { resolve({ ok: false, error: e.message }); }
  });
}

// ---------------- 通用工具 ----------------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  const now = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return hh + ':' + mm;
  return (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hh + ':' + mm;
}

let toastTimer = null;
function toast(text) {
  const t = $('#toast');
  t.textContent = text; t.hidden = false;
  requestAnimationFrame(function () { t.classList.add('show'); });
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    t.classList.remove('show');
    setTimeout(function () { t.hidden = true; }, 220);
  }, 1600);
}

async function copyText(text, btn) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制：' + (text.length > 24 ? text.slice(0, 24) + '…' : text));
    if (btn) {
      const old = btn.textContent;
      btn.classList.add('copied'); btn.textContent = '已复制';
      setTimeout(function () { btn.classList.remove('copied'); btn.textContent = old; }, 1200);
    }
  } catch (e) {
    toast('复制失败，请手动选择文本');
  }
}

// ---------------- 运行期变量 ----------------
let services = [];
let pollTimer = null;
let lastShownCode = ''; // 已展示的验证码，用于触发「新码高亮」动画

// ---------------- 服务 / 域名 ----------------
function fillServices(list, current) {
  services = list || [];
  const sel = $('#serviceSel'); sel.innerHTML = '';
  services.forEach(function (s) {
    const o = document.createElement('option');
    o.value = s.key; o.textContent = s.name;
    if (s.key === current) o.selected = true;
    sel.appendChild(o);
  });
}

async function loadDomains(serviceKey) {
  const domSel = $('#domainSel');
  domSel.innerHTML = '<option>加载中…</option>'; domSel.disabled = true;
  const svc = services.find(function (s) { return s.key === serviceKey; });
  $('#loginRow').style.display = (svc && svc.selectableLogin) ? '' : 'none';
  $('#genHint').className = 'hint'; $('#genHint').textContent = '';

  const r = await send({ type: 'GET_DOMAINS', service: serviceKey });
  domSel.innerHTML = '';
  if (r.ok && r.domains && r.domains.length) {
    r.domains.forEach(function (d) {
      const o = document.createElement('option'); o.value = d; o.textContent = '@' + d; domSel.appendChild(o);
    });
    domSel.disabled = false;
  } else if (serviceKey === 'tmlol' || serviceKey === 'guerrilla') {
    // 这两家域名由服务自动分配，无法自选（Guerrilla 仍可自定义用户名）
    const o = document.createElement('option'); o.value = '';
    o.textContent = serviceKey === 'tmlol' ? '（随机域名，生成后分配）' : '（由 Guerrilla 自动分配）';
    domSel.appendChild(o); domSel.disabled = true;
    $('#genHint').textContent = serviceKey === 'tmlol'
      ? 'TempMail.lol 使用随机域名，直接点生成即可。'
      : 'Guerrilla 自动分配域名，可在上方自定义用户名后点生成。';
  } else {
    const o = document.createElement('option'); o.value = ''; o.textContent = '（暂无可用域名）';
    domSel.appendChild(o); domSel.disabled = true;
    $('#genHint').className = 'hint error';
    $('#genHint').textContent = '该服务暂不可用：' + (r.error || '列域名失败') + '，建议换一个服务。';
  }
}

// ---------------- 生成邮箱 ----------------
async function doGenerate() {
  const service = $('#serviceSel').value;
  const domain = $('#domainSel').value;
  const login = $('#loginInput').value.trim().replace(/[^a-zA-Z0-9._-]/g, '');
  const btn = $('#genBtn');
  const sp = btn.querySelector('.spinner');
  const lb = btn.querySelector('.btn-label');

  btn.disabled = true; sp.hidden = false; lb.textContent = '生成中…';
  $('#genHint').className = 'hint'; $('#genHint').textContent = '';

  const r = await send({ type: 'CREATE_MAILBOX', service: service, domain: domain, login: login });

  btn.disabled = false; sp.hidden = true; lb.textContent = '生成邮箱并开始接码';
  if (!r.ok) {
    $('#genHint').className = 'hint error';
    $('#genHint').textContent = '生成失败：' + (r.error || '未知错误');
    return;
  }
  $('#genHint').className = 'hint ok';
  $('#genHint').textContent = '已生成邮箱，正在自动监测来信…';
  $('#mailboxCard').classList.remove('hidden');
  $('#emailText').textContent = r.email;
  const svc = services.find(function (s) { return s.key === r.service; });
  $('#svcTag').textContent = svc ? svc.name : r.service;
  $('#mbMeta').textContent = '创建于 ' + fmtTime(new Date().toISOString());
  $('#monitorToggle').checked = true;
  $('#monitorBadge').className = 'status live';
  $('#monitorText').textContent = '监测中';
  await refresh();
  startPoll();
}

// ---------------- 渲染 ----------------
function render(st) {
  if (st.email) {
    $('#mailboxCard').classList.remove('hidden');
    $('#emailText').textContent = st.email;
    const svc = (st.services || services).find(function (s) { return s.key === st.service; });
    $('#svcTag').textContent = svc ? svc.name : st.service;
    $('#mbMeta').textContent = st.createdAt ? '创建于 ' + fmtTime(new Date(st.createdAt).toISOString()) : '';
  }
  const badge = $('#monitorBadge');
  if (st.monitoring) {
    badge.className = 'status live'; $('#monitorText').textContent = '监测中'; $('#monitorToggle').checked = true;
  } else {
    badge.className = 'status paused'; $('#monitorText').textContent = st.email ? '已暂停' : '未开始'; $('#monitorToggle').checked = false;
  }
  renderCodeAndMails(st.messages || []);
}

function renderCodeAndMails(messages) {
  messages = messages || [];
  const withCode = messages.find(function (m) { return m.codes && m.codes.length; });

  if (messages.length || $('#emailText').textContent) $('#codeCard').classList.remove('hidden');
  const cv = $('#codeValue');
  const chips = $('#codeChips');
  if (withCode) {
    const newCode = withCode.codes[0];
    if (newCode !== lastShownCode) { // 验证码变化时高亮闪动一次，提示「来新码了」
      lastShownCode = newCode;
      cv.classList.remove('flash'); void cv.offsetWidth; cv.classList.add('flash');
    }
    cv.textContent = newCode; cv.classList.remove('empty');
    chips.innerHTML = '';
    withCode.codes.forEach(function (c) {
      const el = document.createElement('button');
      el.className = 'chip';
      el.innerHTML = esc(c) + ' <span class="mini">复制</span>';
      el.addEventListener('click', function () { copyText(c, null); });
      chips.appendChild(el);
    });
  } else {
    lastShownCode = '';
    cv.textContent = '等待验证码…'; cv.classList.add('empty'); chips.innerHTML = '';
  }

  const listEl = $('#mailList');
  $('#mailCount').textContent = messages.length;

  if (!messages.length) {
    const hasMail = !!$('#emailText').textContent;
    listEl.innerHTML =
      '<div class="empty"><div class="empty-icon">' + (hasMail ? '⏳' : '📭') + '</div>' +
      '<p class="empty-title">' + (hasMail ? '邮箱已就绪，正在等待来信' : '还没有生成邮箱') + '</p>' +
      '<p class="empty-desc">' + (hasMail
        ? '把上方邮箱填到目标网站，验证码到达后会自动显示在这里。'
        : '选择服务与域名后，点「生成邮箱并开始接码」。') + '</p></div>';
    return;
  }

  // 记录当前展开的邮件 id，重建后恢复，避免轮询刷新时把用户正在看的邮件收起
  const openIds = [];
  document.querySelectorAll('#mailList .mail.open').forEach(function (el) { openIds.push(el.dataset.id); });

  listEl.innerHTML = '';
  messages.forEach(function (m, idx) {
    const code = (m.codes && m.codes[0]) || '';
    const div = document.createElement('div');
    div.className = 'mail' + (code ? ' has-code' : '');
    div.dataset.id = String(m.id);
    if (openIds.indexOf(String(m.id)) !== -1) div.classList.add('open');
    div.innerHTML =
      '<div class="mail-top">' +
        '<span class="mail-caret">▸</span>' +
        '<span class="mail-from">' + esc(m.from || '未知发件人') + '</span>' +
        (code ? '<span class="mail-badge">' + esc(code) + '</span>' : '') +
        '<span class="mail-time">' + esc(fmtTime(m.date)) + '</span>' +
      '</div>' +
      '<div class="mail-subject">' + esc(m.subject || '(无主题)') + '</div>' +
      '<div class="mail-body">' +
        '<div class="mail-text">' + esc(m.text || '(邮件正文为空)') + '</div>' +
        '<div class="mail-actions">' +
          (code ? '<button class="btn copy" data-act="code">复制验证码 ' + esc(code) + '</button>' : '') +
          '<button class="btn ghost" data-act="full">复制全文</button>' +
        '</div>' +
      '</div>';

    div.querySelector('.mail-top').addEventListener('click', function () { div.classList.toggle('open'); });
    const codeBtn = div.querySelector('[data-act="code"]');
    if (codeBtn) codeBtn.addEventListener('click', function (e) { e.stopPropagation(); copyText(code, codeBtn); });
    const fullBtn = div.querySelector('[data-act="full"]');
    fullBtn.addEventListener('click', function (e) { e.stopPropagation(); copyText(m.text || '', fullBtn); });

    listEl.appendChild(div);
  });
}

// ---------------- 刷新 / 轮询 ----------------
async function refresh() {
  const r = await send({ type: 'FETCH_INBOX' });
  if (r.ok) {
    renderCodeAndMails(r.messages || []);
    $('#footStatus').textContent = '已更新 · ' + new Date().toLocaleTimeString('zh-CN');
  } else {
    $('#footStatus').textContent = '查收失败：' + (r.error || '网络异常');
  }
}

function startPoll() { if (pollTimer) clearInterval(pollTimer); pollTimer = setInterval(refresh, 3000); }
function stopPoll() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }

// ---------------- 初始化 ----------------
async function init() {
  const s = await send({ type: 'GET_SERVICES' });
  if (s.ok) fillServices(s.services, s.current);

  const st = await send({ type: 'GET_STATE' });
  if (st && st.services) services = st.services;
  if (st && st.email && st.service) $('#serviceSel').value = st.service;

  await loadDomains($('#serviceSel').value);

  if (st && st.email) {
    if (st.domain) {
      const opt = Array.prototype.find.call($('#domainSel').options, function (o) { return o.value === st.domain; });
      if (opt) $('#domainSel').value = st.domain;
    }
    render(st);
    if (st.monitoring) startPoll();
  }

  // 事件绑定
  $('#serviceSel').addEventListener('change', function () { loadDomains(this.value); });
  $('#genBtn').addEventListener('click', doGenerate);
  $('#renewBtn').addEventListener('click', function () { $('#loginInput').value = ''; doGenerate(); });
  $('#copyEmailBtn').addEventListener('click', function () { copyText($('#emailText').textContent, this); });
  $('#copyCodeBtn').addEventListener('click', function () {
    const cv = $('#codeValue');
    if (cv.textContent && !cv.classList.contains('empty')) copyText(cv.textContent, this);
  });
  $('#refreshBtn').addEventListener('click', refresh);
  $('#monitorToggle').addEventListener('change', async function () {
    if (this.checked) {
      await send({ type: 'START_MONITOR' }); startPoll();
      $('#monitorBadge').className = 'status live'; $('#monitorText').textContent = '监测中';
    } else {
      await send({ type: 'STOP_MONITOR' }); stopPoll();
      $('#monitorBadge').className = 'status paused'; $('#monitorText').textContent = '已暂停';
    }
  });
}

document.addEventListener('DOMContentLoaded', init);
window.addEventListener('unload', stopPoll);
