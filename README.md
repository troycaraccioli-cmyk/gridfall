# Gridfall

A Safari / iPad–friendly **Progressive Web App**: a short 3D turn-based strategy game built with HTML, CSS, and Three.js (WebGL). No native iOS app, Xcode, or Apple Developer Program required for this proof.

**Goal of this project:** show that you can ship a playable game to an iPad Home Screen icon via **Safari → Add to Home Screen**.

## App name

**Gridfall** — cyan forces (SW) vs three rival AI armies — **Ember**, **Ash**, and **Cinder** — on a **16×16** tabletop grid. **Wipeout only:** defeat every rival unit to win (~5–15 minutes).

## How to play (quick)

1. Tap a **cyan** unit to select it.
2. Tap a **blue** tile to move, or a **red** enemy to attack.
3. Tap **End Turn** — Ember, Ash, and Cinder move automatically.
4. **Win** by wiping out all rival armies. **Lose** if your army is wiped.

**Armies:** Cyan (you, SW) · Ember (SE) · Ash (NW) · Cinder (NE) — 10 units each (1 Bastion, 5 Infantry, 4 Archers).

**Units:** Infantry (move 3, melee) · Archer (move 2, ranged) · Bastion (move 2, high HP, melee).

**Camera:** drag with one finger to orbit; pinch to zoom.

**After an update:** hard-refresh the page, or clear site data for this origin, so the service worker picks up the new cache. URL `?fresh=1` forces update toast.

## Run locally

From this directory:

```bash
cd /workspace/ipad-strategy-pwa
python3 -m http.server 8080 --bind 0.0.0.0
```

Then open:

- On this machine: http://127.0.0.1:8080/
- On iPad (same LAN): http://<this-computer-LAN-IP>:8080/

> Modules and the service worker need a real HTTP origin (not `file://`).

## Install on iPad (Add to Home Screen)

**HTTPS is strongly preferred** for a smooth PWA / standalone experience. If you only have HTTP on the LAN, Safari may still allow Add to Home Screen, but behavior can vary by iOS version.

1. On the iPad, open **Safari** (not Chrome).
2. Go to the game URL (LAN HTTP or public HTTPS tunnel).
3. Play once to confirm WebGL works (landscape or portrait).
4. Tap the **Share** button (square with arrow).
5. Scroll and tap **Add to Home Screen**.
6. Confirm the name **Gridfall** and tap **Add**.
7. Launch from the Home Screen icon — it should open **standalone** (no Safari chrome).

### Apple meta / icons included

- `manifest.webmanifest` — `name`, `short_name`, `display: standalone`, theme/background colors, 192 & 512 icons
- `icons/apple-touch-icon.png` (180×180) + `icons/icon-192.png` + `icons/icon-512.png`
- Viewport + `apple-mobile-web-app-capable` meta tags

## What this PWA proves vs native / TestFlight

| | This PWA proof | Native (TestFlight / App Store) |
|---|---|---|
| Install icon on Home Screen | Yes (via Safari) | Yes |
| Runs offline-ish after cache | Limited (demo service worker) | Full app bundle |
| App Store listing / review | No | Yes |
| Push, deep IAP, full Game Center, etc. | Limited / not the goal | Available with native APIs |
| Needs Apple Developer Program | **No** for this path | **Yes** for TestFlight/App Store |
| Distribution | URL / QR / LAN | App Store Connect |

This proves: **WebGL game + web app manifest + touch icons → Add to Home Screen on iPad.** It does **not** replace a signed `.ipa` or App Store distribution.

## Project layout

```
ipad-strategy-pwa/
  index.html
  manifest.webmanifest
  sw.js
  css/styles.css
  js/main.js
  icons/apple-touch-icon.png
  icons/icon-192.png
  icons/icon-512.png
  README.md
```

## Tech notes

- Static front-end only; Three.js loaded from jsDelivr CDN via import map.
- Touch-first HUD (large buttons, tap-to-select / tap-to-act; no hover-only UX).
- Optional service worker caches the app shell for demo reopen; **hard-refresh or clear site data** after updates so the new cache version loads.


## Current hosting (this box)

If a server is already running:

- **Local / LAN:** http://0.0.0.0:8080/ (from other devices on the same network, use this machine's LAN IP on port **8080**)
- **Public HTTPS (cloudflared quick tunnel):** check the active tunnel URL printed by `cloudflared` (trycloudflare.com). Quick tunnels are temporary and change when restarted.

Restart server:

```bash
cd /workspace/ipad-strategy-pwa
python3 -m http.server 8080 --bind 0.0.0.0
```

Optional HTTPS tunnel:

```bash
cloudflared tunnel --url http://127.0.0.1:8080
```
