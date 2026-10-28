// Receipt scanning: on-device OCR (Tesseract.js), parsing, and learned merchant rules.
// "Training" = every saved expense teaches merchant → account + category.
import { live, put, get, todayStr } from './model.js';

let tessP;
function loadTesseract() {
  tessP = tessP || new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    sc.onload = res; sc.onerror = () => rej(new Error('Could not load OCR engine (needs internet the first time)'));
    document.head.appendChild(sc);
  });
  return tessP;
}
// Downscale + grayscale: much faster and usually more accurate on phone photos.
async function prep(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(img.width, img.height));
  const c = document.createElement('canvas');
  c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  const g = c.getContext('2d'); g.filter = 'grayscale(1) contrast(1.4)';
  g.drawImage(img, 0, 0, c.width, c.height);
  return c;
}
export async function ocr(file, onProgress = () => {}) {
  await loadTesseract();
  const canvas = await prep(file);
  const { data } = await Tesseract.recognize(canvas, 'eng', {
    logger: m => { if (m.status === 'recognizing text') onProgress(m.progress); }
  });
  return data.text;
}

const AMT = /(\d{1,3}(?:[ ,]\d{3})*[.,]\d{2})(?!\d)/g;
const toNum = s => { s = s.replace(/\s/g, ''); if (/,\d{2}$/.test(s) && !s.includes('.')) s = s.replace(/,(\d{2})$/, '.$1'); return parseFloat(s.replace(/,/g, '')); };
const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const z = n => String(n).padStart(2, '0');
function validDate(y, m, d) {
  if (y < 100) y += 2000;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const s = `${y}-${z(m)}-${z(d)}`;
  const t = todayStr(); const yearAgo = `${+t.slice(0, 4) - 1}${t.slice(4)}`;
  return s <= t && s >= yearAgo ? s : null;
}
function findDate(text) {
  let m;
  if ((m = text.match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/))) { const v = validDate(+m[1], +m[2], +m[3]); if (v) return v; }
  if ((m = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})/i))) {
    const v = validDate(+m[3], MON[m[1].toLowerCase()], +m[2]); if (v) return v;
  }
  if ((m = text.match(/\b(\d{1,2})[-/.](\d{1,2})[-/.](20\d{2}|\d{2})\b/))) {
    const a = +m[1], b = +m[2], y = +m[3];
    return validDate(y, a, b) || validDate(y, b, a); // try MM/DD then DD/MM
  }
  return null;
}
export function parseReceipt(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  let merchant = '';
  for (const l of lines.slice(0, 6)) {
    const letters = (l.match(/[A-Za-z]/g) || []).length;
    if (letters >= 3 && !/receipt|welcome|thank|store\s*#|tel|phone|www|http|@/i.test(l)) {
      merchant = l.replace(/[^A-Za-z0-9&' .-]/g, '').replace(/\s+/g, ' ').trim(); break;
    }
  }
  let total = null;
  for (const l of lines) {
    if (!/total|amount\s*due|balance\s*due|grand|montant/i.test(l) || /sub\s*-?\s*total|saving|discount|items?/i.test(l)) continue;
    const nums = [...l.matchAll(AMT)].map(x => toNum(x[1])).filter(n => !isNaN(n));
    if (nums.length) { const v = nums[nums.length - 1]; if (total === null || v > total) total = v; }
  }
  if (total === null) {
    const all = [...text.matchAll(AMT)].map(x => toNum(x[1])).filter(n => !isNaN(n) && n < 100000);
    if (all.length) total = Math.max(...all);
  }
  const card = text.match(/(?:\*{2,}|x{2,}|#{2,})\s*(\d{4})\b/i);
  return { merchant, total, date: findDate(text), last4: card ? card[1] : null };
}

const STOP = new Set(['the', 'inc', 'ltd', 'store', 'co', 'corp', 'canada', 'and', 'of']);
export function merchantKey(name) {
  return (name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(w => w && !STOP.has(w) && !/^\d+$/.test(w)).slice(0, 2).join(' ');
}
export function suggest(s, merchant, last4) {
  const key = merchantKey(merchant);
  const rules = live(s, 'rules');
  let rule = key && rules.find(r => r.key === key);
  if (!rule && key) { const w = key.split(' ')[0]; rule = rules.find(r => r.key.split(' ')[0] === w && w.length > 3); }
  let accountId = rule?.accountId && get(s, 'accounts', rule.accountId) ? rule.accountId : null;
  if (last4) { const a = live(s, 'accounts').find(a => a.cardLast4 === last4); if (a) accountId = a.id; }
  const categoryId = rule?.categoryId && get(s, 'categories', rule.categoryId) ? rule.categoryId : null;
  return { rule, accountId, categoryId };
}
export function learn(s, merchant, accountId, categoryId) {
  const key = merchantKey(merchant); if (!key || !categoryId) return;
  const id = 'rule_' + key.replace(/ /g, '_'); // deterministic id → merges cleanly across devices
  const old = s.rules.find(r => r.id === id && !r.deleted);
  const same = old && old.accountId === accountId && old.categoryId === categoryId;
  put(s, 'rules', { id, key, merchant, accountId, categoryId, hits: same ? (old.hits || 1) + 1 : 1 });
}
