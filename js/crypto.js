// End-to-end encryption for what MoneyBook stores in Google Drive.
// The key is derived from your passphrase on the device (PBKDF2-SHA256, 600k rounds) and used with
// AES-256-GCM. Google — or anyone who gets into your Google account — only ever sees ciphertext.
// The passphrase is never stored or uploaded; each device keeps a non-exportable key in its own storage.
const enc = new TextEncoder(), dec = new TextDecoder();
const b64 = buf => { let s = ''; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
export const ITER = 600000;

export const isEncrypted = obj => !!(obj && obj.mb_enc === 1 && obj.data && obj.iv && obj.salt);
export const newSalt = () => b64(crypto.getRandomValues(new Uint8Array(16)));

export async function deriveKey(passphrase, salt, iter = ITER) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations: iter },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptJSON(obj, key, salt) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)));
  return { mb_enc: 1, alg: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter: ITER, salt, iv: b64(iv), data: b64(ct) };
}
// Throws if the key is wrong (GCM authentication fails) — nothing is ever half-decrypted.
export async function decryptJSON(env, key) {
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.data));
  return JSON.parse(dec.decode(pt));
}
