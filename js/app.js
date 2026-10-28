import * as M from './model.js';
import * as DB from './db.js';
import * as Sync from './sync.js';
import * as R from './receipt.js';

// ---------- globals ----------
let S;                                   // synced app state
const L = loadLocal();                   // device-only settings (client id, last sync)
let tab = 'trans', statsType = 'expense';
const cursor = new Date(); cursor.setDate(1);
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => { const v = +n || 0; return (v < 0 ? '-' : '') + '$' + Math.abs(v).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
const sfmt = n => { const v = Math.abs(+n || 0); return v >= 1000 ? '$' + (v / 1000).toFixed(v >= 10000 ? 0 : 1) + 'k' : '$' + Math.round(v); };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const COLORS = ['#ec7563', '#f2a05b', '#f5cd5f', '#d4e157', '#8bd47a', '#6fd3c9', '#78a9e8', '#a88be8', '#e88bc8', '#b0b0b5'];
const today = () => M.todayStr();
const cap = s => s[0].toUpperCase() + s.slice(1);

function loadLocal() { try { return JSON.parse(localStorage.getItem('mb_local')) || {}; } catch { return {}; } }
function saveLocal() { try { localStorage.setItem('mb_local', JSON.stringify(L)); } catch {} }
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast.t); toast.t = setTimeout(() => t.classList.remove('show'), ms); }

let saveTimer;
function commit() {
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await DB.save(S);
    if (Sync.hasToken()) doSync(false).catch(() => {});
  }, 500);
}

// ---------- boot ----------
async function init() {
  S = M.migrate((await DB.load()) || M.emptyState());
  if (M.materialize(S)) await DB.save(S);
  render();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
  if (L.clientId) Sync.loadGis().catch(() => {});
  notifyUpcoming();
  // New day while app stays open → post due items.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && M.materialize(S)) commit();
  });
}

// ---------- sync ----------
async function doSync(interactive = true) {
  const btn = $('#syncBtn'); btn.classList.add('spin');
  try {
    S = M.migrate(await Sync.sync(S, L.clientId, interactive));
    M.materialize(S);
    await DB.save(S);
    L.lastSync = new Date().toISOString(); saveLocal();
    render();
    if (interactive) toast('Synced with Google Drive ✓');
  } catch (e) { if (interactive) toast(e.message, 4500); throw e; }
  finally { btn.classList.remove('spin'); }
}

// ---------- reminders on this device ----------
function notifyUpcoming() {
  const days = S.settings.remindDays ?? 3;
  const due = M.projected(S, today(), M.addDays(today(), days));
  if (!due.length || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (L.lastNotified === today()) return;
  L.lastNotified = today(); saveLocal();
  const total = due.reduce((a, t) => a + (t.type === 'income' ? 0 : +t.amount), 0);
  navigator.serviceWorker?.ready.then(reg => reg.showNotification('Upcoming payments', {
    body: `${due.length} payment(s) in the next ${days} days — ${fmt(total)}\n` + due.slice(0, 4).map(t => `${t.date.slice(5)} ${t.note || ''} ${fmt(t.amount)}`).join('\n'),
    icon: 'icons/icon-192.png', tag: 'upcoming'
  })).catch(() => {});
}

// ---------- helpers ----------
function monthRange() {
  const y = cursor.getFullYear(), m = cursor.getMonth();
  return [M.ymd(new Date(y, m, 1)), M.ymd(new Date(y, m + 1, 0))];
}
const monthNav = () => `<div class="monthnav"><button data-act="prevMonth" aria-label="Previous month">‹</button><b>${cursor.getFullYear()} ${MONTHS[cursor.getMonth()]}</b><button data-act="nextMonth" aria-label="Next month">›</button></div>`;
const sortedGroups = () => M.live(S, 'groups').sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
function accountOptions(sel, { allowEmpty = false } = {}) {
  let h = allowEmpty ? '<option value="">—</option>' : '';
  for (const g of sortedGroups()) {
    const accs = M.live(S, 'accounts').filter(a => a.groupId === g.id && (!a.hidden || a.id === sel) && !a.mortgageAccount);
    if (!accs.length) continue;
    h += `<optgroup label="${esc(g.name)}">` + accs.map(a => `<option value="${a.id}" ${a.id === sel ? 'selected' : ''}>${esc(a.name)}</option>`).join('') + '</optgroup>';
  }
  return h;
}
function categoryOptions(type, sel) {
  const cats = M.live(S, 'categories').filter(c => c.type === type).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  let h = '<option value="">— Choose —</option>';
  for (const p of cats.filter(c => !c.parentId)) {
    h += `<option value="${p.id}" ${p.id === sel ? 'selected' : ''}>${esc((p.emoji ? p.emoji + ' ' : '') + p.name)}</option>`;
    for (const c of cats.filter(c => c.parentId === p.id))
      h += `<option value="${c.id}" ${c.id === sel ? 'selected' : ''}>&nbsp;&nbsp;&nbsp;↳ ${esc(c.name)}</option>`;
  }
  return h;
}
const mortgageOptions = sel => M.live(S, 'mortgages').map(m => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('') || '<option value="">Add a mortgage first (More › Mortgages)</option>';
const freqOptions = sel => Object.entries(M.FREQS).map(([k, v]) => `<option value="${k}" ${k === sel ? 'selected' : ''}>${v}</option>`).join('');
function defaultAccount() {
  if (L.lastAccountId && M.get(S, 'accounts', L.lastAccountId)) return L.lastAccountId;
  return M.live(S, 'accounts').find(a => !a.mortgageAccount)?.id || '';
}
function txLabel(t) {
  if (t.type === 'transfer') return '↔ Transfer';
  if (t.type === 'mortgage') return t.prepayment ? '🏡 Prepayment' : '🏡 Mortgage';
  return M.catLabel(S, t.categoryId);
}
function txRow(t, splits = {}) {
  const cls = t.type === 'income' ? 'inc' : t.type === 'transfer' ? 'xfer' : 'exp';
  let acc = M.accName(S, t.accountId);
  if (t.type === 'transfer') acc += ' → ' + M.accName(S, t.toAccountId);
  if (t.type === 'mortgage') { const sp = splits[t.id]; acc += sp ? ` · P ${fmt(sp.principal)} / I ${fmt(sp.interest)}` : ` · ${esc(M.get(S, 'mortgages', t.mortgageId)?.name || '')}`; }
  const target = t.projected && t.recurringId && !M.get(S, 'transactions', t.id)
    ? `data-act="editRule" data-id="${t.recurringId}"` : `data-act="editTxn" data-id="${t.id}"`;
  const freq = t.recurringId ? (M.FREQS[M.get(S, 'recurring', t.recurringId)?.freq] || '') : '';
  return `<div class="tx ${t.projected ? 'proj' : ''}" ${target}>
    <div class="tx-cat">${esc(txLabel(t))}</div>
    <div class="tx-main"><div>${esc(t.note || '')} ${t.projected ? '<span class="badge">Scheduled</span>' : ''}</div>
    <small>${esc(acc)}${freq ? ' (' + freq + ')' : ''}</small></div>
    <div class="amt ${cls}">${fmt(t.amount)}</div></div>`;
}

// ---------- views ----------
const titles = { trans: 'Transactions', calendar: 'Calendar', stats: 'Stats', accounts: 'Accounts', more: 'More' };
function render() {
  document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  $('#title').textContent = titles[tab];
  $('#fab').style.display = tab === 'more' ? 'none' : '';
  $('#view').innerHTML = { trans: viewTrans, calendar: viewCalendar, stats: viewStats, accounts: viewAccounts, more: viewMore }[tab]();
}

function viewTrans() {
  const [from, to] = monthRange(); const t0 = today();
  const posted = M.live(S, 'transactions').filter(t => t.date >= from && t.date <= to && t.date <= t0);
  const proj = M.projected(S, from, to);
  const { inc, exp } = M.sumIE(posted);
  const { map: splits } = M.mortgageSplits(S);
  const days = S.settings.remindDays ?? 3;
  const soon = M.projected(S, t0, M.addDays(t0, days));
  const soonTotal = soon.reduce((a, t) => a + (t.type === 'income' ? 0 : +t.amount), 0);
  const byDay = {};
  [...posted, ...proj].forEach(t => (byDay[t.date] = byDay[t.date] || []).push(t));
  const dates = Object.keys(byDay).sort().reverse();
  let h = monthNav() + `<div class="summary"><div><small>Income</small><b class="inc">${fmt(inc)}</b></div><div><small>Expenses</small><b class="exp">${fmt(exp)}</b></div><div><small>Net</small><b>${fmt(inc - exp)}</b></div></div>`;
  if (soon.length) h += `<div class="banner">⏰ <b>${soon.length} upcoming</b> in the next ${days} days — ${fmt(soonTotal)}. Not deducted from balances until the due date.</div>`;
  if (!dates.length) h += '<div class="empty">No transactions this month.<br>Tap + to add one.</div>';
  for (const d of dates) {
    const list = byDay[d]; const dt = M.parseYmd(d);
    const real = list.filter(t => !t.projected); const s = M.sumIE(real);
    h += `<div class="day"><div class="dayhead"><span class="d">${dt.getDate()}</span><span class="wd">${WD[dt.getDay()]}</span><small class="sub2">${d.slice(0, 7)}</small><span class="sp"></span>
      <span class="amt inc">${s.inc ? fmt(s.inc) : ''}</span><span class="amt exp">${s.exp ? fmt(s.exp) : ''}</span></div>
      ${list.map(t => txRow(t, splits)).join('')}</div>`;
  }
  return h;
}

function viewCalendar() {
  const [from, to] = monthRange(); const t0 = today();
  const first = M.parseYmd(from); const start = M.addDays(from, -first.getDay());
  const end = M.addDays(to, 6 - M.parseYmd(to).getDay());
  const posted = M.live(S, 'transactions').filter(t => t.date >= start && t.date <= end && t.date <= t0);
  const proj = M.projected(S, start, end);
  const agg = {};
  const bucket = d => (agg[d] = agg[d] || { inc: 0, exp: 0, sch: 0, n: 0 });
  posted.forEach(t => { const b = bucket(t.date); if (t.type === 'income') b.inc += +t.amount; else if (t.type !== 'transfer') b.exp += +t.amount; });
  proj.forEach(t => { const b = bucket(t.date); b.sch += t.type === 'income' ? 0 : +t.amount; b.n++; });
  let h = monthNav() + '<div class="cal">' + WD.map(w => `<div class="h">${w}</div>`).join('');
  for (let d = start; d <= end; d = M.addDays(d, 1)) {
    const a = agg[d]; const out = d < from || d > to;
    h += `<div class="c ${out ? 'out' : ''} ${d === t0 ? 'today' : ''}" data-act="day" data-date="${d}"><span class="n">${+d.slice(8)}</span>
      ${a?.inc ? `<span class="inc">${sfmt(a.inc)}</span>` : ''}${a?.exp ? `<span class="exp">${sfmt(a.exp)}</span>` : ''}
      ${a?.n ? `<span class="s">⏰${sfmt(a.sch)}</span>` : ''}</div>`;
  }
  h += '</div>';
  const up = M.projected(S, t0, M.addDays(t0, 45));
  h += `<div class="section-title">Upcoming payments (next 45 days)</div><div class="list">` +
    (up.length ? up.map(t => `<div class="li" ${t.recurringId && !M.get(S, 'transactions', t.id) ? `data-act="editRule" data-id="${t.recurringId}"` : `data-act="editTxn" data-id="${t.id}"`}>
      <div style="min-width:52px"><b>${MONTHS[+t.date.slice(5, 7) - 1]} ${+t.date.slice(8)}</b></div>
      <div class="grow">${esc(t.note || txLabel(t))}<small>${esc(M.accName(S, t.accountId))}</small></div>
      <span class="${t.type === 'income' ? 'inc' : 'exp'}">${fmt(t.amount)}</span></div>`).join('')
      : '<div class="empty">Nothing scheduled. Add repeating payments in More › Repeat.</div>') + '</div>';
  h += `<div class="pad hint">⏰ amounts are scheduled — they count in balances only on their due date. For phone alerts, turn on “Google Calendar reminder” on a repeat payment.</div>`;
  return h;
}

function viewStats() {
  const [from, to] = monthRange();
  const { top } = M.categoryTotals(S, from, to, statsType);
  const rows = Object.entries(top).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((a, [, v]) => a + v, 0);
  let h = monthNav() + `<div class="seg"><button data-act="statsType" data-type="income" class="${statsType === 'income' ? 'on' : ''}">Income</button><button data-act="statsType" data-type="expense" class="${statsType === 'expense' ? 'on' : ''}">Expenses</button></div>`;
  if (!rows.length) return h + '<div class="empty">No data for this month.</div>';
  let acc = 0;
  const stops = rows.map(([, v], i) => { const a = acc; acc += v / total * 100; return `${COLORS[i % COLORS.length]} ${a}% ${acc}%`; });
  h += `<div class="pie" style="background:conic-gradient(${stops.join(',')})"><b>${fmt(total)}</b></div><div class="list">`;
  rows.forEach(([id, v], i) => {
    const c = M.get(S, 'categories', id);
    h += `<div class="li" data-act="statsCat" data-id="${id}"><span class="pct" style="background:${COLORS[i % COLORS.length]}">${Math.round(v / total * 100)}%</span>
      <span class="grow">${esc(c ? `${c.emoji || ''} ${c.name}` : 'Uncategorized')}</span><span>${fmt(v)}</span><span class="chev">›</span></div>`;
  });
  return h + '</div>';
}

function viewAccounts() {
  const b = M.balances(S); const tot = M.totals(S, b);
  let h = `<div class="summary"><div><small>Assets</small><b class="inc">${fmt(tot.assets)}</b></div><div><small>Liabilities</small><b class="exp">${fmt(tot.liabilities)}</b></div><div><small>Net worth</small><b>${fmt(tot.net)}</b></div></div>`;
  for (const g of sortedGroups()) {
    const accs = M.live(S, 'accounts').filter(a => a.groupId === g.id && !a.hidden);
    if (!accs.length) continue;
    const gsum = accs.reduce((a, x) => a + (b[x.id] || 0), 0);
    h += `<div class="grouphead"><span>${esc(g.name)}</span><span class="${gsum < 0 ? 'exp' : 'inc'}">${fmt(gsum)}</span></div><div class="list">`;
    for (const a of accs) {
      const v = b[a.id] || 0; let extra = '';
      if (a.statementDay) {
        const sd = M.lastStatementDate(+a.statementDay); const atStmt = M.balances(S, sd)[a.id] || 0;
        extra = `<small>Statement (${sd.slice(5)}): ${fmt(-atStmt)} · New since: ${fmt(-(v - atStmt))}</small>`;
      }
      const mort = M.live(S, 'mortgages').find(m => m.accountId === a.id);
      if (mort) extra = `<small>${mort.rate}% · ${M.MORT_FREQ[mort.frequency]} ${fmt(mort.payment)}</small>`;
      h += `<div class="li" data-act="${mort ? 'openMortgage' : 'editAccount'}" data-id="${mort ? mort.id : a.id}"><div class="grow">${esc(a.name)}${a.includeInTotals === false ? ' <span class="sub2">(excluded)</span>' : ''}${extra}</div>
        <span class="${v < 0 ? 'exp' : 'inc'}">${fmt(v)}</span><span class="chev">›</span></div>`;
    }
    h += '</div>';
  }
  return h + `<div class="btnrow" style="margin-top:12px"><button class="secondary" data-act="editAccount">+ Account</button><button class="secondary" data-act="editGroup">+ Group</button></div>`;
}

function viewMore() {
  const item = (act, icon, t, sub = '') => `<div class="li" data-act="${act}"><span style="font-size:20px">${icon}</span><div class="grow">${t}${sub ? `<small>${sub}</small>` : ''}</div><span class="chev">›</span></div>`;
  const nm = M.live(S, 'mortgages').length, nr = M.live(S, 'recurring').length, nl = M.live(S, 'rules').length;
  return `<div class="menu">
    ${item('mortgages', '🏡', 'Mortgages', nm ? `${nm} tracked` : 'Track balance, interest & principal')}
    ${item('recurring', '🔁', 'Repeat payments', nr ? `${nr} scheduled` : 'Bills, RESP, mortgage, phone…')}
    ${item('categories', '🏷️', 'Categories & subcategories')}
    ${item('manageAccounts', '🏦', 'Accounts & groups')}
    ${item('receiptRules', '🧾', 'Receipt learning', `${nl} merchant${nl === 1 ? '' : 's'} learned`)}
  </div><div class="menu">
    ${item('syncScreen', '☁️', 'Google Drive sync & backup', L.lastSync ? 'Last sync ' + new Date(L.lastSync).toLocaleString('en-CA') : 'Not set up')}
    ${item('settings', '⚙️', 'Settings & reminders')}
  </div><div class="pad hint">MoneyBook keeps your data on this device and in a private app folder in your own Google Drive. Nothing is sent anywhere else.</div>`;
}

// ---------- sheet ----------
function openSheet(title, html) {
  $('#sheet .sheet-body').innerHTML = `<h2>${esc(title)}<button data-act="closeSheet" aria-label="Close">✕</button></h2>${html}`;
  $('#sheet').classList.remove('hidden');
  $('#sheet .sheet-body').scrollTop = 0;
  return $('#sheet .sheet-body');
}
const closeSheet = () => $('#sheet').classList.add('hidden');
const fv = (f, n) => f.elements[n]?.value?.trim() ?? '';

// ---------- transaction editor ----------
function editTxn(t, preset = {}) {
  const isNew = !t;
  t = t ? { ...t } : { id: M.uid(), type: 'expense', date: today(), amount: '', accountId: defaultAccount(), categoryId: '', note: '', desc: '', ...preset };
  const body = openSheet(isNew ? 'Add transaction' : 'Edit transaction', `
    <div class="seg" id="ttype">${['expense', 'income', 'transfer', 'mortgage'].map(x => `<button type="button" data-type="${x}" class="${t.type === x ? 'on' : ''}">${cap(x)}</button>`).join('')}</div>
    <form id="f">
      <div class="f-scan"><button type="button" id="scanBtn" class="secondary" style="width:100%">📷 Scan receipt</button>
        <input type="file" id="scanFile" accept="image/*" capture="environment" hidden><div id="scanMsg" class="hint"></div></div>
      <div class="two"><label>Date<input type="date" name="date" value="${t.date}" required></label>
      <label>Amount<input type="number" step="0.01" min="0" inputmode="decimal" name="amount" value="${t.amount}" required></label></div>
      <label class="f-acc"><span class="lbl-acc">Account</span><select name="accountId">${accountOptions(t.accountId)}</select></label>
      <label class="f-to">To account<select name="toAccountId">${accountOptions(t.toAccountId, { allowEmpty: true })}</select></label>
      <label class="f-cat">Category<select name="categoryId"></select></label>
      <label class="f-mort">Mortgage<select name="mortgageId">${mortgageOptions(t.mortgageId)}</select></label>
      <label class="f-mort check"><input type="checkbox" name="prepayment" ${t.prepayment ? 'checked' : ''}> Lump-sum prepayment (100% goes to principal)</label>
      <label>Note<input name="note" value="${esc(t.note)}" placeholder="e.g. Costco" autocomplete="off"></label>
      <label>Description<textarea name="desc">${esc(t.desc)}</textarea></label>
      ${isNew ? `<label>Repeat<select name="repeat"><option value="">Don't repeat</option>${freqOptions('')}</select></label>` : ''}
      <div id="futureHint" class="hint"></div>
      <div class="row"><button class="primary">Save</button>${!isNew ? '<button type="button" id="del" class="danger">Delete</button>' : ''}</div>
      ${t.recurringId ? '<div class="hint">This is one occurrence of a repeat payment — edits apply only to this date.</div>' : ''}
    </form>`);
  const f = body.querySelector('#f');
  let catTouched = !!t.categoryId;
  function applyType() {
    const ty = t.type;
    body.querySelectorAll('#ttype button').forEach(b => b.classList.toggle('on', b.dataset.type === ty));
    body.querySelectorAll('.f-to').forEach(e => e.classList.toggle('hidden-f', ty !== 'transfer'));
    body.querySelectorAll('.f-cat').forEach(e => e.classList.toggle('hidden-f', ty === 'transfer' || ty === 'mortgage'));
    body.querySelectorAll('.f-mort').forEach(e => e.classList.toggle('hidden-f', ty !== 'mortgage'));
    body.querySelectorAll('.f-scan').forEach(e => e.classList.toggle('hidden-f', ty !== 'expense'));
    body.querySelector('.lbl-acc').textContent = ty === 'transfer' ? 'From account' : ty === 'mortgage' ? 'Paid from' : 'Account';
    f.categoryId.innerHTML = categoryOptions(ty === 'income' ? 'income' : 'expense', t.categoryId);
  }
  function futureHint() { body.querySelector('#futureHint').textContent = f.date.value > today() ? '⏰ Future date — this will show as scheduled and won’t affect balances until then.' : ''; }
  body.querySelector('#ttype').onclick = e => { const b = e.target.closest('button'); if (b) { t.type = b.dataset.type; applyType(); } };
  f.date.oninput = futureHint;
  f.categoryId.onchange = () => { catTouched = true; t.categoryId = f.categoryId.value; };
  f.note.onchange = () => {
    if (t.type !== 'expense' || catTouched) return;
    const sg = R.suggest(S, f.note.value);
    if (sg.categoryId) { f.categoryId.value = sg.categoryId; t.categoryId = sg.categoryId; }
    if (sg.accountId) f.accountId.value = sg.accountId;
  };
  applyType(); futureHint();

  // receipt scanning
  const msg = s => (body.querySelector('#scanMsg').textContent = s);
  body.querySelector('#scanBtn').onclick = () => body.querySelector('#scanFile').click();
  body.querySelector('#scanFile').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    msg('Reading receipt… (first scan downloads the OCR engine, ~10 MB)');
    try {
      const text = await R.ocr(file, p => msg(`Reading receipt… ${Math.round(p * 100)}%`));
      const r = R.parseReceipt(text);
      if (r.total) f.amount.value = r.total.toFixed(2);
      if (r.date) f.date.value = r.date;
      if (r.merchant) f.note.value = r.merchant;
      const sg = R.suggest(S, r.merchant, r.last4);
      if (sg.accountId) f.accountId.value = sg.accountId;
      if (sg.categoryId) { f.categoryId.value = sg.categoryId; t.categoryId = sg.categoryId; catTouched = true; }
      f.desc.value = text.split('\n').filter(Boolean).slice(0, 12).join('\n');
      futureHint();
      const found = [r.total ? 'total' : null, r.date ? 'date' : null, r.merchant ? 'store' : null].filter(Boolean).join(', ') || 'nothing clear';
      body.querySelector('#scanMsg').className = 'hint ok';
      msg(sg.rule ? `Read ${found}. Recognised “${sg.rule.merchant}” (learned from ${sg.rule.hits} receipt${sg.rule.hits > 1 ? 's' : ''}) — check and save.`
        : `Read ${found}. New store — pick the account & category once and I’ll remember them.`);
    } catch (err) { msg('Could not read receipt: ' + err.message); }
  };

  if (!isNew) body.querySelector('#del').onclick = () => { if (confirm('Delete this transaction?')) { M.remove(S, 'transactions', t.id); closeSheet(); commit(); toast('Deleted'); } };
  f.onsubmit = e => {
    e.preventDefault();
    const amount = parseFloat(f.amount.value);
    if (!(amount > 0)) return toast('Enter an amount');
    const rec = {
      ...t, type: t.type, date: f.date.value, amount: M.round2(amount), accountId: f.accountId.value,
      note: fv(f, 'note'), desc: fv(f, 'desc')
    };
    rec.toAccountId = t.type === 'transfer' ? f.toAccountId.value : undefined;
    rec.categoryId = t.type === 'expense' || t.type === 'income' ? f.categoryId.value : undefined;
    rec.mortgageId = t.type === 'mortgage' ? f.mortgageId.value : undefined;
    rec.prepayment = t.type === 'mortgage' ? f.prepayment.checked : undefined;
    if (t.type === 'transfer' && (!rec.toAccountId || rec.toAccountId === rec.accountId)) return toast('Choose a different “to” account');
    if (t.type === 'mortgage' && !rec.mortgageId) return toast('Add a mortgage first (More › Mortgages)');
    if ((t.type === 'expense' || t.type === 'income') && !rec.categoryId) return toast('Choose a category');
    L.lastAccountId = rec.accountId; saveLocal();
    if (t.type === 'expense' && rec.note) R.learn(S, rec.note, rec.accountId, rec.categoryId);
    const repeat = isNew && f.repeat.value;
    if (repeat) {
      const { id, date, ...template } = rec;
      const r = { id: M.uid(), freq: repeat, interval: 1, startDate: date, template };
      M.put(S, 'recurring', r);
      M.materialize(S);
      toast('Repeat payment created');
    } else { M.put(S, 'transactions', rec); toast(rec.date > today() ? 'Scheduled ⏰' : 'Saved'); }
    closeSheet(); commit();
  };
}

// ---------- recurring ----------
function listRecurring() {
  const rows = M.live(S, 'recurring').map(r => ({ r, next: M.nextDue(r, today(), 1)[0] || '' })).sort((a, b) => (a.next || '9').localeCompare(b.next || '9'));
  const total = rows.filter(x => x.r.template.type !== 'income' && !x.r.paused).reduce((a, x) => a + +x.r.template.amount, 0);
  const body = openSheet('Repeat payments', `<div class="list">${rows.map(({ r, next }) => `<div class="li" data-act="editRule" data-id="${r.id}">
      <div style="min-width:80px"><b>${next || '—'}</b><small>${M.FREQS[r.freq]}</small></div>
      <div class="grow">${esc(r.template.note || txLabel(r.template))}${r.paused ? ' <span class="sub2">(paused)</span>' : ''}${r.gcalEventId ? ' 🔔' : ''}<small>${esc(M.accName(S, r.template.accountId))} · ${esc(txLabel(r.template))}</small></div>
      <span class="${r.template.type === 'income' ? 'inc' : 'exp'}">${fmt(r.template.amount)}</span></div>`).join('') || '<div class="empty">No repeat payments yet.</div>'}</div>
    <div class="hint">Total per occurrence (expenses): ${fmt(total)}. 🔔 = Google Calendar reminder on.</div>
    <div class="row"><button class="primary" id="addR">+ Add repeat payment</button></div>`);
  body.querySelector('#addR').onclick = () => editRecurring();
}
function editRecurring(r) {
  const isNew = !r;
  r = r ? JSON.parse(JSON.stringify(r)) : { id: M.uid(), freq: 'monthly', interval: 1, startDate: today(), template: { type: 'expense', amount: '', accountId: defaultAccount(), note: '' } };
  const t = r.template;
  const nexts = isNew ? [] : M.nextDue(r, today(), 4);
  const body = openSheet(isNew ? 'New repeat payment' : 'Edit repeat payment', `
    <div class="seg" id="ttype">${['expense', 'income', 'transfer', 'mortgage'].map(x => `<button type="button" data-type="${x}" class="${t.type === x ? 'on' : ''}">${cap(x)}</button>`).join('')}</div>
    <form id="f">
      <label>Name / note<input name="note" value="${esc(t.note)}" placeholder="e.g. Internet bill" required></label>
      <div class="two"><label>Amount<input type="number" step="0.01" min="0" inputmode="decimal" name="amount" value="${t.amount}" required></label>
      <label>Repeats<select name="freq">${freqOptions(r.freq)}</select></label></div>
      <div class="two"><label>First / next due date<input type="date" name="startDate" value="${r.startDate}" required></label>
      <label>End date (optional)<input type="date" name="endDate" value="${r.endDate || ''}"></label></div>
      <label><span class="lbl-acc">Account</span><select name="accountId">${accountOptions(t.accountId)}</select></label>
      <label class="f-to">To account<select name="toAccountId">${accountOptions(t.toAccountId, { allowEmpty: true })}</select></label>
      <label class="f-cat">Category<select name="categoryId"></select></label>
      <label class="f-mort">Mortgage<select name="mortgageId">${mortgageOptions(t.mortgageId)}</select></label>
      <label class="check"><input type="checkbox" name="gcal" ${r.gcalEventId ? 'checked' : ''}> 🔔 Google Calendar reminder (${S.settings.remindDays ?? 3} days before + on the day)</label>
      ${!isNew ? `<label class="check"><input type="checkbox" name="paused" ${r.paused ? 'checked' : ''}> Paused</label>` : ''}
      ${isNew ? `<label class="check f-back"><input type="checkbox" name="backfill"> Also create past occurrences since the start date</label>` : ''}
      ${nexts.length ? `<div class="hint">Next: ${nexts.join(' · ')}</div>` : ''}
      <div class="hint">Scheduled amounts appear on the calendar but only hit your balances on the due date.</div>
      <div class="row"><button class="primary">Save</button>${!isNew ? '<button type="button" id="del" class="danger">Delete</button>' : ''}</div>
    </form>`);
  const f = body.querySelector('#f');
  function applyType() {
    const ty = t.type;
    body.querySelectorAll('#ttype button').forEach(b => b.classList.toggle('on', b.dataset.type === ty));
    body.querySelectorAll('.f-to').forEach(e => e.classList.toggle('hidden-f', ty !== 'transfer'));
    body.querySelectorAll('.f-cat').forEach(e => e.classList.toggle('hidden-f', ty === 'transfer' || ty === 'mortgage'));
    body.querySelectorAll('.f-mort').forEach(e => e.classList.toggle('hidden-f', ty !== 'mortgage'));
    body.querySelector('.lbl-acc').textContent = ty === 'transfer' ? 'From account' : ty === 'mortgage' ? 'Paid from' : 'Account';
    f.categoryId.innerHTML = categoryOptions(ty === 'income' ? 'income' : 'expense', t.categoryId);
  }
  body.querySelector('#ttype').onclick = e => { const b = e.target.closest('button'); if (b) { t.type = b.dataset.type; applyType(); } };
  f.categoryId.onchange = () => (t.categoryId = f.categoryId.value);
  applyType();
  if (!isNew) body.querySelector('#del').onclick = async () => {
    if (!confirm('Delete this repeat payment? Past transactions it already created are kept.')) return;
    if (r.gcalEventId) { try { await Sync.deleteReminder(r.gcalEventId, L.clientId); } catch (e) { toast('Calendar: ' + e.message); } }
    M.remove(S, 'recurring', r.id); closeSheet(); commit(); toast('Deleted');
  };
  f.onsubmit = async e => {
    e.preventDefault();
    const amount = parseFloat(f.amount.value); if (!(amount > 0)) return toast('Enter an amount');
    Object.assign(t, { amount: M.round2(amount), note: fv(f, 'note'), accountId: f.accountId.value });
    t.toAccountId = t.type === 'transfer' ? f.toAccountId.value : undefined;
    t.categoryId = t.type === 'expense' || t.type === 'income' ? f.categoryId.value : undefined;
    t.mortgageId = t.type === 'mortgage' ? f.mortgageId.value : undefined;
    if ((t.type === 'expense' || t.type === 'income') && !t.categoryId) return toast('Choose a category');
    if (t.type === 'mortgage' && !t.mortgageId) return toast('Add a mortgage first');
    if (t.type === 'transfer' && (!t.toAccountId || t.toAccountId === t.accountId)) return toast('Choose a different “to” account');
    const startChanged = r.startDate !== f.startDate.value || r.freq !== f.freq.value;
    r.freq = f.freq.value; r.startDate = f.startDate.value; r.endDate = f.endDate.value || undefined;
    if (!isNew) r.paused = f.paused.checked;
    if (isNew || startChanged) {
      // Don't flood the past with entries unless asked.
      if (r.startDate < today() && !(isNew && f.backfill.checked)) r.materializedThrough = M.addDays(today(), -1);
      else if (isNew) delete r.materializedThrough;
    }
    const wantCal = f.gcal.checked;
    M.put(S, 'recurring', r); M.materialize(S);
    closeSheet(); commit();
    try {
      if (wantCal) { r.gcalEventId = await Sync.upsertReminder(S, r, L.clientId, S.settings.remindDays ?? 3); M.put(S, 'recurring', r); commit(); toast('Saved + Google Calendar reminder 🔔'); }
      else if (r.gcalEventId) { await Sync.deleteReminder(r.gcalEventId, L.clientId); delete r.gcalEventId; M.put(S, 'recurring', r); commit(); toast('Saved, calendar reminder removed'); }
      else toast('Saved');
    } catch (err) { toast('Saved, but calendar failed: ' + err.message, 5000); }
  };
}

// ---------- mortgages ----------
function listMortgages() {
  const { bal } = M.mortgageSplits(S);
  const ms = M.live(S, 'mortgages');
  const body = openSheet('Mortgages', `<div class="list">${ms.map(m => `<div class="li" data-act="openMortgage" data-id="${m.id}"><div class="grow">${esc(m.name)}<small>${m.rate}% · ${M.MORT_FREQ[m.frequency]} ${fmt(m.payment)}</small></div><span class="exp">${fmt(bal[m.id])}</span><span class="chev">›</span></div>`).join('') || '<div class="empty">No mortgage yet.</div>'}</div>
    <div class="row"><button class="primary" id="addM">+ Add mortgage</button></div>`);
  body.querySelector('#addM').onclick = () => editMortgage();
}
function editMortgage(m) {
  const isNew = !m;
  const expCats = M.live(S, 'categories').filter(c => c.type === 'expense');
  const home = expCats.find(c => !c.parentId && /mortgage/i.test(c.name));
  m = m ? { ...m } : {
    id: M.uid(), name: 'Home mortgage', lender: '', principal: '', startDate: today(), rate: '', compounding: 'semiannual',
    frequency: 'biweekly', payment: '', amortYears: 25, termEnd: '', categoryId: home?.id,
    interestCategoryId: expCats.find(c => c.parentId === home?.id && /interest/i.test(c.name))?.id,
    principalCategoryId: expCats.find(c => c.parentId === home?.id && /principal/i.test(c.name))?.id
  };
  const body = openSheet(isNew ? 'Add mortgage' : 'Edit mortgage', `<form id="f">
    <div class="two"><label>Name<input name="name" value="${esc(m.name)}" required></label><label>Lender<input name="lender" value="${esc(m.lender)}" placeholder="First National"></label></div>
    <div class="two"><label>Balance owing<input type="number" step="0.01" name="principal" value="${m.principal}" required></label>
    <label>…as of date<input type="date" name="startDate" value="${m.startDate}" required></label></div>
    <div class="hint">Use the balance from your latest mortgage statement. Payments after this date reduce it automatically.</div>
    <div class="two"><label>Interest rate %<input type="number" step="0.001" name="rate" value="${m.rate}" required></label>
    <label>Rate type<select name="compounding"><option value="semiannual" ${m.compounding === 'semiannual' ? 'selected' : ''}>Fixed (semi-annual compounding)</option><option value="monthly" ${m.compounding === 'monthly' ? 'selected' : ''}>Variable (monthly compounding)</option></select></label></div>
    <div class="two"><label>Payment frequency<select name="frequency">${Object.entries(M.MORT_FREQ).map(([k, v]) => `<option value="${k}" ${k === m.frequency ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label>Remaining amortization (yrs)<input type="number" step="0.5" name="amortYears" value="${m.amortYears || ''}"></label></div>
    <div class="two"><label>Payment amount<input type="number" step="0.01" name="payment" value="${m.payment}" required></label>
    <label>&nbsp;<button type="button" id="calc" class="secondary" style="width:100%;margin-top:4px">Calculate</button></label></div>
    <label>Term renewal date (optional)<input type="date" name="termEnd" value="${m.termEnd || ''}"></label>
    ${isNew ? `<label>Paid from<select name="payFrom">${accountOptions(defaultAccount())}</select></label>
      <label class="check"><input type="checkbox" name="mkRepeat" checked> Create the repeating payment</label>
      <label>First payment after the balance date<input type="date" name="firstPay" value="${M.addDays(today(), 1)}"></label>` : ''}
    <div class="row"><button class="primary">Save</button>${!isNew ? '<button type="button" id="del" class="danger">Delete</button>' : ''}</div></form>`);
  const f = body.querySelector('#f');
  body.querySelector('#calc').onclick = () => {
    const p = M.paymentFor(+f.principal.value, +f.rate.value, f.compounding.value, f.frequency.value, +f.amortYears.value || 25);
    if (isFinite(p)) f.payment.value = p.toFixed(2);
  };
  if (!isNew) body.querySelector('#del').onclick = () => {
    if (!confirm('Delete this mortgage? Its payment transactions stay but will no longer be split.')) return;
    M.remove(S, 'mortgages', m.id); if (m.accountId) M.remove(S, 'accounts', m.accountId); closeSheet(); commit();
  };
  f.onsubmit = e => {
    e.preventDefault();
    Object.assign(m, {
      name: fv(f, 'name'), lender: fv(f, 'lender'), principal: M.round2(+f.principal.value), startDate: f.startDate.value,
      rate: +f.rate.value, compounding: f.compounding.value, frequency: f.frequency.value, payment: M.round2(+f.payment.value),
      amortYears: +f.amortYears.value || undefined, termEnd: f.termEnd.value || undefined
    });
    if (!(m.principal > 0 && m.payment > 0)) return toast('Enter balance and payment');
    if (!m.accountId || !M.get(S, 'accounts', m.accountId)) {
      let g = M.live(S, 'groups').find(g => g.kind === 'liability') || M.put(S, 'groups', { id: M.uid(), name: 'Loan', kind: 'liability', order: 99 });
      m.accountId = M.put(S, 'accounts', { id: M.uid(), groupId: g.id, name: m.name, opening: 0, includeInTotals: true, mortgageAccount: true }).id;
    } else { const a = M.get(S, 'accounts', m.accountId); a.name = m.name; M.put(S, 'accounts', a); }
    M.put(S, 'mortgages', m);
    if (isNew && f.mkRepeat.checked) {
      const freq = { monthly: 'monthly', biweekly: 'biweekly', accelBiweekly: 'biweekly', weekly: 'weekly', semimonthly: 'monthly' }[m.frequency];
      M.put(S, 'recurring', { id: M.uid(), freq, interval: 1, startDate: f.firstPay.value, materializedThrough: f.firstPay.value <= today() ? M.addDays(f.firstPay.value, -1) : undefined,
        template: { type: 'mortgage', amount: m.payment, accountId: f.payFrom.value, mortgageId: m.id, note: m.lender || m.name } });
      if (m.frequency === 'semimonthly') toast('Semi-monthly: add a second repeat on the 15th in Repeat payments', 5000);
      M.materialize(S);
    }
    closeSheet(); commit(); mortgageDetail(m);
  };
}
function mortgageDetail(m) {
  m = M.get(S, 'mortgages', m.id) || m;
  const t0 = today();
  const Lg = M.mortgageLedger(S, m, t0);
  const lastDate = Lg.rows.length ? Lg.rows[Lg.rows.length - 1].date : m.startDate;
  const pr = M.project(m, Lg.balance, lastDate, 0, t0);
  const rate = M.rateOn(m, t0);
  const yr = t0.slice(0, 4);
  const ytd = Lg.rows.filter(r => r.date.startsWith(yr));
  const ytdI = ytd.reduce((a, r) => a + r.interest, 0), ytdP = ytd.reduce((a, r) => a + r.principal, 0);
  const next = pr.rows[0];
  const payoff = pr.never ? 'Never — payment too low' : `${MONTHS[+pr.payoffDate.slice(5, 7) - 1]} ${pr.payoffDate.slice(0, 4)}`;
  const body = openSheet(m.name, `
    <div class="cards">
      <div class="card wide"><small>Balance owing</small><b class="exp" style="font-size:24px">${fmt(Lg.balance)}</b><small>${m.lender ? esc(m.lender) + ' · ' : ''}${rate}% ${m.compounding === 'monthly' ? 'variable' : 'fixed'} · ${M.MORT_FREQ[m.frequency]} ${fmt(m.payment)}</small></div>
      <div class="card"><small>Next payment split</small><b>${next ? `P ${fmt(next.principal)}` : '—'}</b><small>${next ? `I ${fmt(next.interest)}` : ''}</small></div>
      <div class="card"><small>Payoff at this pace</small><b>${payoff}</b><small>${pr.never ? '' : `${pr.periods} payments`}</small></div>
      <div class="card"><small>Interest paid ${yr}</small><b class="exp">${fmt(ytdI)}</b><small>Principal ${fmt(ytdP)}</small></div>
      <div class="card"><small>Interest remaining</small><b>${pr.never ? '—' : fmt(pr.totalInterest)}</b><small>Tracked paid: ${fmt(Lg.interestPaid)}</small></div>
      ${m.termEnd ? `<div class="card wide"><small>Term renewal</small><b>${m.termEnd}</b><small>${Math.max(0, Math.round((M.parseYmd(m.termEnd) - M.parseYmd(t0)) / 86400000))} days away — projected balance then: ${fmt((pr.rows.filter(r => r.date <= m.termEnd).pop() || { balance: Lg.balance }).balance)}</small></div>` : ''}
    </div>
    <div class="btnrow">
      <button class="secondary" id="pay">Record payment</button><button class="secondary" id="pre">Prepayment</button>
      <button class="secondary" id="rate">Rate change</button><button class="secondary" id="edit">Edit</button>
    </div>
    <div class="section-title">What if I pay extra each payment?</div>
    <div class="pad" style="padding-top:0"><div class="two"><input type="number" id="extra" step="10" placeholder="Extra $ per payment"><div id="whatif" class="hint" style="margin:10px 0 0"></div></div></div>
    <div class="section-title">Payment history (${Lg.rows.length})</div>
    <div class="tablewrap"><table><tr><th>Date</th><th>Paid</th><th>Interest</th><th>Principal</th><th>Balance</th></tr>
      ${[...Lg.rows].reverse().slice(0, 60).map(r => `<tr><td>${r.date}${r.prepayment ? ' ⚡' : ''}</td><td>${fmt(r.payment)}</td><td>${fmt(r.interest)}</td><td>${fmt(r.principal)}</td><td>${fmt(r.balance)}</td></tr>`).join('') || '<tr><td colspan="5">No payments recorded after the balance date yet.</td></tr>'}</table></div>
    <div class="section-title">Upcoming schedule</div>
    <div class="tablewrap"><table><tr><th>Date</th><th>Interest</th><th>Principal</th><th>Balance</th></tr>
      ${pr.rows.slice(0, 26).map(r => `<tr><td>${r.date}</td><td>${fmt(r.interest)}</td><td>${fmt(r.principal)}</td><td>${fmt(r.balance)}</td></tr>`).join('')}</table></div>
    ${(m.rateChanges || []).length ? `<div class="hint pad">Rate changes: ${(m.rateChanges || []).map(c => `${c.date} → ${c.rate}%`).join(', ')}</div>` : ''}
    <div class="hint pad">Interest is calculated per payment period using Canadian rules (fixed rates compound semi-annually). Small differences from your lender's statement are normal — re-enter the statement balance in Edit any time to true it up.</div>`);
  const pay = { type: 'mortgage', mortgageId: m.id, amount: m.payment, note: m.lender || m.name };
  body.querySelector('#pay').onclick = () => editTxn(null, pay);
  body.querySelector('#pre').onclick = () => editTxn(null, { ...pay, amount: '', prepayment: true, note: 'Mortgage prepayment' });
  body.querySelector('#edit').onclick = () => editMortgage(m);
  body.querySelector('#rate').onclick = () => {
    const d = prompt('Date the new rate starts (YYYY-MM-DD)', t0); if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return;
    const r = parseFloat(prompt('New annual rate %', rate)); if (!(r >= 0)) return;
    const pmt = prompt('New payment amount (leave as is if unchanged)', m.payment);
    m.rateChanges = [...(m.rateChanges || []), { date: d, rate: r }];
    if (pmt && +pmt > 0) m.payment = M.round2(+pmt);
    M.put(S, 'mortgages', m); commit(); mortgageDetail(m);
  };
  body.querySelector('#extra').oninput = e => {
    const x = +e.target.value; const out = body.querySelector('#whatif');
    if (!(x > 0) || pr.never) return (out.textContent = '');
    const p2 = M.project(m, Lg.balance, lastDate, x, t0);
    const months = Math.round((M.parseYmd(pr.payoffDate) - M.parseYmd(p2.payoffDate)) / (86400000 * 30.44));
    out.innerHTML = `Paid off <b>${MONTHS[+p2.payoffDate.slice(5, 7) - 1]} ${p2.payoffDate.slice(0, 4)}</b> (${months} months sooner), saving <b class="inc">${fmt(pr.totalInterest - p2.totalInterest)}</b> interest.`;
  };
}

// ---------- categories ----------
function listCategories(type = 'expense') {
  const cats = M.live(S, 'categories').filter(c => c.type === type).sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const body = openSheet('Categories', `<div class="seg" id="ct"><button data-t="income" class="${type === 'income' ? 'on' : ''}">Income</button><button data-t="expense" class="${type === 'expense' ? 'on' : ''}">Expenses</button></div>
    <div class="list">${cats.filter(c => !c.parentId).map(p => `<div class="li" data-cat="${p.id}"><div class="grow">${esc((p.emoji || '') + ' ' + p.name)}</div><span class="chev">›</span></div>` +
      cats.filter(c => c.parentId === p.id).map(c => `<div class="li" data-cat="${c.id}" style="padding-left:40px"><div class="grow">↳ ${esc(c.name)}</div><span class="chev">›</span></div>`).join('')).join('')}</div>
    <div class="row"><button class="primary" id="add">+ Add category</button></div>`);
  body.querySelector('#ct').onclick = e => { const b = e.target.closest('button'); if (b) listCategories(b.dataset.t); };
  body.querySelectorAll('[data-cat]').forEach(el => (el.onclick = () => editCategory(M.get(S, 'categories', el.dataset.cat), type)));
  body.querySelector('#add').onclick = () => editCategory(null, type);
}
function editCategory(c, type) {
  const isNew = !c; c = c ? { ...c } : { id: M.uid(), type, name: '', emoji: '', parentId: null, order: S.categories.length };
  const parents = M.live(S, 'categories').filter(x => x.type === c.type && !x.parentId && x.id !== c.id);
  const body = openSheet(isNew ? 'Add category' : 'Edit category', `<form id="f">
    <div class="two"><label>Emoji<input name="emoji" value="${esc(c.emoji)}" maxlength="4"></label><label>Name<input name="name" value="${esc(c.name)}" required></label></div>
    <label>Subcategory of<select name="parentId"><option value="">— Main category —</option>${parents.map(p => `<option value="${p.id}" ${p.id === c.parentId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
    <div class="row"><button class="primary">Save</button>${!isNew ? '<button type="button" id="del" class="danger">Delete</button>' : ''}</div></form>`);
  const f = body.querySelector('#f');
  if (!isNew) body.querySelector('#del').onclick = () => {
    if (!confirm('Delete category? Existing transactions will show as Uncategorized.')) return;
    M.remove(S, 'categories', c.id); M.live(S, 'categories').filter(x => x.parentId === c.id).forEach(x => M.remove(S, 'categories', x.id));
    commit(); listCategories(c.type);
  };
  f.onsubmit = e => { e.preventDefault(); Object.assign(c, { name: fv(f, 'name'), emoji: fv(f, 'emoji'), parentId: f.parentId.value || null }); M.put(S, 'categories', c); commit(); listCategories(c.type); };
}

// ---------- accounts & groups ----------
function manageAccounts() {
  const b = M.balances(S);
  const body = openSheet('Accounts & groups', sortedGroups().map(g => `<div class="grouphead"><span data-g="${g.id}" style="cursor:pointer">${esc(g.name)} ✎</span></div><div class="list">` +
    M.live(S, 'accounts').filter(a => a.groupId === g.id && !a.mortgageAccount).map(a => `<div class="li" data-a="${a.id}"><div class="grow">${esc(a.name)}${a.hidden ? ' <span class="sub2">(hidden)</span>' : ''}</div><span>${fmt(b[a.id])}</span><span class="chev">›</span></div>`).join('') + '</div>').join('') +
    `<div class="row"><button class="primary" id="addA">+ Account</button><button class="secondary" id="addG">+ Group</button></div>`);
  body.querySelectorAll('[data-a]').forEach(el => (el.onclick = () => editAccount(M.get(S, 'accounts', el.dataset.a))));
  body.querySelectorAll('[data-g]').forEach(el => (el.onclick = () => editGroup(M.get(S, 'groups', el.dataset.g))));
  body.querySelector('#addA').onclick = () => editAccount();
  body.querySelector('#addG').onclick = () => editGroup();
}
function editAccount(a) {
  const isNew = !a;
  a = a ? { ...a } : { id: M.uid(), groupId: sortedGroups()[1]?.id || sortedGroups()[0]?.id, name: '', opening: 0, includeInTotals: true };
  const cur = M.balances(S)[a.id] ?? 0;
  const body = openSheet(isNew ? 'Add account' : 'Edit account', `<form id="f">
    <label>Group<select name="groupId">${sortedGroups().map(g => `<option value="${g.id}" ${g.id === a.groupId ? 'selected' : ''}>${esc(g.name)}</option>`).join('')}</select></label>
    <label>Name<input name="name" value="${esc(a.name)}" required></label>
    <label>Current balance (negative for money owed, e.g. card or loan)<input type="number" step="0.01" name="balance" value="${M.round2(cur)}"></label>
    <div class="two"><label>Card statement day (cards)<input type="number" min="1" max="31" name="statementDay" value="${a.statementDay || ''}"></label>
    <label>Card last 4 digits (for receipts)<input name="cardLast4" maxlength="4" inputmode="numeric" value="${esc(a.cardLast4 || '')}"></label></div>
    <label class="check"><input type="checkbox" name="inc" ${a.includeInTotals !== false ? 'checked' : ''}> Include in totals</label>
    <label class="check"><input type="checkbox" name="hidden" ${a.hidden ? 'checked' : ''}> Hide account</label>
    <div class="row"><button class="primary">Save</button>${!isNew ? '<button type="button" id="del" class="danger">Delete</button>' : ''}</div></form>`);
  const f = body.querySelector('#f');
  if (!isNew) body.querySelector('#del').onclick = () => { if (confirm('Delete account? Its transactions stay in history.')) { M.remove(S, 'accounts', a.id); closeSheet(); commit(); } };
  f.onsubmit = e => {
    e.preventDefault();
    const target = parseFloat(f.balance.value) || 0;
    // Setting the "current balance" adjusts the opening balance so history stays intact.
    a.opening = M.round2((+a.opening || 0) + (target - cur));
    Object.assign(a, { groupId: f.groupId.value, name: fv(f, 'name'), statementDay: +f.statementDay.value || undefined,
      cardLast4: fv(f, 'cardLast4') || undefined, includeInTotals: f.inc.checked, hidden: f.hidden.checked });
    M.put(S, 'accounts', a); closeSheet(); commit(); toast('Account saved');
  };
}
function editGroup(g) {
  const isNew = !g; g = g ? { ...g } : { id: M.uid(), name: '', kind: 'asset', order: S.groups.length };
  const body = openSheet(isNew ? 'Add group' : 'Edit group', `<form id="f"><label>Name<input name="name" value="${esc(g.name)}" required></label>
    <label>Type<select name="kind">${[['asset', 'Asset (bank, cash, savings, investments)'], ['card', 'Credit card'], ['liability', 'Loan / liability']].map(([k, v]) => `<option value="${k}" ${k === g.kind ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label>Sort order<input type="number" name="order" value="${g.order ?? 0}"></label>
    <div class="row"><button class="primary">Save</button>${!isNew ? '<button type="button" id="del" class="danger">Delete</button>' : ''}</div></form>`);
  const f = body.querySelector('#f');
  if (!isNew) body.querySelector('#del').onclick = () => {
    if (M.live(S, 'accounts').some(a => a.groupId === g.id)) return toast('Move or delete its accounts first');
    M.remove(S, 'groups', g.id); commit(); manageAccounts();
  };
  f.onsubmit = e => { e.preventDefault(); Object.assign(g, { name: fv(f, 'name'), kind: f.kind.value, order: +f.order.value || 0 }); M.put(S, 'groups', g); commit(); manageAccounts(); };
}

// ---------- receipt rules ----------
function receiptRules() {
  const rules = M.live(S, 'rules').sort((a, b) => (b.hits || 0) - (a.hits || 0));
  const body = openSheet('Receipt learning', `<div class="hint">Every expense you save with a store name teaches MoneyBook which account and category to pick next time. Scanned receipts also match cards by their last 4 digits (set in each card's settings).</div>
    <div class="list">${rules.map(r => `<div class="li"><div class="grow">${esc(r.merchant)}<small>${esc(M.catLabel(S, r.categoryId))} · ${esc(M.accName(S, r.accountId))} · ${r.hits || 1}×</small></div><button class="secondary" data-del="${r.id}" style="padding:6px 10px">Forget</button></div>`).join('') || '<div class="empty">Nothing learned yet.</div>'}</div>`);
  body.querySelectorAll('[data-del]').forEach(b => (b.onclick = () => { M.remove(S, 'rules', b.dataset.del); commit(); receiptRules(); }));
}

// ---------- sync & backup ----------
function syncScreen() {
  const origin = location.origin;
  const body = openSheet('Google Drive sync & backup', `
    <div class="hint">Your data is stored in a hidden app folder in <b>your</b> Google Drive (only MoneyBook can see it). Every device that signs in with the same Google account stays in sync.</div>
    <form id="f"><label>Google OAuth Client ID<input name="cid" value="${esc(L.clientId || '')}" placeholder="xxxxxxxx.apps.googleusercontent.com"></label>
    <div class="hint">One-time setup — see the README. Authorized JavaScript origin must be <code>${esc(origin)}</code></div>
    <div class="row"><button class="primary">Save & sync now</button></div></form>
    <div class="hint">${L.lastSync ? 'Last sync: ' + new Date(L.lastSync).toLocaleString('en-CA') : 'Not synced yet on this device.'}</div>
    <div class="section-title">Backup</div>
    <div class="btnrow" style="padding:0"><button class="secondary" id="exp">Export backup (.json)</button><button class="secondary" id="imp">Import backup</button><button class="secondary" id="csv">Export CSV</button></div>
    <input type="file" id="impFile" accept=".json,application/json" hidden>
    <div class="row"><button class="danger" id="out">Sign out of Google on this device</button></div>`);
  const f = body.querySelector('#f');
  f.onsubmit = async e => {
    e.preventDefault(); L.clientId = fv(f, 'cid'); saveLocal();
    try { await doSync(true); syncScreen(); } catch {}
  };
  body.querySelector('#exp').onclick = () => download(`moneybook-backup-${today()}.json`, JSON.stringify(S, null, 1), 'application/json');
  body.querySelector('#csv').onclick = () => {
    const { map } = M.mortgageSplits(S);
    const rows = [['Date', 'Type', 'Amount', 'Account', 'To account', 'Category', 'Note', 'Description', 'Principal', 'Interest']];
    M.live(S, 'transactions').filter(t => t.date <= today()).sort((a, b) => a.date.localeCompare(b.date)).forEach(t => rows.push([
      t.date, t.type, t.amount, M.accName(S, t.accountId), t.toAccountId ? M.accName(S, t.toAccountId) : '', t.categoryId ? M.catLabel(S, t.categoryId) : '',
      t.note || '', t.desc || '', map[t.id]?.principal ?? '', map[t.id]?.interest ?? '']));
    download(`moneybook-${today()}.csv`, rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
  };
  body.querySelector('#imp').onclick = () => body.querySelector('#impFile').click();
  body.querySelector('#impFile').onchange = async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      const data = M.migrate(JSON.parse(await file.text()));
      if (!confirm('Merge this backup into your current data? (Cancel = keep current data)')) return;
      S = M.migrate(M.merge(S, data)); M.materialize(S); commit(); toast('Backup merged');
    } catch (err) { toast('Not a valid backup: ' + err.message); }
  };
  body.querySelector('#out').onclick = () => { Sync.signOut(); toast('Signed out'); };
}
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ---------- settings ----------
function settings() {
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  const body = openSheet('Settings & reminders', `<form id="f">
    <label>Remind me this many days before a payment<input type="number" min="0" max="28" name="rd" value="${S.settings.remindDays ?? 3}"></label>
    <div class="hint">Used for the upcoming banner, this device's notification when you open the app, and new Google Calendar reminders.</div>
    <div class="row"><button class="primary">Save</button></div></form>
    <div class="section-title">Notifications on this device</div>
    <div class="pad hint">Status: <b>${perm}</b>. Browsers can only notify when the app is opened; for reliable alerts while it's closed, use the 🔔 Google Calendar reminder on repeat payments.</div>
    <div class="btnrow"><button class="secondary" id="np">Allow notifications</button></div>`);
  const f = body.querySelector('#f');
  f.onsubmit = e => { e.preventDefault(); S.settings = { ...S.settings, remindDays: Math.max(0, +f.rd.value || 0), updatedAt: Date.now() }; commit(); closeSheet(); toast('Saved'); };
  body.querySelector('#np').onclick = async () => {
    if (!('Notification' in window)) return toast('Not supported in this browser');
    const p = await Notification.requestPermission(); toast('Notifications: ' + p); if (p === 'granted') { L.lastNotified = ''; notifyUpcoming(); }
  };
}

// ---------- day / stats drill-down ----------
function showDay(d) {
  const t0 = today();
  const posted = d <= t0 ? M.live(S, 'transactions').filter(t => t.date === d) : [];
  const proj = M.projected(S, d, d);
  const { map } = M.mortgageSplits(S);
  const body = openSheet(`${WD[M.parseYmd(d).getDay()]} ${d}`, `<div class="day" style="margin:0">${[...posted, ...proj].map(t => txRow(t, map)).join('') || '<div class="empty">Nothing on this day.</div>'}</div>
    <div class="row"><button class="primary" id="add">+ Add on this day</button></div>`);
  body.querySelector('#add').onclick = () => editTxn(null, { date: d });
}
function showStatsCat(topId) {
  const [from, to] = monthRange();
  const { leaf } = M.categoryTotals(S, from, to, statsType);
  const rows = Object.entries(leaf).filter(([id]) => (M.topCatId(S, id) || id) === topId).sort((a, b) => b[1] - a[1]);
  const tx = M.live(S, 'transactions').filter(t => t.date >= from && t.date <= to && t.date <= today() &&
    ((t.type === statsType && (M.topCatId(S, t.categoryId) || t.categoryId || 'none') === topId) ||
     (statsType === 'expense' && t.type === 'mortgage' && M.get(S, 'mortgages', t.mortgageId)?.categoryId === topId)))
    .sort((a, b) => b.date.localeCompare(a.date));
  const { map } = M.mortgageSplits(S);
  const c = M.get(S, 'categories', topId);
  openSheet(c ? `${c.emoji || ''} ${c.name}` : 'Uncategorized', `<div class="list">${rows.map(([id, v]) => `<div class="li"><div class="grow">${esc(id === topId ? '(main category)' : M.get(S, 'categories', id)?.name || '—')}</div><b>${fmt(v)}</b></div>`).join('')}</div>
    <div class="section-title">Transactions</div><div class="day" style="margin:0">${tx.map(t => txRow(t, map)).join('')}</div>`);
}

// ---------- events ----------
const actions = {
  tab: el => { tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
  prevMonth: () => { cursor.setMonth(cursor.getMonth() - 1); render(); },
  nextMonth: () => { cursor.setMonth(cursor.getMonth() + 1); render(); },
  addTxn: () => editTxn(),
  editTxn: el => editTxn(M.get(S, 'transactions', el.dataset.id)),
  editRule: el => editRecurring(M.get(S, 'recurring', el.dataset.id)),
  day: el => showDay(el.dataset.date),
  statsType: el => { statsType = el.dataset.type; render(); },
  statsCat: el => showStatsCat(el.dataset.id),
  editAccount: el => editAccount(M.get(S, 'accounts', el.dataset.id)),
  editGroup: () => editGroup(),
  openMortgage: el => mortgageDetail(M.get(S, 'mortgages', el.dataset.id)),
  mortgages: listMortgages, recurring: listRecurring, categories: () => listCategories(), manageAccounts,
  receiptRules, syncScreen, settings,
  closeSheet,
  sync: () => (L.clientId ? doSync(true).catch(() => {}) : syncScreen())
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = actions[el.dataset.act]; if (fn) { e.preventDefault(); fn(el); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

init().catch(e => { document.body.insertAdjacentHTML('beforeend', `<div class="banner">Startup error: ${esc(e.message)}</div>`); console.error(e); });
