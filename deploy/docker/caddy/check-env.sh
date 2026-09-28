#!/bin/sh
# Entrypoint for the Caddy service (docker compose --profile https). Refuses a
# half-configured HTTPS setup rather than serving one where passkeys fail or
# every user shares Caddy's IP address for rate limiting and the audit log.
set -eu

fail() {
	echo "caddy: $1" >&2
	exit 1
}

[ -n "${SMT_DOMAIN:-}" ] || fail "set SMT_DOMAIN to the public hostname, e.g. SMT_DOMAIN=bastion.example.com"
case "$SMT_DOMAIN" in
*[!A-Za-z0-9.-]*) fail "SMT_DOMAIN must be a bare hostname (no scheme, port or path): $SMT_DOMAIN" ;;
esac
[ "${SMT_BASE_URL%/}" = "https://$SMT_DOMAIN" ] ||
	fail "set SMT_BASE_URL=https://$SMT_DOMAIN (it is ${SMT_BASE_URL:-unset}); passkeys are bound to that hostname"
case "${SMT_TRUST_PROXY:-false}" in
false | "") fail "set SMT_TRUST_PROXY=1 so smt takes client addresses from Caddy's X-Forwarded-For" ;;
esac

# Optional ACME account email, spliced into the Caddyfile's global options
export SMT_ACME_EMAIL_OPTION="${SMT_ACME_EMAIL:+email $SMT_ACME_EMAIL}"

exec "$@"
