# TipFork 🍴

TipFork is a mobile-first group dining assistant: scan the menu, translate dishes, generate dish visuals, select orders, and split expenses with tax/tip and receipt reconciliation.

Built for fast real-world use in restaurants and polished for hackathon demos.

## Table of contents

- [Features](#features)
- [How it works](#how-it-works)
- [Tech stack](#tech-stack)
- [Project structure](#project-structure)
- [Quick start](#quick-start)
- [Configuration](#configuration)
- [API endpoints](#api-endpoints)
- [Mobile packaging (Capacitor)](#mobile-packaging-capacitor)
- [Hackathon demo flow](#hackathon-demo-flow)
- [How Codex was used](#how-codex-was-used)
- [Troubleshooting](#troubleshooting)

## Features

- 📸 Scan menu from camera/gallery
- 🧾 Extract dish names + prices
- 🌐 Translate dish names (resilient fallback chain)
- 🖼️ Generate dish visuals (Qwen/OpenAI provider switch)
- 👥 Assign dishes to people
- 💸 Auto-calculate subtotal, tax, tip, and totals
- 🧾 Scan receipt and compare estimated vs actual total
- 🔗 Share payback details with links/QR

## How it works

1. User scans menu photo in the frontend.
2. OCR + backend extraction detect dish names/prices.
3. Backend normalizes and calibrates parsed items.
4. Translation endpoint returns localized dish names.
5. Visual endpoint returns generated dish images (or placeholders).
6. Frontend computes group totals and split views.
7. Receipt scan reconciles final bill vs estimate.

## Tech stack

### Frontend

- Single-page app: `client/index.html` (vanilla HTML/CSS/JS)
- OCR: Tesseract.js
- PWA support: `client/manifest.webmanifest`, `client/sw.js`
- Mobile wrappers via Capacitor

### Backend

- Node.js + Express (`backend/server.js`)
- AI orchestration for extraction/translation/visuals
- Braintree payment token + checkout endpoints

### AI provider strategy

- Menu extraction: OpenAI + OCR merge + calibration rules
- Translation: OpenAI → Qwen-Turbo → local fallback
- Visuals: provider switch via `VISUAL_PROVIDER` (`qwen`, `openai`, or `auto`)

## Project structure

```text
tipfork/
├─ client/
│  ├─ index.html             # main frontend SPA
│  ├─ manifest.webmanifest   # PWA manifest
│  ├─ sw.js                  # service worker
│  └─ assets/icons/          # favicon/app icons
├─ backend/server.js         # Express backend + AI routes
├─ server.js                 # compatibility entrypoint -> backend/server.js
├─ .env / .env.example       # runtime config
├─ package.json              # scripts + deps
├─ capacitor.config.json     # mobile wrapper config
├─ docs/TipFork-launch-plan.md
└─ samples/menus/            # sample menu images
```

## Quick start

### 1) Install

```bash
npm install
```

### 2) Configure env

```bash
cp .env.example .env
```

Fill required keys in `.env` (Qwen/OpenAI/Braintree as needed).

### 3) Run backend

```bash
node server.js
```

### 4) Run frontend

Open `client/index.html` in your browser (or serve the folder), and make sure:

- `CONFIG.BACKEND_URL` points to backend (default `http://127.0.0.1:3000`)
- `CONFIG.DEMO_MODE` and `CONFIG.MENU_AGENT_DEMO_MODE` are set as intended

## Configuration

### Key frontend flags (in `client/index.html`)

- `CONFIG.DEMO_MODE`
- `CONFIG.MENU_AGENT_DEMO_MODE`
- `CONFIG.VISUAL_IMAGE_PROVIDER` (`qwen`/`openai`/`auto`)
- `CONFIG.NO_OPENAI_VISUAL_MODE`

### Key backend env vars

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI access (extract/translate/optional visuals) |
| `OPENAI_TEXT_MODEL` | OpenAI extraction model |
| `OPENAI_TRANSLATE_MODEL` | OpenAI translation model |
| `VISUAL_PROVIDER` | `qwen`, `openai`, or `auto` |
| `QWEN_API_KEY` / `DASHSCOPE_API_KEY` | Qwen credential |
| `QWEN_TEXT_MODEL` | Qwen translation model (`qwen-turbo`) |
| `QWEN_TEXT_ENDPOINT` | Qwen compatible text endpoint |
| `QWEN_IMAGE_MODEL` | Qwen image model (image-capable) |
| `QWEN_WORKSPACE_ID`, `QWEN_REGION` | Qwen image endpoint construction |
| `QWEN_IMAGE_ENDPOINT` | Optional explicit image endpoint override |
| `BT_MERCHANT_ID`, `BT_PUBLIC_KEY`, `BT_PRIVATE_KEY` | Braintree setup |

## API endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/agent/menu/extract` | Extract menu dish names + prices |
| `POST` | `/api/agent/menu/translate` | Translate dish names |
| `POST` | `/api/agent/menu/visuals` | Generate dish visuals |
| `GET` | `/api/braintree/token` | Create Braintree client token |
| `POST` | `/api/braintree/checkout` | Capture checkout transaction |

## Mobile packaging (Capacitor)

```bash
npm run copy:web
npm run add:ios
npm run add:android
npm run sync
npm run open:ios
npm run open:android
```

## Hackathon demo flow

1. Scan a menu photo.
2. Show extracted dishes and prices.
3. Translate dishes to another language.
4. Generate dish visuals.
5. Assign dishes to 2–3 people.
6. Add tax/tip and show split totals.
7. Scan receipt and reconcile estimate vs actual.

## How Codex was used

Codex was used as an implementation copilot + debugging partner to:

- Infer and refine product intent from prototype files
- Improve extraction quality and calibration across menu styles
- Fix pricing/total calculation issues
- Add robust model/provider fallback chains
- Integrate Qwen support for visuals and translation fallback
- Improve visual generation reliability (timeouts, retries, caching)
- Generate project docs and demo assets quickly

## Troubleshooting

- **Translation fails due to model access:** backend automatically falls back (OpenAI → Qwen → local).
- **Visual generation fails:** verify `VISUAL_PROVIDER` and Qwen/OpenAI keys; placeholders are used as graceful fallback.
- **No backend response:** ensure `node server.js` is running and frontend `BACKEND_URL` matches.
- **Mobile build issues:** run `npm run copy:web` before `sync/open` commands.

## Security note

- Never commit real secrets in `.env`.
- Rotate keys if they were ever exposed.
