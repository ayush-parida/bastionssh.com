#!/bin/sh
# sshd and the host's nginx in the background, the Docker daemon in front.
set -e
/usr/sbin/sshd
nginx
exec dockerd-entrypoint.sh dockerd --host=unix:///var/run/docker.sock
