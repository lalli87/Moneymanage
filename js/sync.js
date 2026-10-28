// Google sign-in (browser token flow), Drive appDataFolder sync, Calendar reminders.
import { merge, get, occurrences, todayStr, addDays } from './model.js';

const SCOPES = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/calendar.events';
const FILE = 'moneybook.json';
let token = null, tokenExp = 0, gisP;

export function loadGis() {
  gisP = gisP || new Promise((res, rej) => {
    const sc = document.createElement('script');
    sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
    sc.onload = res; sc.onerror = () => rej(new Error('Could not load Google sign-in (offline?)'));
    document.head.appendChild(sc);
  });
  return gisP;
}
export const hasToken = () => token && Date.now() < tokenExp;
export function signOut() {
  if (token && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(token, () => {});
  token = null; tokenExp = 0;
}
export async function getToken(clientId, interactive = true) {
  if (hasToken()) return token;
  if (!clientId) throw new Error('Add your Google OAuth Client ID in More › Sync first.');
  await loadGis();
  return new Promise((res, rej) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId, scope: SCOPES,
      callback: r => {
        if (r.error) return rej(new Error(r.error_description || r.error));
        token = r.access_token; tokenExp = Date.now() + (r.expires_in - 60) * 1000; res(token);
      },
      error_callback: e => rej(new Error(e?.message || 'Sign-in cancelled'))
    });
    client.requestAccessToken({ prompt: interactive ? '' : 'none' });
  });
}
async function api(url, opts = {}) {
  const r = await fetch(url, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } });
  if (r.status === 401) { token = null; throw new Error('Google session expired — tap Sync again.'); }
  if (!r.ok && r.status !== 204) throw Object.assign(new Error(`Google API ${r.status}: ${(await r.text()).slice(0, 200)}`), { status: r.status });
  return r.status === 204 ? null : r;
}

// ---------- Drive ----------
async function findFile() {
  const q = encodeURIComponent(`name='${FILE}'`);
  const r = await api(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`);
  return (await r.json()).files?.[0] || null;
}
async function upload(id, data) {
  const body = JSON.stringify(data);
  if (id) {
    await api(`https://www.googleapis.com/upload/drive/v3/files/${id}?uploadType=media`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body
    });
    return id;
  }
  const b = 'mbboundary' + Date.now();
  const meta = JSON.stringify({ name: FILE, parents: ['appDataFolder'] });
  const multipart = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${body}\r\n--${b}--`;
  const r = await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', {
    method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body: multipart
  });
  return (await r.json()).id;
}
// Pull → merge → push. Returns the merged state.
// codec.encode / codec.decode turn the state into what is stored in Drive and back (end-to-end encryption).
const PLAIN = { encode: async s => s, decode: async r => r };
export async function sync(state, clientId, interactive, codec = PLAIN) {
  await getToken(clientId, interactive);
  const f = await findFile();
  let merged = state;
  if (f) {
    const remote = await (await api(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`)).json();
    merged = merge(state, await codec.decode(remote));
  }
  await upload(f?.id, await codec.encode(merged));
  return merged;
}

// ---------- Google Calendar reminders ----------
function rrule(r) {
  const n = r.interval || 1; let x;
  const day = +r.startDate.slice(8, 10);
  switch (r.freq) {
    case 'daily': x = `FREQ=DAILY;INTERVAL=${n}`; break;
    case 'weekly': x = `FREQ=WEEKLY;INTERVAL=${n}`; break;
    case 'biweekly': x = `FREQ=WEEKLY;INTERVAL=${2 * n}`; break;
    case 'monthly': x = `FREQ=MONTHLY;INTERVAL=${n};BYMONTHDAY=${day > 28 ? -1 : day}`; break;
    case 'monthEnd': x = `FREQ=MONTHLY;INTERVAL=${n};BYMONTHDAY=-1`; break;
    case 'yearly': x = `FREQ=YEARLY;INTERVAL=${n}`; break;
  }
  if (r.endDate) x += `;UNTIL=${r.endDate.replace(/-/g, '')}T235959Z`;
  return x;
}
export async function upsertReminder(s, r, clientId, remindDays) {
  await getToken(clientId, true);
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const t = r.template;
  // Event starts at the next upcoming occurrence so no past events clutter the calendar.
  const first = occurrences(r, todayStr(), addDays(todayStr(), 800))[0] || r.startDate;
  const acct = get(s, 'accounts', t.accountId)?.name || '';
  const amt = `$${(+t.amount).toFixed(2)}`;
  const overrides = [{ method: 'popup', minutes: 0 }];
  if (remindDays > 0) overrides.push({ method: 'popup', minutes: Math.min(remindDays * 1440, 40320) });
  const body = {
    summary: `💲 ${t.note || 'Payment'} ${amt}`,
    description: `MoneyBook scheduled ${t.type}: ${amt} from ${acct}.\nThis is only a reminder — balances update in MoneyBook on the due date.`,
    start: { dateTime: `${first}T09:00:00`, timeZone: tz },
    end: { dateTime: `${first}T09:15:00`, timeZone: tz },
    recurrence: [`RRULE:${rrule(r)}`],
    reminders: { useDefault: false, overrides }
  };
  const base = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
  if (r.gcalEventId) {
    try {
      await api(`${base}/${r.gcalEventId}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return r.gcalEventId;
    } catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
  }
  const res = await api(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json()).id;
}
export async function deleteReminder(eventId, clientId) {
  if (!eventId) return;
  await getToken(clientId, true);
  try { await api(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${eventId}`, { method: 'DELETE' }); }
  catch (e) { if (e.status !== 404 && e.status !== 410) throw e; }
}

// ---------- weekly backup copies (kept in the same private app folder) ----------
const BK = 'moneybook-backup-';
export async function listBackups(clientId, interactive = false) {
  await getToken(clientId, interactive);
  const q = encodeURIComponent(`name contains '${BK}'`);
  const r = await api(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,name,modifiedTime,size)&orderBy=modifiedTime desc&pageSize=50`);
  return (await r.json()).files || [];
}
// Makes a dated copy if the newest one is older than `days`; keeps the newest `keep` copies.
export async function weeklyBackup(state, clientId, { days = 7, keep = 8, force = false, codec = PLAIN } = {}) {
  if (!hasToken()) return null;
  const files = await listBackups(clientId);
  const newest = files[0] && Date.parse(files[0].modifiedTime);
  if (!force && newest && Date.now() - newest < days * 86400000) return null;
  const name = `${BK}${new Date().toISOString().slice(0, 10)}.json`;
  const b = 'mbbk' + Date.now();
  const meta = JSON.stringify({ name, parents: ['appDataFolder'] });
  const body = `--${b}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${b}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(await codec.encode(state))}\r\n--${b}--`;
  await api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${b}` }, body });
  for (const f of (await listBackups(clientId)).slice(keep)) await api(`https://www.googleapis.com/drive/v3/files/${f.id}`, { method: 'DELETE' });
  return name;
}
export async function downloadBackup(id, clientId) {
  await getToken(clientId, true);
  return (await api(`https://www.googleapis.com/drive/v3/files/${id}?alt=media`)).json();
}
export async function deleteBackup(id, clientId) {
  await getToken(clientId, true);
  await api(`https://www.googleapis.com/drive/v3/files/${id}`, { method: 'DELETE' });
}
