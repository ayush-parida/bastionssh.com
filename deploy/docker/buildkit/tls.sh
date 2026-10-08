#!/bin/sh
# Certificates for mutual TLS between BastionSSH and its buildkit service
# (docker-compose.yml: buildkit-tls runs this once before buildkit starts).
#
# Why TLS on a private network: a build's RUN steps share the builder's
# network namespace (rootless BuildKit cannot give each its own), so without
# client certificates any project's build script could reach BuildKit's API
# on its own port and drive it. With them, only BastionSSH can.
#
# Made once and kept: /tls/server (the buildkit-tls volume, BuildKit's side)
# and /tls/client (buildkit-client-tls, mounted read-only into smt). The CA's
# private key is thrown away after signing — nothing can issue another
# certificate later. To renew (they last 10 years) or rotate, remove both
# volumes and start the stack again; see README → Builds on BastionSSH.
set -eu
umask 077

server=/tls/server
client=/tls/client

if [ -s "$server/ca.pem" ] && [ -s "$server/cert.pem" ] && [ -s "$server/key.pem" ] &&
  [ -s "$client/ca.pem" ] && [ -s "$client/cert.pem" ] && [ -s "$client/key.pem" ]; then
  echo "buildkit TLS: certificates already present"
  exit 0
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
days=3650
key() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1" 2>/dev/null; }

key "$work/ca-key.pem"
openssl req -x509 -new -key "$work/ca-key.pem" -sha256 -days "$days" -subj "/CN=BastionSSH buildkit CA" -out "$work/ca.pem"

# buildkit: the name smt dials on the builder network (localhost for its own health check)
key "$work/server-key.pem"
openssl req -new -key "$work/server-key.pem" -subj "/CN=buildkit" -out "$work/server.csr"
printf 'subjectAltName=DNS:buildkit,DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature\n' >"$work/server.ext"
openssl x509 -req -in "$work/server.csr" -CA "$work/ca.pem" -CAkey "$work/ca-key.pem" -CAcreateserial -sha256 -days "$days" \
  -extfile "$work/server.ext" -out "$work/server.pem" 2>/dev/null

key "$work/client-key.pem"
openssl req -new -key "$work/client-key.pem" -subj "/CN=bastionssh" -out "$work/client.csr"
printf 'extendedKeyUsage=clientAuth\nkeyUsage=digitalSignature\n' >"$work/client.ext"
openssl x509 -req -in "$work/client.csr" -CA "$work/ca.pem" -CAkey "$work/ca-key.pem" -CAcreateserial -sha256 -days "$days" \
  -extfile "$work/client.ext" -out "$work/client.pem" 2>/dev/null

mkdir -p "$server" "$client"
cp "$work/ca.pem" "$server/ca.pem"
cp "$work/server.pem" "$server/cert.pem"
cp "$work/server-key.pem" "$server/key.pem"
cp "$work/ca.pem" "$client/ca.pem"
cp "$work/client.pem" "$client/cert.pem"
cp "$work/client-key.pem" "$client/key.pem"
# Rootless BuildKit runs as uid 1000; smt reads its side as root
chown -R 1000:1000 "$server"
chmod 0644 "$server/ca.pem" "$server/cert.pem" "$client/ca.pem" "$client/cert.pem"
chmod 0600 "$server/key.pem" "$client/key.pem"
echo "buildkit TLS: new CA, server and client certificates written (valid $days days)"
