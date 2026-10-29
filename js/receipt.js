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
  const rules = live(s, 'rules').filter(r => r.kind !== 'item');
  let rule = key && rules.find(r => r.key === key);
  if (!rule && key) { const w = key.split(' ')[0]; rule = rules.find(r => r.key.split(' ')[0] === w && w.length > 3); }
  let accountId = rule?.accountId && get(s, 'accounts', rule.accountId) ? rule.accountId : null;
  if (last4) { const a = live(s, 'accounts').find(a => a.cardLast4 === last4 || String(a.numbers || '').split(/[,;\s]+/).some(x => x.replace(/\D/g, '').slice(-4) === last4)); if (a) accountId = a.id; }
  const categoryId = rule?.categoryId && get(s, 'categories', rule.categoryId) ? rule.categoryId : null;
  return { rule, accountId, categoryId };
}
// Transfers you confirm (e.g. "Card Load" EQ Bank → EQ Card) are remembered per account pair.
export function learnTransfer(s, merchant, accountId, transferAccountId) {
  const key = merchantKey(merchant); if (!key || !transferAccountId) return;
  const id = 'rule_' + key.replace(/ /g, '_');
  const old = s.rules.find(r => r.id === id && !r.deleted);
  put(s, 'rules', { id, key, merchant, accountId, transferAccountId, categoryId: old?.categoryId, hits: (old?.hits || 0) + 1 });
}
export function learn(s, merchant, accountId, categoryId) {
  const key = merchantKey(merchant); if (!key || !categoryId) return;
  const id = 'rule_' + key.replace(/ /g, '_'); // deterministic id → merges cleanly across devices
  const old = s.rules.find(r => r.id === id && !r.deleted);
  const same = old && old.accountId === accountId && old.categoryId === categoryId;
  put(s, 'rules', { id, key, merchant, accountId, categoryId, hits: same ? (old.hits || 1) + 1 : 1 });
}

// ---------- line items → split by category ----------
// Built-in hints for common receipt words (store abbreviations included). Your corrections are learned
// per word and win over these.
export const ITEM_HINTS = [
  ['clothing', /\b(shirt|tee|t-?shirt|jeans|pant|pants|short|shorts|sock|socks|dress|skirt|jacket|coat|hoodie|sweater|legging|bra|underwear|brief|boxer|pajama|pyjama|shoe|shoes|boot|boots|sandal|slipper|hat|cap|glove|mitt|scarf|apparel|girls|boys|mens|womens|ladies|kids? ?wear|george|athletic works|no boundaries)(?:e?s)?\b/i],
  ['school', /\b(notebook|note ?book|binder|pencil|pen|pens|crayon|marker|highlighter|eraser|glue|scissor|ruler|folder|paper pad|loose leaf|backpack|lunch ?box|stationery|sharpener|index card|sticky note|post-?it)(?:e?s)?\b/i],
  ['household', /\b(detergent|bleach|cleaner|lysol|clorox|dish ?soap|dawn|sponge|paper towel|bounty|toilet paper|bathroom tissue|charmin|cottonelle|napkin|garbage bag|trash bag|hefty|glad|foil|plastic wrap|ziploc|storage bag|light ?bulb|battery|batteries|duracell|energizer|laundry|tide|gain|downy|fabric|swiffer|mop|broom|candle|air freshener|container|organizer|hanger|vacuum|filter|kitchen|utensil|mug|plate|bowl|cup|towel|sheet|pillow)(?:e?s)?\b/i],
  ['personal', /\b(shampoo|conditioner|body ?wash|soap bar|toothpaste|toothbrush|floss|mouthwash|deodorant|razor|shave|lotion|sunscreen|cosmetic|makeup|lipstick|nail|hair|tampon|pad|diaper|wipes|cotton|q-?tip|colgate|crest|dove|gillette|nivea|vaseline)(?:e?s)?\b/i],
  ['health', /\b(vitamin|tylenol|advil|motrin|aspirin|allergy|reactine|claritin|cough|cold|medicine|pharmacy|rx|bandage|band-?aid|thermometer|supplement|probiotic|omega)(?:e?s)?\b/i],
  ['kids', /\b(toy|toys|lego|barbie|hot wheels|puzzle|game|doll|plush|crayola|play-?doh|nerf|stroller|baby|infant|toddler)(?:e?s)?\b/i],
  ['electronics', /\b(charger|cable|usb|hdmi|headphone|earbud|earphone|phone case|screen protector|adapter|electronic|speaker|mouse|keyboard|memory card|sd card|flash drive|ink|toner|printer)(?:e?s)?\b/i],
  ['pets', /\b(dog|cat|puppy|kitten|pet|litter|kibble|purina|pedigree|whiskas|iams)(?:e?s)?\b/i],
  ['auto', /\b(motor oil|windshield|washer fluid|antifreeze|wiper|car wash|tire|auto)(?:e?s)?\b/i],
  ['garden', /\b(soil|mulch|seed|seeds|fertilizer|planter|plant|garden|hose|lawn|rake|shovel)(?:e?s)?\b/i],
  ['gift', /\b(gift card|gift bag|wrapping|card greeting|greeting card|balloon|party)(?:e?s)?\b/i],
  ['groceries', /\b(milk|bread|egg|eggs|cheese|yogurt|yoghurt|butter|banana|apple|orange|grape|berry|berries|tomato|potato|onion|lettuce|carrot|cucumber|pepper|avocado|lemon|lime|chicken|beef|pork|fish|salmon|shrimp|rice|pasta|flour|sugar|salt|oil|cereal|oat|oats|juice|water|pop|soda|coffee|tea|chips|cookie|cracker|snack|chocolate|candy|frozen|pizza|soup|sauce|ketchup|spice|masala|dal|atta|paneer|ghee|naan|roti|tofu|nut|nuts|peanut|almond|honey|jam|meat|deli|produce|grocery|gv |great value|pc |no name|kraft|lays|doritos|kellogg|nestle|danone|natrel|dairyland|beatrice|compliments)(?:e?s)?\b/i],
];
// Maps a hint group to one of your categories by name (first that exists).
export const HINT_CATEGORIES = {
  groceries: ['groceries', 'grocery', 'food'], clothing: ['clothing', 'apparel', 'clothes'], school: ['school supplies', 'books & supplies', 'stationery', 'education'],
  household: ['household supplies', 'household', 'home'], personal: ['personal care', 'toiletries', 'beauty'], health: ['pharmacy', 'health', 'medical'],
  kids: ['toys', 'kids', 'children'], electronics: ['electronics', 'tech', 'gadgets'], pets: ['pets', 'pet'], auto: ['car maintenance', 'maintenance & tires', 'car', 'transport'],
  garden: ['garden', 'home'], gift: ['gifts', 'gift'],
};
const NOT_ITEM = /sub-?\s*total|\btotal\b|\btax\b|\bhst\b|\bgst\b|\bpst\b|\bqst\b|change|cash|visa|master|debit|credit|amex|tend|payment|balance|saving|you saved|discount|coupon|points|rewards|approved|auth|ref\b|tran|account|card ?#|items? sold|thank/i;
export function parseItems(text) {
  const items = []; let tax = 0, subtotal = null, total = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\s+/g, ' ').trim(); if (!l) continue;
    const m = l.match(/^(.*?[A-Za-z].*?)\s+(-?\$?\d{1,4}[.,]\d{2})\s*(-|[A-Z]{1,3})?$/);   // "GV MILK 2L 5.49 J" / "SOCKS 6PK 9.97"
    if (!m) continue;
    const amt = parseFloat(m[2].replace(/[$\s]/g, '').replace(',', '.')) * (m[3] === '-' || /^-/.test(m[2]) ? -1 : 1);
    const desc = m[1].replace(/^\d{6,}\s*/, '').replace(/\s\d{6,}\b/g, '').trim();
    if (/\b(hst|gst|pst|qst|tax)\b/i.test(desc) && !/before tax/i.test(desc)) { if (Math.abs(amt) < 1000) tax += amt; continue; }
    if (/sub-?\s*total/i.test(desc)) { subtotal = amt; continue; }
    if (/\btotal\b/i.test(desc)) { total = Math.max(total ?? 0, amt); continue; }
    if (NOT_ITEM.test(desc) || desc.length < 2) continue;
    items.push({ desc, amount: Math.round(amt * 100) / 100 });
  }
  return { items, tax: Math.round(tax * 100) / 100, subtotal, total };
}
const words = d => (d || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
export function classifyItem(s, desc) {
  // 1) what you taught it
  const learned = live(s, 'rules').filter(r => r.kind === 'item');
  for (const w of words(desc)) {
    const r = learned.find(r => r.key === w), c = r && get(s, 'categories', r.categoryId);
    if (c) { const p = c.parentId && get(s, 'categories', c.parentId); return { categoryId: c.id, how: 'learned', group: /grocer/i.test(`${c.name} ${p?.name || ''}`) ? 'groceries' : 'learned' }; }
  }
  // 2) built-in hints mapped onto your categories
  const cats = live(s, 'categories').filter(c => c.type === 'expense');
  for (const [group, re] of ITEM_HINTS) if (re.test(' ' + desc + ' ')) {
    for (const name of HINT_CATEGORIES[group] || [group]) {
      const c = cats.find(c => c.name.toLowerCase() === name) || cats.find(c => c.name.toLowerCase().includes(name));
      if (c) return { categoryId: c.id, how: 'hint', group };
    }
    return { categoryId: null, how: 'hint', group };
  }
  return { categoryId: null, how: 'none' };
}
// Remember your correction for the distinctive words of an item line.
export function learnItem(s, desc, categoryId) {
  for (const w of words(desc).filter(w => !/^(pk|pack|ea|each|lb|kg|ml|oz|size|item)$/.test(w)).slice(0, 2)) {
    const id = 'item_' + w;
    put(s, 'rules', { id, kind: 'item', key: w, categoryId, merchant: desc });
  }
}
// Group item lines into category splits that add up exactly to the bill total. The tax/rounding difference
// goes to taxable items only (basic groceries are zero-rated for HST in Canada), or across everything if unsure.
export function buildSplits(lines, total) {
  const ok = lines.filter(l => l.categoryId);
  const sum = ok.reduce((a, l) => a + l.amount, 0); if (!ok.length || sum <= 0) return [];
  const extra = total - sum;
  const taxable = ok.filter(l => l.group !== 'groceries'), tsum = taxable.reduce((a, l) => a + l.amount, 0);
  const share = l => (extra > 0 && tsum > 0 ? (l.group !== 'groceries' ? l.amount / tsum : 0) : l.amount / sum);
  const by = {};
  for (const l of ok) by[l.categoryId] = (by[l.categoryId] || 0) + l.amount + extra * share(l);
  const ids = Object.keys(by).sort((a, b) => by[b] - by[a]); let acc = 0;
  const out = ids.map((id, i) => { const v = i === ids.length - 1 ? Math.round((total - acc) * 100) / 100 : Math.round(by[id] * 100) / 100; acc += v; return { categoryId: id, amount: v }; });
  return out.filter(x => x.amount !== 0).sort((a, b) => b.amount - a.amount);
}
