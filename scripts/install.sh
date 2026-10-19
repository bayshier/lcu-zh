#!/bin/sh
# Install LCU on Linux or macOS: find the locally installed ChatGPT app, check its Node, and run the Node
# installer (scripts/install.mjs) on it with all arguments. The app is never downloaded or installed here.
set -eu

fail() { printf 'LCU installer: %s\n' "$*" >&2; exit 1; }

self=$0
while [ -L "$self" ]; do
  link=$(readlink -- "$self")
  case $self in */*) dir=${self%/*} ;; *) dir=. ;; esac
  case $link in /*) self=$link ;; *) self=$dir/$link ;; esac
done
case $self in */*) source_dir=$(cd -P -- "${self%/*}/.." && pwd -P) ;; *) source_dir=$(cd -P .. && pwd -P) ;; esac

# The app the installer will select: --existing-app (either spelling), else the platform default.
system=$(uname -s)
case $system in
  Linux) app=/usr/lib/chatgpt ;;
  Darwin) app=/Applications/ChatGPT.app ;;
  *) fail 'LCU installation currently supports Linux and macOS.' ;;
esac
take=
for arg do
  if [ -n "$take" ]; then app=$arg; take=; continue; fi
  case $arg in
    --existing-app) take=1 ;;
    --existing-app=*) app=${arg#--existing-app=} ;;
  esac
done
case $app in '~') app=$HOME ;; '~/'*) app=$HOME/${app#'~/'} ;; esac

if [ "$system" = Darwin ]; then node_dir=$app/Contents/Resources/cua_node/bin; else node_dir=$app/resources/cua_node/bin; fi
if ! node_dir=$(cd -P -- "$node_dir" 2>/dev/null && pwd -P) || [ ! -f "$node_dir/node" ] || [ ! -x "$node_dir/node" ]; then
  # `--help` works without the app; the text is the one the Node installer prints.
  for arg do
    case $arg in -h|--help)
      while IFS= read -r line || [ -n "$line" ]; do printf '%s\n' "$line"; done < "$source_dir/scripts/install-usage.txt"
      exit 0 ;;
    esac
  done
  fail "LCU requires the official ChatGPT desktop app, which includes Codex, to be installed first. LCU does not download or install the app. No app with its Node was found at $app. Install it from https://chatgpt.com/download/ and rerun LCU. If it is installed elsewhere, pass --existing-app PATH."
fi
node=$node_dir/node
[ -L "$node" ] && fail "$node is a symbolic link; the app's Node must be a regular file."

# Check the Node before running it. Linux: it and every directory above it are owned by root or this account
# and writable by no other account (a sticky directory such as /tmp only lets others add entries); the
# installer then checks the whole app tree. macOS: the binary carries OpenAI's signature (the installer then
# verifies the app bundle and its helper).
# (A function, so `set --` leaves the installer's arguments alone.)
trusted() {
  # Split the listing into fields without globbing a name in it.
  set -f
  # shellcheck disable=SC2046
  set -- $(ls -ldn -- "$1")
  set +f
  case $3 in
    0|"$uid") ;;
    *)
      if [ "$uid" = 0 ]; then
        fail "$path is owned by uid $3. Installing as root would run that account's copy of the app's Node as root, which would let that account run code as root. Run the installer as the account that owns the app (provision system packages first and pass --skip-system), or make the app owned by root."
      fi
      fail "$path is owned by uid $3; the app must be owned by root or this account." ;;
  esac
  case $1 in
    d????????t*|d????????T*|l*) ;;
    ?????w*|????????w*) fail "$path is writable by other accounts; make it writable only by its owner." ;;
  esac
}
if [ "$system" = Linux ]; then
  uid=$(id -u)
  path=$node
  while :; do
    trusted "$path"
    [ "$path" = / ] && break
    path=${path%/*}
    [ -n "$path" ] || path=/
  done
else
  /usr/bin/codesign --verify --strict \
    -R='anchor apple generic and certificate leaf[subject.OU] = "2DC432GLL2"' "$node" 2>/dev/null ||
    fail "$node is not signed by OpenAI; reinstall the ChatGPT app."
fi

exec "$node" "$source_dir/scripts/install.mjs" "$@"
