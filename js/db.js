/// Tiny IndexedDB key-value store holding the whole app state on this device.
const DB = 'moneybook', STORE = 'kv', KEY = 'state';
let dbp;
function open() {
  dbp = dbp || new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  return dbp;
}
export async function load() {
  const db = await open();
  return new Promise((res, rej) => {
    const q = db.transaction(STORE).objectStore(STORE).get(KEY);
    q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error);
  });
}
export async function save(state) {
  const db = await open();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(JSON.parse(JSON.stringify(state)), KEY);
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
