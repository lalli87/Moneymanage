// MoneyBook data model: pure functions, no DOM.
// Rule of the app: balances only include transactions dated <= today.
// Anything dated in the future (one-off or recurring) is "scheduled" and only shown.

export const COLLECTIONS = ['groups', 'accounts', 'categories', 'transactions', 'recurring', 'mortgages', 'rules'];

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const z = n => String(n).padStart(2, '0');
export const ymd = d => `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
export const parseYmd = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const todayStr = () => ymd(new Date());
export const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
export const daysInMonth = (y, m) => new Date(y, m + 1, 0).getDate();
export const round2 = n => Math.round((n + Number.EPSILON) * 100) / 100;
export function addMonths(s, n, anchorDay) {
  const d = parseYmd(s);
  const day = anchorDay ?? d.getDate();
  const t = new Date(d.getFullYear(), d.getMonth() + n, 1);
  t.setDate(Math.min(day, daysInMonth(t.getFullYear(), t.getMonth())));
  return ymd(t);
}
const endOfMonth = s => { const d = parseYmd(s); return ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0)); };

// ---------- state ----------
export function emptyState() {
  const now = Date.now();
  const s = { schema: 1, settings: { currency: 'CAD', remindDays: 3, updatedAt: now } };
  COLLECTIONS.forEach(c => (s[c] = []));
  // Fixed ids for starter records: every device creates the same ones, so syncing never duplicates them.
  const slug = x => x.toLowerCase().replace(/[^a-z0-9]+/g, '_');
  const g = (name, kind) => { const r = { id: 'def_g_' + slug(name), name, kind, order: s.groups.length, updatedAt: 1 }; s.groups.push(r); return r; };
  const cash = g('Cash', 'asset'); g('Accounts', 'asset'); g('Card', 'card'); g('Loan', 'liability'); g('Investments', 'asset');
  s.accounts.push({ id: 'def_a_cash', groupId: cash.id, name: 'Cash', opening: 0, includeInTotals: true, updatedAt: 1 });
  const cat = (type, name, emoji = '', parentId = null) => {
    const r = { id: `def_c_${type}_${parentId ? parentId.replace(/^def_c_\w+?_/, '') + '_' : ''}${slug(name)}`, type, name, emoji, parentId, order: s.categories.length, updatedAt: 1 };
    s.categories.push(r); return r;
  };
  ['🛒 Groceries', '🍜 Food', '🪑 Household', '🚗 Transport', '🔌 Utilities', '🛡️ Insurance', '📙 Education',
   '🧥 Apparel', '💊 Health', '🖼️ Culture', '🧾 Fees & Taxes', '🎁 Gifts'].forEach(x => {
    const [e, ...n] = x.split(' '); cat('expense', n.join(' '), e);
  });
  const mort = cat('expense', 'Home Mortgage', '🏡');
  cat('expense', 'Interest', '', mort.id); cat('expense', 'Principal', '', mort.id);
  ['💰 Salary', '🏅 Bonus', '🏘️ Rental Income', '👶 Child care benefit', '📈 Interest earned', '➕ Other'].forEach(x => {
    const [e, ...n] = x.split(' '); cat('income', n.join(' '), e);
  });
  return s;
}
export function migrate(s) {
  COLLECTIONS.forEach(c => { if (!Array.isArray(s[c])) s[c] = []; });
  s.settings = s.settings || { currency: 'CAD', remindDays: 3, updatedAt: 0 };
  return s;
}

export const live = (s, c) => s[c].filter(r => !r.deleted);
export const get = (s, c, id) => (id ? s[c].find(r => r.id === id && !r.deleted) : undefined);
export function put(s, c, rec) {
  rec.updatedAt = Date.now();
  const i = s[c].findIndex(r => r.id === rec.id);
  if (i >= 0) s[c][i] = rec; else s[c].push(rec);
  return rec;
}
export function remove(s, c, id) {
  const r = s[c].find(r => r.id === id);
  if (r) { r.deleted = true; r.updatedAt = Date.now(); }
}

// ---------- categories / accounts ----------
export const topCatId = (s, id) => { const c = get(s, 'categories', id); return c ? (c.parentId || c.id) : null; };
export function catLabel(s, id) {
  const c = get(s, 'categories', id); if (!c) return 'Uncategorized';
  const p = c.parentId && get(s, 'categories', c.parentId);
  return p ? `${p.emoji || ''} ${p.name} › ${c.name}`.trim() : `${c.emoji || ''} ${c.name}`.trim();
}
export const accName = (s, id) => get(s, 'accounts', id)?.name || '—';

// ---------- recurrence ----------
export const FREQS = {
  monthly: 'Every month', biweekly: 'Every 2 weeks', weekly: 'Every week',
  monthEnd: 'End of every month', yearly: 'Every year', daily: 'Every day'
};
const firstOcc = r => (r.freq === 'monthEnd' ? endOfMonth(r.startDate) : r.startDate);
export function stepDate(r, d) {
  const n = r.interval || 1;
  switch (r.freq) {
    case 'daily': return addDays(d, n);
    case 'weekly': return addDays(d, 7 * n);
    case 'biweekly': return addDays(d, 14 * n);
    case 'monthly': return addMonths(d, n, parseYmd(r.startDate).getDate());
    case 'monthEnd': { const x = parseYmd(d); return ymd(new Date(x.getFullYear(), x.getMonth() + n + 1, 0)); }
    case 'yearly': return addMonths(d, 12 * n, parseYmd(r.startDate).getDate());
    default: return null;
  }
}
export function occurrences(r, from, to) {
  const out = []; let d = firstOcc(r); let guard = 0;
  while (d && d <= to && guard++ < 6000) {
    if (r.endDate && d > r.endDate) break;
    if (d >= from) out.push(d);
    d = stepDate(r, d);
  }
  return out;
}
export const occId = (r, d) => `${r.id}_${d}`; // deterministic → no duplicates across devices

// Turn recurring occurrences that are due (<= today) into real transactions.
export function materialize(s, today = todayStr()) {
  let n = 0;
  const ids = new Set(s.transactions.map(t => t.id));
  for (const r of live(s, 'recurring')) {
    if (r.paused || r.mode === 'remind') continue;   // reminder-only items are added by you, not automatically
    const from = r.materializedThrough ? addDays(r.materializedThrough, 1) : r.startDate;
    if (from > today) continue;
    for (const d of occurrences(r, from, today)) {
      const id = occId(r, d);
      if (ids.has(id)) continue;
      s.transactions.push({ ...r.template, id, date: d, recurringId: r.id, updatedAt: Date.now() });
      ids.add(id); n++;
    }
    r.materializedThrough = today; // intentionally no updatedAt bump (avoids sync churn)
  }
  return n;
}

// Scheduled (future) items in a date range — never counted in balances.
export function projected(s, from, to, today = todayStr()) {
  const start = from > today ? from : addDays(today, 1);
  if (start > to) return [];
  const ids = new Set(s.transactions.map(t => t.id));
  const out = [];
  for (const r of live(s, 'recurring')) {
    if (r.paused) continue;
    for (const d of occurrences(r, start, to)) {
      const id = occId(r, d);
      if (!ids.has(id)) out.push({ ...r.template, id, date: d, recurringId: r.id, projected: true, remind: r.mode === 'remind' });
    }
  }
  for (const t of live(s, 'transactions')) if (t.date >= start && t.date <= to) out.push({ ...t, projected: true });
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
export const nextDue = (r, today = todayStr(), count = 3) =>
  occurrences(r, addDays(today, 1), addDays(today, 800)).slice(0, count);

// ---------- mortgage (Canadian rules) ----------
export const PPY = { monthly: 12, semimonthly: 24, biweekly: 26, accelBiweekly: 26, weekly: 52 };
export const MORT_FREQ = {
  monthly: 'Monthly', semimonthly: 'Semi-monthly', biweekly: 'Bi-weekly',
  accelBiweekly: 'Accelerated bi-weekly', weekly: 'Weekly'
};
// Fixed-rate Canadian mortgages compound semi-annually by law; variable usually monthly.
export function periodicRate(pct, compounding, n) {
  const k = compounding === 'monthly' ? 12 : 2;
  return Math.pow(1 + pct / 100 / k, k / n) - 1;
}
// Terms in effect on a date. rateChanges entries can change rate and/or payment frequency (e.g. monthly → bi-weekly).
export function termsOn(m, date) {
  let rate = +m.rate, frequency = m.frequency;
  [...(m.rateChanges || [])].sort((a, b) => a.date.localeCompare(b.date)).forEach(c => {
    if (c.date <= date) { if (c.rate != null && c.rate !== '') rate = +c.rate; if (c.frequency) frequency = c.frequency; }
  });
  return { rate, frequency };
}
export const rateOn = (m, date) => termsOn(m, date).rate;
export function paymentFor(balance, pct, compounding, freq, years) {
  if (freq === 'accelBiweekly') return round2(paymentFor(balance, pct, compounding, 'monthly', years) / 2);
  const n = PPY[freq]; const i = periodicRate(pct, compounding, n); const N = years * n;
  if (i === 0) return round2(balance / N);
  return round2(balance * i / (1 - Math.pow(1 + i, -N)));
}
// Walk actual recorded payments and split each into interest + principal.
// Checkpoints are balances from lender statements (annual statements, balance letters). The ledger is
// reset to them on their date, so small differences in how the lender counts interest never pile up.
export function mortgageLedger(s, m, asOf = todayStr()) {
  let bal = +m.principal, ti = 0, tp = 0; const rows = [];
  const pays = live(s, 'transactions')
    .filter(t => t.type === 'mortgage' && t.mortgageId === m.id && t.date > m.startDate && t.date <= asOf)
    .map(t => ({ kind: 'pay', date: t.date, t }));
  const cps = (m.checkpoints || []).filter(c => c.date > m.startDate && c.date <= asOf).map(c => ({ kind: 'cp', date: c.date, c }));
  const ev = [...pays, ...cps].sort((a, b) => a.date.localeCompare(b.date) || (a.kind === 'cp') - (b.kind === 'cp') || (a.t?.prepayment ? 1 : 0) - (b.t?.prepayment ? 1 : 0));
  for (const e of ev) {
    if (e.kind === 'cp') {
      const adj = round2(+e.c.balance - bal);
      rows.push({ checkpoint: true, date: e.date, payment: 0, interest: 0, principal: 0, adjust: adj, balance: +e.c.balance, note: e.c.note || 'Lender statement' });
      bal = +e.c.balance; continue;
    }
    const p = e.t, { rate, frequency } = termsOn(m, p.date), amt = +p.amount;
    let interest = 0, principal;
    if (p.prepayment) principal = round2(Math.min(amt, bal));
    else {
      interest = round2(bal * periodicRate(rate, m.compounding, PPY[frequency] || 12));
      principal = round2(Math.min(amt - interest, bal));
    }
    bal = round2(bal - principal); ti += interest; tp += principal;
    rows.push({ txnId: p.id, date: p.date, payment: amt, interest, principal, balance: bal, rate, prepayment: !!p.prepayment });
  }
  return { balance: bal, rows, interestPaid: round2(ti), principalPaid: round2(tp) };
}
// Lender's schedule row for a payment date (±3 days), if the amortization schedule was imported.
export function scheduleRow(m, date) {
  const t = parseYmd(date).getTime();
  return (m.schedule || []).find(r => r.date && Math.abs(parseYmd(r.date).getTime() - t) <= 3 * 86400000) || null;
}
// "🏡 Principal $x · Interest $y · Balance $z" for each recorded payment (kept in the description).
export function mortgageNotes(s) {
  const out = {};
  const f = n => '$' + (+n).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  for (const m of live(s, 'mortgages')) for (const r of mortgageLedger(s, m).rows) {
    if (r.checkpoint) continue;
    out[r.txnId] = r.prepayment ? `🏡 Prepayment · Principal ${f(r.principal)} · Balance ${f(r.balance)}`
      : `🏡 Principal ${f(r.principal)} · Interest ${f(r.interest)} · Balance ${f(r.balance)}`;
  }
  return out;
}
export function refreshMortgageNotes(s) {
  const notes = mortgageNotes(s); let n = 0;
  for (const t of s.transactions) {
    const want = notes[t.id]; if (!want || t.deleted) continue;
    if ((!t.desc || t.desc.startsWith('🏡 ')) && t.desc !== want) { t.desc = want; t.updatedAt = Date.now(); n++; }
  }
  return n;
}
export function stepByFreq(d, freq) {
  if (freq === 'weekly') return addDays(d, 7);
  if (freq === 'biweekly' || freq === 'accelBiweekly') return addDays(d, 14);
  if (freq === 'semimonthly') {
    const x = parseYmd(d);
    return x.getDate() < 15 ? ymd(new Date(x.getFullYear(), x.getMonth(), 15)) : ymd(new Date(x.getFullYear(), x.getMonth() + 1, 1));
  }
  return addMonths(d, 1);
}
// Future amortization from a balance; extra = additional amount per payment.
// firstDate: date of the next payment if known (otherwise one period after fromDate).
// With an imported lender schedule and no extra payment, the lender's own rows are used first.
export function project(m, balance, fromDate, extra = 0, today = todayStr(), firstDate = null) {
  const { rate, frequency } = termsOn(m, today);
  const i = periodicRate(rate, m.compounding, PPY[frequency] || 12);
  const pay = +m.payment + +extra;
  let bal = balance, d = fromDate, ti = 0, n = 0; const rows = [];
  if (bal <= 0) return { payoffDate: fromDate, periods: 0, totalInterest: 0, rows };
  if (pay <= round2(bal * i)) return { never: true, periods: Infinity, totalInterest: Infinity, rows };
  const sched = !extra ? (m.schedule || []).filter(r => r.date > fromDate && r.date) : [];
  if (sched.length && Math.abs(sched[0].balance + sched[0].principal - bal) < Math.max(50, bal * 0.002)) {
    for (const r of sched) { rows.push({ date: r.date, payment: round2(r.interest + r.principal), interest: r.interest, principal: r.principal, balance: r.balance, lender: true }); ti += r.interest; n++; }
    bal = sched[sched.length - 1].balance; d = sched[sched.length - 1].date;
  } else if (firstDate) { d = null; }
  while (bal > 0.004 && n < 3000) {
    d = d === null ? firstDate : stepByFreq(d, frequency);
    const int = round2(bal * i);
    const pr = round2(Math.min(pay - int, bal));
    bal = round2(bal - pr); ti += int; n++;
    rows.push({ date: d, payment: round2(int + pr), interest: int, principal: pr, balance: bal });
  }
  return { payoffDate: d, periods: n, totalInterest: round2(ti), rows };
}
export function mortgageSplits(s, asOf = todayStr()) {
  const map = {}, bal = {};
  for (const m of live(s, 'mortgages')) {
    const L = mortgageLedger(s, m, asOf); bal[m.id] = L.balance;
    L.rows.forEach(r => (map[r.txnId] = r));
  }
  return { map, bal };
}

// ---------- balances ----------
export function balances(s, asOf = todayStr()) {
  const b = {};
  for (const a of live(s, 'accounts')) b[a.id] = +a.opening || 0;
  const add = (id, v) => { if (id in b) b[id] += v; };
  for (const t of live(s, 'transactions')) {
    if (t.date > asOf) continue; // scheduled: not yet real
    const a = +t.amount || 0;
    if (t.type === 'income') add(t.accountId, a);
    else if (t.type === 'expense' || t.type === 'mortgage') add(t.accountId, -a);
    else if (t.type === 'transfer') { add(t.accountId, -a); add(t.toAccountId, a); }
  }
  const { bal } = mortgageSplits(s, asOf);
  for (const m of live(s, 'mortgages')) if (m.accountId in b) b[m.accountId] = -bal[m.id];
  Object.keys(b).forEach(k => (b[k] = round2(b[k])));
  return b;
}
export function totals(s, b) {
  let assets = 0, liab = 0;
  for (const a of live(s, 'accounts')) {
    if (a.includeInTotals === false) continue;
    const v = b[a.id] || 0; if (v >= 0) assets += v; else liab += -v;
  }
  return { assets: round2(assets), liabilities: round2(liab), net: round2(assets - liab) };
}
export function lastStatementDate(day, today = todayStr()) {
  const t = parseYmd(today);
  let d = new Date(t.getFullYear(), t.getMonth(), Math.min(day, daysInMonth(t.getFullYear(), t.getMonth())));
  if (ymd(d) > today) { const p = new Date(t.getFullYear(), t.getMonth() - 1, 1); d = new Date(p.getFullYear(), p.getMonth(), Math.min(day, daysInMonth(p.getFullYear(), p.getMonth()))); }
  return ymd(d);
}

// ---------- reporting ----------
export function sumIE(txns) {
  let inc = 0, exp = 0;
  for (const t of txns) {
    if (t.type === 'income') inc += +t.amount;
    else if (t.type === 'expense' || t.type === 'mortgage') exp += +t.amount;
  }
  return { inc: round2(inc), exp: round2(exp) };
}
export function categoryTotals(s, from, to, type, today = todayStr()) {
  const end = to < today ? to : today;
  const { map } = mortgageSplits(s, today);
  const leaf = {}; const add = (id, a) => { const k = id || 'none'; leaf[k] = round2((leaf[k] || 0) + a); };
  for (const t of live(s, 'transactions')) {
    if (t.date < from || t.date > end) continue;
    if (t.type === type && t.splits?.length) t.splits.forEach(x => add(x.categoryId, +x.amount));   // one bill, several categories
    else if (t.type === type) add(t.categoryId, +t.amount);
    else if (type === 'expense' && t.type === 'mortgage') {
      const m = get(s, 'mortgages', t.mortgageId); const sp = map[t.id];
      if (m && sp) { add(m.interestCategoryId || m.categoryId, sp.interest); add(m.principalCategoryId || m.categoryId, sp.principal); }
      else add(m?.categoryId, +t.amount);
    }
  }
  const top = {};
  for (const id in leaf) { const tid = topCatId(s, id) || id; top[tid] = round2((top[tid] || 0) + leaf[id]); }
  return { leaf, top };
}

// ---------- duplicate clean-up ----------
// Merges categories with the same name/type/parent, groups with the same name/kind, and drops unused copies of
// accounts with the same name in the same group. Everything pointing at a removed copy is moved to the kept one.
const normName = n => String(n || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
function editDist(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 9;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
export function dedupe(s) {
  const now = Date.now(), changed = new Set(), out = { categories: 0, groups: 0, accounts: 0 };
  const touch = (c, r) => { r.updatedAt = now; changed.add(c); };
  const used = {};
  for (const t of live(s, 'transactions')) {
    [t.categoryId, ...(t.splits || []).map(x => x.categoryId)].forEach(id => id && (used[id] = (used[id] || 0) + 1));
    [t.accountId, t.toAccountId].forEach(id => id && (used[id] = (used[id] || 0) + 1));
  }
  live(s, 'recurring').forEach(r => [r.template?.categoryId, r.template?.accountId, r.template?.toAccountId].forEach(id => id && (used[id] = (used[id] || 0) + 1)));
  const pick = list => [...list].sort((a, b) => (used[b.id] || 0) - (used[a.id] || 0) || (a.id.startsWith('def_') ? 1 : 0) - (b.id.startsWith('def_') ? 1 : 0) || (a.updatedAt || 0) - (b.updatedAt || 0))[0];
  const remap = {};
  // groups
  const gByKey = new Map();
  live(s, 'groups').forEach(g => { const k = g.kind + '|' + normName(g.name); (gByKey.get(k) || gByKey.set(k, []).get(k)).push(g); });
  for (const list of gByKey.values()) if (list.length > 1) {
    const keep = pick(list);
    for (const g of list) if (g !== keep) { remap[g.id] = keep.id; g.deleted = true; touch('groups', g); out.groups++; }
  }
  live(s, 'accounts').forEach(a => { if (remap[a.groupId]) { a.groupId = remap[a.groupId]; touch('accounts', a); } });
  // accounts: only remove copies nothing uses
  const aByKey = new Map();
  live(s, 'accounts').forEach(a => { const k = a.groupId + '|' + normName(a.name); (aByKey.get(k) || aByKey.set(k, []).get(k)).push(a); });
  for (const list of aByKey.values()) if (list.length > 1) {
    const keep = pick(list);
    for (const a of list) if (a !== keep && !used[a.id] && !(+a.opening) && !live(s, 'mortgages').some(m => m.accountId === a.id)) { a.deleted = true; touch('accounts', a); out.accounts++; }
  }
  // categories: top level first, then subcategories under their (kept) parent
  for (const level of ['top', 'sub']) {
    const cByKey = new Map();
    live(s, 'categories').filter(c => (level === 'top') === !c.parentId).forEach(c => {
      const parent = c.parentId ? (remap[c.parentId] || c.parentId) : '';
      const k = c.type + '|' + parent + '|' + normName(c.name); (cByKey.get(k) || cByKey.set(k, []).get(k)).push(c);
    });
    for (const list of cByKey.values()) if (list.length > 1) {
      const keep = pick(list);
      for (const c of list) if (c !== keep) {
        remap[c.id] = keep.id;
        ['emoji', 'budget', 'defaultTag'].forEach(f => { if (!keep[f] && c[f]) { keep[f] = c[f]; touch('categories', keep); } });
        c.deleted = true; touch('categories', c); out.categories++;
      }
    }
    live(s, 'categories').forEach(c => { if (c.parentId && remap[c.parentId]) { c.parentId = remap[c.parentId]; touch('categories', c); } });
    // Near-duplicates ("Child care benefit" vs "Child care benifit"): only an UNUSED copy is folded into the used one.
    const lvl = live(s, 'categories').filter(c => (level === 'top') === !c.parentId);
    for (const c of lvl) {
      if (c.deleted || used[c.id] || live(s, 'categories').some(x => x.parentId === c.id && used[x.id])) continue;
      const a = normName(c.name); if (a.length < 5) continue;
      const twin = lvl.find(x => x !== c && !x.deleted && x.type === c.type && (x.parentId || '') === (c.parentId || '') && used[x.id] && editDist(a, normName(x.name)) <= 2);
      if (twin) { remap[c.id] = twin.id; c.deleted = true; touch('categories', c); out.categories++; }
    }
    live(s, 'categories').forEach(c => { if (c.parentId && remap[c.parentId]) { c.parentId = remap[c.parentId]; touch('categories', c); } });
  }
  if (!Object.keys(remap).length && !out.accounts) return out;
  const fix = id => remap[id] || id;
  for (const t of live(s, 'transactions')) {
    let ch = false;
    if (t.categoryId && remap[t.categoryId]) { t.categoryId = fix(t.categoryId); ch = true; }
    (t.splits || []).forEach(x => { if (remap[x.categoryId]) { x.categoryId = fix(x.categoryId); ch = true; } });
    if (ch) touch('transactions', t);
  }
  live(s, 'recurring').forEach(r => { if (r.template?.categoryId && remap[r.template.categoryId]) { r.template.categoryId = fix(r.template.categoryId); touch('recurring', r); } });
  live(s, 'rules').forEach(r => { if (r.categoryId && remap[r.categoryId]) { r.categoryId = fix(r.categoryId); touch('rules', r); } });
  live(s, 'mortgages').forEach(m => ['categoryId', 'interestCategoryId', 'principalCategoryId'].forEach(f => { if (m[f] && remap[m[f]]) { m[f] = fix(m[f]); touch('mortgages', m); } }));
  return out;
}

// ---------- sync merge (last-writer-wins per record, tombstones for deletes) ----------
export function merge(a, b) {
  const out = { schema: 1 };
  for (const c of COLLECTIONS) {
    const map = new Map();
    for (const r of [...(a[c] || []), ...(b[c] || [])]) {
      const e = map.get(r.id);
      if (!e || (r.updatedAt || 0) > (e.updatedAt || 0)) map.set(r.id, r);
      else if (c === 'recurring' && e && r.materializedThrough > (e.materializedThrough || '')) e.materializedThrough = r.materializedThrough;
    }
    out[c] = [...map.values()];
  }
  out.settings = (a.settings?.updatedAt || 0) >= (b.settings?.updatedAt || 0) ? a.settings : b.settings;
  return out;
}
