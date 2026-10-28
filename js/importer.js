// Statement / CSV / screenshot import: reads files on the device, turns them into rows,
// and matches rows against existing transactions to catch duplicates.
// Nothing here sends data anywhere.
import { live, get, parseYmd, round2, todayStr } from './model.js';
import { merchantKey } from './receipt.js';

// ---------- file readers ----------
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
// Rebuild visual lines from positioned text pieces (same y = same line, sorted by x).
function itemsToLines(items) {
  const rows = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    const x = it.transform[4], y = it.transform[5], h = Math.abs(it.transform[3]) || 8;
    let row = rows.find(r => Math.abs(r.y - y) <= Math.max(2, h * 0.35));
    if (!row) rows.push(row = { y, parts: [] });
    row.parts.push({ x, w: it.width || 0, s: it.str });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map(r => {
    r.parts.sort((a, b) => a.x - b.x);
    let out = '', end = null;
    for (const p of r.parts) {
      if (end !== null) out += p.x - end > 1.5 ? '  ' : (/\s$/.test(out) || /^\s/.test(p.s) ? '' : ' ');
      out += p.s; end = p.x + p.w;
    }
    return out.replace(/\s{3,}/g, '  ').trim();
  });
}
export async function readPdf(file, onProgress = () => {}, ocrCanvas) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  let lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    lines.push(...itemsToLines((await page.getTextContent()).items));
    onProgress(p / doc.numPages * 0.5);
  }
  if (lines.join('').replace(/\s/g, '').length < 40 && ocrCanvas) {
    // Scanned / image-only PDF: render each page and read it with OCR.
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

// ---------- shared parsing helpers ----------
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const z = n => String(n).padStart(2, '0');
const MONRE = '(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)[a-z]*\\.?';
// Date token at the start of a string. Returns {m, d, y?, len}.
function leadDate(s) {
  let m;
  if ((m = s.match(new RegExp(`^${MONRE}\\s*(\\d{1,2})(?:,?\\s+(20\\d{2}))?\\b`, 'i'))))
    return { m: MON[m[1].toLowerCase()], d: +m[2], y: m[3] ? +m[3] : null, len: m[0].length };
  if ((m = s.match(new RegExp(`^(\\d{1,2})\\s*${MONRE}(?:,?\\s+(20\\d{2}))?\\b`, 'i'))))
    return { m: MON[m[2].toLowerCase()], d: +m[1], y: m[3] ? +m[3] : null, len: m[0].length };
  if ((m = s.match(/^(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/))) return { y: +m[1], m: +m[2], d: +m[3], len: m[0].length };
  if ((m = s.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](20\d{2}|\d{2}))?\b/))) {
    let a = +m[1], b = +m[2]; const y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null;
    if (a > 12 && b <= 12) [a, b] = [b, a]; // clearly DD/MM
    return { m: a, d: b, y, len: m[0].length };
  }
  if ((m = s.match(/^(today|yesterday)\b/i))) {
    const t = parseYmd(todayStr()); if (/yest/i.test(m[1])) t.setDate(t.getDate() - 1);
    return { y: t.getFullYear(), m: t.getMonth() + 1, d: t.getDate(), len: m[0].length };
  }
  return null;
}
export function parseDate(s) { const r = leadDate(String(s || '').trim()); return r && r.m >= 1 && r.m <= 12 && r.d >= 1 && r.d <= 31 ? r : null; }
const AMT = /(\(?[-+]?\s?\$?\s?\d{1,3}(?:[ ,]\d{3})*(?:\.\d{2})\)?(?:\s?(?:CR|DR|-))?)(?=\s|$)/gi;
function toAmount(tok) {
  let t = tok.trim(); let neg = false;
  if (/^\(.*\)$/.test(t)) { neg = true; t = t.slice(1, -1); }
  if (/\bCR$/i.test(t)) { neg = true; t = t.replace(/\s?CR$/i, ''); }
  t = t.replace(/\s?DR$/i, '');
  if (/-$/.test(t)) { neg = true; t = t.slice(0, -1); }
  if (/^-/.test(t.replace(/[\s$]/g, ''))) neg = true;
  const plus = /^\+/.test(t.replace(/[\s$]/g, ''));
  const v = parseFloat(t.replace(/[^\d.]/g, ''));
  return isNaN(v) ? null : { v, neg, plus };
}
const CREDIT_WORDS = /payment|paiement|thank you|refund|return|credit|deposit|reversal|cashback|cash back|rebate|e-?transfer from|payroll|salary/i;
const PAY_WORDS = /payment|paiement|thank you|pymt|pmt\b/i;
const SKIP_WORDS = /(previous|opening|closing|new|ending|beginning|statement)\s+balance|balance\s+(forward|from|brought)|total|minimum payment|credit limit|available credit|interest rate|annual interest|payment due|due date|page \d|subtotal|^balance\b/i;

function finishDates(rows, text) {
  // Pick the statement year: the most common 4-digit year in the document, else this year.
  const years = {}; (text.match(/\b20\d{2}\b/g) || []).forEach(y => (years[y] = (years[y] || 0) + 1));
  const ref = +(Object.entries(years).sort((a, b) => b[1] - a[1])[0]?.[0] || todayStr().slice(0, 4));
  const months = new Set(rows.map(r => r._d.m));
  const wraps = [...months].some(m => m >= 11) && [...months].some(m => m <= 2);
  const t = todayStr();
  for (const r of rows) {
    let y = r._d.y || (wraps && r._d.m >= 11 ? ref - 1 : ref);
    let s = `${y}-${z(r._d.m)}-${z(r._d.d)}`;
    if (!r._d.y && s > t) { y -= 1; s = `${y}-${z(r._d.m)}-${z(r._d.d)}`; }
    r.date = s; delete r._d;
  }
  return rows;
}

// ---------- PDF / screenshot text → rows ----------
// Each row: { date, desc, amount (positive), dir: 'out' | 'in', src }
// negIsOut: banking-app screenshots show spending as -$12.34 (card statements use - / CR for credits).
export function parseStatementText(lines, src = '', { negIsOut = false } = {}) {
  const rows = []; let curDate = null, pendingDesc = '', prevBal = null;
  for (let raw of lines) {
    const line = raw.replace(/[|•·]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!line) continue;
    let rest = line, d1 = parseDate(rest);
    if (d1) {
      rest = rest.slice(d1.len).trim();
      const d2 = parseDate(rest); if (d2) rest = rest.slice(d2.len).trim(); // posting date column
    }
    const amts = [...rest.matchAll(AMT)].map(m => ({ tok: m[1], idx: m.index }));
    if (!amts.length) {
      if (d1 && !rest) { curDate = d1; pendingDesc = ''; continue; }        // date header (screenshots)
      if (d1) { curDate = d1; pendingDesc = rest; continue; }
      if (curDate && rest.length > 2 && rest.length < 60 && /[a-z]{2}/i.test(rest)) pendingDesc = rest;
      continue;
    }
    let desc = rest.slice(0, amts[0].idx).trim().replace(/[\s$-]+$/, '');
    if (!desc && pendingDesc) desc = pendingDesc;
    const date = d1 || (curDate && desc ? curDate : null);
    if (!date || !desc || SKIP_WORDS.test(desc) || !/[a-z]/i.test(desc)) {
      const b = toAmount(amts[amts.length - 1].tok); if (b && SKIP_WORDS.test(desc)) prevBal = b.neg ? -b.v : b.v;
      continue;
    }
    const a = toAmount(amts[0].tok); if (!a || a.v === 0) continue;
    let dir = a.plus ? 'in' : a.neg ? (negIsOut ? 'out' : 'in') : 'out';
    let how = a.plus || a.neg ? 'sign' : 'default';
    if (amts.length >= 2) {
      // Bank style: amount … running balance. Use the balance change to tell money in from out.
      const b = toAmount(amts[amts.length - 1].tok); const bal = b ? (b.neg ? -b.v : b.v) : null;
      if (bal !== null && prevBal !== null) {
        if (Math.abs(round2(prevBal - a.v) - bal) < 0.011) { dir = 'out'; how = 'balance'; }
        else if (Math.abs(round2(prevBal + a.v) - bal) < 0.011) { dir = 'in'; how = 'balance'; }
      }
      if (bal !== null) prevBal = bal;
    }
    if (how === 'default' && CREDIT_WORDS.test(desc)) dir = 'in';
    rows.push({ _d: date, desc: desc.replace(/\s{2,}/g, ' '), amount: round2(a.v), dir, src });
    pendingDesc = '';
  }
  return finishDates(rows, lines.join('\n'));
}

// Card number printed on a statement / screenshot → last 4 digits.
export function findLast4(text) {
  const pats = [/(?:\*{2,}|x{2,}|•{2,}|#{2,})[\s*x•#-]*(\d{4})\b/i, /\b\d{4}[\s-]+(?:\d{2}|x{2}|\*{2})[\dx*]{0,2}[\s-]+[\dx*]{4}[\s-]+(\d{4})\b/i,
    /(?:card|account|acct)\s*(?:number|no\.?|#|ending(?:\s+in)?)?\s*[:\-]?\s*[\dx*•\s-]*?(\d{4})\b/i];
  for (const p of pats) { const m = text.match(p); if (m) return m[1]; }
  return null;
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
const num = s => { const a = toAmount(String(s || '').replace(/^\$/, '')); return a ? (a.neg ? -a.v : a.v) : null; };
// accountKind: 'card' → positive single amounts are charges; otherwise negative = money out.
export function parseCsvRows(table, accountKind = 'asset', src = '') {
  if (!table.length) return { rows: [] };
  const H = table[0].map(h => h.toLowerCase());
  const has = re => H.findIndex(h => re.test(h));
  let header = H.some(h => /date/.test(h)) && H.some(h => /amount|debit|credit|withdraw|deposit|description|merchant|payee/.test(h));
  let iDate, iDesc, iAmt, iDeb, iCred, body;
  if (header) {
    iDate = has(/transaction date|^date$|date/); iDesc = has(/description|merchant|payee|details|name|memo/);
    iAmt = has(/^amount|amount$|cad\$|^amt/); iDeb = has(/debit|withdraw|charge|money out/); iCred = has(/credit|deposit|payment|money in/);
    if (iAmt >= 0) { iDeb = -1; iCred = -1; }
    body = table.slice(1);
  } else {
    // No header: detect columns from the data.
    body = table; const n = Math.max(...table.map(r => r.length));
    const score = (fn) => [...Array(n).keys()].map(c => table.filter(r => fn(r[c])).length);
    const ds = score(v => parseDate(v)), ns = score(v => v && num(v) !== null && /\d\.\d{2}/.test(v)), ts = score(v => v && /[a-z]{3}/i.test(v) && !parseDate(v));
    iDate = ds.indexOf(Math.max(...ds));
    const numCols = ns.map((s, i) => [s, i]).filter(([s, i]) => s > 0 && i !== iDate);
    const full = numCols.filter(([s]) => s >= table.length * 0.8);
    if (full.length) iAmt = full[0][1];
    else if (numCols.length >= 2) { iDeb = numCols[0][1]; iCred = numCols[1][1]; }
    const lens = [...Array(n).keys()].map(c => ts[c] ? table.reduce((a, r) => a + (r[c] || '').length, 0) : -1);
    iDesc = lens.indexOf(Math.max(...lens));
  }
  const rows = [];
  for (const r of body) {
    const d = parseDate(r[iDate]); if (!d) continue;
    let v = null, dir;
    if (iAmt >= 0) { v = num(r[iAmt]); if (v === null || v === 0) continue; dir = accountKind === 'card' ? (v > 0 ? 'out' : 'in') : (v < 0 ? 'out' : 'in'); }
    else {
      const db = num(r[iDeb]), cr = num(r[iCred]);
      if (db) { v = db; dir = 'out'; } else if (cr) { v = cr; dir = 'in'; } else continue;
    }
    const desc = (r[iDesc] || '').replace(/\s+/g, ' ').trim() || '(no description)';
    rows.push({ _d: d, desc, amount: round2(Math.abs(v)), dir, src });
  }
  return { rows: finishDates(rows, table.flat().join(' ')) };
}

// ---------- duplicates ----------
const norm = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const dayDiff = (a, b) => Math.round(Math.abs(parseYmd(a) - parseYmd(b)) / 86400000);
function similar(a, b) {
  const ka = merchantKey(a), kb = merchantKey(b);
  if (ka && kb && (ka === kb || ka.split(' ')[0] === kb.split(' ')[0])) return true;
  const na = norm(a), nb = norm(b);
  return na.length >= 4 && nb.length >= 4 && (na.includes(nb.slice(0, 6)) || nb.includes(na.slice(0, 6)));
}
// Does this transaction touch the account in the same direction as the row?
function touches(t, accountId, dir) {
  if (t.type === 'transfer') return dir === 'out' ? t.accountId === accountId : t.toAccountId === accountId;
  if (t.accountId !== accountId) return false;
  return dir === 'out' ? (t.type === 'expense' || t.type === 'mortgage') : t.type === 'income';
}
/**
 * Mark duplicates on rows (mutates): row.dup = { reason, txnId? }.
 * 1) Against existing transactions in the same account: same amount and direction,
 *    within ±3 days (posting delays), preferring same date / similar description.
 *    Each existing transaction can only absorb one row, so two real identical charges survive.
 * 2) Within the batch: identical date + amount + description coming from different files
 *    (overlapping statements or screenshots).
 */
export function markDuplicates(S, rows, accountId) {
  const pool = live(S, 'transactions').filter(t => t.date <= todayStr());
  const used = new Set();
  for (const r of rows) {
    delete r.dup;
    let best = null, bestScore = -1;
    for (const t of pool) {
      if (used.has(t.id) || Math.abs(+t.amount - r.amount) > 0.005 || !touches(t, accountId, r.dir)) continue;
      const dd = dayDiff(t.date, r.date); if (dd > 3) continue;
      const sim = similar(t.note || t.desc || '', r.desc);
      const score = (dd === 0 ? 3 : 3 - dd) + (sim ? 3 : 0);
      if (dd > 1 && !sim) continue;
      if (score > bestScore) { best = t; bestScore = score; }
    }
    if (best) { used.add(best.id); r.dup = { reason: 'existing', txnId: best.id }; }
  }
  const seen = new Map();
  for (const r of rows) {
    if (r.dup) continue;
    const k = `${r.date}|${r.amount}|${r.dir}|${norm(r.desc)}`;
    const first = seen.get(k);
    if (first && first.src !== r.src) r.dup = { reason: 'batch' };
    else if (!first) seen.set(k, r);
  }
  return rows;
}

// Existing data clean-up: groups of transactions that look like the same entry recorded twice.
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

// Which account paid this card last time (for "PAYMENT - THANK YOU" rows).
export function usualPayer(S, cardId) {
  const c = {};
  live(S, 'transactions').forEach(t => { if (t.type === 'transfer' && t.toAccountId === cardId) c[t.accountId] = (c[t.accountId] || 0) + 1; });
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
}
export const isPayment = desc => PAY_WORDS.test(desc);
export const accountKind = (S, id) => get(S, 'groups', get(S, 'accounts', id)?.groupId)?.kind || 'asset';
