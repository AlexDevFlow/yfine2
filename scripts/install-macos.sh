#!/bin/bash
#
# Yfine — one-command macOS installer (Intel + Apple Silicon).
#
#   curl -fsSL https://raw.githubusercontent.com/AlexDevFlow/yfine2/main/scripts/install-macos.sh | bash
#
# Downloads the universal .dmg from the latest GitHub Release, copies Yfine.app
# into /Applications, and launches it.
#
# Why this exists: the release binaries are unsigned (free, open-source app), so
# an app copied out of a Finder-downloaded .dmg is quarantined and Gatekeeper
# blocks it. On macOS 15 (Sequoia) and later the old Control-click -> Open
# workaround no longer works at all. curl does not set the quarantine attribute,
# and `ditto --noqtn` refuses to propagate one, so the app installed by this
# script is never quarantined and simply opens.
#
# Usage:
#   install-macos.sh [--tag vX.Y.Z] [--dest DIR] [--force] [--no-launch]
#
# When piped into bash, pass flags after `-s --`:
#   curl -fsSL <url> | bash -s -- --force
#
# Copyright (c) 2026 AlexDevFlow. GPL-3.0-or-later.

set -euo pipefail

REPO="AlexDevFlow/yfine2"
APP_NAME="Yfine.app"
DEST="/Applications"
TAG=""
FORCE=0
LAUNCH=1

MNT=""
TMP=""

# --- output helpers -------------------------------------------------------
if [ -t 1 ]; then
  b=$(printf '\033[1m'); g=$(printf '\033[32m'); y=$(printf '\033[33m')
  r=$(printf '\033[31m'); n=$(printf '\033[0m')
else
  b=""; g=""; y=""; r=""; n=""
fi
say()  { printf '%s==>%s %s\n' "$g$b" "$n" "$*"; }
warn() { printf '%s==>%s %s\n' "$y$b" "$n" "$*" >&2; }
die()  { printf '%sError:%s %s\n' "$r$b" "$n" "$*" >&2; exit 1; }

cleanup() {
  if [ -n "$MNT" ] && [ -d "$MNT" ]; then
    hdiutil detach "$MNT" -quiet 2>/dev/null \
      || hdiutil detach "$MNT" -force -quiet 2>/dev/null \
      || true
    rmdir "$MNT" 2>/dev/null || true
  fi
  [ -n "$TMP" ] && rm -rf "$TMP"
  return 0
}
trap cleanup EXIT INT TERM

# Ask on the real terminal, so this still works when the script arrives on stdin
# through a `curl | bash` pipe.
# `[ -r /dev/tty ]` is not enough: the device node exists and is readable, but
# opening it fails with ENXIO when there is no controlling terminal (cron, CI,
# `setsid`). Probe it with a real open instead.
confirm() {
  local reply
  { : < /dev/tty; } 2>/dev/null || return 1
  printf '%s [y/N] ' "$1" > /dev/tty
  read -r reply < /dev/tty || reply=""
  case "$reply" in [yY]|[yY][eE][sS]) return 0 ;; *) return 1 ;; esac
}

# --- arguments ------------------------------------------------------------
while [ $# -gt 0 ]; do
  case "$1" in
    --tag)        TAG="${2:-}"; [ -n "$TAG" ] || die "--tag needs a value (e.g. v0.1.0)"; shift 2 ;;
    --dest)       DEST="${2:-}"; [ -n "$DEST" ] || die "--dest needs a directory"; shift 2 ;;
    --force|-f)   FORCE=1; shift ;;
    --no-launch)  LAUNCH=0; shift ;;
    -h|--help)
      cat <<'USAGE'
Yfine — one-command macOS installer (Intel + Apple Silicon).

  install-macos.sh [--tag vX.Y.Z] [--dest DIR] [--force] [--no-launch]

  --tag vX.Y.Z   install a specific release instead of the latest
  --dest DIR     install somewhere other than /Applications
  --force, -f    replace an existing install without asking
  --no-launch    install but don't open the app afterwards

When piped into bash, pass flags after `-s --`:
  curl -fsSL <url> | bash -s -- --force
USAGE
      exit 0 ;;
    *)            die "unknown option: $1 (try --help)" ;;
  esac
done

# --- preflight ------------------------------------------------------------
[ "$(uname -s)" = "Darwin" ] || die "this installer is for macOS. On Linux/Windows grab the installer from https://github.com/$REPO/releases"
command -v curl    >/dev/null 2>&1 || die "curl not found"
command -v hdiutil >/dev/null 2>&1 || die "hdiutil not found"
command -v ditto   >/dev/null 2>&1 || die "ditto not found"

case "$(uname -m)" in
  x86_64) say "Detected Intel Mac (x86_64) — installing the universal build." ;;
  arm64)  say "Detected Apple Silicon Mac (arm64) — installing the universal build." ;;
  *)      warn "Unrecognised architecture '$(uname -m)'. Trying the universal build anyway." ;;
esac

[ -d "$DEST" ] || die "destination '$DEST' does not exist"
[ -w "$DEST" ] || die "no write permission on '$DEST'. Re-run with --dest \"\$HOME/Applications\", or with sudo."

# --- resolve the release --------------------------------------------------
if [ -n "$TAG" ]; then
  API="https://api.github.com/repos/$REPO/releases/tags/$TAG"
else
  API="https://api.github.com/repos/$REPO/releases/latest"
fi

say "Looking up the ${TAG:-latest} release of $REPO…"
if ! JSON=$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API" 2>/dev/null); then
  # Re-ask for just the status code so the failure message is accurate.
  CODE=$(curl -sS -o /dev/null -w '%{http_code}' -H 'Accept: application/vnd.github+json' "$API" 2>/dev/null || echo 000)
  if [ -n "$TAG" ]; then MISSING="no release tagged '$TAG'"; else MISSING="no published release"; fi
  case "$CODE" in
    404)     die "$MISSING found. See https://github.com/$REPO/releases" ;;
    403|429) die "GitHub API rate limit reached. Wait a few minutes, or download the .dmg by hand from https://github.com/$REPO/releases" ;;
    000)     die "could not reach the GitHub API — check your internet connection" ;;
    *)       die "GitHub API returned HTTP $CODE" ;;
  esac
fi

# `|| true` on each: a no-match grep exits 1, which under `set -o pipefail`
# would kill the script before we can print a useful message.
VERSION=$(printf '%s' "$JSON" \
  | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 | sed 's/.*"\([^"]*\)"$/\1/' || true)

URL=$(printf '%s' "$JSON" \
  | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*universal\.dmg"' \
  | head -1 | sed 's/.*"\(https:[^"]*\)"$/\1/' || true)

[ -n "$URL" ] || die "the ${TAG:-latest} release has no universal .dmg asset. See https://github.com/$REPO/releases"
say "Found ${b}Yfine ${VERSION:-?}${n}"

# --- download -------------------------------------------------------------
TMP=$(mktemp -d "${TMPDIR:-/tmp}/yfine-install.XXXXXX")
DMG="$TMP/yfine.dmg"

say "Downloading $(basename "$URL")…"
curl -fL --progress-bar -o "$DMG" "$URL" || die "download failed"
[ -s "$DMG" ] || die "downloaded file is empty"

if command -v shasum >/dev/null 2>&1; then
  say "SHA-256: $(shasum -a 256 "$DMG" | cut -d' ' -f1)"
fi

# --- mount & copy ---------------------------------------------------------
MNT=$(mktemp -d "${TMPDIR:-/tmp}/yfine-mnt.XXXXXX")
say "Mounting the disk image…"
hdiutil attach "$DMG" -nobrowse -readonly -quiet -mountpoint "$MNT" \
  || die "could not mount the .dmg (corrupt download?)"

SRC=$(find "$MNT" -maxdepth 1 -name '*.app' -print 2>/dev/null | head -1 || true)
[ -n "$SRC" ] || die "no .app bundle found inside the disk image"
APP_NAME=$(basename "$SRC")
TARGET="$DEST/$APP_NAME"

if [ -e "$TARGET" ]; then
  OLD=$(defaults read "$TARGET/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo "unknown")
  warn "$TARGET already exists (version $OLD) and will be replaced by ${VERSION:-the new build}."
  warn "Your data lives in ~/Library/Application Support and is not touched."
  if [ "$FORCE" -ne 1 ] && ! confirm "Replace it?"; then
    die "aborted — nothing was changed. Re-run with --force to skip this prompt."
  fi
  rm -rf "$TARGET"
fi

# --noqtn: never carry a quarantine flag over, so Gatekeeper doesn't block the
# unsigned bundle on first launch.
say "Installing to $TARGET…"
ditto --noqtn "$SRC" "$TARGET" || die "copy failed"

hdiutil detach "$MNT" -quiet 2>/dev/null || hdiutil detach "$MNT" -force -quiet 2>/dev/null || true
rmdir "$MNT" 2>/dev/null || true
MNT=""

# Belt and braces: strip any quarantine attribute that survived. `xattr` is a
# python3 script on current macOS and may be unavailable without the Xcode
# command line tools, so this is strictly best-effort — `ditto --noqtn` above is
# what actually guarantees the clean install.
if command -v xattr >/dev/null 2>&1; then
  xattr -dr com.apple.quarantine "$TARGET" >/dev/null 2>&1 || true
fi

say "${b}Yfine ${VERSION:-} installed.${n}"

if [ "$LAUNCH" -eq 1 ]; then
  say "Launching…"
  open "$TARGET" || warn "could not launch automatically — open it from $DEST"
else
  say "Open it from $DEST when you're ready."
fi
