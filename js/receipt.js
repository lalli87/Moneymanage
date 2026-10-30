import { grocerySection, sectionCategory } from './grocery.js';
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
  // Read as one block of lines (page-segmentation mode 6) — keeps item names and prices on the same line.
  const w = await Tesseract.createWorker('eng', 1, { logger: m => { if (m.status === 'recognizing text') onProgress(m.progress); } });
  try { await w.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' }); const { data } = await w.recognize(canvas); return data.text; }
  finally { w.terminate(); }
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
  ['household', /\b(detergent|bleach|cleaner|lysol|clorox|dish ?soap|dawn|sponge|paper towel|bounty|toilet paper|bathroom tissue|bath tissue|facial tissue|tissue|kleenex|royale|scotties|charmin|cottonelle|napkin|garbage bag|trash bag|hefty|glad|foil|plastic wrap|ziploc|storage bag|light ?bulb|battery|batteries|duracell|energizer|laundry|tide|gain|downy|fabric|swiffer|mop|broom|candle|air freshener|container|organizer|hanger|vacuum|filter|kitchen|utensil|mug|plate|bowl|cup|towel|sheet|pillow)(?:e?s)?\b|towel/i],
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
// Receipt line → { desc, price, minus } — tolerant of OCR noise after the price ("7.09.", "4.00- H", "27.99 He",
// "13.99 ..") and of misread decimal points ("6:00", "12 .99", "899" with the dot lost).
function splitPrice(l) {
  const m = l.match(/^(.*?)\s*(-?\$?)(\d{1,4})\s?[.,:;]\s?(\d{2})\s*(-?)\s*([^\d]{0,5})$/);
  if (m && !/[A-Za-z]{3}/.test(m[6].replace(/^(he?|[a-z])\b/i, ''))) return { desc: m[1], price: +(m[3] + '.' + m[4]), minus: !!(m[5] || /-/.test(m[2])) };
  const n = l.match(/^(.*[A-Za-z].*?)\s+(\d{3,4})\s*([^\w]{0,3}|[A-Z]{1,2})$/);    // dot lost: "CAESAR 899"
  if (n && /\d{3,}\s+\S*[A-Za-z]/.test(n[1])) return { desc: n[1], price: +n[2] / 100, minus: false, guessed: true };
  return null;
}
const round2 = v => Math.round(v * 100) / 100;
export function parseItems(text) {
  const items = []; let tax = 0, subtotal = null, total = null, pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.replace(/\s+/g, ' ').trim(); if (!l) continue;
    if (/^\W*\d+\s*@/.test(l)) continue;                                   // "3 @ 6.09" quantity line
    let p = splitPrice(l);
    const lastIt = items[items.length - 1];
    if (p && !/[A-Za-z0-9]/.test(p.desc) && lastIt?.noPrice && !p.minus) { lastIt.amount = p.price; delete lastIt.noPrice; continue; }   // price on the next line
    if (p && !/[A-Za-z0-9]/.test(p.desc) && pending) p.desc = pending;
    if (!p) {
      pending = /[A-Za-z]{3}/.test(l) && !NOT_ITEM.test(l) && !/\*{3}/.test(l) ? l : null;
      // "88426 CUCUMBERS . Bag" — an item whose price couldn't be read: keep it with no price so you only type the price
      const im = pending && l.match(/^\W{0,3}(\d{4,7})\s+(.*[A-Za-z]{3}.*)$/);
      if (im) { items.push({ desc: im[2].replace(/[|]/g, '').replace(/[^A-Za-z0-9%)]+\S{0,4}$/, '').trim(), amount: 0, code: im[1], noPrice: true }); pending = null; }
      continue;
    }
    pending = null;
    const amt = p.price * (p.minus ? -1 : 1), desc = p.desc.trim();
    const letters = desc.replace(/[^a-z]/gi, '');
    if (((/(h|g|p|q)st\b|\btax\b|\b(5|13|15|9\.975|14\.975)\s?%/i.test(desc)) || /^[t1il]?ax$/i.test(letters)) && !/before tax/i.test(desc)) { if (Math.abs(amt) < 1000) tax += amt; continue; }
    if (/\b(amount|amt|purchase|approved|change due)\b\s*:?/i.test(desc) && letters.length <= 12) { total = Math.max(total ?? 0, amt); continue; }
    if (/sub-?\s*total/i.test(desc)) { subtotal = amt; continue; }
    if (/\btotal\b/i.test(desc)) { total = Math.max(total ?? 0, amt); continue; }
    // Discounts come right after their item. Costco prints "0000394073 / 318527 4.00-" (coupon / item number);
    // others say TPD, instant savings, coupon… Take them off the item they belong to.
    const code = desc.match(/\/\s*[^\d]{0,3}(\d{4,7})/);
    const isDisc = amt < 0 || /^\W*0{3,}\d*\s*\//.test(desc) || (/^\W*\d{6,}\s*\//.test(desc) && !/[A-Za-z]{3}/.test(desc)) ||
      /\b(tpd|inst(ant)?\s*sav\w*|savings?|discount|disc|coupon|cpn|promo|rebate|mfr)\b/i.test(desc);
    if (isDisc) {
      const off = Math.abs(amt);
      const target = (code && items.find(i => i.code === code[1] && i.amount > off)) || [...items].reverse().find(i => i.amount > off);
      if (target) { target.amount = round2(target.amount - off); target.discount = round2((target.discount || 0) + off); }
      continue;
    }
    if (NOT_ITEM.test(desc) || letters.length < 2) continue;
    const ic = desc.match(/(\d{3,7})\s+(?=\S*[A-Za-z])/);
    const name = desc.replace(/[|]/g, ' ').replace(/\s+/g, ' ').replace(/^.{0,12}?\d{3,7}\s+(?=\S*[A-Za-z])/, '').replace(/^[^A-Za-z0-9]+/, '').replace(/[^A-Za-z0-9%)]+$/, '').trim() || desc;
    items.push({ desc: name, amount: round2(amt), ...(ic ? { code: ic[1] } : {}), ...(p.guessed ? { guessed: true } : {}) });
  }
  // A misread SUBTOTAL line looks like one big item at the end: drop it.
  const last = items[items.length - 1];
  if (last && items.length > 3) {
    const rest = round2(items.slice(0, -1).reduce((a, i) => a + i.amount, 0));
    if ((subtotal != null && Math.abs(last.amount - subtotal) < 0.01) || Math.abs(last.amount - rest) <= Math.max(0.05, rest * 0.25) && last.amount > 40 && !last.code) { items.pop(); subtotal = subtotal ?? last.amount; }
  }
  tax = round2(tax);
  const np = items.filter(i => i.noPrice);
  if (np.length === 1 && subtotal != null) { const gap = round2(subtotal - items.reduce((a, i) => a + i.amount, 0)); if (gap > 0) np[0].amount = gap; }
  // The TOTAL is often printed white-on-black and unreadable: use subtotal + tax.
  if (subtotal != null && (total == null || total < subtotal - 0.005 || (tax && Math.abs(total - subtotal) < 0.005))) total = round2(subtotal + tax);
  return { items, tax, subtotal, total };
}
const words = d => (d || '').toLowerCase().replace(/[^a-z ]/g, ' ').split(/\s+/).filter(w => w.length > 2);
export function classifyItem(s, desc) {
  // 1) what you taught it
  const learned = live(s, 'rules').filter(r => r.kind === 'item');
  for (const w of words(desc)) {
    const r = learned.find(r => r.key === w), c = r && get(s, 'categories', r.categoryId);
    if (c) { const p = c.parentId && get(s, 'categories', c.parentId); return { categoryId: c.id, how: 'learned', group: /grocer/i.test(`${c.name} ${p?.name || ''}`) ? 'groceries' : 'learned' }; }
  }
  // 2) built-in hints mapped onto your categories (non-food first, then the grocery dictionary)
  const cats = live(s, 'categories').filter(c => c.type === 'expense');
  for (const [group, re] of ITEM_HINTS) if (group !== 'groceries' && re.test(' ' + desc + ' ')) {
    for (const name of HINT_CATEGORIES[group] || [group]) {
      const c = cats.find(c => c.name.toLowerCase() === name) || cats.find(c => c.name.toLowerCase().includes(name));
      if (c) return { categoryId: c.id, how: 'hint', group };
    }
    return { categoryId: null, how: 'hint', group };
  }
  const g = grocerySection(desc) || (ITEM_HINTS.find(([gr]) => gr === 'groceries')[1].test(' ' + desc + ' ') ? { section: null, how: 'hint' } : null);
  if (g) return { categoryId: sectionCategory(cats, g.section), how: g.how, group: 'groceries' };
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
