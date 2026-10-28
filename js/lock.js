// App lock: a PIN (stored only as a salted SHA-256 hash on this device) and optional fingerprint/face
// unlock through the phone's built-in authenticator (WebAuthn). This is a privacy screen for the app;
// your data itself stays protected by the phone's own encryption.
const enc = new TextEncoder();
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const rand = n => crypto.getRandomValues(new Uint8Array(n));

export async function hashPin(pin, salt) {
  const h = await crypto.subtle.digest('SHA-256', enc.encode(salt + ':' + pin));
  return b64(h);
}
export async function makePin(pin) { const salt = b64(rand(16)); return { salt, pinHash: await hashPin(pin, salt) }; }
export async function checkPin(lock, pin) { return lock && (await hashPin(pin, lock.salt)) === lock.pinHash; }

export const biometricSupported = async () =>
  !!(window.PublicKeyCredential && PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable());

export async function registerBiometric() {
  const cred = await navigator.credentials.create({ publicKey: {
    challenge: rand(32), rp: { name: 'MoneyBook' },
    user: { id: rand(16), name: 'moneybook-user', displayName: 'MoneyBook' },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
    authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'discouraged' },
    timeout: 60000,
  } });
  return b64(cred.rawId);
}
export async function verifyBiometric(credId) {
  const a = await navigator.credentials.get({ publicKey: {
    challenge: rand(32), allowCredentials: [{ type: 'public-key', id: unb64(credId) }], userVerification: 'required', timeout: 60000,
  } });
  return !!a;
}
