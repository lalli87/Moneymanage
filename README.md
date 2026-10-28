# MoneyBook

Personal money tracker that installs on **Android and Windows** from one codebase (an installable web app / PWA) and syncs through a private folder in **your own Google Drive**.

## Features
- Accounts and account groups: cash, bank, cards, loans, investments. Cards show the statement balance and the charges since the statement.
- Income, expenses and transfers, with categories and subcategories.
- **Scheduled payments.** Repeat payments and future-dated items show on the calendar and in the "Upcoming" list. They hit your balances **only on their due date**.
- **Reminders.**
  - An upcoming banner in the app.
  - A notification on this device when you open the app.
  - An optional **Google Calendar** event per repeat payment, which alerts you N days before and again on the day, even when the app is closed.
- **Mortgage tracking (Canadian rules).**
  - Tracks balance owing, rate (fixed = semi-annual compounding, variable = monthly) and frequency (monthly, bi-weekly, accelerated, weekly, semi-monthly).
  - Each payment is split into interest and principal automatically.
  - Supports lump-sum prepayments and rate changes at renewal.
  - Shows the payoff date, interest remaining, a "what if I pay extra" calculator, and your projected balance at term renewal.
- **Receipt scanning.**
  - Reads the store, total, date and card last-4 digits on your device (Tesseract OCR). Images never leave the phone.
  - Learns store → account + category from every expense you save, so it gets more accurate over time.
- Sync between devices (per-record merge with deletes tracked), JSON backup and restore, CSV export, works offline.

## One-time setup (about 20 minutes)

### 1. Host it on GitHub Pages (free, HTTPS)
Google sign-in and installing the app both need an HTTPS address.
1. Create a GitHub repo, e.g. `moneybook`. Upload every file in this folder to the repo root.
2. In the repo, open **Settings › Pages**. Under **Source**, choose *Deploy from a branch*, then pick `main` and `/ (root)`.
3. Your app will be at `https://<your-username>.github.io/moneybook/`.

> Privacy: a public repo exposes only the app code. Your financial data never goes to GitHub; it lives on your devices and in your Google Drive app folder.

### 2. Create a Google OAuth Client ID (free)
1. Go to <https://console.cloud.google.com/> and create a project named "MoneyBook".
2. Open **APIs & Services › Library** and enable the **Google Drive API** and the **Google Calendar API**.
3. Open **APIs & Services › OAuth consent screen**.
   - User type: **External**. Fill in the app name and your email.
   - Scopes: add `.../auth/drive.appdata` and `.../auth/calendar.events`.
   - **Test users:** add your Gmail address (and your spouse's, if they'll use it).
   - Leave the app in *Testing*. That's fine for personal use.
4. Open **APIs & Services › Credentials › Create credentials › OAuth client ID**.
   - Type: **Web application**.
   - **Authorized JavaScript origins:** `https://<your-username>.github.io`. Use the origin only, with no path.
5. Copy the Client ID. It ends in `.apps.googleusercontent.com`.

> Apps left in *Testing* mode may ask you to sign in again about once a week. That's normal for a personal app.

### 3. Install and connect
- **Android:** open the URL in Chrome, then tap **⋮ › Add to Home screen / Install app**.
- **Windows:** open the URL in Edge or Chrome, then click the install icon in the address bar.
- In the app, go to **More › Google Drive sync**, paste the Client ID, and tap **Save & sync now**. Do this once on each device.

## Moving over from Money Manager
1. Create your groups and accounts in **More › Accounts & groups**. Set each account's current balance.
2. Recreate your repeat payments in **More › Repeat payments**. Turn on 🔔 for the ones you want reminders for.
3. Set up the mortgage in **More › Mortgages**.
   - Enter the balance and date from your latest First National statement, plus your rate.
   - Choose **Bi-weekly** and enter your $2,000 payment.
   - Leave "Create the repeating payment" ticked, then delete your old manual "First National" repeat expense.
4. For cards, set the statement day and last 4 digits. The last 4 digits let receipt scans match the right card.

## Updating the app
Upload changed files to the repo. The app picks up the new version the next time it opens.

## Files
| File | Purpose |
|---|---|
| `index.html`, `styles.css` | Shell and styling |
| `js/model.js` | Data model, balances, recurrence, mortgage math, sync merge |
| `js/app.js` | All screens |
| `js/sync.js` | Google sign-in, Drive sync, Calendar reminders |
| `js/receipt.js` | OCR, receipt parsing, merchant learning |
| `js/db.js` | On-device storage (IndexedDB) |
| `sw.js`, `manifest.webmanifest`, `icons/` | Installable app and offline support |

## Android app (Samsung / any Android phone)
GitHub Actions builds this repo into a real installable Android app (`ca.kamal.moneybook`). The app is a Trusted Web Activity: it runs this site full-screen through Chrome, so Google sign-in, Drive sync, the camera for receipts and notifications all work.

- **Build:** runs on every change to `android/`, or manually from **Actions › Build Android app › Run workflow**.
- **Secrets needed:** two private repo secrets, `KEYSTORE_B64` (the signing key) and `KEYSTORE_PASSWORD`.
- **Install or update:** on the phone, open **Releases** (the latest "MoneyBook for Android" release) and tap `MoneyBook.apk`. Updates install over the top, and your data is kept.
- **Full-screen (no address bar):** needs `https://lalli87.github.io/.well-known/assetlinks.json`, served from the `lalli87.github.io` repo.
- **Signing key:** the key is never stored in this repo. It lives only in the repo secrets and in your private backup. Every update must be signed with the same key.
