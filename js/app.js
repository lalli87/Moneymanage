import * as M from './model.js';
import * as DB from './db.js';
import * as Sync from './sync.js';
import * as R from './receipt.js';
import * as I from './importer.js';
import * as X from './insights.js';
import * as Lk from './lock.js';
import * as Cx from './crypto.js';

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
  M.refreshMortgageNotes(S);
  render();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await DB.save(S);
    if (Sync.hasToken()) doSync(false).catch(() => {});
  }, 500);
}

// ---------- boot ----------
// ---------- theme (per device): 'system' | 'light' | 'dark' ----------
function applyTheme() {
  const t = L.theme || 'system';
  if (t === 'system') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#1c1c1f' : '#ffffff');
}
matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', applyTheme);

async function init() {
  applyTheme();
  showLock();
  try { vault = await DB.getKV('vault'); } catch {}
  S = M.migrate((await DB.load()) || M.emptyState());
  if (M.materialize(S)) await DB.save(S);
  const dd = M.dedupe(S); if (dd.categories || dd.groups || dd.accounts) { await DB.save(S); setTimeout(() => toast(`Merged ${dd.categories + dd.groups + dd.accounts} duplicate categories/accounts`), 800); }
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
// ---------- end-to-end encryption of what goes to Drive ----------
let vault = null;                                   // { salt, key: non-exportable CryptoKey } for this device
const codec = {
  encode: async st => (vault ? Cx.encryptJSON(st, vault.key, vault.salt) : st),
  decode: async r => {
    if (!Cx.isEncrypted(r)) return r;
    if (vault && vault.salt === r.salt) { try { return await Cx.decryptJSON(r, vault.key); } catch {} }
    throw Object.assign(new Error('Enter your encryption passphrase to sync'), { needPass: r });
  }
};
async function setVault(v) { vault = v; if (v) await DB.putKV('vault', v); else await DB.delKV('vault'); }
// Ask for the passphrase of an encrypted file; resolves with { data, key } or null if cancelled.
function askPassphrase(env, why = 'Your MoneyBook data in Google Drive is encrypted.') {
  return new Promise(resolve => {
    const body = openSheet('Encryption passphrase', `<div class="hint">${esc(why)} Enter the passphrase from your password manager. It's checked on this device only.</div>
      <form id="f"><label>Passphrase<input name="p" type="password" autocomplete="current-password" required></label>
      <div class="hint" id="m"></div><div class="row"><button class="primary">Unlock</button><button type="button" class="secondary" id="c">Cancel</button></div></form>`);
    const f = body.querySelector('#f');
    body.querySelector('#c').onclick = () => { closeSheet(); resolve(null); };
    f.onsubmit = async e => {
      e.preventDefault(); body.querySelector('#m').textContent = 'Checking…';
      try {
        const key = await Cx.deriveKey(f.p.value, env.salt, env.iter || Cx.ITER);
        const data = await Cx.decryptJSON(env, key);
        closeSheet(); resolve({ data, key });
      } catch { body.querySelector('#m').textContent = '❌ Wrong passphrase'; }
    };
    setTimeout(() => f.p.focus(), 100);
  });
}

async function doSync(interactive = true) {
  const btn = $('#syncBtn'); btn.classList.add('spin');
  try {
    S = M.migrate(await Sync.sync(S, L.clientId, interactive, codec));
    M.materialize(S);
    const dd = M.dedupe(S); if (dd.categories || dd.groups || dd.accounts) { await Sync.sync(S, L.clientId, false, codec).catch(() => {}); }
    await DB.save(S);
    L.lastSync = new Date().toISOString(); saveLocal();
    render();
    Sync.weeklyBackup(S, L.clientId, { codec }).then(n => n && interactive && toast('Weekly backup saved to Drive')).catch(() => {});
    if (interactive) toast(vault ? 'Synced (end-to-end encrypted) ✓' : 'Synced with Google Drive ✓');
  } catch (e) {
    if (e.needPass && interactive) {
      btn.classList.remove('spin');
      const r = await askPassphrase(e.needPass);
      if (r) { await setVault({ salt: e.needPass.salt, key: r.key }); return doSync(true); }
      return;
    }
    if (interactive) toast(e.message, 4500); throw e;
  }
  finally { btn.classList.remove('spin'); }
}

// ---------- reminders on this device ----------
function notifyUpcoming() {
  const days = S.settings.remindDays ?? 3;
  const due = M.projected(S, today(), M.addDays(today(), days));
  const cards = X.cardStatuses(S).filter(c => c.status === 'overdue' || (c.status === 'due' && c.daysLeft <= days));
  const bills = X.billReminders(S, today(), days);
  if ((!due.length && !cards.length && !bills.length) || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (L.lastNotified === today()) return;
  L.lastNotified = today(); saveLocal();
  const lines = [
    ...cards.map(c => `💳 ${c.account.name}: ${fmt(c.remaining)} ${c.status === 'overdue' ? 'OVERDUE' : 'due ' + c.dueDate.slice(5)}`),
    ...bills.map(b => `🔌 Add ${b.recurring.template.note || 'bill'} (~${fmt(b.recurring.template.amount)})`),
    ...due.slice(0, 4).map(t => `${t.date.slice(5)} ${t.note || ''} ${fmt(t.amount)}`)];
  navigator.serviceWorker?.ready.then(reg => reg.showNotification(cards.length ? 'Card payment due' : 'Upcoming payments', {
    body: lines.slice(0, 6).join('\n'), icon: 'icons/icon-192.png', tag: 'upcoming'
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
  if (t.splits?.length > 1) return `🧩 ${M.catLabel(S, t.splits[0].categoryId).replace(/^\S+\s/, '')} +${t.splits.length - 1}`;
  return M.catLabel(S, t.categoryId);
}
function txRow(t, splits = {}) {
  const cls = t.type === 'income' ? 'inc' : t.type === 'transfer' ? 'xfer' : 'exp';
  let acc = M.accName(S, t.accountId);
  if (t.type === 'transfer') acc += ' → ' + M.accName(S, t.toAccountId);
  if (t.type === 'mortgage') {
    const m = M.get(S, 'mortgages', t.mortgageId);
    const sp = splits[t.id] || (t.projected && m && M.scheduleRow(m, t.date));
    acc += sp ? ` · P ${fmt(sp.principal)} / I ${fmt(sp.interest)}` : ` · ${esc(m?.name || '')}`;
  }
  const target = t.projected && t.recurringId && !M.get(S, 'transactions', t.id)
    ? `data-act="editRule" data-id="${t.recurringId}"` : `data-act="editTxn" data-id="${t.id}"`;
  const freq = t.recurringId ? (M.FREQS[M.get(S, 'recurring', t.recurringId)?.freq] || '') : '';
  return `<div class="tx ${t.projected ? 'proj' : ''}" ${target}>
    <div class="tx-cat">${esc(txLabel(t))}</div>
    <div class="tx-main"><div>${esc(t.note || '')} ${t.remind ? '<span class="badge">Reminder</span>' : t.projected ? '<span class="badge">Scheduled</span>' : ''}</div>
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
  h += attentionHtml();
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
  if (!rows.length) return h + '<div class="empty">No data for this month.</div>' + (statsType === 'expense' ? budgetBars(from, to) : '');
  let acc = 0;
  const stops = rows.map(([, v], i) => { const a = acc; acc += v / total * 100; return `${COLORS[i % COLORS.length]} ${a}% ${acc}%`; });
  h += `<div class="pie" style="background:conic-gradient(${stops.join(',')})"><b>${fmt(total)}</b></div><div class="list">`;
  rows.forEach(([id, v], i) => {
    const c = M.get(S, 'categories', id);
    h += `<div class="li" data-act="statsCat" data-id="${id}"><span class="pct" style="background:${COLORS[i % COLORS.length]}">${Math.round(v / total * 100)}%</span>
      <span class="grow">${esc(c ? `${c.emoji || ''} ${c.name}` : 'Uncategorized')}</span><span>${fmt(v)}</span><span class="chev">›</span></div>`;
  });
  return h + '</div>' + (statsType === 'expense' ? budgetBars(from, to) : '');
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
      h += `<div class="li" data-act="${mort ? 'openMortgage' : 'openAccount'}" data-id="${mort ? mort.id : a.id}"><div class="grow">${esc(a.name)}${a.includeInTotals === false ? ' <span class="sub2">(excluded)</span>' : ''}${extra}</div>
        <span class="${v < 0 ? 'exp' : 'inc'}">${fmt(v)}</span><span class="chev">›</span></div>`;
    }
    h += '</div>';
  }
  return h + `<div class="btnrow" style="margin-top:12px"><button class="secondary" data-act="forecast">📈 60-day forecast</button></div><div class="btnrow"><button class="secondary" data-act="manageAccounts">⚙️ Manage accounts & groups</button></div>`;
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
    ${item('suggestions', '✨', 'Smart suggestions', 'Duplicate schedules, regular bills not yet scheduled')}
    ${item('forecast', '📈', 'Cash-flow forecast', 'Next 60 days for each bank account')}
    ${item('budgets', '🎯', 'Monthly budgets')}
    ${item('taxReports', '🧾', 'Rental & business reports', 'Tax-year totals, rental share, HST')}
    ${item('importStatement', '📥', 'Import statement, CSV or screenshots', 'PDF statements, bank CSV files, banking-app screenshots')}
    ${item('dupScan', '🧹', 'Find duplicate entries', 'Clean up anything recorded twice')}
  </div><div class="menu">
    ${item('syncScreen', '☁️', 'Google Drive sync & backup', L.lastSync ? 'Last sync ' + new Date(L.lastSync).toLocaleString('en-CA') : 'Not set up')}
    ${item('settings', '⚙️', 'Settings & reminders')}
    ${item('lockSettings', '🔒', 'App lock', L.lock?.pinHash ? (L.lock.credId ? 'PIN + fingerprint' : 'PIN') : 'Off')}
    ${item('backupsScreen', '🗂️', 'Drive backups', 'Weekly copies, restore')}
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
      <div class="f-split">
        <button type="button" id="splitBtn" class="secondary" style="width:100%;margin-bottom:10px">🧩 Split across categories (mixed bill)</button>
        <div id="splitBox" class="hidden-f card" style="margin-bottom:10px">
          <div id="items"></div>
          <small>Category lines — they must add up to the amount</small>
          <div id="splitRows"></div>
          <div class="btnrow" style="padding:6px 0 0"><button type="button" class="secondary" id="addLine">+ Line</button><button type="button" class="secondary" id="usual">Usual split here</button><button type="button" class="secondary" id="noSplit">No split</button></div>
          <div id="splitMsg" class="hint" style="margin-bottom:0"></div>
        </div>
      </div>
      <label class="f-mort">Mortgage<select name="mortgageId">${mortgageOptions(t.mortgageId)}</select></label>
      <label class="f-mort check"><input type="checkbox" name="prepayment" ${t.prepayment ? 'checked' : ''}> Lump-sum prepayment (100% goes to principal)</label>
      <label>Note<input name="note" value="${esc(t.note)}" placeholder="e.g. Costco" autocomplete="off"></label>
      <label>Description<textarea name="desc">${esc(t.desc)}</textarea></label>
      <div class="two f-tag"><label>Purpose<select name="tag"><option value="">Auto${X.tagOf(S, { ...t, tag: undefined }) ? ' (' + esc(X.TAGS[X.tagOf(S, { ...t, tag: undefined })]) + ')' : ' (personal)'}</option>${Object.entries(X.TAGS).map(([k, v]) => `<option value="${k}" ${t.tag === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      <label>HST included<span style="display:flex;gap:6px"><input type="number" step="0.01" min="0" name="hst" value="${t.hst || ''}" placeholder="optional"><button type="button" id="hstBtn" class="secondary" style="padding:0 10px;margin-top:4px">${S.settings.hstRate ?? 13}%</button></span></label></div>
      ${isNew ? `<label>Repeat<select name="repeat"><option value="">Don't repeat</option>${freqOptions('')}</select></label>` : ''}
      <div id="futureHint" class="hint"></div>
      <div class="row"><button class="primary">Save</button>${!isNew ? '<button type="button" id="del" class="danger">Delete</button>' : ''}</div>
      ${t.recurringId ? '<div class="hint">This is one occurrence of a repeat payment — edits apply only to this date.</div>' : ''}
    </form>`);
  const f = body.querySelector('#f');
  let catTouched = !!t.categoryId;
  let splits = (t.splits || []).map(x => ({ ...x })), items = null, splitOn = splits.length > 1;
  function applyType() {
    const ty = t.type;
    body.querySelectorAll('#ttype button').forEach(b => b.classList.toggle('on', b.dataset.type === ty));
    body.querySelectorAll('.f-to').forEach(e => e.classList.toggle('hidden-f', ty !== 'transfer'));
    body.querySelectorAll('.f-cat').forEach(e => e.classList.toggle('hidden-f', ty === 'transfer' || ty === 'mortgage'));
    body.querySelectorAll('.f-mort').forEach(e => e.classList.toggle('hidden-f', ty !== 'mortgage'));
    body.querySelectorAll('.f-scan').forEach(e => e.classList.toggle('hidden-f', ty !== 'expense'));
    body.querySelectorAll('.f-tag').forEach(e => e.classList.toggle('hidden-f', ty === 'transfer'));
    body.querySelectorAll('.f-split').forEach(e => e.classList.toggle('hidden-f', ty !== 'expense'));
    body.querySelectorAll('.f-cat').forEach(e => e.classList.toggle('hidden-f', ty === 'transfer' || ty === 'mortgage' || (ty === 'expense' && splitOn)));
    body.querySelector('.lbl-acc').textContent = ty === 'transfer' ? 'From account' : ty === 'mortgage' ? 'Paid from' : 'Account';
    f.categoryId.innerHTML = categoryOptions(ty === 'income' ? 'income' : 'expense', t.categoryId);
  }
  body.querySelector('#hstBtn').onclick = () => { const r = (S.settings.hstRate ?? 13) / 100, a = parseFloat(f.amount.value); if (a > 0) f.hst.value = (a * r / (1 + r)).toFixed(2); };
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

  // ---- split one bill across categories (from receipt items or by hand) ----
  const box = body.querySelector('#splitBox');
  const amt = () => parseFloat(f.amount.value) || 0;
  function renderSplit() {
    box.classList.toggle('hidden-f', !splitOn);
    body.querySelector('#splitBtn').classList.toggle('hidden-f', splitOn);
    body.querySelectorAll('.f-cat').forEach(e => e.classList.toggle('hidden-f', t.type !== 'expense' || splitOn));
    body.querySelector('#splitRows').innerHTML = splits.map((x, i) => `<div style="display:grid;grid-template-columns:1fr 96px 34px;gap:6px;align-items:center" data-r="${i}">
      <select data-k="cat">${categoryOptions('expense', x.categoryId)}</select><input data-k="amt" type="number" step="0.01" inputmode="decimal" value="${x.amount}" style="margin-top:4px">
      <button type="button" class="secondary" data-k="x" style="padding:8px 0;margin-top:4px" aria-label="Remove line">✕</button></div>`).join('');
    const left = M.round2(amt() - splits.reduce((a, x) => a + (+x.amount || 0), 0));
    body.querySelector('#splitMsg').innerHTML = Math.abs(left) < 0.005 ? '✅ Adds up to the total' : `<span class="exp">${left > 0 ? fmt(left) + ' not assigned yet' : fmt(-left) + ' more than the total'}</span>`;
  }
  function renderItems() {
    const el = body.querySelector('#items');
    if (!items?.length) return (el.innerHTML = '');
    el.innerHTML = `<small>${items.length} items on the receipt — change any category and the split updates (and is remembered next time)</small>` +
      items.map((it, i) => `<div style="display:grid;grid-template-columns:1fr 70px;gap:4px 8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--line)" data-it="${i}">
        <span style="font-size:13px">${esc(it.desc)}</span><span style="text-align:right;font-size:13px">${fmt(it.amount)}</span>
        <select data-k="icat" style="grid-column:1/3;margin:0;padding:6px;font-size:13px">${categoryOptions('expense', it.categoryId)}</select></div>`).join('');
  }
  const rebuildFromItems = () => { splits = R.buildSplits(items, amt()); renderSplit(); };
  body.querySelector('#splitBtn').onclick = () => {
    splitOn = true;
    if (!splits.length) splits = [{ categoryId: f.categoryId.value || '', amount: amt() }, { categoryId: '', amount: 0 }];
    renderSplit();
  };
  body.querySelector('#addLine').onclick = () => { const left = M.round2(amt() - splits.reduce((a, x) => a + (+x.amount || 0), 0)); splits.push({ categoryId: '', amount: Math.max(0, left) }); renderSplit(); };
  body.querySelector('#noSplit').onclick = () => { splitOn = false; if (splits[0]?.categoryId) { f.categoryId.value = splits[0].categoryId; t.categoryId = splits[0].categoryId; } splits = []; items = null; renderItems(); renderSplit(); };
  body.querySelector('#usual').onclick = () => {
    const key = R.merchantKey(f.note.value); const tot = {}; let n = 0;
    M.live(S, 'transactions').filter(x => x.splits?.length > 1 && x.id !== t.id && R.merchantKey(x.note) === key && key).forEach(x => { n++; x.splits.forEach(p => (tot[p.categoryId] = (tot[p.categoryId] || 0) + p.amount / x.amount)); });
    if (!n) return toast('No earlier split bills at this store yet');
    const ids = Object.keys(tot); let acc = 0;
    splits = ids.map((id, i) => { const v = i === ids.length - 1 ? M.round2(amt() - acc) : M.round2(amt() * tot[id] / n); acc += v; return { categoryId: id, amount: v }; });
    renderSplit(); toast(`Average of your last ${n} split bill${n > 1 ? 's' : ''} here`);
  };
  box.addEventListener('change', e => {
    const r = e.target.closest('[data-r]'), it = e.target.closest('[data-it]');
    if (it) { const x = items[+it.dataset.it]; x.categoryId = e.target.value; x.changed = true; return rebuildFromItems(); }
    if (!r) return; const x = splits[+r.dataset.r];
    if (e.target.dataset.k === 'cat') x.categoryId = e.target.value;
    if (e.target.dataset.k === 'amt') x.amount = M.round2(+e.target.value || 0);
    renderSplit();
  });
  box.addEventListener('click', e => { const b = e.target.closest('[data-k="x"]'); if (b) { splits.splice(+b.closest('[data-r]').dataset.r, 1); renderSplit(); } });
  f.amount.addEventListener('change', () => { if (!splitOn) return; if (items) rebuildFromItems(); else renderSplit(); });
  renderSplit();

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
      const pi = R.parseItems(text);
      if (pi.items.length >= 2) {
        items = pi.items.map(i => ({ ...i, ...R.classifyItem(S, i.desc) }));
        const cats = new Set(items.map(i => i.categoryId || '?'));
        if (cats.size > 1 || cats.has('?')) { splitOn = true; renderItems(); rebuildFromItems(); }
        else { const only = [...cats][0]; f.categoryId.value = only; t.categoryId = only; catTouched = true; }
      }
      const found = [r.total ? 'total' : null, r.date ? 'date' : null, r.merchant ? 'store' : null].filter(Boolean).join(', ') || 'nothing clear';
      body.querySelector('#scanMsg').className = 'hint ok';
      if (items && splitOn) msg(`Read ${found} and ${items.length} items in ${new Set(items.map(i => i.categoryId).filter(Boolean)).size} categories — check the split below.`); else
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
    rec.splits = undefined;
    if (t.type === 'expense' && splitOn) {
      const lines = splits.filter(x => x.categoryId && +x.amount);
      const left = M.round2(M.round2(amount) - lines.reduce((a, x) => a + +x.amount, 0));
      if (lines.some(x => !x.categoryId) || splits.some(x => +x.amount && !x.categoryId)) return toast('Pick a category for every split line');
      if (Math.abs(left) >= 0.01) return toast(`Split lines must add up to the amount (${left > 0 ? fmt(left) + ' left' : fmt(-left) + ' over'})`, 4000);
      if (lines.length > 1) { rec.splits = lines.map(x => ({ categoryId: x.categoryId, amount: M.round2(+x.amount) })).sort((a, b) => b.amount - a.amount); rec.categoryId = rec.splits[0].categoryId; }
      else if (lines.length === 1) rec.categoryId = lines[0].categoryId;
      (items || []).filter(i => i.changed && i.categoryId).forEach(i => R.learnItem(S, i.desc, i.categoryId));
    }
    rec.mortgageId = t.type === 'mortgage' ? f.mortgageId.value : undefined;
    rec.prepayment = t.type === 'mortgage' ? f.prepayment.checked : undefined;
    rec.tag = t.type !== 'transfer' && f.tag.value ? f.tag.value : undefined;
    rec.hst = t.type !== 'transfer' && +f.hst.value > 0 ? M.round2(+f.hst.value) : undefined;
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
      <label>When it's due<select name="mode"><option value="auto" ${r.mode !== 'remind' ? 'selected' : ''}>Post it automatically (fixed amount / auto-debit)</option><option value="remind" ${r.mode === 'remind' ? 'selected' : ''}>Remind me to add it (amount varies, e.g. utilities)</option></select></label>
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
    r.freq = f.freq.value; r.startDate = f.startDate.value; r.endDate = f.endDate.value || undefined; r.mode = f.mode.value;
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
    <label>Purpose of payments (for the rental report)<select name="tag"><option value="">Personal</option><option value="rental-shared" ${m.defaultTag === 'rental-shared' ? 'selected' : ''}>🏠 Shared home cost — interest counted at rental %</option><option value="rental" ${m.defaultTag === 'rental' ? 'selected' : ''}>🏘️ Rental property (100%)</option></select></label>
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
      amortYears: +f.amortYears.value || undefined, termEnd: f.termEnd.value || undefined, defaultTag: f.tag.value || undefined
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
  const rec = M.live(S, 'recurring').find(r => r.template?.type === 'mortgage' && r.template.mortgageId === m.id && !r.paused);
  const firstDate = (rec && M.nextDue(rec, t0, 1)[0]) || (m.nextDue > t0 ? m.nextDue : null);
  const pr = M.project(m, Lg.balance, lastDate, 0, t0, firstDate);
  const pays = Lg.rows.filter(r => !r.checkpoint);
  const rate = M.rateOn(m, t0);
  const yr = t0.slice(0, 4);
  const ytd = pays.filter(r => r.date.startsWith(yr));
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
      <button class="secondary" id="link">Link past payments</button><button class="secondary" id="doc">Import lender PDF</button>
    </div>
    ${!rec ? `<div class="banner">No repeat payment is set up for this mortgage yet${firstDate ? ` (next due ${firstDate})` : ''}. <button class="secondary" id="mkrec" style="padding:4px 10px">Create it</button></div>` : ''}
    <div class="section-title">What if I pay extra each payment?</div>
    <div class="pad" style="padding-top:0"><div class="two"><input type="number" id="extra" step="10" placeholder="Extra $ per payment"><div id="whatif" class="hint" style="margin:10px 0 0"></div></div></div>
    ${m.annual && Object.keys(m.annual).length ? `<div class="section-title">From your lender's annual statements</div>
    <div class="tablewrap"><table><tr><th>Year</th><th>Paid</th><th>Interest</th><th>Principal</th><th>Year-end balance</th></tr>
      ${Object.entries(m.annual).sort().reverse().map(([y, a]) => `<tr><td>${y}</td><td>${fmt(a.paid)}</td><td>${fmt(a.interest)}</td><td>${fmt(a.principal)}</td><td>${fmt(a.closing)}</td></tr>`).join('')}</table></div>` : ''}
    <div class="section-title">Payment history (${pays.length})</div>
    <div class="tablewrap"><table><tr><th>Date</th><th>Paid</th><th>Interest</th><th>Principal</th><th>Balance</th></tr>
      ${[...Lg.rows].reverse().slice(0, 80).map(r => r.checkpoint
        ? `<tr><td>${r.date} 📄</td><td colspan="3" style="text-align:left">${esc(r.note)}${Math.abs(r.adjust) >= 0.01 ? ` (true-up ${r.adjust > 0 ? '+' : ''}${fmt(r.adjust)})` : ' ✓ matches'}</td><td>${fmt(r.balance)}</td></tr>`
        : `<tr><td>${r.date}${r.prepayment ? ' ⚡' : ''}</td><td>${fmt(r.payment)}</td><td>${fmt(r.interest)}</td><td>${fmt(r.principal)}</td><td>${fmt(r.balance)}</td></tr>`).join('') || '<tr><td colspan="5">No payments recorded after the start date yet — use “Link past payments”.</td></tr>'}</table></div>
    <div class="section-title">Upcoming schedule${pr.rows[0]?.lender ? ' (from your lender)' : ''}</div>
    <div class="hint pad" style="padding-top:0">Future payments are shown as scheduled only — they never reduce today's balances or count in monthly totals until the payment date.</div>
    <div class="tablewrap"><table><tr><th>Date</th><th>Interest</th><th>Principal</th><th>Balance</th></tr>
      ${pr.rows.slice(0, 60).map(r => `<tr><td>${r.date}</td><td>${fmt(r.interest)}</td><td>${fmt(r.principal)}</td><td>${fmt(r.balance)}</td></tr>`).join('')}</table></div>
    ${(m.rateChanges || []).length ? `<div class="hint pad">Terms history: ${[...(m.rateChanges || [])].sort((a, b) => a.date.localeCompare(b.date)).map(c => `${c.date} → ${c.rate ? c.rate + '%' : ''}${c.frequency ? ' ' + M.MORT_FREQ[c.frequency] : ''}${c.payment ? ' ' + fmt(c.payment) : ''}`).join(' · ')}</div>` : ''}
    <div class="hint pad">Interest is calculated per payment using Canadian rules (fixed rates compound semi-annually). Balances from lender statements are used as checkpoints, so the tracked balance always lines up with your statements.</div>`);
  const pay = { type: 'mortgage', mortgageId: m.id, amount: m.payment, note: m.lender || m.name };
  body.querySelector('#pay').onclick = () => editTxn(null, pay);
  body.querySelector('#pre').onclick = () => editTxn(null, { ...pay, amount: '', prepayment: true, note: 'Mortgage prepayment' });
  body.querySelector('#edit').onclick = () => editMortgage(m);
  body.querySelector('#link').onclick = () => linkMortgagePayments(m);
  body.querySelector('#mkrec')?.addEventListener('click', () => {
    const payers = {}; M.live(S, 'transactions').filter(t => t.type === 'mortgage' && t.mortgageId === m.id).forEach(t => (payers[t.accountId] = (payers[t.accountId] || 0) + 1));
    const payer = Object.entries(payers).sort((a, b) => b[1] - a[1])[0]?.[0] || defaultAccount();
    const freq = { monthly: 'monthly', biweekly: 'biweekly', accelBiweekly: 'biweekly', weekly: 'weekly', semimonthly: 'monthly' }[m.frequency] || 'monthly';
    const start = firstDate || M.addDays(t0, 1);
    M.put(S, 'recurring', { id: M.uid(), freq, interval: 1, startDate: start, materializedThrough: t0, template: { type: 'mortgage', amount: m.payment, accountId: payer, mortgageId: m.id, note: m.lender || m.name } });
    commit(); toast(`Repeat payment created from ${M.accName(S, payer)}`); mortgageDetail(m);
  });
  body.querySelector('#doc').onclick = () => importStatement();
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
    const p2 = M.project(m, Lg.balance, lastDate, x, t0, firstDate || pr.rows[0]?.date);
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
    <div class="row"><button class="primary" id="add">+ Add category</button></div>
    <div class="btnrow" style="padding:8px 0 0"><button class="secondary" id="pack">✨ Add suggested categories</button><button class="secondary" id="dd">🧹 Merge duplicates</button></div>`);
  body.querySelector('#pack').onclick = () => suggestedCategories(type);
  body.querySelector('#dd').onclick = () => { const r = M.dedupe(S); commit(); toast(r.categories ? `Merged ${r.categories} duplicate categor${r.categories === 1 ? 'y' : 'ies'}` : 'No duplicates found'); listCategories(type); };
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
    <label>Default purpose<select name="tag"><option value="">Personal / none</option>${Object.entries(X.TAGS).filter(([k]) => k !== 'personal').map(([k, v]) => `<option value="${k}" ${c.defaultTag === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
    ${c.type === 'expense' ? `<label>Monthly budget (main categories)<input name="budget" type="number" min="0" step="10" value="${c.budget || ''}" placeholder="none"></label>` : ''}
    <div class="row"><button class="primary">Save</button>${!isNew ? '<button type="button" id="del" class="danger">Delete</button>' : ''}</div></form>`);
  const f = body.querySelector('#f');
  if (!isNew) body.querySelector('#del').onclick = () => {
    if (!confirm('Delete category? Existing transactions will show as Uncategorized.')) return;
    M.remove(S, 'categories', c.id); M.live(S, 'categories').filter(x => x.parentId === c.id).forEach(x => M.remove(S, 'categories', x.id));
    commit(); listCategories(c.type);
  };
  f.onsubmit = e => { e.preventDefault(); Object.assign(c, { name: fv(f, 'name'), emoji: fv(f, 'emoji'), parentId: f.parentId.value || null, defaultTag: f.tag.value || undefined, budget: f.budget && +f.budget.value > 0 ? +f.budget.value : undefined }); M.put(S, 'categories', c); commit(); listCategories(c.type); };
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
    <label>Card / account number endings<input name="numbers" inputmode="numeric" placeholder="e.g. 1234, 5678" value="${esc(I.accountEndings(a).join(', '))}"></label>
    <div class="hint" style="margin-top:-4px">Last 4 digits of every card/account number on this account — used to pick the right account for statements, CSVs, receipts and transfers.</div>
    <div class="two"><label>Statement day (cards)<input type="number" min="1" max="31" name="statementDay" value="${a.statementDay || ''}"></label>
    <label>Payment due (days after statement)<input type="number" min="1" max="40" name="dueDays" value="${a.dueDays || ''}" placeholder="learned"></label></div>
    <label>Default purpose of its transactions<select name="tag"><option value="">Personal / none</option>${Object.entries(X.TAGS).filter(([k]) => k !== 'personal').map(([k, v]) => `<option value="${k}" ${a.defaultTag === k ? 'selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
    <label>Name on bank statements (multi-account PDFs)<input name="labels" value="${esc((a.statementLabels || []).join('; '))}" placeholder="e.g. Chequing 0"></label>
    ${accountCycleInfo(a)}
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
    Object.assign(a, { groupId: f.groupId.value, name: fv(f, 'name'), statementDay: +f.statementDay.value || undefined, dueDays: +f.dueDays.value || undefined,
      numbers: fv(f, 'numbers') || undefined, cardLast4: undefined, defaultTag: f.tag.value || undefined, statementLabels: fv(f, 'labels').split(';').map(x => x.trim()).filter(Boolean),
      includeInTotals: f.inc.checked, hidden: f.hidden.checked });
    M.put(S, 'accounts', a); closeSheet(); commit(); toast('Account saved');
  };
}
function accountCycleInfo(a) {
  if (I.accountKind(S, a.id) !== 'card' && !(a.cycles || []).length) return '';
  const pc = X.predictCycle(a);
  const cyc = [...(a.cycles || [])].reverse().filter(c => c.dueDate).slice(0, 3);
  const plans = (a.plans || []).filter(p => !p.expiry || p.expiry >= today());
  return `<div class="card" style="margin-bottom:10px"><small>Statement cycle</small>
    ${pc ? `<b style="font-size:14px">Next statement ~${pc.next} · due ~${pc.nextDue}</b><small>Learned from ${(a.cycles || []).length} statement date(s) (${{ dom: 'same day each month', eom: 'same distance from month end', len: 'fixed cycle length' }[pc.method]}); payment due ${pc.dueGap} days after.</small>` : '<small>Import a statement or set the statement day to get due-date reminders.</small>'}
    ${cyc.map(c => `<small>${c.statementDate} → due ${c.dueDate} · ${fmt(c.balanceDue ?? c.newBalance ?? 0)}${c.minPayment ? ` (min ${fmt(c.minPayment)})` : ''}</small>`).join('')}
    ${plans.length ? `<small style="margin-top:6px"><b>Equal payment plans</b> (not due all at once): ${plans.map(p => `${p.start} ${fmt(p.original)} → ${fmt(p.monthly)}/mo until ${p.expiry}`).join('; ')}</small>` : ''}</div>`;
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
    <div class="section-title">End-to-end encryption</div>
    <div class="pad hint" style="padding-top:0">${vault ? '🔐 <b>On.</b> Your sync file and new backups are encrypted on this device before upload — Google, or anyone who gets into your Google account, sees only scrambled data.' : '<b>Off.</b> Turn on to encrypt your sync file and backups with a passphrase only you know.'}</div>
    <div class="btnrow" style="padding:0">${vault ? '<button class="secondary" id="encChg">Change passphrase</button><button class="secondary" id="encOff">Turn off</button>' : '<button class="primary" id="encOn">Turn on encryption</button>'}</div>
    <div class="section-title">Backup</div>
    <div class="btnrow" style="padding:0"><button class="secondary" id="exp">Export backup (.json)</button><button class="secondary" id="imp">Import backup</button><button class="secondary" id="csv">Export CSV</button></div>
    <input type="file" id="impFile" accept=".json,application/json" hidden>
    <div class="hint">“Import backup” also accepts a MoneyBook setup file (card numbers, statement cycles, mortgage details).</div>
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
      let raw = JSON.parse(await file.text());
      if (Cx.isEncrypted(raw)) { const r = await askPassphrase(raw, 'This backup file is encrypted.'); if (!r) return; raw = r.data; }
      if (raw.type === 'moneybook-setup') return applySetup(raw);
      const data = M.migrate(raw);
      const n = M.live(data, 'transactions').length;
      const b2 = openSheet('Import backup', `<div class="hint">“${esc(file.name)}” has ${n} transactions and ${M.live(data, 'accounts').length} accounts.</div>
        <div class="list">
          <div class="li" id="optR"><div class="grow"><b>Replace all data</b><small>Removes everything currently in MoneyBook (on all synced devices) and uses this file instead. Use this for your first import from Money Manager.</small></div><span class="chev">›</span></div>
          <div class="li" id="optM"><div class="grow"><b>Merge</b><small>Keeps current data and adds this file's records. Same records are combined; newest edit wins.</small></div><span class="chev">›</span></div>
        </div><div class="row"><button class="secondary" data-act="closeSheet">Cancel</button></div>`);
      b2.querySelector('#optM').onclick = () => { S = M.migrate(M.merge(S, data)); M.materialize(S); closeSheet(); commit(); toast('Backup merged'); };
      b2.querySelector('#optR').onclick = () => {
        if (!confirm('Replace ALL current MoneyBook data with this backup? This cannot be undone (export a backup first if unsure).')) return;
        replaceAll(data, n);   // tombstones old records so synced devices drop them too
      };
    } catch (err) { toast('Not a valid backup: ' + err.message); }
  };
  body.querySelector('#out').onclick = () => { Sync.signOut(); toast('Signed out'); };
  body.querySelector('#encOn')?.addEventListener('click', () => encryptionSetup(false));
  body.querySelector('#encChg')?.addEventListener('click', () => encryptionSetup(true));
  body.querySelector('#encOff')?.addEventListener('click', async () => {
    if (!confirm('Turn off encryption? Your Drive sync file will be stored unencrypted again. Existing encrypted backups stay encrypted.')) return;
    await setVault(null); try { await doSync(true); } catch {} syncScreen();
  });
}
function encryptionSetup(change) {
  if (!L.clientId) return toast('Set up Google Drive sync first');
  const body = openSheet(change ? 'Change passphrase' : 'Turn on encryption', `
    <div class="hint">Choose a long passphrase (at least 12 characters — a few random words works well) and save it in your password manager <b>before</b> continuing.<br><br>
    ⚠️ If you forget it and lose your devices, the Drive copy and encrypted backups <b>cannot be recovered by anyone</b>. Your data on this device is not affected.</div>
    <form id="f"><label>Passphrase<input name="p1" type="password" autocomplete="new-password" minlength="12" required></label>
    <label>Repeat passphrase<input name="p2" type="password" autocomplete="new-password" required></label>
    <label class="check"><input type="checkbox" name="saved" required> I've saved it in my password manager</label>
    ${!change ? '<label class="check"><input type="checkbox" name="wipe" checked> Delete my older unencrypted backups from Drive</label>' : ''}
    <div class="hint" id="m"></div><div class="row"><button class="primary">${change ? 'Change & re-encrypt' : 'Encrypt my Drive data'}</button></div></form>
    <div class="hint">Other devices will ask for the passphrase once at their next sync.</div>`);
  const f = body.querySelector('#f');
  f.onsubmit = async e => {
    e.preventDefault();
    const p = f.p1.value; if (p.length < 12) return toast('Use at least 12 characters'); if (p !== f.p2.value) return toast("Passphrases don't match");
    const m = body.querySelector('#m'); m.textContent = 'Encrypting… (a few seconds)';
    try {
      const old = (!change && f.wipe?.checked) ? await Sync.listBackups(L.clientId, true) : [];
      const prev = vault, salt = Cx.newSalt(), nv = { salt, key: await Cx.deriveKey(p, salt) };
      // Read Drive with the current key, write it back with the new one.
      const mixed = { decode: async r => (Cx.isEncrypted(r) && prev && prev.salt === r.salt ? Cx.decryptJSON(r, prev.key) : codec.decode(r)),
                      encode: async st => Cx.encryptJSON(st, nv.key, nv.salt) };
      S = M.migrate(await Sync.sync(S, L.clientId, true, mixed)); M.materialize(S); await DB.save(S);
      await setVault(nv); render();
      await Sync.weeklyBackup(S, L.clientId, { force: true, codec });
      for (const b of old) await Sync.deleteBackup(b.id, L.clientId);
      closeSheet(); toast(change ? 'Passphrase changed — Drive data re-encrypted 🔐' : 'Encryption on — Drive data is now encrypted 🔐', 4000);
    } catch (err) { m.textContent = 'Failed: ' + err.message; }
  };
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
    <label>Appearance<select name="theme">${[['system', 'Match phone / PC setting'], ['light', 'Always light (day mode)'], ['dark', 'Always dark']].map(([k, v]) => `<option value="${k}" ${(L.theme || 'system') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label>HST rate % (for the HST button on transactions)<input type="number" min="0" max="20" step="0.5" name="hst" value="${S.settings.hstRate ?? 13}"></label>
    <label>Remind me this many days before a payment<input type="number" min="0" max="28" name="rd" value="${S.settings.remindDays ?? 3}"></label>
    <div class="hint">Used for the upcoming banner, this device's notification when you open the app, and new Google Calendar reminders.</div>
    <div class="row"><button class="primary">Save</button></div></form>
    <div class="section-title">Notifications on this device</div>
    <div class="pad hint">Status: <b>${perm}</b>. Browsers can only notify when the app is opened; for reliable alerts while it's closed, use the 🔔 Google Calendar reminder on repeat payments.</div>
    <div class="btnrow"><button class="secondary" id="np">Allow notifications</button></div>`);
  const f = body.querySelector('#f');
  f.theme.onchange = () => { L.theme = f.theme.value; saveLocal(); applyTheme(); };
  f.onsubmit = e => { e.preventDefault(); L.theme = f.theme.value; saveLocal(); applyTheme(); S.settings = { ...S.settings, remindDays: Math.max(0, +f.rd.value || 0), hstRate: +f.hst.value || 13, updatedAt: Date.now() }; commit(); closeSheet(); toast('Saved'); };
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
    ((t.type === statsType && (t.splits?.length ? t.splits.map(x => x.categoryId) : [t.categoryId]).some(id => (M.topCatId(S, id) || id || 'none') === topId)) ||
     (statsType === 'expense' && t.type === 'mortgage' && M.get(S, 'mortgages', t.mortgageId)?.categoryId === topId)))
    .sort((a, b) => b.date.localeCompare(a.date));
  const { map } = M.mortgageSplits(S);
  const c = M.get(S, 'categories', topId);
  openSheet(c ? `${c.emoji || ''} ${c.name}` : 'Uncategorized', `<div class="list">${rows.map(([id, v]) => `<div class="li"><div class="grow">${esc(id === topId ? '(main category)' : M.get(S, 'categories', id)?.name || '—')}</div><b>${fmt(v)}</b></div>`).join('')}</div>
    <div class="section-title">Transactions</div><div class="day" style="margin:0">${tx.map(t => txRow(t, map)).join('')}</div>`);
}

// ---------- statement / CSV / screenshot import ----------
function importStatement() {
  const body = openSheet('Import transactions', `
    <div class="hint">Pick one or more files — mixing banks and cards is fine. They are read <b>on this device</b>; nothing is uploaded.</div>
    <div class="list">
      <div class="li"><span style="font-size:20px">📄</span><div class="grow">PDF statements<small>Scotia, Triangle, CIBC, Meridian (incl. multi-account statements)… and mortgage statements / amortization schedules</small></div></div>
      <div class="li"><span style="font-size:20px">📊</span><div class="grow">CSV downloads<small>Scotia, EQ Bank & EQ Card, Triangle, Meridian Visa, CIBC…</small></div></div>
      <div class="li"><span style="font-size:20px">📱</span><div class="grow">Screenshots<small>Banking-app transaction lists — overlaps between screenshots are removed</small></div></div>
    </div>
    <div class="row"><button class="primary" id="pick">Choose files</button></div>
    <input type="file" id="files" multiple accept=".pdf,application/pdf,.csv,text/csv,text/plain,image/*" hidden>
    <div id="msg" class="hint"></div>`);
  const msg = t => (body.querySelector('#msg').textContent = t);
  body.querySelector('#pick').onclick = () => body.querySelector('#files').click();
  body.querySelector('#files').onchange = async e => {
    const files = [...e.target.files]; if (!files.length) return;
    const batches = [], notes = [], mortgageDocs = [];
    try {
      for (const [i, f] of files.entries()) {
        const tag = `${i + 1}/${files.length} ${f.name}`;
        if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) {
          msg(`Reading ${tag}…`);
          const r = await I.readPdf(f, p => msg(`Reading ${tag}… ${Math.round(p * 100)}%`), (c, pr) => R.ocr(c, pr));
          const md = I.parseMortgageDoc(r.lines);
          if (md) { mortgageDocs.push({ name: f.name, doc: md }); continue; }
          const { rows, meta } = I.parseStatement(r.lines, f.name);
          batches.push({ name: f.name, kind: 'pdf', rows, meta, endings: meta.endings || [] });
          if (r.scanned) notes.push(`${f.name} is a scanned PDF — double-check amounts.`);
        } else if (/csv|text/i.test(f.type) || /\.(csv|txt)$/i.test(f.name)) {
          const table = I.parseCsvText(await f.text());
          const probe = I.parseCsvRows(table, 'asset', f.name);
          batches.push({ name: f.name, kind: 'csv', table, endings: probe.endings || [], sig: probe.sig });
        } else if (/^image\//.test(f.type)) {
          msg(`Reading ${tag}… (first time downloads the text reader, ~10 MB)`);
          const t = await R.ocr(f, p => msg(`Reading ${tag}… ${Math.round(p * 100)}%`));
          const { rows, meta } = I.parseStatement(t.split(/\r?\n/), f.name, { negIsOut: true });
          batches.push({ name: f.name, kind: 'image', rows, meta, endings: I.findAllLast4(t) });
        } else notes.push(`Skipped ${f.name} (unsupported type).`);
      }
    } catch (err) { return msg('Could not read the file: ' + err.message); }
    if (mortgageDocs.length) { mortgageDocImport(mortgageDocs, !batches.length); if (!batches.length) return; }
    for (const b of batches) {
      const m = I.matchAccount(S, { endings: b.endings, sig: b.sig, filename: b.name });
      b.accountId = m?.account.id || L.lastImportAccount || defaultAccount(); b.how = m?.how || null;
      const secs = [...new Set((b.rows || []).map(r => r.section).filter(Boolean))];
      if (secs.length > 1) { b.sectionAcc = {}; secs.forEach(s => (b.sectionAcc[s] = I.sectionAccount(S, s)?.id || '')); }
    }
    importReview({ batches, notes });
  };
}

function importReview(ctx) {
  const st = { flip: false, rows: [] };
  const accFor = (b, r) => (b.sectionAcc && r.section && b.sectionAcc[r.section]) || b.accountId;
  function build() {
    const rows = [];
    ctx.batches.forEach((b, bi) => {
      const parsed = b.kind === 'csv' ? I.parseCsvRows(b.table, I.accountKind(S, b.accountId), b.name).rows : b.rows.map(r => ({ ...r }));
      for (const r of parsed) {
        r.bi = bi; r.accountId = accFor(b, r);
        r.dir = I.resolveDir(r, I.accountKind(S, r.accountId), b.meta?.kind);
        if (st.flip) r.dir = r.dir === 'out' ? 'in' : 'out';
      }
      rows.push(...parsed);
    });
    rows.sort((a, b) => a.date.localeCompare(b.date));
    for (const r of rows) {
      const kind = I.accountKind(S, r.accountId);
      const cp = I.counterpartAccount(S, r.raw || r.desc, r.accountId);
      const sg = R.suggest(S, r.desc);
      const tr = sg.rule?.transferAccountId && (sg.rule.accountId === r.accountId || sg.rule.transferAccountId === r.accountId) ? (sg.rule.accountId === r.accountId ? sg.rule.transferAccountId : sg.rule.accountId) : null;
      if (cp) { r.type = 'transfer'; r.other = cp.id; }
      else if (tr && M.get(S, 'accounts', tr)) { r.type = 'transfer'; r.other = tr; }
      else if (r.dir === 'in' && kind === 'card' && I.isPayment(r.desc)) { r.type = 'transfer'; r.other = I.usualPayer(S, r.accountId) || ''; }
      else if (r.dir === 'out' && kind !== 'card' && /credit card|visa|mastercard|card payment|cc pay|loc pay/i.test(r.desc)) { r.type = 'transfer'; r.other = ''; }
      else {
        r.type = r.dir === 'out' ? 'expense' : 'income';
        const c = sg.categoryId && M.get(S, 'categories', sg.categoryId);
        r.categoryId = c && c.type === r.type ? c.id : bankCategory(r.bankCat, r.type);
      }
    }
    I.markDuplicates(S, rows);
    rows.forEach(r => (r.on = (!r.dup || r.dup.reason === 'scheduled') && !r.pending && !!r.accountId));
    st.rows = rows;
  }
  function bankCategory(label, type) {
    if (!label) return '';
    const l = label.toLowerCase().slice(0, 5);
    return M.live(S, 'categories').find(c => c.type === type && c.name.toLowerCase().startsWith(l))?.id || '';
  }
  function render() {
    const rows = st.rows, sel = rows.filter(r => r.on);
    const dups = rows.filter(r => r.dup && r.dup.reason !== 'scheduled').length, upd = rows.filter(r => r.dup?.reason === 'scheduled').length;
    const multi = new Set(rows.map(r => r.accountId)).size > 1;
    const body = openSheet('Review import', `
      ${ctx.batches.map((b, bi) => `<div class="card" style="margin-bottom:8px">
        <small>${b.kind === 'pdf' ? '📄' : b.kind === 'csv' ? '📊' : '📱'} ${esc(b.name)}${b.meta?.statementDate ? ` · statement ${b.meta.statementDate}` : ''}${b.meta?.dueDate ? ` · due ${b.meta.dueDate}` : ''}</small>
        ${b.sectionAcc ? Object.keys(b.sectionAcc).map(s => `<label>“${esc(s)}” goes to<select data-b="${bi}" data-sec="${esc(s)}">${accountOptions(b.sectionAcc[s], { allowEmpty: true })}</select></label>`).join('')
          : `<label style="margin:4px 0 0">Account<select data-b="${bi}">${accountOptions(b.accountId)}</select></label>`}
        ${b.how === 'number' ? `<small>Matched by card/account number.</small>` : b.how === 'signature' ? '<small>Matched from a previous import of this file type.</small>' : b.endings?.length ? `<small>Number ending ${esc(b.endings.join(', '))} — saved to the account you pick, so next time it's automatic.</small>` : ''}
      </div>`).join('')}
      <div class="hint">${rows.length} found · <b>${dups} duplicate${dups === 1 ? '' : 's'}</b> unticked${upd ? ` · ${upd} will update scheduled entries` : ''}${rows.some(r => r.pending) ? ' · pending items unticked' : ''} · ${sel.length} selected.</div>
      ${ctx.notes.map(n => `<div class="hint">⚠️ ${esc(n)}</div>`).join('')}
      <div class="btnrow" style="padding:0 0 8px"><button class="secondary" id="all">Select all</button><button class="secondary" id="nodup">Untick duplicates</button><button class="secondary" id="flip">Swap in / out</button></div>
      <div class="list" id="rows">${rows.map((r, i) => rowHtml(r, i, multi)).join('') || '<div class="empty">No transactions recognised in these files. Send a sample to have this layout added.</div>'}</div>
      <div class="sticky-bar"><button class="primary" id="go" style="width:100%" ${sel.length ? '' : 'disabled'}>Import ${sel.length} transaction${sel.length === 1 ? '' : 's'}</button></div>`);
    body.querySelectorAll('select[data-b]').forEach(s => (s.onchange = e => {
      const b = ctx.batches[+s.dataset.b];
      if (s.dataset.sec) b.sectionAcc[s.dataset.sec] = e.target.value; else { b.accountId = e.target.value; b.how = null; L.lastImportAccount = b.accountId; saveLocal(); }
      build(); render();
    }));
    body.querySelector('#all').onclick = () => { rows.forEach(r => (r.on = !!r.accountId)); render(); };
    body.querySelector('#nodup').onclick = () => { rows.forEach(r => r.dup && r.dup.reason !== 'scheduled' && (r.on = false)); render(); };
    body.querySelector('#flip').onclick = () => { st.flip = !st.flip; build(); render(); };
    body.querySelector('#rows').onchange = e => {
      const i = +e.target.closest('[data-i]')?.dataset.i; const r = rows[i]; if (!r) return;
      const k = e.target.dataset.k;
      if (k === 'on') r.on = e.target.checked;
      if (k === 'type') { r.type = e.target.value; r.categoryId = ''; r.other = ''; }
      if (k === 'cat') r.categoryId = e.target.value;
      if (k === 'other') r.other = e.target.value;
      const sc = $('#sheet .sheet-body').scrollTop; render(); $('#sheet .sheet-body').scrollTop = sc;
    };
    body.querySelector('#go').onclick = () => doImport(rows.filter(r => r.on));
  }
  function rowHtml(r, i, multi) {
    const cls = r.type === 'income' ? 'inc' : r.type === 'transfer' ? 'xfer' : 'exp';
    const d = r.dup?.txnId && M.get(S, 'transactions', r.dup.txnId);
    let dupText = '';
    if (r.dup?.reason === 'existing') dupText = `⚠️ Duplicate — already in MoneyBook: ${d.date} · ${esc(d.note || txLabel(d))} · ${fmt(d.amount)}`;
    else if (r.dup?.reason === 'batch') dupText = r.type === 'transfer' ? `⚠️ Duplicate — other side of the same transfer (“${esc(r.dup.twin || '')}”) in another file` : `⚠️ Duplicate — same entry is in another file you picked (“${esc(r.dup.twin || '')}”)`;
    else if (r.dup?.reason === 'scheduled') dupText = `🔁 Updates the scheduled “${esc(d.note || '')}” on ${d.date}${Math.abs(d.amount - r.amount) > 0.004 ? ` (${fmt(d.amount)} → ${fmt(r.amount)})` : ''} instead of adding a copy`;
    else if (r.pending) dupText = '⏳ Pending at the bank — import it after it posts';
    const typeSel = `<select data-k="type">${['expense', 'income', 'transfer'].map(t => `<option value="${t}" ${t === r.type ? 'selected' : ''}>${cap(t)}</option>`).join('')}</select>`;
    const second = r.type === 'transfer'
      ? `<select data-k="other"><option value="">${r.dir === 'in' ? 'Paid from…' : 'Paid to…'}</option>${M.live(S, 'accounts').filter(a => a.id !== r.accountId && !a.mortgageAccount).map(a => `<option value="${a.id}" ${a.id === r.other ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}</select>`
      : `<select data-k="cat">${categoryOptions(r.type, r.categoryId)}</select>`;
    return `<div class="imp-row ${r.dup || r.pending ? 'dup' : ''} ${r.on ? '' : 'off'}" data-i="${i}">
      <input type="checkbox" data-k="on" ${r.on ? 'checked' : ''} aria-label="Import this row">
      <div class="imp-main"><div>${esc(r.desc)}</div><small>${r.date}${r.dir === 'in' ? ' · money in' : ''}${multi ? ' · ' + esc(M.accName(S, r.accountId)) : ''}</small></div>
      <b class="${cls}">${fmt(r.amount)}</b>
      ${r.on && r.dup?.reason !== 'scheduled' ? `<div class="imp-ctl">${typeSel}${second}</div>` : ''}
      ${dupText ? `<div class="dupnote">${dupText}</div>` : ''}</div>`;
  }
  function doImport(rows) {
    const noAcc = rows.filter(r => r.dup?.reason !== 'scheduled' && r.type === 'transfer' && !r.other);
    if (noAcc.length) return toast(`Pick the other account for ${noAcc.length} transfer${noAcc.length > 1 ? 's' : ''} (e.g. which bank paid the card)`, 4500);
    const missing = rows.filter(r => r.dup?.reason !== 'scheduled' && r.type !== 'transfer' && !r.categoryId).length;
    if (missing && !confirm(`${missing} selected row(s) have no category yet. Import them as Uncategorized anyway?`)) return;
    let n = 0, u = 0;
    for (const r of rows) {
      if (r.dup?.reason === 'scheduled') {           // statement is the truth: correct the auto-posted entry
        const t = M.get(S, 'transactions', r.dup.txnId); if (!t) continue;
        Object.assign(t, { amount: r.amount, date: r.date, imported: true }); M.put(S, 'transactions', t); u++; continue;
      }
      const t = { id: M.uid(), type: r.type, date: r.date, amount: r.amount, note: r.desc, desc: '', imported: true };
      if (r.type === 'transfer') {
        if (r.dir === 'out') { t.accountId = r.accountId; t.toAccountId = r.other; } else { t.accountId = r.other; t.toAccountId = r.accountId; }
        R.learnTransfer(S, r.desc, r.accountId, r.other);
      } else { t.accountId = r.accountId; t.categoryId = r.categoryId; }
      M.put(S, 'transactions', t); n++;
      if (t.type === 'expense' && t.categoryId) R.learn(S, r.desc, r.accountId, t.categoryId);
    }
    // Remember how to recognise these files and keep each card's statement history (for due-date reminders).
    for (const b of ctx.batches) {
      const a = M.get(S, 'accounts', b.accountId); if (!a || b.sectionAcc) { if (b.sectionAcc) saveSectionLabels(b); continue; }
      const nums = I.accountEndings(a);
      if (b.endings?.length && b.endings.length <= 3 && b.how !== 'number') a.numbers = [...new Set([...nums, ...b.endings])].join(', ');
      if (b.sig && !(a.importSigs || []).includes(b.sig)) a.importSigs = [...(a.importSigs || []), b.sig];
      const mt = b.meta;
      if (mt?.kind === 'card' && mt.statementDate) {
        upsertCycle(a, { statementDate: mt.statementDate, dueDate: mt.dueDate, balanceDue: mt.balanceDue ?? mt.newBalance, newBalance: mt.newBalance, minPayment: mt.minPayment });
        if (mt.periodStart) upsertCycle(a, { statementDate: M.addDays(mt.periodStart, -1) });
      }
      if (mt?.plans?.length) { const by = new Map((a.plans || []).map(p => [p.start + '|' + p.original, p])); mt.plans.forEach(p => by.set(p.start + '|' + p.original, p)); a.plans = [...by.values()]; }
      M.put(S, 'accounts', a);
    }
    closeSheet(); commit(); toast(`Imported ${n} transaction${n === 1 ? '' : 's'}${u ? `, updated ${u} scheduled` : ''}`);
  }
  function saveSectionLabels(b) {
    for (const [sec, id] of Object.entries(b.sectionAcc)) {
      const a = M.get(S, 'accounts', id); if (!a) continue;
      const label = sec.split(/\s+-\s+|\s{2,}/)[0].trim();
      if (label && !(a.statementLabels || []).includes(label)) { a.statementLabels = [...(a.statementLabels || []), label]; M.put(S, 'accounts', a); }
    }
  }
  build(); render();
}
function upsertCycle(a, c) {
  const list = (a.cycles || []).filter(x => x.statementDate !== c.statementDate);
  const old = (a.cycles || []).find(x => x.statementDate === c.statementDate) || {};
  const merged = { ...old }; Object.entries(c).forEach(([k, v]) => { if (v != null) merged[k] = v; });
  a.cycles = [...list, merged].sort((x, y) => x.statementDate.localeCompare(y.statementDate)).slice(-24);
}

// ---------- mortgage documents (statements, annual statements, amortization schedule) ----------
function mortgageDocImport(docs, standalone = true) {
  const ms = M.live(S, 'mortgages');
  const num = docs.map(d => d.doc.number).find(Boolean);
  let target = ms.find(m => num && m.number === num) || (ms.length === 1 ? ms[0] : null);
  const body = openSheet('Mortgage documents', `
    <div class="hint">Found: ${docs.map(d => `<b>${esc({ info: 'balance statement', annual: `${d.doc.year} annual statement`, schedule: 'amortization schedule' }[d.doc.kind])}</b>`).join(', ')}.</div>
    <label>Apply to<select id="mt">${ms.map(m => `<option value="${m.id}" ${target?.id === m.id ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}<option value="">+ New mortgage from these documents</option></select></label>
    <div class="hint">Balances become checkpoints (your tracked balance is corrected to the lender's figure on that date). The schedule gives exact future interest/principal splits. Rate, payment and frequency are updated from the newest document.</div>
    <div class="row"><button class="primary" id="go">Apply</button></div>`);
  body.querySelector('#go').onclick = () => {
    const id = body.querySelector('#mt').value;
    let m = id ? M.get(S, 'mortgages', id) : null;
    if (!m) {
      const ann = docs.map(d => d.doc).filter(d => d.kind === 'annual').sort((a, b) => a.year - b.year)[0];
      m = { id: M.uid(), name: 'Home mortgage', lender: '', compounding: 'semiannual', principal: ann?.advances || ann?.opening || 0, startDate: ann ? `${ann.year}-01-01` : today(), rate: 0, frequency: 'monthly', payment: 0 };
      ensureMortgageAccount(m);
    }
    applyMortgageDocs(m, docs.map(d => d.doc));
    M.put(S, 'mortgages', m); M.materialize(S); commit();
    toast('Mortgage updated from lender documents'); mortgageDetail(m);
  };
}
function ensureMortgageAccount(m) {
  if (m.accountId && M.get(S, 'accounts', m.accountId)) return;
  const g = M.live(S, 'groups').find(g => g.kind === 'liability') || M.put(S, 'groups', { id: M.uid(), name: 'Loan', kind: 'liability', order: 99 });
  m.accountId = M.put(S, 'accounts', { id: 'acct_' + m.id, groupId: g.id, name: m.name, opening: 0, includeInTotals: true, mortgageAccount: true }).id;
}
function addCheckpoint(m, date, balance, note) {
  if (!date || !(balance >= 0)) return;
  m.checkpoints = [...(m.checkpoints || []).filter(c => c.date !== date), { date, balance, note }].sort((a, b) => a.date.localeCompare(b.date));
}
function applyMortgageDocs(m, docs) {
  docs = [...docs].sort((a, b) => (a.asOf || a.periodEnd || '').localeCompare(b.asOf || b.periodEnd || ''));
  for (const d of docs) {
    if (d.number) m.number = d.number;
    if (d.kind === 'annual') {
      addCheckpoint(m, d.periodEnd, d.closing, `${d.year} annual statement`);
      m.annual = { ...(m.annual || {}), [d.year]: { interest: d.interestPaid, principal: d.principalPaid, paid: d.totalPaid, closing: d.closing } };
      if (d.frequency || d.rate) m.rateChanges = [...(m.rateChanges || []).filter(c => c.date !== `${d.year}-01-01`), { date: `${d.year}-01-01`, rate: d.rate, frequency: d.frequency, payment: d.payment }];
      if (d.maturity) m.termEnd = d.maturity;
      if (d.advances > 0 && !(d.opening > 0) && (!m.principal || m.startDate >= `${d.year}-01-01`)) m.principal = d.advances;
    }
    if (d.kind === 'info') {
      addCheckpoint(m, d.asOf, d.balance, 'Lender balance statement');
      Object.assign(m, { payment: d.payment || m.payment, rate: d.rate || m.rate, frequency: d.frequency || m.frequency, compounding: d.rateType === 'variable' ? 'monthly' : 'semiannual' });
      if (d.amortYears) m.amortYears = Math.round(d.amortYears * 10) / 10;
      if (d.finalPayment) m.termEnd = d.finalPayment;
      if (d.nextDue) m.nextDue = d.nextDue;
    }
    if (d.kind === 'schedule') {
      addCheckpoint(m, d.asOf, d.balance, 'Amortization schedule');
      m.schedule = d.schedule; m.payment = d.payment || m.payment; m.frequency = d.frequency || m.frequency;
      if (d.schedule?.[0]?.date) m.nextDue = d.schedule[0].date;
    }
  }
  syncMortgageRepeat(m);
}
// Keep the repeat payment in step with the lender's next due date and amount.
function syncMortgageRepeat(m) {
  const rec = M.live(S, 'recurring').find(r => r.template?.type === 'mortgage' && r.template.mortgageId === m.id);
  if (rec && m.nextDue && m.nextDue > today()) {
    const freq = { monthly: 'monthly', biweekly: 'biweekly', accelBiweekly: 'biweekly', weekly: 'weekly', semimonthly: 'monthly' }[m.frequency] || rec.freq;
    if (!M.occurrences(rec, m.nextDue, m.nextDue).length || +rec.template.amount !== +m.payment || rec.freq !== freq) {
      Object.assign(rec, { startDate: m.nextDue, freq, materializedThrough: today() }); rec.template.amount = m.payment; M.put(S, 'recurring', rec);
    }
  }
}

// Turn past lender-payment expenses (and their repeat) into mortgage payments split into interest + principal.
function linkMortgagePayments(m) {
  const words = (m.lender || m.name || '').toLowerCase().split(/[^a-z]+/).filter(w => w.length > 3 && !/mortgage|home/.test(w));
  const isMortCat = id => /mortgage/i.test(M.catLabel(S, id));
  const matches = t => {
    const txt = `${t.note || ''} ${t.desc || ''}`.toLowerCase();
    return (words.some(w => txt.includes(w)) || isMortCat(t.categoryId) || (t.type === 'transfer' && /mortgage/i.test(M.accName(S, t.toAccountId))));
  };
  const cands = M.live(S, 'transactions').filter(t => t.type !== 'mortgage' && t.type !== 'income' && t.date >= m.startDate && t.date <= today() && +t.amount >= 50 && matches(t))
    .sort((a, b) => a.date.localeCompare(b.date));
  const counts = {}; cands.forEach(t => (counts[t.amount] = (counts[t.amount] || 0) + 1));
  const regular = new Set(Object.entries(counts).filter(([, n]) => n >= 2).map(([a]) => +a));
  (m.rateChanges || []).forEach(c => c.payment && regular.add(+c.payment)); if (m.payment) regular.add(+m.payment);
  const rows = cands.map(t => ({ t, on: true, pre: !regular.has(+t.amount) && ![...regular].some(r => Math.abs(r - t.amount) < 1) }));
  const recs = M.live(S, 'recurring').filter(r => r.template?.type !== 'mortgage' && matches(r.template || {}));
  const body = openSheet('Link past mortgage payments', `
    <div class="hint">These look like payments to ${esc(m.lender || m.name)}. Linked payments are split into interest and principal automatically, reduce the mortgage balance, and get a note like “🏡 Principal $818.75 · Interest $1,181.25 · Balance $543,166.99”. Amounts that aren't a regular payment are marked ⚡ prepayment (100% principal) — untick if wrong.</div>
    ${recs.length ? `<div class="hint">Repeat payment${recs.length > 1 ? 's' : ''} to convert: ${recs.map(r => `<b>${esc(r.template.note || '')}</b> ${fmt(r.template.amount)} ${M.FREQS[r.freq] || ''}`).join(', ')}</div>` : ''}
    <div class="list">${rows.map((r, i) => `<div class="imp-row" data-i="${i}"><input type="checkbox" data-k="on" checked>
      <div class="imp-main"><div>${esc(r.t.note || txLabel(r.t))}</div><small>${r.t.date} · ${esc(M.accName(S, r.t.accountId))}</small></div><b class="exp">${fmt(r.t.amount)}</b>
      <label class="check dupnote" style="color:var(--ink)"><input type="checkbox" data-k="pre" ${r.pre ? 'checked' : ''}> ⚡ Prepayment</label></div>`).join('') || '<div class="empty">No matching payments found. Check the lender name in Edit.</div>'}</div>
    <div class="sticky-bar"><button class="primary" id="go" style="width:100%">Link ${rows.length} payment${rows.length === 1 ? '' : 's'}${recs.length ? ` + ${recs.length} repeat` : ''}</button></div>`);
  body.querySelector('.list').onchange = e => { const r = rows[+e.target.closest('[data-i]').dataset.i]; r[e.target.dataset.k] = e.target.checked; };
  body.querySelector('#go').onclick = () => {
    const cats = {};
    for (const r of rows.filter(r => r.on)) {
      const t = r.t; if (t.categoryId) cats[t.categoryId] = (cats[t.categoryId] || 0) + 1;
      Object.assign(t, { type: 'mortgage', mortgageId: m.id, prepayment: r.pre || undefined }); delete t.toAccountId;
      M.put(S, 'transactions', t);
    }
    for (const r of recs) { r.template = { ...r.template, type: 'mortgage', mortgageId: m.id }; delete r.template.toAccountId; M.put(S, 'recurring', r); }
    const top = Object.entries(cats).sort((a, b) => b[1] - a[1])[0]?.[0];
    if (top && !m.categoryId) m.categoryId = M.topCatId(S, top);
    if (m.categoryId) {
      const sub = name => M.live(S, 'categories').find(c => c.parentId === m.categoryId && c.name.toLowerCase() === name.toLowerCase())
        || M.put(S, 'categories', { id: M.uid(), type: 'expense', name, emoji: '', parentId: m.categoryId, order: S.categories.length });
      m.interestCategoryId = m.interestCategoryId || sub('Interest').id; m.principalCategoryId = m.principalCategoryId || sub('Principal').id;
    }
    M.put(S, 'mortgages', m); syncMortgageRepeat(m); M.refreshMortgageNotes(S); commit();
    toast(`Linked ${rows.filter(r => r.on).length} payments`); mortgageDetail(m);
  };
}

// ---------- private setup file (made from your statements; never stored on GitHub) ----------
function applySetup(data) {
  const accs = M.live(S, 'accounts');
  const find = e => {
    const names = [e.match?.name, ...(e.match?.aliases || [])].filter(Boolean).map(n => n.toLowerCase());
    return accs.find(a => names.includes(a.name.toLowerCase())) || accs.find(a => names.some(n => a.name.toLowerCase().includes(n) || n.includes(a.name.toLowerCase())));
  };
  const entries = (data.accounts || []).map(e => ({ e, acc: find(e) }));
  const body = openSheet('Apply setup file', `
    <div class="hint">${esc(data.title || 'Setup from your statements')}. Pick the matching account for each item — anything set to “skip” is left alone.</div>
    <div class="list">${entries.map((x, i) => `<div class="li" style="display:block"><b>${esc(x.e.label || x.e.match?.name)}</b><small>${esc(x.e.summary || '')}</small>
      <select data-i="${i}" style="margin-top:6px"><option value="">— skip —</option>${accountOptions(x.acc?.id || '').replace(/<option value="">—<\/option>/, '')}</select></div>`).join('')}</div>
    ${(data.mortgages || []).length ? `<div class="hint">Mortgage: <b>${esc(data.mortgages.map(m => m.name).join(', '))}</b> with ${data.mortgages[0].checkpoints?.length || 0} statement balances and ${data.mortgages[0].schedule?.length || 0} scheduled payments. After applying, use “Link past payments” on the mortgage.</div>` : ''}
    <div class="row"><button class="primary" id="go">Apply</button></div>`);
  if (!entries.every(x => x.acc)) entries.forEach((x, i) => { const sel = body.querySelector(`select[data-i="${i}"]`); if (!x.acc) sel.value = ''; else sel.value = x.acc.id; });
  body.querySelector('#go').onclick = () => {
    let n = 0;
    entries.forEach((x, i) => {
      const id = body.querySelector(`select[data-i="${i}"]`).value; const a = id && M.get(S, 'accounts', id); if (!a) return;
      const set = x.e.set || {};
      if (set.numbers) a.numbers = [...new Set([...I.accountEndings(a), ...set.numbers.split(/[,\s]+/).filter(Boolean)])].join(', ');
      ['dueDays', 'statementDay'].forEach(k => set[k] != null && (a[k] = set[k]));
      if (set.importSigs) a.importSigs = [...new Set([...(a.importSigs || []), ...set.importSigs])];
      if (set.statementLabels) a.statementLabels = [...new Set([...(a.statementLabels || []), ...set.statementLabels])];
      (x.e.cycles || []).forEach(c => upsertCycle(a, c));
      if (x.e.plans) { const by = new Map((a.plans || []).map(p => [p.start + '|' + p.original, p])); x.e.plans.forEach(p => by.set(p.start + '|' + p.original, p)); a.plans = [...by.values()]; }
      M.put(S, 'accounts', a); n++;
    });
    for (const dm of data.mortgages || []) {
      let m = M.live(S, 'mortgages').find(x => (dm.number && x.number === dm.number) || x.id === dm.id);
      const { checkpoints = [], rateChanges = [], annual = {}, ...fields } = dm;
      if (!m) { m = { ...fields }; ensureMortgageAccount(m); }
      else Object.assign(m, Object.fromEntries(Object.entries(fields).filter(([k]) => !['id', 'accountId'].includes(k))));
      checkpoints.forEach(c => addCheckpoint(m, c.date, c.balance, c.note));
      m.rateChanges = [...(m.rateChanges || []).filter(c => !rateChanges.some(r => r.date === c.date)), ...rateChanges];
      m.annual = { ...(m.annual || {}), ...annual };
      const acc = M.get(S, 'accounts', m.accountId); if (acc) { acc.name = m.name; M.put(S, 'accounts', acc); }
      M.put(S, 'mortgages', m);
    }
    closeSheet(); commit(); toast(`Setup applied to ${n} account${n === 1 ? '' : 's'}${(data.mortgages || []).length ? ' + mortgage' : ''}`);
    if ((data.mortgages || []).length) { tab = 'more'; render(); listMortgages(); }
  };
}

// ---------- needs attention: card payments, bills to add, suggestions ----------
function attentionHtml() {
  const rd = S.settings.remindDays ?? 3;
  const cards = X.cardStatuses(S).filter(c => c.status === 'due' || c.status === 'overdue');
  const bills = X.billReminders(S, today(), rd);
  const nSug = suggestionCount();
  const m0 = M.ymd(new Date(new Date().getFullYear(), new Date().getMonth(), 1)), m1 = M.ymd(new Date(new Date().getFullYear(), new Date().getMonth() + 1, 0));
  const buds = X.budgetStatus(S, m0, m1).filter(b => b.status === 'over' || b.status === 'near');
  const lows = forecastLows();
  if (!cards.length && !bills.length && !nSug && !buds.length && !lows.length) return '';
  const line = (icon, main, sub, btns, warn) => `<div class="li"><span style="font-size:20px">${icon}</span><div class="grow"><span class="${warn ? 'exp' : ''}">${main}</span><small>${sub}</small></div>${btns}</div>`;
  return `<div class="section-title">Needs attention</div><div class="list">` +
    cards.map(c => line('💳', `${esc(c.account.name)} — ${fmt(c.remaining)} ${c.status === 'overdue' ? 'was due' : 'due'} ${c.dueDate.slice(5)}`,
      `${c.status === 'overdue' ? 'Overdue — not showing as paid' : `${c.daysLeft} day${c.daysLeft === 1 ? '' : 's'} left · not paid yet`}${c.paid ? ` · ${fmt(c.paid)} paid so far` : ''}${c.minPayment ? ` · min ${fmt(c.minPayment)}` : ''}${c.predicted ? ` · estimated (statement ~${c.statementDate.slice(5)})` : ''}`,
      `<button class="secondary" data-act="payCard" data-id="${c.account.id}" data-amt="${c.remaining}" style="padding:6px 10px">Pay</button>`, c.status === 'overdue' || c.daysLeft <= rd)).join('') +
    bills.map(b => line('🔌', `${esc(b.recurring.template.note || 'Bill')} — about ${fmt(b.recurring.template.amount)}`,
      `${b.overdue ? `Usually around ${b.date.slice(5)} — not added yet` : `Due ${b.date.slice(5)} · reminder`}`,
      `<button class="secondary" data-act="addBill" data-id="${b.recurring.id}" data-date="${b.date}" style="padding:6px 10px">Add</button><button class="secondary" data-act="skipBill" data-id="${b.recurring.id}" data-date="${b.date}" style="padding:6px 8px;margin-left:4px">Skip</button>`, b.overdue)).join('') +
    lows.map(a => line('📉', `${esc(a.name)} may drop to ${fmt(a.min)}`, `around ${a.minDate.slice(5)} with scheduled payments — see forecast`, '<span class="chev">›</span>', true).replace('<div class="li">', '<div class="li" data-act="forecast">')).join('') +
    buds.map(b => line('🎯', `${esc(b.category.name)}: ${fmt(b.spent)} of ${fmt(b.budget)}`, b.status === 'over' ? `${fmt(-b.left)} over budget this month` : `${Math.round(b.pct * 100)}% used`, '<span class="chev">›</span>', b.status === 'over').replace('<div class="li">', '<div class="li" data-act="budgets">')).join('') +
    (nSug ? line('✨', `${nSug} suggestion${nSug === 1 ? '' : 's'} for your scheduled payments`, 'Duplicates to remove and regular bills to schedule', '<span class="chev">›</span>').replace('<div class="li">', '<div class="li" data-act="suggestions">') : '') +
    '</div>';
}
let lowCache = { at: 0, v: [] };
function forecastLows() {
  if (Date.now() - lowCache.at < 4000) return lowCache.v;
  lowCache = { at: Date.now(), v: X.forecast(S, today(), 30).accounts.filter(a => a.min < 0) };
  return lowCache.v;
}
let sugCache = { at: 0, n: 0 };
function suggestionCount() {
  if (Date.now() - sugCache.at < 4000) return sugCache.n;
  sugCache = { at: Date.now(), n: X.redundantSchedules(S).length + X.predictRecurring(S).length };
  return sugCache.n;
}
function suggestions() {
  const red = X.redundantSchedules(S), pred = X.predictRecurring(S);
  const kindTxt = { utility: '🔔 Reminder only — amount varies, you add it', phone: 'Auto-posts (auto-debit)', other: 'Auto-posts on the due date' };
  const body = openSheet('Smart suggestions', `
    <div class="section-title">Duplicate or outdated scheduled payments (${red.length})</div>
    <div class="list">${red.map((r, i) => `<div class="li"><div class="grow">${esc(r.drop?.template?.note || r.dropTxn?.note || '')} ${fmt(r.drop?.template?.amount ?? r.dropTxn?.amount)}<small>${esc(r.why)}</small></div><button class="secondary" data-rm="${i}" style="padding:6px 10px">Remove</button></div>`).join('') || '<div class="empty">Nothing redundant 👍</div>'}</div>
    ${red.length > 1 ? '<div class="row"><button class="secondary" id="rmAll">Remove all</button></div>' : ''}
    <div class="section-title">Regular charges not scheduled yet (${pred.length})</div>
    <div class="list">${pred.map((p, i) => `<div class="li"><div class="grow">${esc(p.note)} — ${p.variable ? 'about ' : ''}${fmt(p.amount)}<small>${M.FREQS[p.freq]} · next ~${p.nextDate} · seen ${p.count}× · ${esc(M.accName(S, p.accountId))}<br>${kindTxt[p.kind]}</small></div><button class="secondary" data-add="${i}" style="padding:6px 10px">Add</button></div>`).join('') || '<div class="empty">All regular charges are scheduled 👍</div>'}</div>
    ${pred.length > 1 ? '<div class="row"><button class="primary" id="addAll">Add all</button></div>' : ''}
    <div class="hint pad">Phone and internet are scheduled to post automatically (they're auto-debit) with no reminder. Utilities become reminders that appear under “Needs attention” until you add the actual bill.</div>`);
  const drop = r => { if (r.drop) M.remove(S, 'recurring', r.drop.id); if (r.dropTxn) M.remove(S, 'transactions', r.dropTxn.id); };
  const add = p => M.put(S, 'recurring', { id: M.uid(), freq: p.freq, interval: 1, startDate: p.nextDate, materializedThrough: today(), mode: p.kind === 'utility' ? 'remind' : 'auto', predicted: true,
    template: { type: 'expense', amount: p.amount, accountId: p.accountId, categoryId: p.categoryId, note: p.note } });
  body.querySelectorAll('[data-rm]').forEach(b => (b.onclick = () => { drop(red[+b.dataset.rm]); sugCache.at = 0; commit(); suggestions(); }));
  body.querySelectorAll('[data-add]').forEach(b => (b.onclick = () => { add(pred[+b.dataset.add]); sugCache.at = 0; commit(); suggestions(); }));
  body.querySelector('#rmAll')?.addEventListener('click', () => { red.forEach(drop); sugCache.at = 0; commit(); suggestions(); });
  body.querySelector('#addAll')?.addEventListener('click', () => { pred.forEach(add); sugCache.at = 0; commit(); suggestions(); toast(`Scheduled ${pred.length} payments`); });
}

// ---------- duplicate clean-up for existing data ----------
function dupScan() {
  const groups = I.findExistingDuplicates(S);
  const extra = groups.reduce((a, g) => a + g.length - 1, 0);
  const body = openSheet('Find duplicate entries', `
    <div class="hint">Entries with the same date, amount, account and note. The first one is kept; the copies are listed for removal. Check each — two identical purchases on the same day can be real.</div>
    ${groups.length ? `<div class="row" style="margin-top:0"><button class="danger" id="all">Remove all ${extra} cop${extra === 1 ? 'y' : 'ies'}</button></div>` : ''}
    <div class="list">${groups.map((g, i) => `<div class="li"><div class="grow">${esc(g[0].note || txLabel(g[0]))}<small>${g[0].date} · ${esc(M.accName(S, g[0].accountId))} · ${g.length}× ${fmt(g[0].amount)}</small></div><button class="secondary" data-g="${i}" style="padding:6px 10px">Remove ${g.length - 1}</button></div>`).join('') || '<div class="empty">No duplicates found 🎉</div>'}</div>`);
  const drop = g => g.slice(1).forEach(t => M.remove(S, 'transactions', t.id));
  body.querySelectorAll('[data-g]').forEach(b => (b.onclick = () => { drop(groups[+b.dataset.g]); commit(); dupScan(); }));
  body.querySelector('#all')?.addEventListener('click', () => { if (confirm(`Remove ${extra} duplicate entries?`)) { groups.forEach(drop); commit(); dupScan(); toast('Duplicates removed'); } });
}

// ---------- 60-day cash-flow forecast ----------
function sparkline(series, w = 320, h = 70) {
  const vals = series.map(p => p.bal), min = Math.min(0, ...vals), max = Math.max(...vals, 1), span = max - min || 1;
  const x = i => (i / (series.length - 1)) * w, y = v => h - 4 - ((v - min) / span) * (h - 8);
  const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p.bal).toFixed(1)}`).join(' ');
  const zero = min < 0 ? `<line x1="0" x2="${w}" y1="${y(0)}" y2="${y(0)}" stroke="var(--exp)" stroke-dasharray="4 3" stroke-width="1"/>` : '';
  return `<svg viewBox="0 0 ${w} ${h}" width="100%" height="${h}" preserveAspectRatio="none" aria-hidden="true">${zero}<polyline points="${pts}" fill="none" stroke="var(--inc)" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>`;
}
function forecastScreen() {
  const f = X.forecast(S);
  const low = f.accounts.filter(a => a.min < 0);
  const body = openSheet('Cash-flow forecast', `
    <div class="hint">Next ${f.horizon} days for your bank accounts: repeat payments, bill reminders (estimated), card statements due (paid from the account that usually pays each card) and the next predicted statements. ${low.length ? `<b class="exp">⚠️ ${low.length} account${low.length > 1 ? 's go' : ' goes'} below $0.</b>` : '✅ No account goes below $0.'}</div>
    ${f.accounts.map(a => `<div class="card" style="margin-bottom:10px">
      <small>${esc(a.name)}</small>
      <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><b>${fmt(a.start)}</b><small>in ${f.horizon} days: <b class="${a.end < 0 ? 'exp' : ''}" style="font-size:14px">${fmt(a.end)}</b></small></div>
      ${sparkline(a.series)}
      <small class="${a.min < 0 ? 'exp' : ''}">Lowest: ${fmt(a.min)} on ${a.minDate}</small>
      <details style="margin-top:6px"><summary class="sub2" style="cursor:pointer">${a.events.length} upcoming item${a.events.length === 1 ? '' : 's'}</summary>
        <table style="margin-top:6px">${a.events.map(e => `<tr><td>${e.date.slice(5)}</td><td style="text-align:left;white-space:normal">${esc(e.label)}${e.kind === 'estimate' ? ' <span class="pill">est.</span>' : e.kind === 'card' ? ' <span class="pill">card</span>' : ''}</td><td class="${e.amount < 0 ? 'exp' : 'inc'}">${fmt(e.amount)}</td></tr>`).join('')}</table></details>
    </div>`).join('') || '<div class="empty">No bank accounts with upcoming activity.</div>'}
    <div class="hint">A forecast only — it never changes your balances. Make sure each card has a payment history (or set its payer by recording one payment) so card dues land on the right account.</div>`);
}

// ---------- rental & business reports ----------
function taxReports(which = L.reportWhich || 'rental', year = L.reportYear || +today().slice(0, 4)) {
  L.reportWhich = which; L.reportYear = year; saveLocal();
  const { map } = M.mortgageSplits(S);
  const r = X.taxReport(S, year, which, map);
  const years = [0, 1, 2, 3].map(i => +today().slice(0, 4) - i);
  const table = (m, cls) => Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<tr><td>${esc(k)}</td><td class="${cls}">${fmt(v)}</td></tr>`).join('') || '<tr><td colspan="2" class="sub2">Nothing tagged yet</td></tr>';
  const body = openSheet(which === 'rental' ? 'Rental report' : 'Business report', `
    <div class="seg" id="w"><button data-w="rental" class="${which === 'rental' ? 'on' : ''}">🏘️ Rental</button><button data-w="business" class="${which === 'business' ? 'on' : ''}">💼 Business</button></div>
    <div class="two"><label>Tax year<select id="yr">${years.map(y => `<option ${y === year ? 'selected' : ''}>${y}</option>`).join('')}</select></label>
    ${which === 'rental' ? `<label>Rental share of home %<input id="share" type="number" min="0" max="100" step="0.1" value="${S.settings.rentalShare ?? ''}" placeholder="e.g. 35"></label>` : '<div></div>'}</div>
    ${which === 'rental' ? '<div class="hint" style="margin-top:-4px">Share of the house used by the basement unit (e.g. by floor area). Applied to items tagged “Shared home cost” and to mortgage interest on payments tagged that way.</div>' : ''}
    <div class="cards" style="padding:0 0 10px">
      <div class="card"><small>Income</small><b class="inc">${fmt(r.totalIncome)}</b></div>
      <div class="card"><small>Expenses</small><b class="exp">${fmt(r.totalExpenses)}</b></div>
      <div class="card wide"><small>Net ${which === 'rental' ? 'rental' : 'business'} income</small><b>${fmt(r.net)}</b></div>
      ${which === 'business' ? `<div class="card wide"><small>HST (from amounts entered on transactions)</small><b>${fmt(r.hstNet)} ${r.hstNet >= 0 ? 'owing' : 'refund'}</b><small>Collected ${fmt(r.hstCollected)} · paid (input tax credits) ${fmt(r.hstPaid)}</small></div>` : ''}
    </div>
    <div class="section-title">Income</div><div class="tablewrap"><table>${table(r.income, 'inc')}</table></div>
    <div class="section-title">Expenses</div><div class="tablewrap"><table>${table(r.expenses, 'exp')}</table></div>
    <div class="btnrow" style="padding:0"><button class="secondary" id="csv">Export CSV (${r.rows.length} items)</button><button class="secondary" id="how">How tagging works</button></div>
    <div class="hint">A summary to take to your tax return or accountant (rental: CRA form T776). It isn't tax advice — check what's deductible with your accountant.</div>`);
  body.querySelector('#w').onclick = e => { const b = e.target.closest('button'); if (b) taxReports(b.dataset.w, year); };
  body.querySelector('#yr').onchange = e => taxReports(which, +e.target.value);
  body.querySelector('#share')?.addEventListener('change', e => { S.settings = { ...S.settings, rentalShare: +e.target.value || 0, updatedAt: Date.now() }; commit(); taxReports(which, year); });
  body.querySelector('#csv').onclick = () => {
    const rows = [['Date', 'Category', 'Note', 'Account', 'Type', 'Amount', 'Share', 'Counted', 'HST']].concat(r.rows.map(x => [x.t.date, x.label, x.t.note || '', M.accName(S, x.t.accountId), x.t.type, x.t.amount, x.f, x.v, x.t.hst || '']));
    download(`moneybook-${which}-${year}.csv`, rows.map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n'), 'text/csv');
  };
  body.querySelector('#how').onclick = () => openSheet('How tagging works', `<div class="pad hint" style="font-size:14px;line-height:1.6">
    Each transaction has a <b>Purpose</b>: Personal, Rental (100%), Shared home cost (counted at your rental %), or Business.<br><br>
    Set defaults once so you rarely tag by hand:<br>• <b>Accounts</b> — e.g. your business chequing, savings and Visa → Business.<br>• <b>Categories</b> — e.g. Rental Income → Rental; Utilities, Home insurance, Property tax → Shared home cost.<br>• <b>Mortgage</b> — tag the mortgage payments' paying account or individual payments as Shared home cost; only the interest part is counted.<br><br>
    You can always override a single transaction in its editor. Add the HST amount on business sales and purchases to get an HST summary.</div>`);
}

// ---------- budgets ----------
function budgetsScreen() {
  const [from, to] = monthRange();
  const st = Object.fromEntries(X.budgetStatus(S, from, to).map(b => [b.category.id, b]));
  const { top } = M.categoryTotals(S, from, to, 'expense');
  const cats = M.live(S, 'categories').filter(c => c.type === 'expense' && !c.parentId).sort((a, b) => (top[b.id] || 0) - (top[a.id] || 0));
  const body = openSheet('Monthly budgets', `
    <div class="hint">Set a monthly limit for the categories you want to watch. Progress shows on the Stats tab, and “Needs attention” warns you at 90%. This month so far is shown for each.</div>
    <form id="f"><div class="list">${cats.map(c => `<div class="li"><div class="grow">${esc((c.emoji || '') + ' ' + c.name)}<small>${MONTHS[cursor.getMonth()]}: ${fmt(top[c.id] || 0)}${st[c.id] ? ` · ${Math.round(st[c.id].pct * 100)}%` : ''}</small></div>
      <input name="b_${c.id}" type="number" min="0" step="10" inputmode="decimal" value="${c.budget || ''}" placeholder="—" style="width:110px;margin:0"></div>`).join('')}</div>
    <div class="sticky-bar"><button class="primary" style="width:100%">Save budgets</button></div></form>`);
  body.querySelector('#f').onsubmit = e => {
    e.preventDefault();
    for (const c of cats) {
      const v = +e.target.elements['b_' + c.id].value || 0;
      if ((+c.budget || 0) !== v) { const x = { ...c, budget: v || undefined }; M.put(S, 'categories', x); }
    }
    closeSheet(); commit(); toast('Budgets saved');
  };
}
function budgetBars(from, to) {
  const bs = X.budgetStatus(S, from, to); if (!bs.length) return '<div class="btnrow" style="margin-top:12px"><button class="secondary" data-act="budgets">🎯 Set monthly budgets</button></div>';
  const col = { over: 'var(--exp)', near: 'var(--sched)', fast: 'var(--sched)', ok: 'var(--inc)' };
  return `<div class="section-title">Budgets</div><div class="list">${bs.map(b => `<div class="li" style="display:block">
    <div style="display:flex;justify-content:space-between"><span>${esc((b.category.emoji || '') + ' ' + b.category.name)}</span><span class="${b.status === 'over' ? 'exp' : ''}">${fmt(b.spent)} / ${fmt(b.budget)}</span></div>
    <div class="bar"><i style="width:${Math.min(100, b.pct * 100).toFixed(1)}%;background:${col[b.status]}"></i></div>
    <small>${b.status === 'over' ? `${fmt(-b.left)} over` : `${fmt(b.left)} left`}${b.status === 'fast' ? ' · spending faster than the month' : ''}</small></div>`).join('')}</div>
    <div class="btnrow" style="margin-top:10px"><button class="secondary" data-act="budgets">Edit budgets</button></div>`;
}

// ---------- app lock ----------
let lockedAt = 0, unlocked = !L.lock?.pinHash;
function showLock() {
  if (!L.lock?.pinHash) return;
  unlocked = false;
  const el = $('#lock'); el.classList.remove('hidden');
  const inp = el.querySelector('#pinIn'), msg = el.querySelector('#lockMsg'), bio = el.querySelector('#bioBtn');
  inp.value = ''; msg.textContent = '';
  bio.classList.toggle('hidden-f', !L.lock.credId);
  const done = () => { unlocked = true; el.classList.add('hidden'); render(); };
  const tryPin = async () => { if (await Lk.checkPin(L.lock, inp.value)) done(); else if (inp.value.length >= (L.lock.len || 4)) { msg.textContent = 'Wrong PIN'; inp.value = ''; } };
  inp.oninput = () => { if (inp.value.length >= (L.lock.len || 4)) tryPin(); };
  el.querySelector('#unlockBtn').onclick = tryPin;
  inp.onkeydown = e => { if (e.key === 'Enter') tryPin(); };
  bio.onclick = async () => { try { if (await Lk.verifyBiometric(L.lock.credId)) done(); } catch (e) { msg.textContent = 'Fingerprint not available — use your PIN'; } };
  if (L.lock.credId) setTimeout(() => bio.click(), 300); else setTimeout(() => inp.focus(), 100);
}
document.addEventListener('visibilitychange', () => {
  if (!L.lock?.pinHash) return;
  if (document.visibilityState === 'hidden') lockedAt = Date.now();
  else if (unlocked && lockedAt && Date.now() - lockedAt >= (L.lock.minutes ?? 1) * 60000) showLock();
});
function lockSettings() {
  const on = !!L.lock?.pinHash;
  const body = openSheet('App lock', `
    <div class="hint">Locks MoneyBook on this device with a PIN, and optionally your fingerprint or face. Set separately on each device. The PIN is stored only as a scrambled (hashed) code on this device.</div>
    <form id="f">
      <div class="two"><label>${on ? 'New PIN' : 'PIN'} (4–8 digits)<input name="p1" type="password" inputmode="numeric" pattern="\\d{4,8}" autocomplete="new-password"></label>
      <label>Repeat PIN<input name="p2" type="password" inputmode="numeric" autocomplete="new-password"></label></div>
      <label>Lock again after leaving the app<select name="min">${[[0, 'Immediately'], [1, 'After 1 minute'], [5, 'After 5 minutes'], [15, 'After 15 minutes']].map(([v, t]) => `<option value="${v}" ${(L.lock?.minutes ?? 1) === v ? 'selected' : ''}>${t}</option>`).join('')}</select></label>
      <div class="row"><button class="primary">${on ? 'Save' : 'Turn on lock'}</button>${on ? '<button type="button" id="off" class="danger">Turn off</button>' : ''}</div>
    </form>
    ${on ? `<div class="section-title">Fingerprint / face unlock</div><div class="pad hint" id="bioStat">${L.lock.credId ? 'On for this device.' : 'Off.'}</div>
      <div class="btnrow"><button class="secondary" id="bio">${L.lock.credId ? 'Turn off fingerprint' : 'Use fingerprint / face'}</button></div>` : ''}`);
  const f = body.querySelector('#f');
  f.onsubmit = async e => {
    e.preventDefault();
    const p1 = f.p1.value, p2 = f.p2.value, minutes = +f.min.value;
    if (!p1 && on) { L.lock.minutes = minutes; saveLocal(); return toast('Saved'); }
    if (!/^\d{4,8}$/.test(p1)) return toast('PIN must be 4–8 digits');
    if (p1 !== p2) return toast("PINs don't match");
    L.lock = { ...(L.lock || {}), ...(await Lk.makePin(p1)), len: p1.length, minutes }; saveLocal(); unlocked = true;
    toast('App lock on 🔒'); lockSettings();
  };
  body.querySelector('#off')?.addEventListener('click', () => { if (confirm('Turn off the app lock on this device?')) { delete L.lock; saveLocal(); toast('App lock off'); lockSettings(); } });
  body.querySelector('#bio')?.addEventListener('click', async () => {
    if (L.lock.credId) { delete L.lock.credId; saveLocal(); return lockSettings(); }
    if (!(await Lk.biometricSupported())) return toast('This device/browser has no fingerprint or face unlock available');
    try { L.lock.credId = await Lk.registerBiometric(); saveLocal(); toast('Fingerprint unlock on'); lockSettings(); }
    catch (err) { toast('Could not set up fingerprint: ' + err.message, 4500); }
  });
}

// ---------- Drive backups ----------
function replaceAll(data, n) {
  const now = Date.now();
  for (const c of M.COLLECTIONS) {
    S[c].forEach(r => { r.deleted = true; r.updatedAt = now; });
    (data[c] || []).forEach(r => { r.updatedAt = now + 1; });
  }
  data.settings = { ...(data.settings || S.settings), updatedAt: now + 1 };
  S = M.migrate(M.merge(S, data)); M.materialize(S); closeSheet(); commit();
  toast(`Replaced — ${n ?? M.live(data, 'transactions').length} transactions restored`);
}
async function backupsScreen() {
  const body = openSheet('Drive backups', `<div class="hint">${vault ? '🔐 New backups are end-to-end encrypted. ' : ''}A dated copy of everything is saved in your Google Drive app folder once a week when you sync (the newest 8 are kept). Restore one if something goes wrong.</div>
    <div class="list" id="bl"><div class="empty">Loading…</div></div>
    <div class="row"><button class="primary" id="now">Back up now</button></div>`);
  const load = async () => {
    try {
      const files = await Sync.listBackups(L.clientId, true);
      body.querySelector('#bl').innerHTML = files.map(f => `<div class="li"><div class="grow">${esc(f.name.replace('moneybook-backup-', '').replace('.json', ''))}<small>${new Date(f.modifiedTime).toLocaleString('en-CA')} · ${Math.round((+f.size || 0) / 1024)} KB</small></div><button class="secondary" data-id="${f.id}" style="padding:6px 10px">Restore</button></div>`).join('') || '<div class="empty">No backups yet.</div>';
      body.querySelectorAll('[data-id]').forEach(b => (b.onclick = async () => {
        if (!confirm('Replace ALL current data with this backup? Your current data is replaced on every synced device.')) return;
        try {
          let raw = await Sync.downloadBackup(b.dataset.id, L.clientId);
          if (Cx.isEncrypted(raw)) {
            if (vault && vault.salt === raw.salt) raw = await Cx.decryptJSON(raw, vault.key);
            else { const r = await askPassphrase(raw, 'This backup is encrypted (maybe with an older passphrase).'); if (!r) return; raw = r.data; }
          }
          replaceAll(M.migrate(raw));
        } catch (e) { toast(e.message, 4500); }
      }));
    } catch (e) { body.querySelector('#bl').innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
  };
  body.querySelector('#now').onclick = async () => { try { await Sync.weeklyBackup(S, L.clientId, { force: true, codec }); toast(vault ? 'Encrypted backup saved to Drive' : 'Backup saved to Drive'); load(); } catch (e) { toast(e.message, 4500); } };
  if (!L.clientId) return (body.querySelector('#bl').innerHTML = '<div class="empty">Set up Google Drive sync first.</div>');
  load();
}

// ---------- account register: Daily / Monthly / Annually ----------
// Deposit = money into the account, Withdrawal = money out. Balance = balance at the end of the period.
function accountEntries(id) {
  const a = M.get(S, 'accounts', id); const t0 = today();
  const list = M.live(S, 'transactions').filter(t => t.date <= t0 && (t.accountId === id || t.toAccountId === id))
    .sort((x, y) => x.date.localeCompare(y.date) || (x.updatedAt || 0) - (y.updatedAt || 0));
  let bal = +a?.opening || 0;
  return list.map(t => {
    const inn = (t.type === 'income' && t.accountId === id) || (t.type === 'transfer' && t.toAccountId === id);
    const v = inn ? +t.amount : -t.amount;
    bal = M.round2(bal + v);
    return { t, v, bal };
  });
}
function sumPeriod(es, from, to, openBal) {
  let dep = 0, wd = 0, end = openBal;
  for (const e of es) { if (e.t.date < from) { end = e.bal; continue; } if (e.t.date > to) break; if (e.v > 0) dep += e.v; else wd -= e.v; end = e.bal; }
  return { dep: M.round2(dep), wd: M.round2(wd), net: M.round2(dep - wd), end };
}
function accountDetail(id, view = L.accView || 'daily', anchor) {
  const a = M.get(S, 'accounts', id); if (!a) return;
  const mort = M.live(S, 'mortgages').find(m => m.accountId === id); if (mort) return mortgageDetail(mort);
  L.accView = view; saveLocal();
  const t0 = today();
  anchor = anchor || (view === 'daily' ? t0.slice(0, 7) : t0.slice(0, 4));
  const es = accountEntries(id), open = +a.opening || 0;
  const tabs = `<div class="seg" id="av">${[['daily', 'Daily'], ['monthly', 'Monthly'], ['annual', 'Annually']].map(([k, l]) => `<button data-v="${k}" class="${view === k ? 'on' : ''}">${l}</button>`).join('')}</div>`;
  const head = (label, s) => `<div class="card" style="margin-bottom:8px"><small>Statement ${label}</small>
    <div class="summary" style="grid-template-columns:repeat(4,1fr);padding:6px 0 0;border:0;background:none">
      <div><small>Deposit</small><b class="inc">${fmt(s.dep)}</b></div><div><small>Withdrawal</small><b class="exp">${fmt(s.wd)}</b></div>
      <div><small>Total</small><b>${fmt(s.net)}</b></div><div><small>Balance</small><b class="${s.end < 0 ? 'exp' : 'inc'}">${fmt(s.end)}</b></div></div></div>`;
  const nav = txt => `<div class="monthnav" style="background:none;padding:4px 0 8px"><button data-nav="-1" aria-label="Previous">‹</button><b>${txt}</b><button data-nav="1" aria-label="Next">›</button></div>`;
  let html = '';
  if (view === 'daily') {
    const [y, mo] = anchor.split('-').map(Number);
    const from = `${anchor}-01`, to = M.ymd(new Date(y, mo, 0));
    const s = sumPeriod(es, from, to, open);
    const inMonth = es.filter(e => e.t.date >= from && e.t.date <= to);
    const byDay = {}; inMonth.forEach(e => (byDay[e.t.date] = byDay[e.t.date] || []).push(e));
    html = nav(`${y} ${MONTHS[mo - 1]}`) + head(`${from.replace(/-/g, '.')} ~ ${to.slice(5).replace('-', '.')}`, s) +
      (Object.keys(byDay).sort().reverse().map(d => {
        const list = byDay[d], dt = M.parseYmd(d);
        const dep = list.filter(e => e.v > 0).reduce((x, e) => x + e.v, 0), wd = -list.filter(e => e.v < 0).reduce((x, e) => x + e.v, 0);
        return `<div class="day" style="margin-top:8px"><div class="dayhead"><span class="d">${dt.getDate()}</span><span class="wd">${WD[dt.getDay()]}</span><small class="sub2">${d.slice(0, 7)}</small><span class="sp"></span>
          <span class="amt inc">${dep ? fmt(dep) : ''}</span><span class="amt exp">${wd ? fmt(wd) : ''}</span></div>
          ${[...list].reverse().map(e => `<div class="tx" data-tx="${e.t.id}"><div class="tx-cat">${esc(txLabel(e.t))}</div>
            <div class="tx-main"><div>${esc(e.t.note || '')}</div><small>${esc(e.t.type === 'transfer' ? (e.v > 0 ? 'From ' + M.accName(S, e.t.accountId) : 'To ' + M.accName(S, e.t.toAccountId)) : a.name)}</small></div>
            <div style="text-align:right"><div class="amt ${e.v > 0 ? 'inc' : 'exp'}">${fmt(Math.abs(e.v))}</div><small class="sub2">(Balance ${fmt(e.bal)})</small></div></div>`).join('')}</div>`;
      }).join('') || '<div class="empty">No transactions this month.</div>');
  } else if (view === 'monthly') {
    const y = +anchor;
    const s = sumPeriod(es, `${y}-01-01`, `${y}-12-31`, open);
    const rows = [];
    for (let mo = 12; mo >= 1; mo--) {
      const from = `${y}-${String(mo).padStart(2, '0')}-01`, to = M.ymd(new Date(y, mo, 0));
      if (from > t0) continue;
      rows.push([mo, from, to, sumPeriod(es, from, to, open)]);
    }
    html = nav(String(y)) + head(`${y}.01.01 ~ 12.31`, s) + `<div class="list">${rows.map(([mo, from, to, r]) => `<div class="li" data-month="${from.slice(0, 7)}">
      <div class="grow"><b>${MONTHS[mo - 1]}</b><small>${from.slice(5).replace('-', '.')} ~ ${to.slice(5).replace('-', '.')}</small></div>
      <div style="text-align:right"><span class="inc">${fmt(r.dep)}</span><small>${fmt(r.net)}</small></div>
      <div style="text-align:right;min-width:92px"><span class="exp">${fmt(r.wd)}</span><small>(${fmt(r.end)})</small></div></div>`).join('')}</div>`;
  } else {
    const first = es.length ? +es[0].t.date.slice(0, 4) : +t0.slice(0, 4), last = +t0.slice(0, 4);
    const all = sumPeriod(es, `${first}-01-01`, `${last}-12-31`, open);
    const rows = []; for (let y = last; y >= first; y--) rows.push([y, sumPeriod(es, `${y}-01-01`, `${y}-12-31`, open)]);
    html = `<div style="text-align:center;padding:4px 0 8px"><b>${first} ~ ${last}</b></div>` + head(`${first}.01.01 ~ ${last}.12.31`, all) +
      `<div class="list">${rows.map(([y, r]) => `<div class="li" data-year="${y}"><div class="grow"><b>${y}</b><small>${y}.01.01 ~ 12.31</small></div>
        <div style="text-align:right"><span class="inc">${fmt(r.dep)}</span><small>${fmt(r.net)}</small></div>
        <div style="text-align:right;min-width:92px"><span class="exp">${fmt(r.wd)}</span><small>(${fmt(r.end)})</small></div></div>`).join('')}</div>`;
  }
  const body = openSheet(a.name, tabs + html + `<div class="btnrow" style="padding:12px 0 0"><button class="secondary" id="addHere">+ Add transaction</button><button class="secondary" id="editAcc">✏️ Edit account</button></div>`);
  body.querySelector('#av').onclick = e => { const b = e.target.closest('button'); if (b) accountDetail(id, b.dataset.v); };
  body.querySelectorAll('[data-nav]').forEach(b => (b.onclick = () => {
    const d = +b.dataset.nav;
    if (view === 'daily') { const [y, mo] = anchor.split('-').map(Number); const n = new Date(y, mo - 1 + d, 1); accountDetail(id, view, `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`); }
    else accountDetail(id, view, String(+anchor + d));
  }));
  body.querySelectorAll('[data-month]').forEach(el => (el.onclick = () => accountDetail(id, 'daily', el.dataset.month)));
  body.querySelectorAll('[data-year]').forEach(el => (el.onclick = () => accountDetail(id, 'monthly', el.dataset.year)));
  body.querySelectorAll('[data-tx]').forEach(el => (el.onclick = () => editTxn(M.get(S, 'transactions', el.dataset.tx))));
  body.querySelector('#addHere').onclick = () => editTxn(null, { accountId: id });
  body.querySelector('#editAcc').onclick = () => editAccount(a);
}

// ---------- suggested categories (adds only what you don't already have) ----------
const CATEGORY_PACK = {
  expense: [
    ['🛒', 'Groceries', ['Produce', 'Meat & fish', 'Dairy & eggs', 'Bakery', 'Snacks & drinks', 'Indian groceries']],
    ['🍽️', 'Dining out', ['Restaurants', 'Coffee & tea', 'Fast food', 'Food delivery']],
    ['🏠', 'Home', ['Property tax', 'Home insurance', 'Maintenance & repairs', 'Furniture & décor', 'Appliances', 'Garden']],
    ['🔌', 'Utilities', ['Hydro', 'Water & gas', 'Internet', 'Mobile phone']],
    ['🧴', 'Household supplies', ['Cleaning', 'Paper & kitchen', 'Laundry', 'Dollar store']],
    ['👕', 'Clothing', ['Adults', 'Kids', 'Shoes']],
    ['💊', 'Health', ['Pharmacy', 'Dental', 'Vision', 'Fitness']],
    ['💅', 'Personal care', ['Haircut & salon', 'Toiletries']],
    ['🚗', 'Car', ['EV charging', 'Car insurance', 'Maintenance & tires', 'Parking & tolls', 'Licence & registration']],
    ['🚕', 'Rides & transit', ['Uber & taxi', 'Transit']],
    ['👶', 'Kids', ['Childcare', 'Activities & classes', 'School supplies', 'Toys']],
    ['📚', 'Education', ['Tuition', 'Books & supplies', 'Courses & certifications']],
    ['💻', 'Tech & subscriptions', ['Software & apps', 'Streaming', 'Cloud storage', 'Electronics']],
    ['🎁', 'Gifts & donations', ['Gifts', 'Donations']],
    ['✈️', 'Travel', ['Flights', 'Hotels', 'Travel spending']],
    ['🎉', 'Entertainment', ['Events & outings', 'Hobbies', 'Games']],
    ['🐾', 'Pets', []],
    ['🏘️', 'Rental unit', ['Repairs & maintenance', 'Supplies', 'Advertising', 'Legal & fees'], 'rental'],
    ['💼', 'Business expenses', ['Office supplies', 'Software', 'Professional fees', 'Bank fees'], 'business'],
    ['🧾', 'Fees & interest', ['Bank fees', 'Card interest', 'Government fees', 'Income tax']],
  ],
  income: [
    ['💰', 'Salary', []], ['🏘️', 'Rental income', [], 'rental'], ['💼', 'Business income', [], 'business'], ['👶', 'Canada Child Benefit', []],
    ['📈', 'Interest & dividends', []], ['💸', 'Cashback & rewards', []], ['🎁', 'Gifts received', []], ['↩️', 'Refunds', []], ['➕', 'Other income', []],
  ],
};
// Names you may already use for the same thing — subcategories go under yours instead of a near-duplicate.
const CATEGORY_SYNONYMS = { 'dining out': ['food', 'restaurants', 'eating out'], 'household supplies': ['household'], clothing: ['apparel', 'clothes'], car: ['transport', 'transportation', 'vehicle', 'auto'],
  entertainment: ['culture', 'fun'], 'fees & interest': ['fees & taxes', 'fees', 'bank charges'], 'gifts & donations': ['gifts'], 'canada child benefit': ['child care benefit', 'ccb', 'child benefit'],
  'interest & dividends': ['interest earned', 'interest'], 'other income': ['other'], health: ['medical'], 'tech & subscriptions': ['subscriptions'], 'rental unit': ['rental expenses'] };
const nn = x => String(x || '').toLowerCase().replace(/[^a-z0-9&]+/g, ' ').trim();
function suggestedCategories(type = 'expense') {
  const mine = M.live(S, 'categories').filter(c => c.type === type);
  const findTop = name => mine.find(c => !c.parentId && (nn(c.name) === nn(name) || (CATEGORY_SYNONYMS[nn(name)] || []).includes(nn(c.name))));
  const plan = [];
  for (const [emoji, name, subs, tag] of CATEGORY_PACK[type]) {
    const top = findTop(name);
    const missingSubs = subs.filter(sb => !mine.some(c => c.parentId === top?.id && nn(c.name) === nn(sb)) && !(top && mine.some(c => nn(c.name) === nn(sb))));
    if (!top || missingSubs.length) plan.push({ emoji, name, top, subs: missingSubs, tag });
  }
  const body = openSheet('Suggested categories', `
    <div class="hint">Only categories you don't have yet. Where you already have a matching one (e.g. your “Apparel” for Clothing), the new subcategories go under it.</div>
    <div class="list">${plan.map((p, i) => `<label class="li check" style="display:flex;align-items:flex-start;gap:10px;margin:0"><input type="checkbox" data-i="${i}" checked style="margin-top:3px">
      <div class="grow">${p.top ? `${esc((p.top.emoji || '') + ' ' + p.top.name)} <span class="pill">yours</span>` : `${p.emoji} ${esc(p.name)}`}${p.tag && !p.top ? ` <span class="pill">${p.tag}</span>` : ''}
      <small>${p.subs.length ? '+ ' + p.subs.map(esc).join(', ') : 'new category'}</small></div></label>`).join('') || '<div class="empty">You already have all of them 👍</div>'}</div>
    ${plan.length ? '<div class="sticky-bar"><button class="primary" id="go" style="width:100%">Add selected</button></div>' : ''}`);
  body.querySelector('#go')?.addEventListener('click', () => {
    let n = 0;
    body.querySelectorAll('input[data-i]:checked').forEach(cb => {
      const p = plan[+cb.dataset.i];
      const top = p.top || M.put(S, 'categories', { id: M.uid(), type, name: p.name, emoji: p.emoji, parentId: null, order: S.categories.length, defaultTag: p.tag });
      if (!p.top) n++;
      p.subs.forEach(sb => { M.put(S, 'categories', { id: M.uid(), type, name: sb, emoji: '', parentId: top.id, order: S.categories.length }); n++; });
    });
    commit(); toast(`Added ${n} categor${n === 1 ? 'y' : 'ies'}`); listCategories(type);
  });
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
  openAccount: el => accountDetail(el.dataset.id),
  editGroup: () => editGroup(),
  openMortgage: el => mortgageDetail(M.get(S, 'mortgages', el.dataset.id)),
  mortgages: listMortgages, recurring: listRecurring, categories: () => listCategories(), manageAccounts,
  receiptRules, syncScreen, settings, importStatement, dupScan, suggestions, forecast: forecastScreen, budgets: budgetsScreen, taxReports: () => taxReports(), lockSettings, backupsScreen,
  payCard: el => { const id = el.dataset.id; editTxn(null, { type: 'transfer', amount: +el.dataset.amt || '', accountId: I.usualPayer(S, id) || defaultAccount(), toAccountId: id, note: 'Card payment' }); },
  addBill: el => { const r = M.get(S, 'recurring', el.dataset.id); if (r) editTxn(null, { ...r.template, date: el.dataset.date <= today() ? el.dataset.date : today() }); },
  skipBill: el => { const r = M.get(S, 'recurring', el.dataset.id); if (r) { r.dismissed = [...(r.dismissed || []), el.dataset.date].slice(-12); M.put(S, 'recurring', r); commit(); toast('Skipped this time'); } },
  closeSheet,
  sync: () => (L.clientId ? doSync(true).catch(() => {}) : syncScreen())
};
document.addEventListener('click', e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const fn = actions[el.dataset.act]; if (fn) { e.preventDefault(); fn(el); }
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeSheet(); });

init().catch(e => { document.body.insertAdjacentHTML('beforeend', `<div class="banner">Startup error: ${esc(e.message)}</div>`); console.error(e); });
