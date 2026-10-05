#!/bin/sh
# bastionctl, installed by BastionSSH (deployments spec §2.2). Runs
# bin/bastionctl.mjs in a pinned Node.js image with this root directory and
# the Docker socket mounted, so the server needs nothing but Docker. Do not
# edit: BastionSSH checks this file's SHA-256 before every use.
set -eu
ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
IMAGE='@NODE_IMAGE@'
SOCKET=${BASTION_DOCKER_SOCKET:-/var/run/docker.sock}
if [ ! -S "$SOCKET" ]; then
  echo "bastionctl: no Docker socket at $SOCKET (is Docker installed and running?)" >&2
  exit 1
fi
DOCKER=docker
# Not in the docker group: passwordless sudo for docker, if allowed
if [ ! -w "$SOCKET" ]; then DOCKER='sudo -n docker'; fi
SOCKET_GID=$(stat -L -c %g "$SOCKET" 2>/dev/null || stat -L -f %g "$SOCKET")
exec $DOCKER run --rm -i --init --network none \
  --user "$(id -u):$(id -g)" --group-add "$SOCKET_GID" \
  -v "$ROOT:$ROOT" -v "$SOCKET:/var/run/docker.sock" \
  -e BASTION_ROOT="$ROOT" -e BASTION_ACTOR="${BASTION_ACTOR:-$(id -un)}" -e HOME=/tmp \
  -w "$ROOT" --label bastion.managed=bastionctl \
  --entrypoint node "$IMAGE" "$ROOT/bin/bastionctl.mjs" "$@"
