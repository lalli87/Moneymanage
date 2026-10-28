// Smart helpers that look at your own data (on the device) and suggest or remind.
import { live, get, todayStr, addDays, parseYmd, ymd, round2, occurrences, balances, daysInMonth, catLabel } from './model.js';
import { merchantKey } from './receipt.js';
import { similar, PAY_WORDS } from './importer.js';

const days = (a, b) => Math.round((parseYmd(b) - parseYmd(a)) / 86400000);
const median = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : 0; };
const kindOf = (S, accId) => get(S, 'groups', get(S, 'accounts', accId)?.groupId)?.kind || 'asset';

export const UTILITY = /hydro|\butl\b|utilit|enbridge|enova|\bwater\b|natural gas|\bgas bill|electric|alectra|kitch-?wilmt|waterloo north|reliance|union gas|kitchener utilities|kw hydro|grandbridge|sewer/i;
export const PHONE_NET = /koodo|fizz|rogers|\bbell\b|telus|fido|freedom mobile|virgin|chatr|public mobile|distributel|teksavvy|start\.ca|wireless|mobile|internet|cogeco|shaw|eastlink|vmedia|phone|cell/i;
const NOT_BILL = /freshco|walmart|wal-mart|sobeys|food basics|costco|tim hortons|starbucks|mcdonald|dollarama|amazon|amzn|uber|petro|esso|shell|loblaws|no frills|zehrs|winners/i;

function isUtility(S, t) { return UTILITY.test(t.note || '') || UTILITY.test(catLabel(S, t.categoryId)); }
function isPhone(S, t) { return PHONE_NET.test(t.note || '') || /phone|internet|mobile|cell/i.test(catLabel(S, t.categoryId)); }

// ---------- recurring charges you pay but haven't scheduled ----------
export function predictRecurring(S, today = todayStr()) {
  const since = addDays(today, -400);
  const groups = new Map();
  for (const t of live(S, 'transactions')) {
    if (t.date > today || t.date < since || t.type !== 'expense' || !(+t.amount > 0)) continue;
    const key = merchantKey(t.note || '');
    if (!key || NOT_BILL.test(t.note || '')) continue;
    (groups.get(key) || groups.set(key, []).get(key)).push(t);
  }
  const out = [];
  for (const [key, list] of groups) {
    const ts = list.sort((a, b) => a.date.localeCompare(b.date)).filter((t, i, a) => i === 0 || t.date !== a[i - 1].date);
    if (ts.length < 3) continue;
    const iv = ts.slice(1).map((t, i) => days(ts[i].date, t.date));
    const med = median(iv);
    let freq = null;
    if (med >= 26 && med <= 35 && iv.filter(x => x >= 20 && x <= 40).length >= iv.length * 0.7) freq = 'monthly';
    else if (med >= 13 && med <= 15 && iv.filter(x => x >= 11 && x <= 17).length >= iv.length * 0.7) freq = 'biweekly';
    else if (med >= 6 && med <= 8 && iv.filter(x => x >= 5 && x <= 9).length >= iv.length * 0.8) freq = 'weekly';
    if (!freq) continue;
    const last = ts[ts.length - 1];
    if (days(last.date, today) > med * 1.7 + 5) continue;                      // stopped
    const recent = ts.slice(-6).map(t => +t.amount), am = median(recent);
    const spread = (Math.max(...recent) - Math.min(...recent)) / am;
    const phone = isPhone(S, last), util = !phone && isUtility(S, last);   // phone/internet are auto-debit: never reminder-only
    if (!util && spread > 0.15) continue;                                         // groceries etc. vary too much to be a bill
    if (freq === 'weekly' && !util && spread > 0.02) continue;
    const dom = Math.round(median(ts.slice(-6).map(t => +t.date.slice(8, 10))));
    let next;
    if (freq === 'monthly') {
      const d = parseYmd(last.date); const n = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      next = ymd(new Date(n.getFullYear(), n.getMonth(), Math.min(dom, daysInMonth(n.getFullYear(), n.getMonth()))));
    } else next = addDays(last.date, freq === 'weekly' ? 7 : 14);
    while (next <= today) next = freq === 'monthly' ? (() => { const d = parseYmd(next); const n = new Date(d.getFullYear(), d.getMonth() + 1, 1); return ymd(new Date(n.getFullYear(), n.getMonth(), Math.min(dom, daysInMonth(n.getFullYear(), n.getMonth())))); })() : addDays(next, freq === 'weekly' ? 7 : 14);
    const s = { key, note: last.note, accountId: last.accountId, categoryId: last.categoryId, freq, amount: round2(util ? median(recent.slice(-3)) : am),
      variable: spread > 0.03, count: ts.length, lastDate: last.date, nextDate: next, kind: util ? 'utility' : phone ? 'phone' : 'other' };
    if (!coveredBySchedule(S, s)) out.push(s);
  }
  const order = { utility: 0, phone: 1, other: 2 };
  return out.sort((a, b) => order[a.kind] - order[b.kind] || a.nextDate.localeCompare(b.nextDate));
}
function coveredBySchedule(S, s) {
  return live(S, 'recurring').some(r => {
    const t = r.template || {};
    const sameThing = similar(t.note || '', s.note || '') || (t.categoryId && t.categoryId === s.categoryId && (s.kind !== 'other'));
    const closeAmt = s.variable || Math.abs(+t.amount - s.amount) <= Math.max(2, s.amount * 0.3);
    return sameThing && closeAmt;
  }) || live(S, 'mortgages').some(m => similar(m.lender || m.name || '', s.note || ''));
}

// ---------- duplicate / outdated scheduled payments ----------
export function redundantSchedules(S, today = todayStr()) {
  const recs = live(S, 'recurring').filter(r => !r.paused);
  const out = [], seen = new Set();
  const nextOf = r => occurrences(r, addDays(today, 1), addDays(today, 400))[0];
  const fq = f => (f === 'monthEnd' ? 'monthly' : f);
  for (const r of live(S, 'recurring')) if (r.endDate && r.endDate < today) out.push({ kind: 'ended', keep: null, drop: r, why: `ended on ${r.endDate}` });
  for (let i = 0; i < recs.length; i++) for (let j = i + 1; j < recs.length; j++) {
    const a = recs[i], b = recs[j], ta = a.template || {}, tb = b.template || {};
    if (fq(a.freq) !== fq(b.freq)) continue;
    const amtOk = Math.abs(+ta.amount - +tb.amount) <= Math.max(1, +ta.amount * 0.05);
    const thing = similar(ta.note || '', tb.note || '') || (ta.categoryId && ta.categoryId === tb.categoryId) ||
      (ta.type === 'mortgage' || tb.type === 'mortgage') && similar(get(S, 'mortgages', ta.mortgageId || tb.mortgageId)?.lender || 'mortgage', ta.type === 'mortgage' ? tb.note : ta.note);
    if (!amtOk || !thing) continue;
    const na = nextOf(a), nb = nextOf(b);
    if (!na || !nb || Math.abs(days(na, nb)) > 6) continue;
    // Keep the more specific one: mortgage type, then the one with a calendar reminder, then the newer edit.
    const score = r => (r.template?.type === 'mortgage' ? 4 : 0) + (r.gcalEventId ? 2 : 0) + (r.updatedAt || 0) / 1e14;
    const [keep, drop] = score(a) >= score(b) ? [a, b] : [b, a];
    if (seen.has(drop.id)) continue; seen.add(drop.id);
    out.push({ kind: 'duplicate', keep, drop, why: `same ${keep.template.type === 'mortgage' ? 'mortgage payment' : 'payment'} as “${keep.template.note || 'another repeat'}”` });
  }
  // One-off future entries that a repeat payment already covers.
  for (const t of live(S, 'transactions')) {
    if (t.date <= today || t.recurringId) continue;
    const r = recs.find(r => r.template?.accountId === t.accountId && Math.abs(+r.template.amount - +t.amount) <= Math.max(1, +t.amount * 0.02) &&
      occurrences(r, addDays(t.date, -3), addDays(t.date, 3)).length);
    if (r) out.push({ kind: 'oneoff', keep: r, dropTxn: t, why: `${t.date} is already covered by the repeat “${r.template.note || ''}”` });
  }
  return out;
}

// ---------- credit card statement cycles ----------
// Learns the next statement date from past ones: same day of month, same distance from month end, or fixed length.
export function predictCycle(a, after = todayStr()) {
  const hist = [...new Set((a.cycles || []).map(c => c.statementDate).filter(Boolean))].sort();
  const dueGaps = (a.cycles || []).filter(c => c.statementDate && c.dueDate).map(c => days(c.statementDate, c.dueDate));
  const dueGap = dueGaps.length ? Math.round(median(dueGaps)) : (+a.dueDays || 21);
  const methods = {
    dom: (prev, day) => { const d = parseYmd(prev); const n = new Date(d.getFullYear(), d.getMonth() + 1, 1); return ymd(new Date(n.getFullYear(), n.getMonth(), Math.min(day, daysInMonth(n.getFullYear(), n.getMonth())))); },
    eom: (prev, off) => { const d = parseYmd(prev); const n = new Date(d.getFullYear(), d.getMonth() + 2, 0); n.setDate(n.getDate() - off); return ymd(n); },
    len: (prev, L) => addDays(prev, Math.round(L)),
  };
  let method = 'dom', param = hist.length ? +hist[hist.length - 1].slice(8, 10) : (+a.statementDay || 0);
  if (!param) return null;
  if (hist.length >= 2) {
    const dom = Math.round(median(hist.map(h => +h.slice(8, 10))));
    const eom = Math.round(median(hist.map(h => { const d = parseYmd(h); return daysInMonth(d.getFullYear(), d.getMonth()) - d.getDate(); })));
    const len = median(hist.slice(1).map((h, i) => days(hist[i], h)));
    const err = (fn, p) => hist.slice(1).reduce((s, h, i) => s + Math.abs(days(fn(hist[i], p), h)), 0);
    const cand = [['dom', dom, err(methods.dom, dom)], ['eom', eom, err(methods.eom, eom)], ['len', len, err(methods.len, len)]].sort((x, y) => x[2] - y[2]);
    [method, param] = cand[0];
  }
  let prev = hist.length ? hist[hist.length - 1] : null;
  if (!prev) { const t = parseYmd(after); prev = ymd(new Date(t.getFullYear(), t.getMonth() - 1, Math.min(param, daysInMonth(t.getFullYear(), t.getMonth() - 1)))); }
  let next = methods[method](prev, param), guard = 0;
  while (next <= after && guard++ < 36) { prev = next; next = methods[method](prev, param); }
  return { last: prev, next, method, dueGap, nextDue: addDays(next, dueGap), lastDue: addDays(prev, dueGap) };
}
const paymentsInto = (S, accId, from, to) => live(S, 'transactions').filter(t => t.date > from && t.date <= to &&
  ((t.type === 'transfer' && t.toAccountId === accId) || (t.type === 'income' && t.accountId === accId && PAY_WORDS.test(t.note || ''))))
  .reduce((s, t) => s + +t.amount, 0);
// Equal-payment plans: the part of a card balance that is not due this month.
function planHeld(a, date) {
  let held = 0, inst = 0;
  for (const p of a.plans || []) {
    if (!p.start || p.start > date || (p.expiry && p.expiry < date)) continue;
    const months = Math.max(0, Math.floor(days(p.start, date) / 30.44));
    const left = Math.max(0, +p.original - months * +p.monthly);
    held += left; if (left > 0) inst += Math.min(+p.monthly, left);
  }
  return { held, inst };
}
export function cardStatuses(S, today = todayStr()) {
  const out = [];
  for (const a of live(S, 'accounts')) {
    if (kindOf(S, a.id) !== 'card' || a.hidden) continue;
    const pc = predictCycle(a, today); if (!pc) continue;
    const stmt = pc.last;                                     // most recent statement date on or before today
    const known = (a.cycles || []).find(c => c.statementDate === stmt);
    const due = known?.dueDate || pc.lastDue;
    let amount;
    if (known && (known.balanceDue ?? known.newBalance) != null) amount = +(known.balanceDue ?? known.newBalance);
    else {
      const owed = -(balances(S, stmt)[a.id] || 0);
      const { held, inst } = planHeld(a, stmt);
      amount = round2(Math.max(0, owed - held + inst));
    }
    const paid = round2(paymentsInto(S, a.id, stmt, today));
    const remaining = round2(Math.max(0, amount - paid));
    let status = amount <= 0.005 ? 'none' : remaining <= 0.5 ? 'paid' : today > due ? 'overdue' : 'due';
    out.push({ account: a, statementDate: stmt, dueDate: due, amount, paid, remaining, status, predicted: !known, minPayment: known?.minPayment ?? null,
      daysLeft: days(today, due), nextStatement: pc.next, method: pc.method });
  }
  return out.sort((x, y) => x.dueDate.localeCompare(y.dueDate));
}

// ---------- reminder-only bills (utilities) you add by hand ----------
export function billReminders(S, today = todayStr(), remindDays = 3) {
  const out = [];
  for (const r of live(S, 'recurring')) {
    if (r.paused || r.mode !== 'remind') continue;
    const t = r.template || {};
    for (const d of occurrences(r, addDays(today, -25), addDays(today, remindDays))) {
      const done = live(S, 'transactions').some(x => x.type === t.type && Math.abs(days(d, x.date)) <= 12 &&
        (similar(x.note || '', t.note || '') || (t.categoryId && x.categoryId === t.categoryId && Math.abs(+x.amount - +t.amount) <= +t.amount * 0.4)));
      if (!done && !(r.dismissed || []).includes(d)) out.push({ recurring: r, date: d, overdue: d < today, daysLeft: days(today, d) });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}
