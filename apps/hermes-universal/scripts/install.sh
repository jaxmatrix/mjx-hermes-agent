#!/usr/bin/env bash
#
# System-wide installer for Hermes Universal (Linux).
#
# `tauri build` only *produces* artifacts under target/release/bundle; it never
# installs them, and it gives you no way back out. This script closes that gap: it
# builds if needed, installs the app so it is on $PATH and in the application
# launcher, and can remove it again.
#
# It also handles the two states that make a hand-rolled `dpkg -i` go wrong here:
# the version is pinned at 0.0.1 and never moves, so apt can decide a rebuild is
# "already the newest version" and install nothing; and a previously failed
# install can leave the package registered with dpkg while its binary is gone
# (`dpkg -V hermes` -> "missing /usr/bin/hermes-universal"), which no plain
# install command repairs. Both are handled by forcing --reinstall.
#
# Two install methods:
#
#   deb       — hand the .deb to apt. Debian/Ubuntu/Pop!_OS only. Dependencies are
#               resolved automatically and the app becomes a real dpkg package, so
#               `apt remove hermes` works. This is the default where apt exists.
#   portable  — copy the single self-contained binary plus a .desktop entry and
#               icons under a prefix (/usr/local system-wide, ~/.local for --user).
#               Works on any distro, needs no package manager, and is the only
#               option for --user installs.
#
# Both methods verify the runtime libraries the webview links against before they
# put anything on disk, because a Tauri binary that is missing libwebkit2gtk exits
# with a bare loader error that says nothing about what to install.
#
# Usage: ./scripts/install.sh [options]   (see --help)

set -euo pipefail

# --- Paths --------------------------------------------------------------------

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname -- "$SCRIPT_DIR")"        # apps/hermes-universal
TAURI_DIR="$APP_DIR/src-tauri"
BUNDLE_DIR="$TAURI_DIR/target/release/bundle"

# Stable identifiers. APP_ID doubles as the icon/desktop-entry basename, so it must
# not collide with anything else in the hicolor theme.
APP_ID="hermes-universal"
APP_NAME="Hermes"
DEB_PACKAGE="hermes"                          # dpkg name tauri derives from productName

# --- Options ------------------------------------------------------------------

METHOD="auto"        # auto | deb | portable
SCOPE="system"       # system | user
PREFIX=""            # defaults per scope
BUILD="auto"         # auto | always | never
ARTIFACT=""          # explicit .deb / binary to install instead of building
ASSUME_YES=0
UNINSTALL=0

usage() {
  cat <<EOF
Install Hermes Universal system-wide.

Usage: $0 [options]

Options:
  --deb                 Install via apt using the .deb bundle (Debian/Ubuntu).
  --portable            Install the raw binary + desktop entry under a prefix.
                        (default: --deb where apt exists, else --portable)
  --user                Install for the current user only, into ~/.local.
                        Needs no root. Implies --portable.
  --prefix DIR          Portable install prefix (default: /usr/local, or
                        ~/.local with --user).
  --build               Force a fresh release build even if artifacts exist.
  --no-build            Never build; fail if no artifact is available.
  --artifact PATH       Install this .deb or this prebuilt binary directly.
  --uninstall           Remove a previously installed Hermes Universal.
  -y, --yes             Do not prompt; answer yes to package installs.
  -h, --help            Show this help.

Examples:
  sudo ./scripts/install.sh                 # build + install system-wide
  ./scripts/install.sh --user               # no root, into ~/.local
  ./scripts/install.sh --portable --no-build --artifact ./Hermes
  sudo ./scripts/install.sh --uninstall
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --deb)        METHOD="deb" ;;
    --portable)   METHOD="portable" ;;
    --user)       SCOPE="user"; METHOD="portable" ;;
    --prefix)     PREFIX="${2:?--prefix needs a directory}"; shift ;;
    --build)      BUILD="always" ;;
    --no-build)   BUILD="never" ;;
    --artifact)   ARTIFACT="${2:?--artifact needs a path}"; shift ;;
    --uninstall)  UNINSTALL=1 ;;
    -y|--yes)     ASSUME_YES=1 ;;
    -h|--help)    usage; exit 0 ;;
    *)            echo "unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
  shift
done

# --- Output helpers -----------------------------------------------------------

if [[ -t 1 ]]; then
  BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GREEN=$'\033[32m'
  YELLOW=$'\033[33m'; RESET=$'\033[0m'
else
  BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

info()  { echo "${BOLD}==>${RESET} $*"; }
warn()  { echo "${YELLOW}warning:${RESET} $*" >&2; }
die()   { echo "${RED}error:${RESET} $*" >&2; exit 1; }
ok()    { echo "${GREEN}✓${RESET} $*"; }
note()  { echo "${DIM}    $*${RESET}"; }

# Run a command as root. Inside `sudo ./install.sh` we are already root and sudo
# may not even be on $PATH, so only reach for it when we actually need to.
as_root() {
  if [[ $EUID -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    die "need root for this step and sudo is not installed. Re-run as root, or use --user."
  fi
}

confirm() {
  [[ $ASSUME_YES -eq 1 ]] && return 0
  local reply
  read -r -p "$1 [Y/n] " reply </dev/tty || return 1
  [[ -z "$reply" || "$reply" =~ ^[Yy] ]]
}

# --- Resolve scope / prefix ---------------------------------------------------

if [[ "$SCOPE" == "user" ]]; then
  PREFIX="${PREFIX:-$HOME/.local}"
else
  PREFIX="${PREFIX:-/usr/local}"
fi

# Where a portable install puts things. The manifest lets --uninstall delete
# exactly what was written instead of guessing at paths.
BIN_PATH="$PREFIX/bin/$APP_ID"
LIB_DIR="$PREFIX/lib/$APP_ID"
DESKTOP_FILE="$PREFIX/share/applications/$APP_ID.desktop"
ICON_ROOT="$PREFIX/share/icons/hicolor"
MANIFEST="$PREFIX/share/$APP_ID/install-manifest.txt"

# Portable system-wide installs write outside $HOME, so they need root.
maybe_root() {
  if [[ "$SCOPE" == "user" ]]; then
    "$@"
  else
    as_root "$@"
  fi
}

# --- Install state ------------------------------------------------------------

# `dpkg -s` exits 0 for packages that are merely deconfigured or left with config
# files, and even for one whose files were deleted out from under dpkg — which is
# exactly the broken state a failed install leaves behind. Match on the Status
# field, then confirm the binary is really there.
deb_installed() {
  command -v dpkg >/dev/null 2>&1 || return 1
  dpkg -s "$DEB_PACKAGE" 2>/dev/null | grep -q '^Status: install ok installed'
}

# Registered with dpkg but the payload is gone. Reinstalling over the top is the
# fix; apt will not do it on its own because it believes the package is present.
deb_broken() {
  deb_installed || return 1
  local f
  while IFS= read -r f; do
    [[ "$f" == /usr/bin/* ]] || continue
    [[ -e "$f" ]] || return 0
  done < <(dpkg -L "$DEB_PACKAGE" 2>/dev/null)
  return 1
}

portable_installed() {
  local prefix
  for prefix in /usr/local "$HOME/.local" "$PREFIX"; do
    [[ -f "$prefix/share/$APP_ID/install-manifest.txt" ]] && return 0
  done
  return 1
}

# --- Uninstall ----------------------------------------------------------------

do_uninstall() {
  local removed=0

  # dpkg-managed install, if there is one. Use `dpkg -s` directly rather than
  # deb_installed(), so a half-removed or file-less entry still gets purged.
  # Skipped for --user: that package is system-scope and removing it needs root,
  # which a per-user uninstall has no business demanding.
  if [[ "$SCOPE" != "user" ]] &&
     command -v dpkg >/dev/null 2>&1 && dpkg -s "$DEB_PACKAGE" >/dev/null 2>&1; then
    info "Removing dpkg package '$DEB_PACKAGE'"
    # Non-fatal: if this needs a password we cannot supply, the portable cleanup
    # below must still run rather than `set -e` killing the whole uninstall.
    if as_root apt-get remove -y "$DEB_PACKAGE"; then
      removed=1
    else
      warn "could not remove the dpkg package; run: sudo apt remove $DEB_PACKAGE"
    fi
  elif [[ "$SCOPE" == "user" ]] &&
       command -v dpkg >/dev/null 2>&1 && dpkg -s "$DEB_PACKAGE" >/dev/null 2>&1; then
    note "A system-wide dpkg package '$DEB_PACKAGE' is also installed."
    note "Remove it with: sudo apt remove $DEB_PACKAGE"
  fi

  # Portable install(s). A system-scope uninstall sweeps the usual prefixes so it
  # still finds the install when the user forgot which one they used; a --user
  # uninstall stays inside $HOME so it never needs root.
  local -a prefixes=("$PREFIX" "$HOME/.local")
  [[ "$SCOPE" != "user" ]] && prefixes+=(/usr/local)

  local prefix
  for prefix in "${prefixes[@]}"; do
    local manifest="$prefix/share/$APP_ID/install-manifest.txt"
    [[ -f "$manifest" ]] || continue
    info "Removing portable install under $prefix"
    local path
    while IFS= read -r path; do
      [[ -n "$path" ]] || continue
      if [[ "$prefix" == "$HOME/"* ]]; then
        rm -f -- "$path"
      else
        as_root rm -f -- "$path"
      fi
    done <"$manifest"
    if [[ "$prefix" == "$HOME/"* ]]; then
      rm -rf -- "${prefix:?}/lib/${APP_ID:?}" "${prefix:?}/share/${APP_ID:?}"
    else
      as_root rm -rf -- "${prefix:?}/lib/${APP_ID:?}" "${prefix:?}/share/${APP_ID:?}"
    fi
    refresh_desktop_db "$prefix"
    removed=1
  done

  if [[ $removed -eq 0 ]]; then
    warn "nothing to uninstall — no dpkg package and no install manifest found."
    return 0
  fi
  ok "Hermes Universal removed."
  note "User data (settings, keyring entries) was left in place."
}

# --- Runtime dependency preflight ---------------------------------------------

# Libraries the built binary dlopen()s or links against. Missing ones produce a
# loader error at launch with no hint about the package name, so name them here.
# Format: "soname|apt package|dnf package|pacman package"
RUNTIME_LIBS=(
  "libwebkit2gtk-4.1.so.0|libwebkit2gtk-4.1-0|webkit2gtk4.1|webkit2gtk-4.1"
  "libjavascriptcoregtk-4.1.so.0|libjavascriptcoregtk-4.1-0|javascriptcoregtk4.1|webkit2gtk-4.1"
  "libgtk-3.so.0|libgtk-3-0|gtk3|gtk3"
  "libasound.so.2|libasound2t64|alsa-lib|alsa-lib"
)

# Ask the dynamic loader, not the package manager: this stays correct on distros
# whose package names we do not know, and on Nix/Flatpak-ish setups.
have_lib() {
  ldconfig -p 2>/dev/null | grep -q "[[:space:]]$1[[:space:]]" && return 0
  # ldconfig misses some multiarch dirs on non-glibc systems; fall back to a search.
  local dir
  for dir in /usr/lib /usr/lib64 /usr/lib/x86_64-linux-gnu /lib/x86_64-linux-gnu; do
    [[ -e "$dir/$1" ]] && return 0
  done
  return 1
}

pkg_index() {
  # Which column of RUNTIME_LIBS applies to this host's package manager.
  if   command -v apt-get >/dev/null 2>&1; then echo 2
  elif command -v dnf     >/dev/null 2>&1; then echo 3
  elif command -v pacman  >/dev/null 2>&1; then echo 4
  else echo 0
  fi
}

install_packages() {
  local -a pkgs=("$@")
  [[ ${#pkgs[@]} -gt 0 ]] || return 0
  if   command -v apt-get >/dev/null 2>&1; then as_root apt-get install -y "${pkgs[@]}"
  elif command -v dnf     >/dev/null 2>&1; then as_root dnf install -y "${pkgs[@]}"
  elif command -v pacman  >/dev/null 2>&1; then as_root pacman -S --needed --noconfirm "${pkgs[@]}"
  else die "no supported package manager; install manually: ${pkgs[*]}"
  fi
}

check_runtime_deps() {
  local col missing_libs=() missing_pkgs=() entry soname pkg
  col="$(pkg_index)"

  for entry in "${RUNTIME_LIBS[@]}"; do
    IFS='|' read -r soname p_apt p_dnf p_pac <<<"$entry"
    have_lib "$soname" && continue
    missing_libs+=("$soname")
    case "$col" in
      2) pkg="$p_apt" ;; 3) pkg="$p_dnf" ;; 4) pkg="$p_pac" ;; *) pkg="" ;;
    esac
    [[ -n "$pkg" ]] && missing_pkgs+=("$pkg")
  done

  [[ ${#missing_libs[@]} -eq 0 ]] && { ok "Runtime libraries present."; return 0; }

  warn "missing runtime libraries: ${missing_libs[*]}"
  if [[ ${#missing_pkgs[@]} -eq 0 ]]; then
    die "install the packages providing those libraries, then re-run."
  fi
  # libasound2t64 only exists on Ubuntu 24.04+/Debian trixie+; older releases still
  # call it libasound2. Try the modern name and fall back rather than hard-failing.
  info "Installing: ${missing_pkgs[*]}"
  if ! confirm "Install these packages with the system package manager?"; then
    die "declined; cannot continue without those libraries."
  fi
  if ! install_packages "${missing_pkgs[@]}"; then
    local -a fallback=()
    local p
    for p in "${missing_pkgs[@]}"; do
      [[ "$p" == "libasound2t64" ]] && fallback+=("libasound2") || fallback+=("$p")
    done
    warn "retrying with legacy package names: ${fallback[*]}"
    install_packages "${fallback[@]}"
  fi
  ok "Runtime libraries installed."
}

# --- Build --------------------------------------------------------------------

# The deb bundler needs nothing beyond the build toolchain; AppImage additionally
# needs librsvg2-dev + patchelf (see README). We only ever build `deb`, so the
# check stays short.
check_build_deps() {
  command -v cargo >/dev/null 2>&1 || die "cargo not found — install Rust (https://rustup.rs) and re-run."
  command -v node  >/dev/null 2>&1 || die "node not found — the frontend build needs Node."
  if ! pkg-config --exists webkit2gtk-4.1 2>/dev/null; then
    die "webkit2gtk-4.1 development files missing. On Debian/Ubuntu:
    sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \\
      libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf"
  fi
}

# The package manager the app itself uses. pnpm is the repo standard; fall back to
# npm so the installer still works on a machine that only has npm.
frontend_pm() {
  if command -v pnpm >/dev/null 2>&1; then echo pnpm; else echo npm; fi
}

build_release() {
  check_build_deps
  local pm; pm="$(frontend_pm)"
  info "Building release bundle (this takes a while on a cold target/ dir)"
  ( cd "$APP_DIR" && "$pm" run tauri build -- --bundles deb )
}

# Locate the built .deb. Tauri writes it as bundle/deb/<name>_<version>_<arch>.deb.
find_deb() {
  local f
  f="$(find "$BUNDLE_DIR/deb" -maxdepth 1 -name '*.deb' -printf '%T@ %p\n' 2>/dev/null \
       | sort -rn | head -1 | cut -d' ' -f2-)"
  [[ -n "$f" ]] && echo "$f"
}

# Locate the built binary. Tauri names the main binary after `productName`, but the
# plain cargo name is also produced — accept whichever exists.
find_binary() {
  local candidate
  for candidate in "$TAURI_DIR/target/release/$APP_NAME" \
                   "$TAURI_DIR/target/release/$APP_ID" \
                   "$TAURI_DIR/target/release/hermes-universal"; do
    [[ -f "$candidate" && -x "$candidate" ]] && { echo "$candidate"; return 0; }
  done
  # Fall back to whatever the deb bundler staged, which is always the real binary.
  candidate="$(find "$BUNDLE_DIR/deb" -path '*/usr/bin/*' -type f -perm -u+x 2>/dev/null | head -1)"
  [[ -n "$candidate" ]] && echo "$candidate"
}

# Produce an artifact for the requested method, building only if we have to.
acquire_artifact() {
  local want="$1"   # deb | binary
  local found=""

  if [[ -n "$ARTIFACT" ]]; then
    [[ -e "$ARTIFACT" ]] || die "--artifact path does not exist: $ARTIFACT"
    echo "$ARTIFACT"; return 0
  fi

  if [[ "$BUILD" != "always" ]]; then
    [[ "$want" == "deb" ]] && found="$(find_deb)" || found="$(find_binary)"
  fi

  if [[ -z "$found" ]]; then
    [[ "$BUILD" == "never" ]] && die "no $want artifact found and --no-build was given."
    build_release >&2
    [[ "$want" == "deb" ]] && found="$(find_deb)" || found="$(find_binary)"
    [[ -n "$found" ]] || die "build finished but no $want artifact was produced under $BUNDLE_DIR."
  fi
  echo "$found"
}

# --- Install: deb -------------------------------------------------------------

install_deb() {
  command -v apt-get >/dev/null 2>&1 || die "--deb needs apt (Debian/Ubuntu). Use --portable instead."

  if portable_installed; then
    warn "a portable install already exists; you will end up with two launcher entries."
    note "Run '$0 --uninstall' first, or install with --portable to replace it."
  fi

  local deb; deb="$(acquire_artifact deb)"
  local -a apt_args=(install -y)

  # The app's version is pinned at 0.0.1 and rarely moves, so apt will happily
  # decide "already the newest version" and install nothing — including over a
  # registered-but-file-less package left by a failed install. Force it.
  if deb_installed; then
    if deb_broken; then
      warn "'$DEB_PACKAGE' is registered with dpkg but its files are missing — reinstalling over it."
    else
      info "'$DEB_PACKAGE' is already installed; reinstalling this build over it."
    fi
    apt_args+=(--reinstall)
  fi

  info "Installing $(basename "$deb") with apt"
  # `apt install ./file.deb` (not `dpkg -i`) so declared dependencies are resolved
  # instead of leaving dpkg in a half-configured state.
  as_root apt-get "${apt_args[@]}" "$(realpath "$deb")"
  ok "Installed as dpkg package '$DEB_PACKAGE'."
  local launcher
  launcher="$(dpkg -L "$DEB_PACKAGE" 2>/dev/null | grep -m1 '^/usr/bin/')" || true
  note "Launch with: ${launcher:-$APP_NAME}   (or from your application menu)"
  note "Uninstall with: sudo apt remove $DEB_PACKAGE"
}

# --- Install: portable --------------------------------------------------------

# Best-effort cache refresh so the launcher picks the entry up without a re-login.
# Neither tool is required, and neither failing should abort an otherwise good install.
refresh_desktop_db() {
  local prefix="$1"
  # Decide on root from the prefix, not the scope: a system-scope uninstall also
  # sweeps ~/.local, and prompting for a password to refresh a cache in $HOME is
  # both pointless and, when there is no tty, fatal.
  local -a run=(maybe_root)
  [[ "$prefix" == "$HOME/"* ]] && run=()
  if command -v update-desktop-database >/dev/null 2>&1; then
    "${run[@]}" update-desktop-database -q "$prefix/share/applications" 2>/dev/null || true
  fi
  if command -v gtk-update-icon-cache >/dev/null 2>&1; then
    "${run[@]}" gtk-update-icon-cache -qtf "$prefix/share/icons/hicolor" 2>/dev/null || true
  fi
}

install_portable() {
  # A leftover dpkg package ships its own /usr/share/applications/Hermes.desktop,
  # so leaving it in place means two launcher entries and a /usr/bin binary that
  # shadows ours on $PATH. Offer to take it out.
  if command -v dpkg >/dev/null 2>&1 && dpkg -s "$DEB_PACKAGE" >/dev/null 2>&1; then
    warn "the dpkg package '$DEB_PACKAGE' is installed and will conflict (duplicate launcher entry)."
    if [[ "$SCOPE" == "user" ]]; then
      note "Remove it with: sudo apt remove $DEB_PACKAGE"
    elif confirm "Remove the dpkg package first?"; then
      as_root apt-get remove -y "$DEB_PACKAGE"
    fi
  fi

  local bin; bin="$(acquire_artifact binary)"
  local -a written=()

  info "Installing to $PREFIX"

  # 1. Binary. It goes in lib/ with a bin/ symlink rather than straight into bin/,
  #    so anything we add later (sidecars, resources) has an obvious home.
  maybe_root install -d "$LIB_DIR" "$PREFIX/bin"
  maybe_root install -m 0755 "$bin" "$LIB_DIR/$APP_ID"
  maybe_root ln -sfn "$LIB_DIR/$APP_ID" "$BIN_PATH"
  written+=("$LIB_DIR/$APP_ID" "$BIN_PATH")

  # 2. Icons, mapped from Tauri's icon set into the hicolor theme. 128x128@2x is a
  #    256px image despite the name, so it lands in 256x256.
  local -a icons=("32x32.png:32x32" "128x128.png:128x128" "128x128@2x.png:256x256")
  local spec src size dest
  for spec in "${icons[@]}"; do
    src="$TAURI_DIR/icons/${spec%%:*}"
    size="${spec##*:}"
    [[ -f "$src" ]] || continue
    dest="$ICON_ROOT/$size/apps/$APP_ID.png"
    maybe_root install -Dm 0644 "$src" "$dest"
    written+=("$dest")
  done

  # 3. Desktop entry. StartupWMClass must match the toplevel's WM class — which
  #    tao derives from the cargo binary name, i.e. `hermes-universal`, NOT the
  #    productName — or the launcher shows a second, iconless entry once the
  #    window opens.
  local tmp_desktop; tmp_desktop="$(mktemp)"
  cat >"$tmp_desktop" <<EOF
[Desktop Entry]
Type=Application
Version=1.0
Name=$APP_NAME
GenericName=Hermes Universal client
Comment=Chat, workspace, terminal and gateway management in one app
Exec=$BIN_PATH %U
Icon=$APP_ID
Terminal=false
Categories=Development;
Keywords=hermes;agent;ai;llm;
StartupNotify=true
StartupWMClass=$APP_ID
EOF
  maybe_root install -Dm 0644 "$tmp_desktop" "$DESKTOP_FILE"
  rm -f "$tmp_desktop"
  written+=("$DESKTOP_FILE")

  # 4. Manifest, so --uninstall removes exactly these paths.
  local tmp_manifest; tmp_manifest="$(mktemp)"
  printf '%s\n' "${written[@]}" >"$tmp_manifest"
  maybe_root install -Dm 0644 "$tmp_manifest" "$MANIFEST"
  rm -f "$tmp_manifest"

  refresh_desktop_db "$PREFIX"

  ok "Installed $APP_NAME to $BIN_PATH"
  note "Launch with: $APP_ID   (or from your application menu)"
  if [[ "$SCOPE" == "user" ]]; then
    note "Uninstall with: $0 --uninstall --user"
  else
    note "Uninstall with: sudo $0 --uninstall"
  fi

  # A --user install is useless if ~/.local/bin is not on PATH; say so rather than
  # letting `hermes-universal` mysteriously not resolve.
  case ":$PATH:" in
    *":$PREFIX/bin:"*) ;;
    *) warn "$PREFIX/bin is not on your PATH. Add it to your shell profile:
      fish:  fish_add_path $PREFIX/bin
      bash:  export PATH=\"$PREFIX/bin:\$PATH\"" ;;
  esac
}

# --- Main ---------------------------------------------------------------------

[[ "$(uname -s)" == "Linux" ]] || die "this installer targets Linux. On macOS use the .dmg, on Windows the .msi/NSIS installer from \`tauri build\`."

if [[ $UNINSTALL -eq 1 ]]; then
  do_uninstall
  exit 0
fi

if [[ "$METHOD" == "auto" ]]; then
  if [[ "$SCOPE" == "system" ]] && command -v apt-get >/dev/null 2>&1; then
    METHOD="deb"
  else
    METHOD="portable"
  fi
fi

info "Method: $METHOD   Scope: $SCOPE$( [[ $METHOD == portable ]] && echo "   Prefix: $PREFIX" )"
check_runtime_deps

case "$METHOD" in
  deb)      install_deb ;;
  portable) install_portable ;;
  *)        die "unknown method: $METHOD" ;;
esac
