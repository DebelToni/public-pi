#!/bin/sh
set -eu

source_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
agent_dir=${PI_AGENT_DIR:-$HOME/.pi/agent}
state_dir=$agent_dir/codex-runtime-compat
root_file=$state_dir/root

find_root() {
	node - "$1" <<'NODE'
const fs = require("node:fs");
const path = require("node:path");
let current = path.dirname(fs.realpathSync(process.argv[2]));
while (true) {
  const manifest = path.join(current, "package.json");
  if (fs.existsSync(manifest)) {
    const value = JSON.parse(fs.readFileSync(manifest, "utf8"));
    if (value.name === "@earendil-works/pi-coding-agent") {
      process.stdout.write(current);
      process.exit(0);
    }
  }
  const parent = path.dirname(current);
  if (parent === current) break;
  current = parent;
}
process.exit(1);
NODE
}

root=
if [ -r "$root_file" ]; then
	root=$(cat "$root_file")
fi
if [ ! -f "$root/package.json" ]; then
	upstream_pi=$(command -v pi 2>/dev/null || true)
	[ -n "$upstream_pi" ] && [ -e "$upstream_pi" ] || {
		printf '%s\n' 'Cannot locate the installed pi command.' >&2
		exit 1
	}
	root=$(find_root "$upstream_pi") || {
		printf '%s\n' 'Cannot locate @earendil-works/pi-coding-agent from the installed pi command.' >&2
		exit 1
	}
fi

version=$(node -e 'const fs=require("node:fs"); const p=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(p.version)' "$root/package.json")
[ "$version" = 0.84.3 ] || {
	printf 'Expected Pi 0.84.3, found %s. Stop and obtain a reviewed compatibility release.\n' "$version" >&2
	exit 1
}
[ -w "$root/dist/core/agent-session.js" ] || {
	printf 'Pi package is not writable by this user: %s\n' "$root" >&2
	exit 1
}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup=$HOME/tmp/pi-codex-runtime-backup-$stamp
umask 077
mkdir -p "$backup" "$agent_dir/bin" "$state_dir"
tar -C "$(dirname "$root")" -czf "$backup/pi-coding-agent-0.84.3.tar.gz" "$(basename "$root")"
if command -v pi >/dev/null 2>&1; then
	command -v pi > "$backup/original-pi-command.txt"
fi
for name in pi pi-ensure-codex-runtime-patches pi-patch-awaited-extension-send-message pi-patch-codex-cache-affinity test_pi_awaited_extension_send_message.mjs; do
	if [ -e "$agent_dir/bin/$name" ] || [ -L "$agent_dir/bin/$name" ]; then
		cp -a "$agent_dir/bin/$name" "$backup/$name"
	fi
	install -m 0755 "$source_dir/$name" "$agent_dir/bin/$name"
done

temporary_root=$state_dir/.root.$$
printf '%s\n' "$root" > "$temporary_root"
chmod 0600 "$temporary_root"
mv -f "$temporary_root" "$root_file"
chmod 0600 "$root_file"

PI_CODING_AGENT_ROOT=$root "$agent_dir/bin/pi-ensure-codex-runtime-patches"
PI_CODING_AGENT_ROOT=$root node "$agent_dir/bin/test_pi_awaited_extension_send_message.mjs"
"$agent_dir/bin/pi" --version
"$agent_dir/bin/pi" --list-models >/dev/null
chmod -R go-rwx "$backup"
printf 'Installed Codex runtime compatibility for Pi %s.\n' "$version"
printf 'Backup: %s\n' "$backup"
printf 'Prepend %s/bin to PATH, open a fresh shell, and require command -v pi to resolve to %s/bin/pi.\n' "$agent_dir" "$agent_dir"
