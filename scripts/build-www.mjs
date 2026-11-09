// Copies the web app into www/ for the Android app. The web version is served straight from the repo root.
import { cpSync, rmSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
rmSync('www', { recursive: true, force: true });
mkdirSync('www');
for (const f of ['index.html', 'styles.css', 'manifest.webmanifest', 'js', 'vendor', 'icons']) cpSync(f, `www/${f}`, { recursive: true });
// The Capacitor runtime is injected by the native shell; nothing else to change.
const html = readFileSync('www/index.html', 'utf8');
// Let the app shell keep the page clear of the status and navigation bars.
writeFileSync('www/index.html', html.replace('<html', `<html data-native="1"${process.env.STORE ? ` data-store="${process.env.STORE}"` : ''}`).replace(',viewport-fit=cover', ''));
console.log('www/ ready');
