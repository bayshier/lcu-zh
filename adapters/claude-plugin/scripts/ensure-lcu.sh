#!/bin/sh
# SessionStart hook of the LCU plugin for Claude Code.
#
# Adding the plugin is the whole setup. When LCU is missing, this installs it from the
# latest release after checking the archive against the SHA-256 the release publishes,
# then registers Claude Code with `lcu setup --agent claude-code`. Registration stays with
# `lcu setup`, so the MCP entry, lifecycle hooks, deny rules and the lcu-approve mod are
# the ones a manual setup writes. A plugin-scoped MCP entry would be named `plugin:lcu:lcu`
# and its tools `mcp__plugin_lcu_lcu__*`, which none of those match.
#
# Once an installation is registered, later sessions leave after one file comparison and a
# check that Claude Code's configuration still has the `lcu` server.
set -eu

REPO=https://github.com/amontlabs/lcu
GUIDE=$REPO/blob/main/docs/INSTALLATION.md

# A path given as `~` or `~/...` (quoted, so the shell did not expand it), as the installer accepts.
# shellcheck disable=SC2088 # the literal tilde is what is matched
expand() {
  case "$1" in
    "~") printf '%s' "$HOME" ;;
    "~/"*) printf '%s/%s' "$HOME" "${1#"~/"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

state=${CLAUDE_PLUGIN_DATA:-$HOME/.local/state/lcu/claude-plugin}
prefix=$(expand "${LCU_PREFIX:-$HOME/.local/share/lcu}")
app=$(expand "${LCU_APP:-/Applications/ChatGPT.app}")
lcu=$prefix/current/bin/lcu
registered=$state/registered

# The marker alone would outlive a registration removed from Claude Code's configuration.
if [ -x "$lcu" ] && [ "$(cat "$registered" 2>/dev/null || true)" = "$lcu" ] &&
    plutil -extract mcpServers.lcu json -o /dev/null "$HOME/.claude.json" >/dev/null 2>&1; then
  exit 0
fi

# One line for the person, as the hook's JSON output. The session starts either way.
tell() {
  printf '{"systemMessage": "LCU plugin: %s"}\n' \
    "$(printf '%s' "$*" | tr -s '[:cntrl:]' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')"
  exit 0
}

# The same, for a condition that a new session does not change: said once, then quiet.
tell_once() {
  stamp=$state/told-$1
  shift
  [ ! -e "$stamp" ] || exit 0
  mkdir -p "$state"
  : > "$stamp"
  tell "$@"
}

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) ;;
  *) tell_once platform "it installs and registers LCU on Apple Silicon macOS only." \
       "On Linux, install and register LCU by hand: $GUIDE#linux" ;;
esac

# `lcu setup` writes Claude Code's default configuration and refuses a redirected one.
[ -z "${CLAUDE_CONFIG_DIR:-}" ] ||
  tell_once config-dir "CLAUDE_CONFIG_DIR is set, and lcu setup registers only the default" \
    "Claude Code configuration. Unset it, or register by hand: $GUIDE"

# Sessions can start together; one of them does the work.
mkdir -p "$state"
lock=$state/lock
if ! mkdir "$lock" 2>/dev/null; then
  # A lock that outlived the hook's timeout belongs to a session that died.
  [ -n "$(find "$lock" -maxdepth 0 -mmin +10 2>/dev/null)" ] || exit 0
  rmdir "$lock" 2>/dev/null || exit 0
  mkdir "$lock" 2>/dev/null || exit 0
fi
work=
cleanup() {
  rmdir "$lock" 2>/dev/null || true
  [ -z "$work" ] || rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

log=$state/setup.log
: > "$log"
outcome="is registered"

if [ ! -x "$lcu" ]; then
  # Check what the installer needs before downloading it, so a missing prerequisite does
  # not fetch the archive again in every session.
  [ -d "$app" ] ||
    tell "LCU needs the official ChatGPT desktop app, which it never installs. Get it from" \
      "https://chatgpt.com/download/ and start a new session. For an app outside" \
      "/Applications, set LCU_APP to its path."
  # The tag comes from the redirect of /releases/latest, as in `lcu update`: no API, no rate limit.
  latest=$(curl -fsS --proto '=https' --max-time 20 -o /dev/null -w '%{redirect_url}' \
    -I "$REPO/releases/latest" 2>>"$log") ||
    tell "could not reach GitHub to find the latest LCU release. The next session tries again."
  tag=${latest#"$REPO/releases/tag/"}
  printf '%s\n' "$tag" | grep -Eq '^v[0-9]+\.[0-9]+\.[0-9]+$' ||
    tell "unexpected answer while looking for the latest LCU release. The next session tries again."
  archive=lcu-${tag#v}-darwin-arm64.tar.gz
  url=$REPO/releases/download/$tag/$archive

  work=$(mktemp -d "${TMPDIR:-/tmp}/lcu-plugin.XXXXXX")
  { curl -fsSL --proto '=https' --proto-redir '=https' --max-time 240 \
      -o "$work/$archive" "$url" 2>>"$log" &&
    curl -fsSL --proto '=https' --proto-redir '=https' --max-time 20 \
      -o "$work/$archive.sha256" "$url.sha256" 2>>"$log"; } ||
    tell "could not download $archive. The next session tries again."
  expected=$(awk -v name="$archive" \
    'NF == 1 || $NF == name || $NF == "*" name { print tolower($1); exit }' "$work/$archive.sha256")
  actual=$(shasum -a 256 "$work/$archive" | awk '{ print $1 }')
  { printf '%s\n' "$expected" | grep -Eq '^[0-9a-f]{64}$' && [ "$expected" = "$actual" ]; } ||
    tell "the downloaded $archive does not match its published SHA-256, so nothing was installed."
  { tar -xzf "$work/$archive" -C "$work" 2>>"$log" &&
    [ -f "$work/${archive%.tar.gz}/scripts/install.sh" ]; } ||
    tell "$archive is not an LCU release bundle, so nothing was installed."

  "$work/${archive%.tar.gz}/scripts/install.sh" --prefix "$prefix" --existing-app "$app" \
    --runtime-only >>"$log" 2>&1 ||
    tell "the LCU installer failed: $(tail -n 2 "$log") Full output: $log"
  outcome="${tag#v} was installed and registered"
fi

"$lcu" setup --prefix "$prefix" --agent claude-code --yes >>"$log" 2>&1 ||
  tell "registering Claude Code failed: $(tail -n 2 "$log") Full output: $log"
printf '%s\n' "$lcu" > "$registered"
tell "LCU $outcome for Claude Code. Restart Claude Code to load it, then run this in a" \
  "terminal to check macOS permissions: $lcu doctor"
