#!/usr/bin/env bash
# Install (or update) the extension for the current user.
#
#   ./install.sh            copy files, compile schemas, install the font, enable
#   ./install.sh --uninstall
set -euo pipefail

UUID="liquidglass-widgets@local"
HERE="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"
FONT_DIR="$HOME/.local/share/fonts/liquidglass-widgets"

if [[ "${1:-}" == "--uninstall" ]]; then
    gnome-extensions disable "$UUID" 2>/dev/null || true
    rm -rf "$DEST" "$FONT_DIR"
    fc-cache -f "$HOME/.local/share/fonts" >/dev/null 2>&1 || true
    echo "Removed $UUID. Log out and back in to clear it from GNOME Shell."
    exit 0
fi

rm -rf "$DEST"
mkdir -p "$DEST"
cp -r "$HERE/extension/." "$DEST/"
glib-compile-schemas "$DEST/schemas"

# GNOME Shell draws text through fontconfig, so the dial font has to be
# installed for the user rather than loaded from the extension folder.
mkdir -p "$FONT_DIR"
cp "$HERE/fonts/"*.otf "$HERE/fonts/"*.ttf "$FONT_DIR/"
fc-cache -f "$FONT_DIR" >/dev/null

if gnome-extensions enable "$UUID" 2>/dev/null; then
    echo "Installed and enabled $UUID."
    echo "If it was already running, log out and back in to load the new code."
else
    # A running Wayland session only discovers new extensions at login, so
    # mark it enabled now and it starts with the next session.
    current="$(gsettings get org.gnome.shell enabled-extensions)"
    if [[ "$current" != *"'$UUID'"* ]]; then
        if [[ "$current" == "@as []" || "$current" == "[]" ]]; then
            updated="['$UUID']"
        else
            updated="${current%]}, '$UUID']"
        fi
        gsettings set org.gnome.shell enabled-extensions "$updated"
    fi
    echo "Installed $UUID. Log out and back in to start it."
fi
