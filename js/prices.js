// Price book: what you paid per kg / L / each for grocery items, month by month, and how that compares with
// Statistics Canada (food CPI and average retail prices, refreshed weekly into data/statcan.json by a GitHub job).
import * as M from './model.js';

export const GROUPS = {
  fruit: { label: 'Fresh fruit', emoji: '🍎', cpi: 'Fresh fruit' },
  veg: { label: 'Fresh vegetables', emoji: '🥦', cpi: 'Fresh vegetables' },
  meat: { label: 'Meat', emoji: '🥩', cpi: 'Meat' },
  fish: { label: 'Fish & seafood', emoji: '🐟', cpi: 'Fish, seafood and other marine products' },
  dairy: { label: 'Dairy & eggs', emoji: '🥛', cpi: 'Dairy products and eggs' },
  bakery: { label: 'Bakery & cereal', emoji: '🍞', cpi: /^Bakery and cereal products/ },
  pantry: { label: 'Pantry & other food', emoji: '🥫', cpi: 'Other food products and non-alcoholic beverages' },
  drinks: { label: 'Drinks', emoji: '🧃', cpi: 'Non-alcoholic beverages' },
  frozen: { label: 'Frozen', emoji: '🧊', cpi: 'Food purchased from stores' },
};
export const ALL_FOOD_CPI = 'Food purchased from stores';
const UNIT_TO_BASE = { kg: ['kg', 1], g: ['kg', 0.001], lb: ['kg', 0.45359237], oz: ['kg', 0.028349523], L: ['L', 1], l: ['L', 1], ml: ['L', 0.001], mL: ['L', 0.001], each: ['each', 1], dozen: ['each', 12] };
export const UNIT_LABEL = { kg: '/kg', L: '/L', each: ' each' };
export const perLb = v => v * 0.45359237;

// Turn what the AI (or you) said about an item into a base quantity: kg, L or each.
export function normalize(qty, unit) {
  const [base, f] = UNIT_TO_BASE[unit] || UNIT_TO_BASE[String(unit || '').toLowerCase()] || ['each', 1];
  const q = +qty > 0 ? +qty * f : (base === 'each' ? 1 : 0);
  return q > 0 ? { qty: Math.round(q * 10000) / 10000, unit: base } : null;
}
export const keyOf = name => String(name || '').toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();

// ---------- the price records (synced collection "prices") ----------
// One record per grocery line on a receipt; ids follow the transaction so re-saving it updates them.
// Records stay when the expense is deleted, so the history is kept.
export function syncFromTxn(S, t) {
  if (!t || t.type !== 'expense') return 0;
  const want = new Map();
  (t.items || []).forEach((it, i) => {
    const pb = it.pb; if (!pb?.name || !(+it.amount > 0)) return;
    const n = normalize(pb.qty, pb.unit); if (!n) return;
    const paid = M.round2(+it.amount);
    want.set(`pb_${t.id}_${i}`, { txnId: t.id, date: t.date, store: t.note || '', name: pb.name, key: keyOf(pb.name), group: pb.group || 'pantry',
      qty: n.qty, unit: n.unit, paid, unitPrice: Math.round(paid / n.qty * 1000) / 1000, ...(pb.statcan ? { statcan: pb.statcan } : {}) });
  });
  let n = 0;
  for (const p of M.live(S, 'prices')) if (p.txnId === t.id && !want.has(p.id)) { M.remove(S, 'prices', p.id); n++; }
  for (const [id, rec] of want) {
    const old = M.get(S, 'prices', id);
    if (old && ['date', 'store', 'name', 'group', 'qty', 'unit', 'paid', 'statcan'].every(k => old[k] === rec[k])) continue;
    M.put(S, 'prices', { ...(old || {}), id, ...rec, ...(old?.renamed ? { name: old.name, key: old.key } : {}) }); n++;
  }
  return n;
}
// Rename / merge: every record of one item takes the other name (so "Bananas" and "Banana, organic" can be one line, or not).
export function renameItem(S, fromKey, toName) {
  for (const p of M.live(S, 'prices')) if (p.key === fromKey) M.put(S, 'prices', { ...p, name: toName, key: keyOf(toName), renamed: true });
}

// ---------- reading the history ----------
export const ym = d => d.slice(0, 7);
export function items(S) {
  const by = {};
  for (const p of M.live(S, 'prices')) {
    const k = `${p.key}|${p.unit}`, e = (by[k] = by[k] || { key: p.key, unit: p.unit, name: p.name, group: p.group, statcan: null, rows: [] });
    e.rows.push(p); if (p.statcan) e.statcan = p.statcan; if (p.date >= (e.last?.date || '')) { e.last = p; e.name = p.name; e.group = p.group; }
  }
  return Object.values(by).map(e => ({ ...e, rows: e.rows.sort((a, b) => a.date.localeCompare(b.date)) }));
}
// Quantity-weighted average price per base unit for a set of records (what you really paid on average).
const avg = rows => { const q = rows.reduce((a, p) => a + p.qty, 0); return q ? rows.reduce((a, p) => a + p.paid, 0) / q : null; };
export function byPeriod(rows, len = 7) {
  const g = {}; rows.forEach(p => (g[p.date.slice(0, len)] = g[p.date.slice(0, len)] || []).push(p));
  return Object.entries(g).sort().map(([k, rs]) => ({ k, avg: avg(rs), min: Math.min(...rs.map(p => p.unitPrice)), max: Math.max(...rs.map(p => p.unitPrice)), n: rs.length, spent: rs.reduce((a, p) => a + p.paid, 0), stores: [...new Set(rs.map(p => p.store).filter(Boolean))] }));
}
export const pct = (a, b) => (a != null && b ? (a / b - 1) * 100 : null);

// Your basket from one year to the next: items bought in both, each item's change weighted by what you spent on it.
// months limits both years to the same months (so a part year compares fairly).
export function basketChange(S, year, { group, months } = {}) {
  const inYear = (p, y) => p.date.startsWith(String(y)) && (!months || months.includes(+p.date.slice(5, 7)));
  let wsum = 0, acc = 0; const list = [];
  for (const it of items(S)) {
    if (group && it.group !== group) continue;
    const a = it.rows.filter(p => inYear(p, year - 1)), b = it.rows.filter(p => inYear(p, year));
    if (!a.length || !b.length) continue;
    const ch = avg(b) / avg(a) - 1, w = b.reduce((x, p) => x + p.paid, 0);
    wsum += w; acc += w * ch; list.push({ it, ch: ch * 100, w });
  }
  return { change: wsum ? acc / wsum * 100 : null, items: list.sort((x, y) => y.w - x.w) };
}
// Same month a year earlier: your monthly year-over-year, from items bought in both months (±1 month a year back).
export function monthlyYoY(S, monthStr) {
  const [y, m] = monthStr.split('-').map(Number);
  const back = [-1, 0, 1].map(d => { const x = new Date(y - 1, m - 1 + d, 1); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`; });
  let wsum = 0, acc = 0, n = 0;
  for (const it of items(S)) {
    const b = it.rows.filter(p => ym(p.date) === monthStr); if (!b.length) continue;
    const a = it.rows.filter(p => back.includes(ym(p.date))); if (!a.length) continue;
    const w = b.reduce((x, p) => x + p.paid, 0); wsum += w; acc += w * (avg(b) / avg(a) - 1); n++;
  }
  return n >= 3 ? { change: acc / wsum * 100, n } : null;
}

// ---------- Statistics Canada ----------
// Downloaded by the app from Statistics Canada's Web Data Service (official API, no key) and kept in your synced
// data as S.statcan, so a device that can't reach StatCan (e.g. the PC browser) still gets it through Drive sync.
//   cpi:    food CPI (table 18-10-0004-01, 2002=100) for Ontario and Canada, by month
//   prices: monthly average retail prices (table 18-10-0245-01) for the products your items are matched to
const WDS = 'https://www150.statcan.gc.ca/t1/wds/rest/';
const CPI_PID = 18100004, AVG_PID = 18100245, GEOS = ['Ontario', 'Canada'], MONTHS_BACK = 120;
const CPI_WANT = ['Food purchased from stores', 'Food', 'All-items', ...new Set(Object.values(GROUPS).map(g => g.cpi))];
let SCref = null;
export const useStatCan = S => (SCref = S.statcan || null);
export const statcan = () => SCref;
export const geoOf = () => 'Ontario';
async function cubeMembers(http, pid) {
  const [r] = await http(WDS + 'getCubeMetadata', [{ productId: pid }]);
  if (r?.status !== 'SUCCESS') throw new Error('Statistics Canada did not return table ' + pid);
  const dims = r.object.dimension.sort((a, b) => a.dimensionPositionId - b.dimensionPositionId);
  const find = re => dims.find(d => re.test(d.dimensionNameEn));
  const geo = find(/geograph/i), prod = find(/product/i);
  if (!geo || !prod) throw new Error('Unexpected table layout for ' + pid);
  return { n: dims.length, geo, prod };
}
const coord = (n, pos) => { const c = Array(Math.max(n, 10)).fill(0); Object.entries(pos).forEach(([p, id]) => (c[p - 1] = id)); return c.slice(0, 10).join('.'); };
async function pull(http, pid, meta, pairs) {   // pairs: [{ geo, prod, gid, pidm }] → { [geo]: { [prod]: { 'YYYY-MM': value } } }
  const out = {};
  for (let i = 0; i < pairs.length; i += 10) {   // small requests: StatCan limits data points per request
    const chunk = pairs.slice(i, i + 10);
    const res = await http(WDS + 'getDataFromCubePidCoordAndLatestNPeriods', chunk.map(p => ({ productId: pid, coordinate: coord(meta.n, { [meta.geo.dimensionPositionId]: p.gid, [meta.prod.dimensionPositionId]: p.pidm }), latestN: MONTHS_BACK })));
    res.forEach((r, k) => {
      if (r?.status !== 'SUCCESS') return;
      const p = chunk[k], pts = r.object?.vectorDataPoint || [];
      for (const d of pts) if (d.value != null) ((out[p.geo] = out[p.geo] || {})[p.prod] = out[p.geo][p.prod] || {})[String(d.refPer).slice(0, 7)] = +d.value;
    });
  }
  return out;
}
// Refresh from StatCan. matched = product names your items are matched to (average prices are fetched for those only).
export async function refreshStatCan(S, http, { force = false } = {}) {
  const old = S.statcan;
  if (!force && old?.fetchedAt && Date.now() - old.fetchedAt < 6 * 864e5 && sameSet(old.matched, matchedProducts(S))) return old;
  const cm = await cubeMembers(http, CPI_PID);
  const gidOf = (meta, g) => meta.geo.member.find(m => m.memberNameEn === g)?.memberId;
  const cpiPairs = [];
  for (const g of GEOS) for (const want of CPI_WANT) {
    const m = cm.prod.member.find(x => (want instanceof RegExp ? want.test(x.memberNameEn) : x.memberNameEn === want));
    if (m && gidOf(cm, g)) cpiPairs.push({ geo: g, prod: m.memberNameEn, gid: gidOf(cm, g), pidm: m.memberId });
  }
  const cpi = await pull(http, CPI_PID, cm, cpiPairs);
  if (!Object.keys(cpi).length) throw new Error('No CPI data came back from Statistics Canada');
  const am = await cubeMembers(http, AVG_PID);
  const products = am.prod.member.map(m => m.memberNameEn).sort();
  const matched = matchedProducts(S).filter(p => products.includes(p));
  const avgPairs = [];
  for (const g of GEOS) for (const p of matched) { const m = am.prod.member.find(x => x.memberNameEn === p); if (m && gidOf(am, g)) avgPairs.push({ geo: g, prod: p, gid: gidOf(am, g), pidm: m.memberId }); }
  const prices = avgPairs.length ? await pull(http, AVG_PID, am, avgPairs) : {};
  S.statcan = { fetchedAt: Date.now(), source: 'Statistics Canada, tables 18-10-0004-01 (CPI, 2002=100) and 18-10-0245-01 (average retail prices). Statistics Canada Open Licence.', cpi, prices, products, matched };
  return useStatCan(S);
}
const sameSet = (a = [], b = []) => a.length === b.length && b.every(x => a.includes(x));
export const matchedProducts = S => [...new Set(M.live(S, 'prices').map(p => p.statcan).filter(Boolean))].sort();
export const productNames = () => SCref?.products || [];
export const latestMonth = () => { const s = SCref?.cpi?.[geoOf()]?.[ALL_FOOD_CPI] || SCref?.cpi?.Canada?.[ALL_FOOD_CPI]; return s ? Object.keys(s).sort().pop() : null; };
function series(table, name, geo = geoOf()) {
  const t = SCref?.[table]; if (!t) return null;
  const pick = g => { const s = t[g]; if (!s) return null; const k = name instanceof RegExp ? Object.keys(s).find(x => name.test(x)) : name; return k && s[k] ? { name: k, by: s[k], geo: g } : null; };
  return pick(geo) || pick('Canada');
}
export const cpiSeries = (name, geo) => series('cpi', name, geo);
// CPI change over a year: average of the chosen months vs the same months a year earlier.
export function cpiChange(name, year, months, geo) {
  const sr = cpiSeries(name, geo); if (!sr) return null;
  const ms = (months || [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]).map(m => String(m).padStart(2, '0'));
  let sa = 0, sb = 0, n = 0;
  for (const m of ms) { const a = sr.by[`${year - 1}-${m}`], b = sr.by[`${year}-${m}`]; if (a != null && b != null) { sa += a; sb += b; n++; } }
  return n ? { change: (sb / sa - 1) * 100, months: n, geo: sr.geo } : null;
}
export function cpiYoYMonth(name, m, geo) {
  const sr = cpiSeries(name, geo); if (!sr) return null;
  const [y, mo] = m.split('-'); const a = sr.by[`${+y - 1}-${mo}`], b = sr.by[m];
  return a && b ? (b / a - 1) * 100 : null;
}

// Average retail prices: product names carry their size ("Bananas, per kilogram", "Milk, 2 litres", "Eggs, 1 dozen").
export function productUnit(name) {
  const s = name.toLowerCase();
  if (/per kilogram/.test(s)) return { unit: 'kg', qty: 1 };
  if (/per pound/.test(s)) return { unit: 'kg', qty: 0.45359237 };
  let m = s.match(/([\d.]+)\s*kilograms?\b/); if (m) return { unit: 'kg', qty: +m[1] };
  m = s.match(/([\d.]+)\s*grams?\b/); if (m) return { unit: 'kg', qty: +m[1] / 1000 };
  m = s.match(/([\d.]+)\s*millilitres?\b/); if (m) return { unit: 'L', qty: +m[1] / 1000 };
  m = s.match(/([\d.]+)\s*litres?\b/); if (m) return { unit: 'L', qty: +m[1] };
  if (/dozen/.test(s)) return { unit: 'each', qty: (+(s.match(/([\d.]+)\s*dozen/) || [])[1] || 1) * 12 };
  m = s.match(/([\d.]+)\s*(?:units?|pack|count)\b/); if (m) return { unit: 'each', qty: +m[1] };
  return { unit: 'each', qty: 1 };
}
// The government average for a product, converted to the item's unit (per kg, per L or each), by month.
export function govPrices(product, unit, geo) {
  const sr = series('prices', product, geo); if (!sr) return null;
  const pu = productUnit(sr.name); if (pu.unit !== unit) return null;
  const by = {}; for (const [m, v] of Object.entries(sr.by)) by[m] = v / pu.qty;
  return { by, geo: sr.geo, name: sr.name };
}

// ---------- tidy older receipt items that were saved before the Price book (needs the AI) ----------
export function untidied(S) {
  const done = new Set(M.live(S, 'prices').map(p => p.txnId));
  return M.live(S, 'transactions').filter(t => t.type === 'expense' && t.items?.length && !done.has(t.id) && !t.items.some(i => i.pb));
}
