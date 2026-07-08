# TipFork — iOS + Android launch & monetization plan

_Last updated: July 2026_

This plan covers two things: how to turn the existing TipFork web app into real App Store and Play Store apps, and how to actually make money from it — with the current (2026) store-fee rules that decide which models keep the most cash.

---

## Part 1 — Getting TipFork into the App Store and Play Store

### Recommended path: Capacitor (wrap the web app)

TipFork already works as a single-page web app. The fastest, cheapest way to ship native iOS and Android apps is to **wrap that same code in Capacitor** rather than rewriting it in Swift/Kotlin or React Native. You keep one codebase, get real store-installable apps, and gain native access to the camera, GPS, and payment SDKs. A full rewrite would cost months and buys you almost nothing at this stage.

The scaffolding is already in this folder: `capacitor.config.json` and `package.json`.

**Build steps (run locally on a Mac — iOS requires macOS + Xcode):**

1. Install prerequisites: Node.js, Xcode (for iOS), and Android Studio (for Android).
2. In the project folder: `npm install`
3. Stage the web files: `npm run copy:web` (copies `tip-app.html` → `www/index.html` plus manifest, service worker, and icons).
4. Add the platforms: `npm run add:ios` and `npm run add:android`.
5. Open the native projects: `npm run open:ios` (Xcode) / `npm run open:android` (Android Studio).
6. Set the app icon, splash screen, and signing certificates, then build to a device or simulator.
7. Submit through App Store Connect and the Play Console.

### Native details you'll need to handle

- **Permissions strings.** iOS requires usage descriptions in `Info.plist`: `NSCameraUsageDescription` ("Scan menus and receipts") and `NSLocationWhenInUseUsageDescription` ("Find your local tax rate"). Android needs `CAMERA` and `ACCESS_FINE_LOCATION` in the manifest. Without these, the OS blocks the feature.
- **Camera & GPS.** The web `getUserMedia`/Geolocation calls work inside Capacitor, but the `@capacitor/camera` and `@capacitor/geolocation` plugins give a more reliable native experience — worth swapping in for the store build.
- **Venmo/Braintree.** Use Braintree's **native** iOS/Android Drop-in SDK rather than the web one — the native SDK hands off to the installed Venmo app cleanly, which is a much better checkout. Your `server.js` backend stays exactly the same.
- **App Store review note.** Because TipFork moves *real* money between friends (a real-world service), Apple and Google do **not** require you to use their in-app purchase system for those payments — a normal processor (Braintree/Stripe) is correct and allowed. Say this clearly in your review notes to avoid a rejection.

### Cheaper interim option

If you want to validate demand before paying the store fees, ship the existing app as an installable **PWA** (already built — `manifest.webmanifest` + `sw.js`) hosted on any HTTPS URL. Tools like **PWABuilder** can also package that PWA into store binaries. Zero code change, and you learn whether people actually use it before investing in native polish.

---

## Part 2 — How to make money

### The one rule that shapes everything: digital vs. real-world

The stores treat two kinds of money completely differently:

- **Real-world payments** (splitting an actual dinner bill between friends) are **exempt** from Apple/Google commission. You run these through Braintree/Stripe and the stores take **0%**. P2P payments, food, and physical goods are explicitly carved out.
- **Digital goods** (a "Premium" subscription unlocked inside the app) **must** use in-app purchase, and the store takes a cut — **15%** on Apple's Small Business Program (under $1M/yr) and effectively **~15%** on Google Play subscriptions.

So: charging a small fee on the money moving through the app is far more margin-friendly than a digital subscription, because the stores don't tax it. Keep that in mind as you read the options below.

### Ranked models (best fit for TipFork first)

**1. Convenience / service fee on payments (highest-margin, store-exempt).**
Add a small flat fee — say $0.25–$0.50 — per person settled, or a ~1% fee on the amount routed through TipFork's Venmo/card flow. Because it's a real-world payment, no store cut applies; you only pay the processor (~3%). The catch: Venmo-via-Braintree margins are thin, and adding markup on top of someone else's rails can rub against processor terms, so this works best once you process card payments directly. Frame it as a "split fee" the group splits, not a surprise charge.

**2. Freemium + Premium subscription (most proven for this category).**
Keep the core free (scan, split, tip, pay). Charge ~$3–5/month or ~$25/year for power features: unlimited receipt history and storage, recurring groups/roommates, itemized OCR, multi-currency trips, spend analytics, and CSV/Expensify/QuickBooks export for business diners. This is the Splitwise Pro model and the most reliable revenue for a consumer utility. Remember the store takes ~15%. Bundle the export/expense features to win over business users, who pay more readily than casual diners.

**3. Restaurant / merchant B2B (biggest long-term upside).**
White-label the scan → itemize → tip → pay flow for restaurants, or offer it as a QR at the table. Charge restaurants a SaaS fee or a per-transaction rate. This flips you from fighting for consumer dollars to selling a tool that increases tip rates and table turnover — a much larger, stickier revenue base. It's a bigger build and a sales motion, but it's where a bill/tip app becomes a real business.

**4. Affiliate & referral revenue (low effort, modest).**
Venmo, Cash App, and card issuers pay referral bounties for new signups; you can surface relevant dining/credit-card offers at the payment step. Restaurant-deal affiliate networks (e.g. dining rewards) can also pay per conversion. Low lift, but revenue scales only with volume.

**5. Cosmetic in-app purchases (small, easy).**
Themes, app icons, custom receipt/share cards. Trivial to build, small but pure-margin-ish (still store-taxed as digital goods). A nice top-up, not a core model.

**6. Ads (only at real scale, use sparingly).**
A single tasteful interstitial after a split is possible, but ad revenue is tiny below large daily active numbers and hurts the clean UX that makes a utility like this sticky. Consider it a last resort.

### What NOT to do

Avoid selling or brokering users' dining/spend data — it's privacy-sensitive, erodes trust, and increasingly runs into platform and legal limits. If you ever use aggregate data, make it anonymized, opt-in, and transparent.

### A realistic starting stack

For a solo/bootstrapped launch: ship **free core + a Premium subscription** (option 2) to establish recurring revenue, layer in a modest **split fee** (option 1) once you process cards directly, and treat **restaurant B2B** (option 3) as the expansion play once you have consumer traction and usage data to sell against. Referrals and cosmetics are easy add-ons whenever you want them.

### Rough economics

- Store presence: ~$99/yr (Apple) + $25 once (Google).
- Backend + processing: cheap hosting (~$0–7/mo) + ~3% per payment.
- Premium subscription nets you ~85% of the sticker price after the store cut.
- Payment/convenience fees net you the fee minus ~3% processing, with **no** store cut.

---

## Sources

- Apple Small Business Program (15%): https://developer.apple.com/app-store/small-business-program/
- Apple physical-goods / real-world-services exemption: https://www.revenuecat.com/blog/engineering/small-business-program/
- Google Play service fees & physical/P2P exemption: https://support.google.com/googleplay/android-developer/answer/112622
- Google Play 2026 fee changes: https://android-developers.googleblog.com/2026/06/play-expanded-billing.html
- Capacitor (wrap web apps as native): https://capacitorjs.com/docs
