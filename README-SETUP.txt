RESELL & CO — COMPLETE SETUP GUIDE   (build v2026-09-14.2)
==========================================================
Three parts: the APP (GitHub Pages), the CLOUD (Cloudflare Worker), and your DEVICES.
Do them in this order. Total time: about 20 minutes. You only do this once.

═══════════════════════════════════════════════════════════════════
KEYS & SECRETS — everything the app needs, in one place
═══════════════════════════════════════════════════════════════════
BAKED INTO THE APP (nothing to do):
  • Scout worker URL   https://resellco-scout.8pavii.workers.dev/
  • Sync passphrase    rc-KX1kmHIYYT0ds917m9xPBMot
  • AI worker URL      https://sitbackandco-ai.8pavii.workers.dev/
  • Push public key    (VAPID public — baked)
  • Firebase config    (public, already in the file)

YOU PASTE INTO CLOUDFLARE (Worker → Settings → Variables & Secrets → type "Secret"):
  SYNC_SECRET    = rc-KX1kmHIYYT0ds917m9xPBMot
  VAPID_PUBLIC   = BHxzrHD5ItbQL6QRHtLY44erYS9TRLF5ZNhGo6FREcTjw7-yQn2S0w6lDWgRpg1K2qykj4U0z0rCRfVO2b2uIRA
  VAPID_PRIVATE  = J2I3RJfE_4rtlsJFlbXNL30akN6oNoFCWJoRWcZmqrg
  VAPID_SUBJECT  = mailto:8pavii@gmail.com
  EBAY_APP_ID    = your eBay developer App ID     (optional — see Part 2E)
  EBAY_CERT_ID   = your eBay developer Cert ID    (optional)

ALREADY ON YOUR OTHER WORKER (sitbackandco-ai) — leave alone:
  ANTHROPIC_KEY  = your Anthropic API key (stays a secret there, never in the app)

═══════════════════════════════════════════════════════════════════
PART 1 — THE APP (GitHub Pages)   ~3 min
═══════════════════════════════════════════════════════════════════
1. https://github.com/SitBackCo/Sitback-Co
2. Add file → Upload files → drag in these 7 and REPLACE existing:
     index.html · manifest.json · sw.js · icon-192.png · icon-512.png · apple-touch-icon.png · (scout-worker.js can go up too, harmless)
3. Commit changes. Wait 2 minutes.
4. Open https://sitbackco.github.io/Sitback-Co/  → hard-refresh once (hold reload → Reload).
   You should see the three-picture opening → radar → Blueprint.

═══════════════════════════════════════════════════════════════════
PART 2 — THE CLOUD SCANNER (Cloudflare Worker)   ~10 min
═══════════════════════════════════════════════════════════════════
A. Create the worker (name matters — the app is baked to it)
   dash.cloudflare.com → Workers & Pages → Create → Create Worker
   Name: resellco-scout   → Deploy
   (If you already have a scout worker under another name: rename it, OR paste its real
    URL into the app: Radar tab → Connect → URL. The baked URL is only a default.)

B. Paste the code
   Edit code → select all → delete → paste the whole of scout-worker.js → Deploy

C. KV namespace (the worker's memory for finds, criteria, subscriptions, pickups)
   Workers & Pages → KV → Create a namespace → name: SCOUT_KV
   Back in the worker → Settings → Bindings → Add binding → KV Namespace
     Variable name: SCOUT_KV     KV namespace: SCOUT_KV   → Save / Deploy

D. Secrets — paste the six from the top of this file
   Settings → Variables and Secrets → Add → Type: Secret → Name / Value → Save.  Repeat.
   ⚠ SYNC_SECRET must match EXACTLY — it is baked into the app.

E. eBay keys (optional but recommended — Gumtree works without them)
   developer.ebay.com → Register (free) → My Account → Application Keys → Production
   Copy "App ID (Client ID)" → EBAY_APP_ID   and   "Cert ID (Client Secret)" → EBAY_CERT_ID

F. Cron — makes it scan 24/7 with your phone off
   Settings → Triggers → Cron Triggers → Add Cron Trigger →  */10 * * * *   → Save

G. Check
   Open https://resellco-scout.8pavii.workers.dev/ping in a browser. You want:
     "ok":true   "hasPush":true   "inbox":true   ("hasEbay":true if you did step E)

═══════════════════════════════════════════════════════════════════
PART 3 — iPHONE   ~3 min
═══════════════════════════════════════════════════════════════════
1. Safari (must be Safari) → https://sitbackco.github.io/Sitback-Co/
2. Share (box with arrow) → Add to Home Screen → Add
3. Close Safari. From now on open Resell & Co FROM THE HOME SCREEN ICON only.
4. Sign in with Google when asked (Firebase sync — same data on every device).
5. Radar tab → should say Connected (URL + key are baked). If not, wait 30s and reopen.
6. Tools → App theme → pick Light / Dark / Galaxy.
7. Tools → "Enable push alerts" → Allow → tap "Send test push" → phone buzzes.
8. iPhone Settings → Notifications → Resell & Co → Allow, Lock Screen, Banners, Sounds, Badges all ON.
   Settings → Focus → allow Resell & Co through Do Not Disturb if you want night alerts.
   (Push needs iOS 16.4+ and only works from the installed icon, never from Safari.)

═══════════════════════════════════════════════════════════════════
PART 4 — CHROMEBOOK   ~1 min
═══════════════════════════════════════════════════════════════════
Chrome → same URL → install icon in the address bar (or ⋮ → Install Resell & Co).
Sign in with Google. Tools → Enable push alerts → Allow.

═══════════════════════════════════════════════════════════════════
PART 5 — TELL IT WHAT TO HUNT
═══════════════════════════════════════════════════════════════════
🎯 Criteria tab → Gumtree → search words (e.g. corner sofa), max price, sells-for, min profit
   → "Send to Agent".  Repeat for eBay. Repeat for drills, consoles, whatever you flip.
Every edit syncs to the cloud. You only get pushed listings that pass YOUR words,
clear YOUR min profit and score 60+. Morning brief 8am · evening check 7pm (London).

═══════════════════════════════════════════════════════════════════
PART 6 — SHARE ANY LISTING → INSTANT PROFIT PUSH
═══════════════════════════════════════════════════════════════════
Chromebook / Android: on any listing → Share → Resell & Co. Built in.
iPhone (one-time): Tools → "Share any listing" → Copy link.
  Shortcuts app → + → Add Action "Receive input from Share Sheet" (URLs)
  → Add Action "Open URLs" → paste the link, then insert the "Shortcut Input" variable on the end
  → name it "Score in Resell & Co" → Done.  Now it's in every Share menu.
Facebook pages usually can't be read by the cloud — you'll get a "couldn't read" push; paste into Analyse instead.

═══════════════════════════════════════════════════════════════════
PART 7 — COLLECTION DAYS (Wed + Sun)
═══════════════════════════════════════════════════════════════════
🏴 Bounties tab → Collection days → Wed + Sun are pre-set (tap to change).
On a deal: set Area (e.g. KT9) and Pickup day. Pickups group by area on the planner.
The night before a travel day (7pm) you get a push listing tomorrow's pickups — app closed.
Tap "Collected ✓" when you pick it up → moves to Listed, stamps the bought date.

═══════════════════════════════════════════════════════════════════
WHERE YOUR DATA LIVES (nothing is lost when you close the app)
═══════════════════════════════════════════════════════════════════
Deals, settings, achievements, bounties, criteria, planner → saved instantly on the device
AND to Firebase with an 800ms debounce + flush on close. Sign in with Google on each device.
Finds, subscriptions, pickups → Cloudflare KV. Only Tools → Reset wipes anything.

═══════════════════════════════════════════════════════════════════
HONEST LIMITS
═══════════════════════════════════════════════════════════════════
• Facebook Marketplace: no API, blocks bots. Cloud scans Gumtree (always) + eBay (with keys).
  Criteria builds Facebook deep-links you tap; the inbox will usually fail on Facebook pages.
• Push has been built to spec but can only be proven by your phone — that's the "Send test push" button.
