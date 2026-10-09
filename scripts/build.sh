#!/bin/bash
# Flipaper 빌드 스크립트 — Flipaper.app 을 만들고 업데이트용 zip 과 releases/latest.json 을 씁니다.
#
#   scripts/build.sh                 # VERSION 파일의 버전으로 빌드
#   scripts/build.sh --notes "고친 점 1" "고친 점 2"
#
# 필요: Go 1.24+, python3 (Linux/macOS 어디서든 크로스 빌드됩니다)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(tr -d ' \n' < "$ROOT/VERSION")"
NOTES=()
if [ "${1:-}" = "--notes" ]; then shift; NOTES=("$@"); fi

DIST="$ROOT/dist"
APP="$DIST/Flipaper.app"
rm -rf "$DIST"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

for pair in "arm64:arm64" "amd64:x86_64"; do
  GA="${pair%%:*}"; MA="${pair##*:}"
  echo "▶ 엔진 빌드 (darwin/$GA, v$VERSION)"
  ( cd "$ROOT/engine" && CGO_ENABLED=0 GOOS=darwin GOARCH="$GA" \
      go build -trimpath -ldflags "-s -w -X main.build=$VERSION" -o "$APP/Contents/Resources/flipaper-$MA" . )
  chmod 755 "$APP/Contents/Resources/flipaper-$MA"
done

cp "$ROOT/app/launcher.sh" "$APP/Contents/MacOS/Flipaper"
chmod 755 "$APP/Contents/MacOS/Flipaper"
sed "s/__VERSION__/$VERSION/g" "$ROOT/app/Info.plist" > "$APP/Contents/Info.plist"
cp "$ROOT/app/AppIcon.icns" "$APP/Contents/Resources/AppIcon.icns"
printf '%s' "$VERSION" > "$APP/Contents/Resources/version.txt"
printf 'APPL????' > "$APP/Contents/PkgInfo"

ZIP="Flipaper-$VERSION.zip"
mkdir -p "$ROOT/releases"
python3 "$ROOT/scripts/zipapp.py" "$DIST" "Flipaper.app" "$ROOT/releases/$ZIP"
cp "$ROOT/releases/$ZIP" "$DIST/Flipaper.zip"

SHA="$(python3 -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$ROOT/releases/$ZIP")"
SIZE="$(python3 -c "import os,sys;print(os.path.getsize(sys.argv[1]))" "$ROOT/releases/$ZIP")"
python3 - "$ROOT/releases/latest.json" "$VERSION" "$ZIP" "$SHA" "$SIZE" "${NOTES[@]+"${NOTES[@]}"}" <<'PY'
import json, sys, datetime
path, ver, zipname, sha, size, *notes = sys.argv[1:]
json.dump({"version": ver, "date": datetime.date.today().isoformat(), "zip": zipname,
           "sha256": sha, "size": int(size), "notes": notes}, open(path, "w"), ensure_ascii=False, indent=2)
PY
echo "✔ $ROOT/releases/$ZIP ($SIZE bytes)"
echo "✔ releases/latest.json → v$VERSION"
