// Statement / CSV / screenshot / mortgage-document import.
// Everything is parsed on the device; nothing is sent anywhere.
import { live, get, parseYmd, round2, todayStr, addDays, ymd } from './model.js';
import { merchantKey } from './receipt.js';

// ---------- PDF reading ----------
let pdfP;
function loadPdfJs() {
  pdfP = pdfP || new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'vendor/pdfjs/pdf.min.js';
    sc.onload = () => { pdfjsLib.GlobalWorkerOptions.workerSrc = 'vendor/pdfjs/pdf.worker.min.js'; res(pdfjsLib); };
    sc.onerror = () => rej(new Error('Could not load the PDF reader'));
    document.head.appendChild(sc);
  });
  return pdfP;
}
// Positioned text pieces → visual lines made of cells (a cell = words close together).
// items: [{s, x, y, w, h}]
export function itemsToLines(items, page = 1) {
  const rows = [];
  for (const it of items) {
    if (!it.s || !it.s.trim()) continue;
    const h = it.h || 8;
    let row = rows.find(r => Math.abs(r.y - it.y) <= Math.max(1.5, Math.min(h, r.h) * 0.4));
    if (!row) rows.push(row = { y: it.y, h, parts: [] });
    row.parts.push(it);
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map(r => {
    r.parts.sort((a, b) => a.x - b.x);
    const cells = []; let cur = null;
    for (const p of r.parts) {
      const end = cur ? cur.x + cur.w : 0, gap = cur ? p.x - end : 0, h = p.h || r.h || 8;
      if (cur && gap <= h * 0.9) {
        cur.s += (gap > h * 0.12 && !/\s$/.test(cur.s) && !/^\s/.test(p.s) ? ' ' : '') + p.s;
        cur.w = p.x + (p.w || 0) - cur.x;
      } else { cur = { x: p.x, w: p.w || 0, s: p.s }; cells.push(cur); }
    }
    cells.forEach(c => (c.s = c.s.replace(/[\u0080-\u009f\u00a0\u2000-\u200b\u202f]/g, ' ').replace(/\s+/g, ' ').trim()));
    return { text: cells.map(c => c.s).join('  '), cells, page };
  });
}
export async function readPdf(file, onProgress = () => {}, ocrCanvas) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  let lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const items = (await page.getTextContent()).items.map(it => ({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width, h: Math.abs(it.transform[3]) }));
    lines.push(...itemsToLines(items, p));
    onProgress(p / doc.numPages * 0.5);
  }
  if (lines.map(l => l.text).join('').replace(/\s/g, '').length < 40 && ocrCanvas) {
    lines = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const vp = page.getViewport({ scale: 2 });
      const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      lines.push(...(await ocrCanvas(c, pr => onProgress(0.5 + (p - 1 + pr) / doc.numPages * 0.5))).split(/\r?\n/));
    }
    return { lines, scanned: true };
  }
  return { lines, scanned: false };
}

// ---------- dates & amounts ----------
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const z = n => String(n).padStart(2, '0');
const MONRE = '(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?';
function leadDate(s) {
  let m;
  if ((m = s.match(new RegExp(`^${MONRE}\\s*(\\d{1,2})(?:,?\\s*(20\\d{2}))?(?![\\d:])`, 'i'))))
    return { m: MON[m[1].toLowerCase()], d: +m[2], y: m[3] ? +m[3] : null, len: m[0].length };
  if ((m = s.match(new RegExp(`^(\\d{1,2})[\\s-]*${MONRE}(?:[\\s,-]*(20\\d{2}|\\d{2}))?\\b`, 'i'))))
    return { m: MON[m[2].toLowerCase()], d: +m[1], y: m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null, len: m[0].length };
  if ((m = s.match(/^(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/))) return { y: +m[1], m: +m[2], d: +m[3], len: m[0].length };
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](20\d{2}|\d{2}))?(?![\d.,])/))) {
    let a = +m[1], b = +m[2]; const y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null;
    if (a > 12 && b <= 12) [a, b] = [b, a];
    return { m: a, d: b, y, len: m[0].length };
  }
  if ((m = s.match(/^(today|yesterday)\b/i))) {
    const t = parseYmd(todayStr()); if (/yest/i.test(m[1])) t.setDate(t.getDate() - 1);
    return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), len: m[0].length };
  }
  return null;
}
export function parseDate(s) { const r = leadDate(String(s || '').trim()); return r && r.m >= 1 && r.m <= 12 && r.d >= 1 && r.d <= 31 ? r : null; }
// Full date string ("October 11, 2026", "10/14/26", "11/05/2026", "2026-10-21") → YYYY-MM-DD
export function looseDate(s) {
  const r = parseDate(s); if (!r || !r.y) return null;
  return `${r.y}-${z(r.m)}-${z(r.d)}`;
}
const AMT_TOKEN = String.raw`\(?[-+]?\s?\$?\s?\d{1,3}(?:,\d{3})*\.\d{2}\)?(?:\s?(?:CR|DR|-))?`;
const AMT = new RegExp(`(${AMT_TOKEN})(?=\\s|$)`, 'gi');
const AMT_FULL = new RegExp(`^${AMT_TOKEN}$`, 'i');
function toAmount(tok) {
  let t = tok.trim(); let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/\bCR$/i.test(t)) { neg = true; t = t.replace(/\s?CR$/i, ''); }
  t = t.replace(/\s?DR$/i, '');
  if (/-$/.test(t)) { neg = true; t = t.slice(0, -1); }
  const bare = t.replace(/[\s$]/g, '');
  if (/^-/.test(bare)) neg = true;
  const plus = /^\+/.test(bare);
  const v = parseFloat(bare.replace(/[^\d.]/g, ''));
  return isNaN(v) ? null : { v, neg, plus };
}
const num = s => { const a = toAmount(String(s || '').replace(/^\$/, '')); return a ? (a.neg ? -a.v : a.v) : null; };

const CREDIT_WORDS = /payment|paiement|thank you|refund|return|credit|deposit|reversal|cashback|cash back|rebate|e-?transfer (from|received)|received from|payroll|salary|interest (earned|received|credit)|benefit|load from/i;
export const PAY_WORDS = /payment|paiement|thank you|pymt|pmt\b|payment from/i;
const SKIP_WORDS = /(previous|opening|closing|new|ending|beginning|statement|account)\s+balance|balance\s+(forward|from|brought|due)|^total|\btotals?\b|minimum payment|credit limit|available (credit|cash)|interest rate|annual interest|payment due|due date|page \d|subtotal|^balance\b|continued on|amount disputed|days in billing/i;
const BAL_START = /balance\s+forward|opening balance|previous balance|balance from (your )?last statement|beginning balance/i;
// Sections after the transaction list that must not be read as transactions.
const STOP_AT = /details of your .*(equal payment|store purchases|interest charges)|interest charge calculation|creditsmart|spend report|rewards summary|scorecard bonus points|equal payments plan\(s\)/i;
const SUBHEAD = /^(purchases|payments received|returns and other credits|your payments|your new charges|transactions (since|from)|card number|purchases - card|payments and credits|other credits|cardholder account summary)/i;
const HEADER_A = /description|details|account activity|transaction description|^activity$/i;
const HEADER_B = /amount|withdraw|debit|deposit|credit|balance/i;

// ---------- statement facts (dates, balance due, card numbers) ----------
const DTXT = String.raw`([A-Z][a-z]{2,8}\.?\s+\d{1,2},?\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}-[A-Z][a-z]{2}-\d{4})`;
const money = s => s ? parseFloat(s.replace(/[,$\s]/g, '')) : null;
export function statementMeta(text) {
  const t = text.replace(/[\u0080-\u009f\u00a0\u2000-\u200b\u202f]/g, ' ').replace(/[ \t]+/g, ' ');
  const pick = (res, f = x => x) => { for (const re of res) { const m = t.match(re); if (m) { const v = f(m[m.length - 1]); if (v != null && !Number.isNaN(v)) return v; } } return null; };
  const meta = {};
  meta.kind = /credit limit|minimum payment|payment due/i.test(t) ? 'card' : /balance forward|opening balance|withdrawals|deposits/i.test(t) ? 'bank' : null;
  meta.periodEnd = pick([new RegExp(String.raw`(?:statement\s+)?period[:\s]*[A-Z][a-z]+\.?\s+\d{1,2},?(?:\s+\d{4})?\s*(?:-|to)\s*` + DTXT, 'i'),
    new RegExp(String.raw`(?:statement\s+)?period[:\s]*[A-Z][a-z]+\s+\d{1,2}\s+to\s+` + DTXT, 'i')], looseDate);
  meta.periodStart = pick([new RegExp(String.raw`(?:statement\s+)?period[:\s]*` + DTXT + String.raw`\s*(?:-|to)`, 'i'),
    /(?:statement\s+)?period[:\s]*([A-Z][a-z]+\.?\s+\d{1,2})(?:,?\s+\d{4})?\s*(?:-|to)\s*[A-Z][a-z]+\.?\s+\d{1,2},?\s+(\d{4})/i], s => looseDate(s) || null);
  if (!meta.periodStart) {
    const m = t.match(/(?:statement\s+)?period[:\s]*([A-Z][a-z]+\.?\s+\d{1,2})(?:,?\s+\d{4})?\s*(?:-|to)\s*[A-Z][a-z]+\.?\s+\d{1,2},?\s+(\d{4})/i);
    if (m) { let s = looseDate(`${m[1]}, ${m[2]}`); if (s && meta.periodEnd && s > meta.periodEnd) s = looseDate(`${m[1]}, ${+m[2] - 1}`); meta.periodStart = s; }
  }
  meta.statementDate = pick([new RegExp(String.raw`statement\s+(?:closing\s+)?date[:\s]*` + DTXT, 'i'), new RegExp(String.raw`statement period ending[:\s]*` + DTXT, 'i'),
    new RegExp(String.raw`closing date[:\s]*` + DTXT, 'i')], looseDate) || meta.periodEnd;
  meta.dueDate = pick([new RegExp(String.raw`payment due date[:\s]*` + DTXT, 'i'), new RegExp(String.raw`pay this amount by\s+` + DTXT, 'i'),
    new RegExp(String.raw`minimum payment due by\s+` + DTXT, 'i'), new RegExp(String.raw`due date[:\s]*` + DTXT, 'i')], looseDate);
  meta.balanceDue = pick([/balance due\s*\$?\s*([\d,]+\.\d{2})/i, /amount due\d?\s*\$?\s*([\d,]+\.\d{2})/i], money);
  meta.newBalance = pick([/new balance[\s=:$]*([\d,]+\.\d{2})/i, /total balance[\s=+:$]*([\d,]+\.\d{2})/i, /account balance[\s=:$]*([\d,]+\.\d{2})/i], money);
  meta.minPayment = pick([/(?:total\s+)?minimum payment(?:\s+due)?\s*\d?\s*\$?\s*([\d,]+\.\d{2})/i], money);
  meta.endings = findAllLast4(t);
  return meta;
}
export function findAllLast4(text) {
  const out = new Set(); let m;
  const res = [/(?:\*|x|X|#|•){2,}[\s*xX#•-]*(\d{4})\b/g, /ending (?:with|in) (\d{4})\b/gi, /\b\d{4}\s\d{2}[xX*]{2}\s[xX*]{4}\s(\d{4})\b/g];
  for (const re of res) while ((m = re.exec(text))) out.add(m[1]);
  return [...out];
}
export const findLast4 = text => findAllLast4(text)[0] || null;

// ---------- statement lines → rows ----------
// Row: { date, desc, raw, amount, sign (-1|0|1), plus, colDir, balDir, section, card, pending, src }
function headerColumns(line) {
  if (!line.cells) return null;
  const cols = { out: null, in: null, bal: null, amt: null, exclude: [], right: 0, descX: null };
  for (const c of line.cells) {
    const l = c.s.toLowerCase(), r = c.x + c.w;
    cols.right = Math.max(cols.right, r);
    if (/withdraw|debit/.test(l)) cols.out = r;
    else if (/deposit|credit/.test(l)) cols.in = r;
    else if (/balance/.test(l)) cols.bal = r;
    else if (/amount/.test(l)) cols.amt = r;
    else if (/categor|reference|ref\.?\s*#|plan name|merchant city|province/.test(l) && !/date/.test(l)) cols.exclude.push([c.x - 6, c.x + c.w + 6]);
    if (/description|details|activity/.test(l)) cols.descX = c.x;
  }
  if (cols.out == null && cols.in == null && cols.amt == null) return null;
  return cols;
}
export function parseStatement(input, src = '', { negIsOut = false } = {}) {
  const lines = input.map(l => (typeof l === 'string' ? { text: l, cells: null } : l));
  const fullText = lines.map(l => l.text).join('\n');
  const meta = statementMeta(fullText);
  const rows = [];
  let cols = null, prevBal = null, lastRow = null, lastRowAt = -9, curDate = null, pendingDesc = '';
  let section = null, titleCand = [], card = null, stopped = false, headerSeen = !lines.some(l => l.cells);
  const plans = [];
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    let text = L.text.replace(/[|•·Ý]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    // Equal-payment / instalment plans listed on card statements.
    const pm = text.match(/^([A-Z][a-z]{2}\.? \d{1,2},? \d{4})\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})\s+([A-Z][a-z]{2}\.? \d{1,2},? \d{4})$/);
    if (pm) { plans.push({ start: looseDate(pm[1]), original: money(pm[2]), monthly: money(pm[3]), balance: money(pm[4]), expiry: looseDate(pm[5]) }); continue; }
    if (meta.kind === 'card' && rows.length && STOP_AT.test(text)) { stopped = true; continue; }
    if (stopped) continue;
    // Table header?
    if (HEADER_A.test(text) && HEADER_B.test(text) && !AMT.test(text)) {
      AMT.lastIndex = 0;
      const hc = headerColumns(L); if (hc) cols = hc;
      headerSeen = true;
      if (meta.kind !== 'card' && !/cont/i.test(text) && titleCand.length) section = titleCand[titleCand.length - 1];
      titleCand = []; continue;
    }
    AMT.lastIndex = 0;
    const cm = text.match(/card\s*#?\s*(?:number\s*)?[\dxX* ]{8,}?(\d{4})\b/i); if (cm && /purchases|card number|card #/i.test(text)) card = cm[1];
    // Use cells to drop side-panel text, excluded columns, and find amount columns.
    let amountCells = null;
    if (L.cells && cols) {
      const keep = L.cells.filter(c => c.x < cols.right + 8 && !cols.exclude.some(([a, b]) => c.x >= a && c.x <= b && !AMT_FULL.test(c.s)));
      amountCells = keep.filter(c => AMT_FULL.test(c.s));
      text = keep.map(c => c.s).join('  ').replace(/[|•·Ý]/g, ' ').replace(/\s+/g, ' ').trim();
      if (!text) continue;
    }
    // Strip leading reference numbers ("001 Sep 21 …").
    text = text.replace(/^\d{1,4}\s+(?=(?:[A-Za-z]{3,9}\.?\s+\d{1,2}\b|\d{1,2}[/-]))/, '');
    let rest = text, d1 = parseDate(rest);
    if (d1) {
      rest = rest.slice(d1.len).trim();
      const d2 = parseDate(rest); if (d2) rest = rest.slice(d2.len).trim();
    }
    const amts = [...rest.matchAll(AMT)].map(m => ({ tok: m[1], idx: m.index }));
    if (!amts.length) {
      if (d1 && !rest) { curDate = d1; pendingDesc = ''; continue; }
      if (d1) { curDate = d1; pendingDesc = rest; continue; }
      if (SUBHEAD.test(rest)) { lastRow = null; continue; }
      // Continuation of the previous row's description (wrapped lines) — but not a new account's title.
      const nextStartsSection = lines.slice(i + 1, i + 4).some(n => BAL_START.test(n.text) || /daily rate/i.test(n.text) || (HEADER_A.test(n.text) && HEADER_B.test(n.text)));
      if (lastRow && !nextStartsSection && !/member (number|name)|page \d|statement period|account number/i.test(rest) && i - lastRowAt <= 2 && rest.length < 70 && /[a-z]{2}/i.test(rest) && !SKIP_WORDS.test(rest) && !HEADER_A.test(rest)) {
        lastRow.raw += ' ' + rest;
        if (lastRow.desc.length < 40 || /^(to|from|wire from)\b/i.test(rest)) lastRow.desc = (lastRow.desc + ' ' + rest).trim();
        lastRowAt = i; continue;
      }
      if (rest.length > 2 && rest.length < 80 && /[a-z]{3}/i.test(rest) && !/daily rate|interest rate|as at|page \d/i.test(rest)) { titleCand.push(rest); if (titleCand.length > 4) titleCand.shift(); }
      if (curDate && rest.length > 2 && rest.length < 60 && /[a-z]{2}/i.test(rest)) pendingDesc = rest;
      continue;
    }
    let desc = rest.slice(0, amts[0].idx).trim().replace(/[\s$-]+$/, '');
    if (!desc && pendingDesc) desc = pendingDesc;
    if (BAL_START.test(desc)) {
      const b = toAmount(amts[amts.length - 1].tok); if (b) prevBal = b.neg ? -b.v : b.v;
      if (titleCand.length && meta.kind !== 'card') section = titleCand[titleCand.length - 1];
      titleCand = []; lastRow = null; continue;
    }
    // Undated line inside a block (e.g. a fee under the transaction it belongs to).
    const date = d1 || (!headerSeen ? null : lastRow && i - lastRowAt <= 2 && desc ? lastRow._d : (curDate && desc ? curDate : null));
    if (!date || !desc || SKIP_WORDS.test(desc) || !/[a-z]{2}/i.test(desc)) {
      if (SKIP_WORDS.test(desc) && /balance/i.test(desc)) { const b = toAmount(amts[amts.length - 1].tok); if (b) prevBal = b.neg ? -b.v : b.v; }
      continue;
    }
    const a = toAmount(amts[0].tok); if (!a || a.v === 0) continue;
    const r = { _d: date, desc, raw: desc, amount: round2(a.v), sign: a.neg ? -1 : 0, plus: a.plus, section, card, src };
    // Column position tells money in vs out on bank statements.
    if (amountCells && amountCells.length && cols && (cols.out != null || cols.in != null)) {
      const ac = amountCells[0], right = ac.x + ac.w;
      const cand = [['out', cols.out], ['in', cols.in], ['bal', cols.bal]].filter(([, x]) => x != null).sort((p, q) => Math.abs(p[1] - right) - Math.abs(q[1] - right));
      if (cand[0] && cand[0][0] !== 'bal') r.colDir = cand[0][0];
      if (cand[0] && cand[0][0] === 'bal' && amountCells.length === 1) continue;   // balance only, no money moved
    }
    // Running balance tells it too.
    if (amts.length >= 2) {
      const b = toAmount(amts[amts.length - 1].tok); const bal = b ? (b.neg ? -b.v : b.v) : null;
      if (bal !== null && prevBal !== null) {
        if (Math.abs(round2(prevBal - a.v) - bal) < 0.011) r.balDir = 'out';
        else if (Math.abs(round2(prevBal + a.v) - bal) < 0.011) r.balDir = 'in';
      }
      if (bal !== null) prevBal = bal;
    }
    if (negIsOut) r.negIsOut = true;
    rows.push(r); lastRow = r; lastRowAt = i; pendingDesc = '';
  }
  finishDates(rows, meta);
  rows.forEach(r => (r.desc = cleanDesc(r.desc)));
  if (plans.length) meta.plans = plans;
  return { rows, meta };
}
export const parseStatementText = (lines, src, opts) => parseStatement(lines, src, opts).rows;

function cleanDesc(s) {
  return s.replace(/^\s*[A-Z]{3,5}\d{2}\b/, '')                 // plan codes (PBUS01)
    .replace(/\b(?=[A-Z0-9]*\d{6})[A-Z0-9]{8,}\b/g, '')         // long reference numbers
    .replace(/#\s+\d{6,}/g, '').replace(/\b\d{9,}\b/g, '')
    .replace(/\s+[#*-]\s*$/, '').replace(/\s{2,}/g, ' ').trim() || s.trim();
}
function finishDates(rows, meta) {
  const ref = meta?.statementDate || meta?.periodEnd || todayStr();
  const refY = +ref.slice(0, 4), t = todayStr();
  const limit = addDays(ref > t ? ref : t, 7);
  for (const r of rows) {
    const d = r._d; let y = d.y || refY;
    let s = `${y}-${z(d.m)}-${z(d.d)}`;
    if (!d.y && s > limit) s = `${y - 1}-${z(d.m)}-${z(d.d)}`;
    r.date = s; delete r._d;
  }
  return rows;
}

// ---------- CSV ----------
export function parseCsvText(text) {
  const out = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',' || c === ';' || c === '\t') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); out.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); out.push(row); }
  return out.map(r => r.map(x => x.trim())).filter(r => r.some(Boolean));
}
// Decide y-m-d / m-d-y / d-m-y for a whole column of numeric dates.
function dateOrder(values) {
  const trip = values.map(v => String(v || '').match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})/)).filter(Boolean);
  if (!trip.length) return null;
  const t = todayStr(), lo = `${+t.slice(0, 4) - 8}-01-01`, hi = addDays(t, 2);
  const yy = n => (n < 100 ? 2000 + n : n);
  const make = (o, m) => { const p = [+m[1], +m[2], +m[3]]; const [y, mo, d] = o === 'ymd' ? [yy(p[0]), p[1], p[2]] : o === 'mdy' ? [yy(p[2]), p[0], p[1]] : [yy(p[2]), p[1], p[0]];
    return mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && y > 1999 && y < 2100 ? `${y}-${z(mo)}-${z(d)}` : null; };
  let best = null, bestScore = -1;
  for (const o of ['ymd', 'mdy', 'dmy']) {
    const ds = trip.map(m => make(o, m));
    let score = ds.filter(d => d && d >= lo && d <= hi).length * 10;
    const ok = ds.filter(Boolean);
    let asc = 0, desc = 0; for (let i = 1; i < ok.length; i++) { if (ok[i] >= ok[i - 1]) asc++; if (ok[i] <= ok[i - 1]) desc++; }
    score += Math.max(asc, desc);
    if (score > bestScore) { best = o; bestScore = score; }
  }
  return { order: best, make: v => { const m = String(v || '').match(/^(\d{1,4})[-/.](\d{1,2})[-/.](\d{1,4})/); return m ? make(best, m) : looseDate(v); } };
}
const GENERIC = /^(pos purchase|bill payment|withdrawal|deposit|customer transfer|miscellaneous payment|service charge|abm withdrawal|reg education sav plan|transfer|payroll deposit|canadian child benefit|e-?transfer|interac|pre-?authorized|insurance|mortgage|loan payment|investment|shared abm)/i;
function findCol(H, list, not) {
  for (const re of list) { const i = H.findIndex(h => re.test(h) && !(not && not.test(h))); if (i >= 0) return i; }
  return -1;
}
// accountKind: 'card' → positive single amounts are charges; otherwise negative = money out.
export function parseCsvRows(table, accountKind = 'asset', src = '') {
  if (!table.length) return { rows: [], sig: '' };
  // Header row: the first rows can be a summary block (e.g. "Start Date, End Date, Current Balance").
  const hscore = r => (r.some(h => /date/i.test(h)) ? 1 : 0) * (r.filter(h => /^(amount|debit|credit|withdrawals?|deposits?|description|merchant( name)?|payee|details|memo|sub-description|type( of transaction)?|status|balance)$/i.test(h.trim())).length);
  let hi = -1, hs = 0;
  table.slice(0, 12).forEach((r, i) => { const sc = hscore(r); if (sc > hs && r.some(h => /description|merchant|payee|details|memo/i.test(h))) { hs = sc; hi = i; } });
  if (hi < 0) table.slice(0, 12).forEach((r, i) => { const sc = hscore(r); if (sc > hs) { hs = sc; hi = i; } });
  let iDate, iDesc, iSub = -1, iAmt = -1, iDeb = -1, iCred = -1, iType = -1, iStatus = -1, iCat = -1, body, dateCol, sig;
  if (hi >= 0) {
    const H = table[hi].map(h => h.toLowerCase().trim());
    sig = H.join('|');
    iDate = findCol(H, [/^trans(action)?\.? date$/, /^date$/, /transaction date/, /^trans/, /date/], /post/);
    if (iDate < 0) iDate = findCol(H, [/date/]);
    iDesc = findCol(H, [/^description$/, /merchant name|^merchant$/, /^details$/, /description/, /payee/, /memo/, /^name$/], /sub|cardholder|mcc/);
    iSub = findCol(H, [/sub-?description/]);
    iAmt = findCol(H, [/^amount/, /amount$/, /^amt/, /cad/], /balance/);
    iDeb = findCol(H, [/debit|withdraw|money out|charges?$/], /type/);
    iCred = findCol(H, [/credit|deposit|money in|payments?$/], /type|limit|available/);
    if (iAmt >= 0) { iDeb = -1; iCred = -1; }
    iType = findCol(H, [/^type( of transaction)?$/, /^transaction type$/]);
    iStatus = findCol(H, [/^status$/]);
    iCat = findCol(H, [/^category$/]);
    body = table.slice(hi + 1);
  } else {
    body = table; const n = Math.max(...table.map(r => r.length));
    const score = fn => [...Array(n).keys()].map(c => table.filter(r => fn(r[c])).length);
    const ds = score(v => parseDate(v)), ns = score(v => v && num(v) !== null && /\d\.\d{2}/.test(v)), ts = score(v => v && /[a-z]{3}/i.test(v) && !parseDate(v));
    iDate = ds.indexOf(Math.max(...ds));
    const numCols = ns.map((s, i) => [s, i]).filter(([s, i]) => s > 0 && i !== iDate);
    const full = numCols.filter(([s]) => s >= table.length * 0.8);
    if (full.length) iAmt = full[0][1]; else if (numCols.length >= 2) { iDeb = numCols[0][1]; iCred = numCols[1][1]; }
    const lens = [...Array(n).keys()].map(c => (ts[c] ? table.reduce((a, r) => a + (r[c] || '').length, 0) : -1));
    iDesc = lens.indexOf(Math.max(...lens));
    sig = 'noheader:' + n;
  }
  dateCol = dateOrder(body.map(r => r[iDate]));
  const rows = [];
  for (const r of body) {
    const date = dateCol ? dateCol.make(r[iDate]) : looseDate(r[iDate]);
    if (!date) continue;
    let v = null, dir = null, sign = 0;
    if (iAmt >= 0) {
      v = num(r[iAmt]); if (v === null || v === 0) continue;
      const ty = iType >= 0 ? (r[iType] || '').toLowerCase() : '';
      if (/^debit|purchase/.test(ty)) dir = 'out'; else if (/^credit|payment|refund/.test(ty)) dir = 'in';
      else dir = accountKind === 'card' ? (v > 0 ? 'out' : 'in') : (v < 0 ? 'out' : 'in');
      sign = v < 0 ? -1 : 1;
    } else {
      const db = num(r[iDeb]), cr = num(r[iCred]);
      if (db) { v = db; dir = 'out'; } else if (cr) { v = cr; dir = 'in'; } else continue;
    }
    let desc = (r[iDesc] || '').replace(/\s+/g, ' ').trim();
    const sub = iSub >= 0 ? (r[iSub] || '').replace(/\s+/g, ' ').trim() : '';
    const raw = `${desc} ${sub} ${(desc + sub).replace(/\s/g, '')}`;
    if (sub) desc = !desc || (GENERIC.test(desc) && sub.length >= 4 && !/^(canada|ontario)$/i.test(sub)) ? `${sub} · ${desc}`.replace(/ · $/, '') : `${desc} · ${sub}`;
    desc = desc.replace(/\s+·\s*$/, '') || '(no description)';
    const row = { date, desc, raw, amount: round2(Math.abs(v)), dir, csvDir: true, src };
    if (iStatus >= 0 && /pending/i.test(r[iStatus] || '')) row.pending = true;
    if (iCat >= 0 && r[iCat]) row.bankCat = r[iCat];
    rows.push(row);
  }
  // The file's own card/account number: from a number column or the file name — never from descriptions
  // (those mention other accounts, e.g. "Load from *****1234").
  const numCols = hi >= 0 ? table[hi].map((h, i) => (/account number|card number|associated card|^card$|^account$/i.test(h) ? i : -1)).filter(i => i >= 0) : [];
  const ownText = numCols.map(i => body.slice(0, 20).map(r => r[i] || '').join(' ')).join(' ');
  const endings = [...new Set([...findAllLast4(ownText), ...(ownText.match(/\d{4,}/g) || []).map(x => x.slice(-4))])];
  return { rows, sig, endings };
}

// ---------- direction ----------
// Decide money in / out for a parsed row given the account kind ('card' | 'asset' | 'liability').
export function resolveDir(r, accountKind, docKind) {
  if (r.csvDir) return r.dir;
  if (r.colDir) return r.colDir;
  if (r.balDir) return r.balDir;
  if (r.plus) return 'in';
  const bankLike = r.negIsOut || docKind === 'bank' || (docKind !== 'card' && accountKind !== 'card');
  if (r.sign < 0) return bankLike ? 'out' : 'in';
  if (CREDIT_WORDS.test(r.desc) && !/debit memo|bill payment/i.test(r.desc)) return 'in';
  return 'out';
}

// ---------- accounts by number ----------
export function accountEndings(a) {
  const src = [a.numbers, a.cardLast4].filter(Boolean).join(',');
  return [...new Set(src.split(/[,;\s]+/).map(x => x.replace(/\D/g, '')).filter(x => x.length >= 4).map(x => x.slice(-4)))];
}
// Find the account a file belongs to from card/account number endings, labels or a learned file signature.
export function matchAccount(S, { endings = [], text = '', sig = '', filename = '' }) {
  const accs = live(S, 'accounts');
  const fileDigits = (filename.match(/\d{4,}/g) || []).map(x => x.slice(-4));
  const all = new Set([...endings, ...fileDigits]);
  let best = null, bestN = 0;
  for (const a of accs) {
    const n = accountEndings(a).filter(e => all.has(e)).length;
    if (n > bestN) { best = a; bestN = n; }
  }
  if (best) return { account: best, how: 'number' };
  if (sig) { const a = accs.find(a => (a.importSigs || []).includes(sig)); if (a) return { account: a, how: 'signature' }; }
  return null;
}
export function sectionAccount(S, section) {
  if (!section) return null;
  const s = section.toLowerCase();
  return live(S, 'accounts').find(a => (a.statementLabels || []).some(l => l && s.includes(l.toLowerCase()))) || null;
}
// Another of your accounts mentioned in a description ("Pc To 4500…5678", "Load from *****1234").
export function counterpartAccount(S, raw, selfId) {
  const groups = (raw.match(/[\dXx*#]{4,}/g) || []).map(g => g.replace(/\D/g, '')).filter(g => g.length >= 4).map(g => g.slice(-4));
  if (!groups.length) return null;
  for (const a of live(S, 'accounts')) {
    if (a.id === selfId) continue;
    if (accountEndings(a).some(e => groups.includes(e))) return a;
  }
  return null;
}

// ---------- duplicates ----------
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const dayDiff = (a, b) => Math.round(Math.abs(parseYmd(a) - parseYmd(b)) / 86400000);
export function similar(a, b) {
  const ka = merchantKey(a), kb = merchantKey(b);
  if (ka && kb && (ka === kb || ka.split(' ')[0] === kb.split(' ')[0])) return true;
  const na = norm(a), nb = norm(b);
  return na.length >= 4 && nb.length >= 4 && (na.includes(nb.slice(0, 6)) || nb.includes(na.slice(0, 6)));
}
function touches(t, accountId, dir) {
  if (t.type === 'transfer') return dir === 'out' ? t.accountId === accountId : t.toAccountId === accountId;
  if (t.accountId !== accountId) return false;
  return dir === 'out' ? (t.type === 'expense' || t.type === 'mortgage') : t.type === 'income';
}
/**
 * Mark duplicates on rows (mutates). Rows need .accountId and .dir.
 *  existing  – same account & direction & amount, within 3 days (similar text if >1 day apart)
 *  scheduled – an auto-posted repeat payment close in amount (±15%) and date (±5 days): the import updates it
 *  batch     – identical entry from another file picked at the same time (overlapping statements/screenshots)
 */
export function markDuplicates(S, rows) {
  const pool = live(S, 'transactions').filter(t => t.date <= addDays(todayStr(), 3));
  const used = new Set();
  for (const r of rows) {
    delete r.dup;
    let best = null, bestScore = -1;
    for (const t of pool) {
      if (used.has(t.id) || Math.abs(+t.amount - r.amount) > 0.005 || !touches(t, r.accountId, r.dir)) continue;
      const dd = dayDiff(t.date, r.date); if (dd > 3) continue;
      const sim = similar(t.note || t.desc || '', r.desc);
      if (dd > 1 && !sim) continue;
      const score = (3 - dd) + (sim ? 3 : 0);
      if (score > bestScore) { best = t; bestScore = score; }
    }
    if (best) { used.add(best.id); r.dup = { reason: 'existing', txnId: best.id }; continue; }
    for (const t of pool) {
      if (used.has(t.id) || !t.recurringId || !touches(t, r.accountId, r.dir)) continue;
      if (dayDiff(t.date, r.date) > 5 || Math.abs(+t.amount - r.amount) > Math.max(1, +t.amount * 0.15)) continue;
      if (!similar(t.note || '', r.desc)) continue;
      used.add(t.id); r.dup = { reason: 'scheduled', txnId: t.id }; break;
    }
  }
  // Across the files picked together: the same purchase in a PDF and a CSV of the same card (descriptions differ),
  // and the two sides of one transfer (bank file "Pc To …5678" + card file "Payment from …1234").
  const kept = [], pairedSame = new Set(), pairedMirror = new Set();
  for (const r of rows) {
    if (r.dup) { if (r.dup.reason !== 'batch') kept.push(r); continue; }   // already-in-app rows still absorb their twins
    const near = k => k.src !== r.src && Math.abs(k.amount - r.amount) < 0.005 && dayDiff(k.date, r.date) <= 3;
    const same = kept.find(k => !pairedSame.has(k) && near(k) && k.accountId === r.accountId && k.dir === r.dir && (dayDiff(k.date, r.date) <= 1 || similar(k.desc, r.desc)));
    if (same) { r.dup = { reason: 'batch', twin: same.desc }; pairedSame.add(same); continue; }
    // Other side of a transfer. If only one side names the other account ("Load from *****1234" vs "Card Load"),
    // the plain side becomes the transfer and the named side is the duplicate.
    const mirrorOf = (x, y) => !pairedMirror.has(y) && y.src !== x.src && Math.abs(y.amount - x.amount) < 0.005 && dayDiff(y.date, x.date) <= 3 &&
      x.type === 'transfer' && y.accountId === x.other && y.dir !== x.dir && !y.dup && (y.type !== 'transfer' || y.other === x.accountId);
    const mirror = kept.find(k => mirrorOf(r, k)) || kept.find(k => mirrorOf(k, r) && (r.type = 'transfer', r.other = k.accountId, false));
    if (mirror) {
      if (mirror.type !== 'transfer') { mirror.type = 'transfer'; mirror.other = r.accountId; delete mirror.categoryId; }
      r.dup = { reason: 'batch', twin: mirror.desc }; pairedMirror.add(mirror); continue;
    }
    const back = kept.find(k => k.type === 'transfer' && !pairedMirror.has(k) && k.src !== r.src && k.other === r.accountId && r.accountId && Math.abs(k.amount - r.amount) < 0.005 && dayDiff(k.date, r.date) <= 3 && k.dir !== r.dir);
    if (back) { r.dup = { reason: 'batch', twin: back.desc }; pairedMirror.add(back); continue; }
    kept.push(r);
  }
  return rows;
}
export function findExistingDuplicates(S) {
  const groups = new Map();
  for (const t of live(S, 'transactions')) {
    if (t.date > todayStr()) continue;
    const k = [t.type, t.accountId, t.toAccountId || '', t.date, (+t.amount).toFixed(2), norm(t.note)].join('|');
    (groups.get(k) || groups.set(k, []).get(k)).push(t);
  }
  return [...groups.values()].filter(g => g.length > 1)
    .map(g => g.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0)))
    .sort((a, b) => b[0].date.localeCompare(a[0].date));
}
export function usualPayer(S, cardId) {
  const c = {};
  live(S, 'transactions').forEach(t => { if (t.type === 'transfer' && t.toAccountId === cardId) c[t.accountId] = (c[t.accountId] || 0) + 1; });
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}
export const isPayment = desc => PAY_WORDS.test(desc);
export const accountKind = (S, id) => get(S, 'groups', get(S, 'accounts', id)?.groupId)?.kind || 'asset';

// ---------- mortgage documents (lender statements, annual statements, amortization schedules) ----------
const FREQMAP = s => (/accel/i.test(s) ? 'accelBiweekly' : /bi-?weekly/i.test(s) ? 'biweekly' : /semi/i.test(s) ? 'semimonthly' : /weekly/i.test(s) ? 'weekly' : /monthly/i.test(s) ? 'monthly' : null);
export function parseMortgageDoc(input) {
  const text = (Array.isArray(input) ? input.map(l => (typeof l === 'string' ? l : l.text)).join('\n') : input).replace(/[ \t]+/g, ' ');
  const g = (re, f = x => x) => { const m = text.match(re); return m ? f(m[1]) : null; };
  const out = { number: g(/mortgage number:?\s*(\d{5,})/i), rate: g(/interest rate\s*([\d.]+)\s*%/i, parseFloat) };
  if (/amortization schedule/i.test(text)) {
    out.kind = 'schedule';
    out.asOf = g(/as of\s+([A-Z][a-z]+ \d{1,2}, \d{4})/i, looseDate);
    out.balance = g(/principal balance remaining\s*\$([\d,]+\.\d{2})/i, money);
    out.payment = g(/principal & interest payment\s*\$([\d,]+\.\d{2})/i, money);
    out.frequency = g(/principal & interest payment\s*\$[\d,]+\.\d{2}\s*([A-Za-z -]+)/i, FREQMAP);
    const rows = []; const re = /(?:^|\s)(\d{1,3})\s+(?:([A-Z][a-z]+ \d{1,2}, \d{4})\s+)?\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})/g; let m;
    while ((m = re.exec(text))) rows.push({ n: +m[1], inline: m[2] ? looseDate(m[2]) : null, interest: money(m[3]), principal: money(m[4]), balance: money(m[5]) });
    // First payment date, then step by the payment frequency (dates are split across lines in these PDFs).
    const first = text.match(/future payments[\s\S]*?([A-Z][a-z]+)\s+(\d{1,2}),?[\s\S]{0,80}?\b(20\d{2})\b/i);
    let d = first ? looseDate(`${first[1]} ${first[2]}, ${first[3]}`) : null;
    const seq = rows.filter((r, i) => r.n === i + 1);
    for (const r of seq) {
      if (r.inline) d = r.inline;
      delete r.inline;
      r.date = d;
      if (d) d = out.frequency === 'monthly' ? ymd(new Date(+d.slice(0, 4), +d.slice(5, 7), +d.slice(8, 10))) : addDays(d, out.frequency === 'weekly' ? 7 : 14);
    }
    out.schedule = seq;
    return out;
  }
  if (/annual mortgage statement/i.test(text)) {
    out.kind = 'annual';
    out.year = g(/(\d{4}) annual mortgage statement/i, Number);
    out.periodEnd = g(/statement period:.*?-\s*([A-Z][a-z]+ \d{1,2}, \d{4})/i, looseDate);
    out.closing = g(/closing principal balance\s*\$([\d,]+\.\d{2})/i, money);
    out.opening = g(/opening principal balance\s*\$([\d,]+\.\d{2})/i, money);
    out.advances = g(/advances\s*\$([\d,]+\.\d{2})/i, money);
    out.totalPaid = g(/total payments received\s*\$([\d,]+\.\d{2})/i, money);
    out.principalPaid = g(/\bprincipal\s+\$([\d,]+\.\d{2})/i, money);
    out.interestPaid = g(/\binterest\s+\$([\d,]+\.\d{2})/i, money);
    out.frequency = g(/payment frequency\s*([A-Za-z-]+)/i, FREQMAP);
    out.payment = g(/principal & interest\s*\$([\d,]+\.\d{2})/i, money);
    out.maturity = g(/maturity date\s*([A-Z][a-z]+ \d{1,2}, \d{4})/i, looseDate);
    return out;
  }
  if (/mortgage (information )?statement|mortgage balance/i.test(text)) {
    out.kind = 'info';
    out.asOf = g(/as of\s+([A-Z][a-z]+ \d{1,2}, \d{4})/i, looseDate);
    out.balance = g(/mortgage balance\s*\$([\d,]+\.\d{2})/i, money);
    out.payment = g(/principal & interest\s*\$([\d,]+\.\d{2})/i, money);
    out.frequency = g(/payment frequency\s*([A-Za-z -]+?)(?:\s{2,}|\n|$)/i, FREQMAP);
    out.rateType = g(/rate type\s*(fixed|variable)/i, s => s.toLowerCase());
    out.nextDue = g(/next payment due date\s*([A-Z][a-z]+ \d{1,2}, \d{4})/i, looseDate);
    out.finalPayment = g(/final scheduled payment\s*([A-Z][a-z]+ \d{1,2}, \d{4})/i, looseDate);
    const am = text.match(/remaining amortization\s*(\d+)\s*years?,?\s*(\d+)?\s*months?/i);
    if (am) out.amortYears = +am[1] + (+am[2] || 0) / 12;
    return out;
  }
  return null;
}
