# Flipaper — notes for Claude

Flipaper is a personal macOS app for **Nevertheless_D**, who is not a programmer.
Talk to them in Korean, in plain words. Never ask them to use Terminal; give them a double-clickable result.
(The GitHub repo is spelled `NeverthelessD/Filpaper`; the app itself is **Flipaper**.)

## What it is

A "script-type" app: `Flipaper.app/Contents/MacOS/Flipaper` is a bash launcher (`app/launcher.sh`). It copies
`Contents/Resources/flipaper-<arm64|x86_64>` (Go binaries) to `~/Library/Application Support/Flipaper/bin/`,
starts it on 127.0.0.1 with a random token, and opens the UI in a Chrome/Edge/Brave `--app` window (or the default browser).

- `engine/` — Go (+ golang.org/x/image). Embeds `web/`.
  - `main.go` routes/settings/folder picker · `images.go` image decode/resize · `pdf.go` PDF handling
  - `update.go` auto-update from `releases/latest.json` in this repo (raw.githubusercontent.com), sha256 check,
    swaps the .app (backup kept in Support/backup for rollback), restart keeps port+token so the open window reloads.
- `engine/web/` — `index.html`, `app.css`, `app.js` (single file; update UI is the "버전 · 업데이트" section), `assets/` (pdf-lib, pdf.js).

Design: coral→amber gradient (#ff6b4a → #ffb547), warm light / charcoal dark. Footer must say `made by. Nevertheless_D`.

## Releasing an update (this is how the user's app updates itself)

1. Make the change. Bump `VERSION` (semver, e.g. 1.1.1).
2. `scripts/build.sh --notes "바뀐 점 1" "바뀐 점 2"` (Korean, user-facing). Writes `releases/Flipaper-<v>.zip` and `releases/latest.json`.
3. Commit everything (including the zip and latest.json) and push to `main`. Installed apps pick it up within 6 hours or via the version badge.
4. Keep only the three newest zips in `releases/`.
5. Also send the user `dist/Flipaper.zip` for a fresh install if they ask.

Never publish a `latest.json` whose zip is missing or whose `version.txt` differs — the app verifies both.
Commit as `Nevertheless_D <NeverthelessD@users.noreply.github.com>`.

## Testing without a Mac

`go build -o /tmp/flip ./engine`, run with `FLIPAPER_SUPPORT`, `FLIPAPER_TOKEN`, `FLIPAPER_TEST_CHOOSE` (fake folder picker),
`FLIPAPER_APP` (fake .app path), `FLIPAPER_UPDATE_URL` (local latest.json). For an update test, make a fake
`Flipaper.app` with a Linux engine named `flipaper-x86_64`, set `HOME` to a temp dir and run the launcher with bash.
Drive the UI with Playwright (Chromium is preinstalled).
