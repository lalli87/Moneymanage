// Optional AI help through Claude (Anthropic API), using YOUR API key, stored only on this device.
// Requests go straight from this device to Anthropic: no MoneyBook server. Off until a key is added.
// Every answer with numbers is worked out by the app's own functions (tools), not guessed by the AI.
import * as M from './model.js';
import * as X from './insights.js';

export const MODEL = 'claude-haiku-5-5';
const PRICE = { in: 0.10 / 1e6, out: 0.50 / 1e6 };   // USD per token (Haiku 5.5, prompts up to 100K)

let L = null, saveLocal = () => {};
export function init(local, save) { L = local; saveLocal = save; }
export const enabled = () => !!L?.aiKey;

function track(usage) {
  if (!usage || !L) return;
  const m = new Date().toISOString().slice(0, 7);
  if (!L.aiUsage || L.aiUsage.month !== m) L.aiUsage = { month: m, calls: 0, in: 0, out: 0, cost: 0 };
  const i = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) + (usage.cache_read_input_tokens || 0), o = usage.output_tokens || 0;
  L.aiUsage.calls++; L.aiUsage.in += i; L.aiUsage.out += o; L.aiUsage.cost += i * PRICE.in + o * PRICE.out;
  saveLocal();
}

async function call(body, key = L?.aiKey) {
  if (!key) throw new Error('Add your Claude API key in More › AI assistant first.');
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({ model: MODEL, max_tokens: 2048, ...body }),
    });
  } catch { throw new Error('No connection to Claude — check your internet.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.error?.message || r.statusText;
    if (r.status === 401) throw new Error('Claude rejected the API key — check it in More › AI assistant.');
    if (r.status === 429) throw new Error('Claude is busy or your spending limit was reached — try again shortly.');
    if (/credit balance/i.test(msg)) throw new Error('Your Claude account is out of credit — add credit at console.anthropic.com.');
    throw new Error('Claude: ' + msg);
  }
  track(j.usage);
  return j;
}
export async function testKey(key) { await call({ max_tokens: 16, messages: [{ role: 'user', content: 'Reply with OK.' }] }, key); return true; }

// ---------- helpers: what the AI may know about your setup (names only) ----------
const catList = S => M.live(S, 'categories').filter(c => !c.hidden).map(c => {
  const p = c.parentId ? M.get(S, 'categories', c.parentId) : null;
  return { id: c.id, type: c.type, name: p ? `${p.name} › ${c.name}` : c.name };
});
const accList = S => M.live(S, 'accounts').filter(a => !a.hidden).map(a => ({ id: a.id, name: a.name, kind: M.get(S, 'groups', a.groupId)?.kind || '', last4: (a.numbers || []).map(n => String(n).slice(-4)) }));

async function imagePart(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1568 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.88).split(',')[1] } };
}

// ---------- receipts ----------
const RECEIPT_TOOL = {
  name: 'record_receipt',
  description: 'Record everything read from the receipt.',
  input_schema: {
    type: 'object',
    properties: {
      store: { type: 'string', description: 'Store name, short and clean, e.g. "Costco", "Food Basics"' },
      date: { type: 'string', description: 'Purchase date YYYY-MM-DD, empty if not printed' },
      subtotal: { type: 'number' }, tax: { type: 'number', description: 'Total sales tax (HST/GST/PST), 0 if none' },
      total: { type: 'number', description: 'Amount actually paid' },
      card_last4: { type: 'string', description: 'Last 4 digits of the payment card if printed, else empty' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            desc: { type: 'string', description: 'Item name, readable (expand obvious abbreviations, e.g. "KS PAPER TWL" → "Kirkland paper towels")' },
            amount: { type: 'number', description: 'What was actually paid for this item AFTER any discount on it' },
            discount: { type: 'number', description: 'Discount taken off this item, 0 if none. If the receipt prints the already-discounted price with a "saving/you saved" note, the amount is that printed price and discount is 0.' },
            categoryId: { type: 'string', description: 'Best matching expense category id from the list' },
          },
          required: ['desc', 'amount', 'categoryId'],
        },
      },
    },
    required: ['store', 'total', 'tax', 'items'],
  },
};
export async function readReceipt(S, { file, text }) {
  const cats = catList(S).filter(c => c.type === 'expense');
  const learned = (S.rules || []).filter(r => r.kind === 'item' && r.categoryId).slice(-60).map(r => `${r.merchant || r.key} → ${r.categoryId}`);
  const content = [];
  if (file) content.push(await imagePart(file));
  content.push({ type: 'text', text:
    `Read this ${file ? 'receipt photo' : 'receipt text'} and call record_receipt.\n` +
    `Rules: every purchased item once; skip totals, payment, points, coupons-as-lines, addresses. Items (after discounts) must add up to the subtotal; tax + subtotal = total. ` +
    `Weighed items: the price on the weight line belongs to the item above. Pick each item's category from this list (id: name):\n` +
    cats.map(c => `${c.id}: ${c.name}`).join('\n') +
    (learned.length ? `\nThe owner's own past choices (item → category id), follow these:\n${learned.join('\n')}` : '') +
    (text ? `\n\nReceipt text:\n${text.slice(0, 12000)}` : '') });
  const j = await call({ tools: [RECEIPT_TOOL], tool_choice: { type: 'tool', name: 'record_receipt' }, messages: [{ role: 'user', content }] });
  const r = j.content.find(b => b.type === 'tool_use')?.input;
  if (!r?.items) throw new Error('Claude could not read this receipt.');
  const ids = new Set(cats.map(c => c.id));
  r.items = r.items.filter(i => +i.amount).map(i => ({ desc: i.desc, amount: M.round2(+i.amount), ...(+i.discount ? { discount: M.round2(+i.discount) } : {}), categoryId: ids.has(i.categoryId) ? i.categoryId : '', how: 'ai' }));
  return r;
}

// ---------- "type it": a sentence becomes a transaction ----------
const ENTRY_TOOL = {
  name: 'fill_transaction',
  description: 'Fill in the transaction form from what the user wrote.',
  input_schema: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['expense', 'income', 'transfer'] },
      amount: { type: 'number' }, date: { type: 'string', description: 'YYYY-MM-DD' },
      accountId: { type: 'string', description: 'Account paid from (or received into) — id from the list' },
      toAccountId: { type: 'string', description: 'For transfers: destination account id' },
      categoryId: { type: 'string' }, note: { type: 'string', description: 'Payee / short note, e.g. "Costco"' },
      splits: { type: 'array', description: 'Only if the user split it across categories', items: { type: 'object', properties: { categoryId: { type: 'string' }, amount: { type: 'number' } }, required: ['categoryId', 'amount'] } },
    },
    required: ['type', 'amount'],
  },
};
export async function parseEntry(S, sentence) {
  const today = M.todayStr();
  const j = await call({
    tools: [ENTRY_TOOL], tool_choice: { type: 'tool', name: 'fill_transaction' },
    messages: [{ role: 'user', content: `Today is ${today} (${new Date().toLocaleDateString('en-CA', { weekday: 'long' })}). Accounts (id: name [kind, card endings]):\n` +
      accList(S).map(a => `${a.id}: ${a.name} [${a.kind}${a.last4.length ? ', ' + a.last4.join('/') : ''}]`).join('\n') +
      `\nCategories (id: type · name):\n` + catList(S).map(c => `${c.id}: ${c.type} · ${c.name}`).join('\n') +
      `\n\nThe user wrote: "${sentence}"\nCall fill_transaction. Use ids from the lists; leave a field out if unsure.` }],
  });
  return j.content.find(b => b.type === 'tool_use')?.input || null;
}

// ---------- Ask MoneyBook: questions answered from your own data ----------
const QA_TOOLS = [
  { name: 'spending_by_category', description: 'Totals per category for a date range. Top-level categories, or the subcategories of one category.',
    input_schema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string', enum: ['expense', 'income'] }, parent: { type: 'string', description: 'Optional category name to break down into subcategories' } }, required: ['from', 'to'] } },
  { name: 'monthly_totals', description: 'Income, expenses and net for each of the last N months (including this month so far).',
    input_schema: { type: 'object', properties: { months: { type: 'integer' } }, required: ['months'] } },
  { name: 'search_transactions', description: 'Find transactions by text (payee/note/item), category, account and date range. Returns count, total and up to 40 rows.',
    input_schema: { type: 'object', properties: { text: { type: 'string' }, category: { type: 'string' }, account: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, type: { type: 'string', enum: ['expense', 'income', 'transfer'] } } } },
  { name: 'accounts', description: 'Current balances of all accounts, credit-card payable amounts and due dates.', input_schema: { type: 'object', properties: {} } },
  { name: 'budgets', description: 'Budget status for the current month.', input_schema: { type: 'object', properties: {} } },
  { name: 'upcoming', description: 'Scheduled (future) payments and income in the next N days.', input_schema: { type: 'object', properties: { days: { type: 'integer' } }, required: ['days'] } },
];
const catPath = (S, id) => { const c = M.get(S, 'categories', id); if (!c) return 'Uncategorized'; const p = c.parentId ? M.get(S, 'categories', c.parentId) : null; return p ? `${p.name} › ${c.name}` : c.name; };
function runTool(S, name, a) {
  const t0 = M.todayStr();
  if (name === 'spending_by_category') {
    const type = a.type || 'expense', { top, leaf: sub } = M.categoryTotals(S, a.from, a.to, type);
    if (a.parent) {
      const p = M.live(S, 'categories').find(c => !c.parentId && c.name.toLowerCase() === a.parent.toLowerCase());
      if (!p) return { error: 'No such category' };
      const kids = M.live(S, 'categories').filter(c => c.parentId === p.id);
      return { category: p.name, total: M.round2(top[p.id] || 0), subcategories: kids.map(k => ({ name: k.name, amount: M.round2(sub[k.id] || 0) })).filter(x => x.amount) };
    }
    return { from: a.from, to: a.to, type, categories: Object.entries(top).map(([id, v]) => ({ name: catPath(S, id), amount: M.round2(v) })).sort((x, y) => y.amount - x.amount) };
  }
  if (name === 'monthly_totals') {
    const n = Math.min(36, Math.max(1, a.months || 6)), out = [], d = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const m = new Date(d.getFullYear(), d.getMonth() - i, 1), from = M.ymd(m), to = M.ymd(new Date(m.getFullYear(), m.getMonth() + 1, 0));
      const { inc, exp } = M.sumIE(M.live(S, 'transactions').filter(t => t.date >= from && t.date <= to && t.date <= t0));
      out.push({ month: from.slice(0, 7), income: M.round2(inc), expenses: M.round2(exp), net: M.round2(inc - exp) });
    }
    return out;
  }
  if (name === 'search_transactions') {
    const q = (a.text || '').toLowerCase(), cq = (a.category || '').toLowerCase(), aq = (a.account || '').toLowerCase();
    const rows = M.live(S, 'transactions').filter(t => t.date <= t0 && (!a.from || t.date >= a.from) && (!a.to || t.date <= a.to) && (!a.type || t.type === a.type)
      && (!q || [t.note, t.memo, ...(t.items || []).map(i => i.desc)].join(' ').toLowerCase().includes(q))
      && (!cq || [t.categoryId, ...(t.splits || []).map(s => s.categoryId)].some(id => catPath(S, id).toLowerCase().includes(cq)))
      && (!aq || [t.accountId, t.toAccountId].some(id => (M.accName(S, id) || '').toLowerCase().includes(aq))))
      .sort((x, y) => y.date.localeCompare(x.date));
    return { count: rows.length, total: M.round2(rows.reduce((s, t) => s + (+t.amount || 0), 0)),
      rows: rows.slice(0, 40).map(t => ({ date: t.date, type: t.type, amount: +t.amount, payee: t.note || '', category: t.type === 'transfer' ? 'Transfer' : catPath(S, t.categoryId), account: M.accName(S, t.accountId) })) };
  }
  if (name === 'accounts') {
    const bal = M.balances(S, t0), cards = Object.fromEntries(X.cardStatuses(S).map(c => [c.account.id, c]));
    return M.live(S, 'accounts').filter(x => !x.hidden).map(x => ({ name: x.name, group: M.get(S, 'groups', x.groupId)?.name, balance: M.round2(bal[x.id] || 0),
      ...(cards[x.id] ? { payable: cards[x.id].remaining, due: cards[x.id].dueDate, status: cards[x.id].status } : {}) }));
  }
  if (name === 'budgets') {
    const d = new Date(), from = M.ymd(new Date(d.getFullYear(), d.getMonth(), 1)), to = M.ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
    return X.budgetStatus(S, from, to).map(b => ({ category: b.category.name, budget: b.budget, spent: b.spent, left: b.left, status: b.status }));
  }
  if (name === 'upcoming') {
    return M.projected(S, t0, M.addDays(t0, Math.min(120, a.days || 30))).map(t => ({ date: t.date, type: t.type, amount: +t.amount, payee: t.note || '', account: M.accName(S, t.accountId) }));
  }
  return { error: 'unknown tool' };
}
export async function ask(S, question, history = []) {
  const system = `You are MoneyBook's assistant for the owner's personal finances (Ontario, Canada; amounts in CAD). Today is ${M.todayStr()}.
Always use the tools for numbers — never estimate or invent figures. Keep answers short and plain: lead with the answer, then a few supporting numbers. Use $ with two decimals.
If something can't be answered from the data, say what's missing. You give information, not financial, tax or legal advice.
Categories: ${catList(S).map(c => c.name).join('; ')}
Accounts: ${accList(S).map(a => a.name).join('; ')}`;
  const messages = [...history, { role: 'user', content: question }];
  for (let turn = 0; turn < 6; turn++) {
    const j = await call({ system, tools: QA_TOOLS, messages, max_tokens: 1200 });
    messages.push({ role: 'assistant', content: j.content });
    const uses = j.content.filter(b => b.type === 'tool_use');
    if (!uses.length || j.stop_reason !== 'tool_use') return { answer: j.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim(), messages };
    messages.push({ role: 'user', content: uses.map(u => { let out; try { out = runTool(S, u.name, u.input || {}); } catch (e) { out = { error: e.message }; } return { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 20000) }; }) });
  }
  return { answer: 'That took too many steps — try a more specific question.', messages };
}
