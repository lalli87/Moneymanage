// Phone features when MoneyBook runs as the Android app (Capacitor). In a browser every function here
// falls back to the web way of doing things, so the website keeps working unchanged.
import { Capacitor, registerPlugin } from '../vendor/capacitor/core.js';

export const isNative = Capacitor.isNativePlatform();
const SocialLogin = registerPlugin('SocialLogin');
const TextRec = registerPlugin('CapacitorPluginMlKitTextRecognition');
const Notes = registerPlugin('LocalNotifications');
const Files = registerPlugin('Filesystem');
const Share = registerPlugin('Share');
const App = registerPlugin('App');
const SystemTheme = registerPlugin('SystemTheme');

// ---------- Google sign-in (Android's own account picker; Google blocks its web sign-in inside apps) ----------
let inited = null;
export async function googleToken(webClientId, scopes, interactive) {
  if (inited !== webClientId) { await SocialLogin.initialize({ google: { webClientId, mode: 'online' } }); inited = webClientId; }
  const r = await SocialLogin.login({
    provider: 'google',
    options: interactive ? { scopes } : { scopes, style: 'bottom', filterByAuthorizedAccounts: true, autoSelectEnabled: true },
  });
  const at = r?.result?.accessToken;
  if (!at?.token) throw new Error('Google did not return access — check the Android sign-in setup.');
  const exp = at.expires ? Date.parse(at.expires) : NaN;
  return { token: at.token, expiresAt: Number.isFinite(exp) ? exp - 60000 : Date.now() + 50 * 60000 };
}
export async function googleSignOut() { try { await SocialLogin.logout({ provider: 'google' }); } catch {} }

// ---------- receipt text (Google ML Kit, on the phone, works offline) ----------
// ML Kit returns text blocks — often the names column and the prices column separately — so the pieces are
// put back into rows by their position on the receipt.
export async function readReceipt(file) {
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 2200 / Math.max(img.width, img.height));
  const c = document.createElement('canvas'); c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
  c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
  const base64Image = c.toDataURL('image/jpeg', 0.92).split(',')[1];
  const res = await TextRec.detectText({ base64Image, rotation: 0 });
  return rowsFromBlocks(res);
}
export function rowsFromBlocks(res) {
  const parts = [];
  for (const b of res.blocks || []) for (const l of b.lines || []) {
    const bb = l.boundingBox; if (!bb) continue;
    parts.push({ text: l.text, x: bb.left, top: bb.top, bottom: bb.bottom, mid: (bb.top + bb.bottom) / 2, h: bb.bottom - bb.top });
  }
  if (!parts.length) return res.text || '';
  parts.sort((a, b) => a.mid - b.mid);
  const rows = [];
  for (const p of parts) {
    const row = rows.find(r => Math.abs(r.mid - p.mid) < Math.max(6, Math.min(r.h, p.h) * 0.55));
    if (row) { row.items.push(p); row.mid = (row.mid * (row.items.length - 1) + p.mid) / row.items.length; }
    else rows.push({ mid: p.mid, h: p.h, items: [p] });
  }
  return rows.sort((a, b) => a.mid - b.mid).map(r => r.items.sort((a, b) => a.x - b.x).map(p => p.text).join(' ')).join('\n');
}

// ---------- saving files (backup, CSV): the phone's share sheet — Drive, Files, email… ----------
export async function saveFile(name, text) {
  const { uri } = await Files.writeFile({ path: name, data: text, directory: 'CACHE', encoding: 'utf8' });
  await Share.share({ title: name, files: [uri], dialogTitle: 'Save or send ' + name });
}

// ---------- reminders: real Android notifications at 9 am, even when the app is closed ----------
export async function scheduleReminders(list) {
  try {
    const perm = await Notes.checkPermissions();
    if (perm.display !== 'granted' && (await Notes.requestPermissions()).display !== 'granted') return 0;
    const pending = await Notes.getPending();
    if (pending.notifications?.length) await Notes.cancel({ notifications: pending.notifications.map(n => ({ id: n.id })) });
    const now = Date.now();
    const notifications = list.map((r, i) => {
      const [y, m, d] = r.date.split('-').map(Number);
      return { id: 1000 + i, title: r.title, body: r.body, schedule: { at: new Date(y, m - 1, d, 9, 0, 0), allowWhileIdle: true } };
    }).filter(n => n.schedule.at.getTime() > now).slice(0, 60);
    if (notifications.length) await Notes.schedule({ notifications });
    return notifications.length;
  } catch { return 0; }
}

// ---------- Android back button closes the open sheet first ----------
export function onBack(fn) { if (isNative) App.addListener('backButton', () => { if (!fn()) App.exitApp(); }); }
export async function appInfo() { try { return await App.getInfo(); } catch { return null; } }

// Phone dark mode on/off, now and whenever it changes (MainActivity's small SystemTheme plugin).
export function watchNight(fn) {
  if (!isNative) return;
  SystemTheme.get().then(r => fn(!!r.night)).catch(() => {});
  SystemTheme.addListener('change', r => fn(!!r.night)).catch?.(() => {});
}
