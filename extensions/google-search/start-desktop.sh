#!/usr/bin/env bash
set -euo pipefail

image=pi-google-chromium:headed-20260929
secret="$HOME/.pi/agent/google-search-runtime/vnc.pass"
[[ -r "$secret" ]] || { echo "Missing private VNC auth file: $secret" >&2; exit 1; }
docker image inspect "$image" >/dev/null
if ! docker volume inspect pi-google-profile >/dev/null 2>&1; then
  docker volume create pi-google-profile >/dev/null
  docker run --rm --network none --user root:root \
    --mount type=volume,source=pi-google-profile,target=/profile \
    --entrypoint /bin/chown "$image" 1000:1000 /profile >/dev/null
fi
if docker container inspect pi-google-desktop >/dev/null 2>&1; then
  echo "pi-google-desktop already exists; use docker start/restart, or remove it after checking the profile volume"
  exit 0
fi
docker run -d --restart unless-stopped --init --name pi-google-desktop \
  --user 1000:1000 --security-opt no-new-privileges --cap-drop ALL \
  --pids-limit 512 --memory 2g --network bridge \
  -p 127.0.0.1:18876:9222 -p 127.0.0.1:18875:6080 \
  --read-only --tmpfs /tmp:rw,nosuid,nodev,size=256m --shm-size 256m \
  --mount type=volume,source=pi-google-profile,target=/profile \
  --mount "type=bind,source=$secret,target=/secrets/vnc.pass,readonly" \
  "$image" >/dev/null
echo "pi-google-desktop started"
