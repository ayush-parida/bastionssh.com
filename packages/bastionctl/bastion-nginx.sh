#!/bin/sh
# bastion-nginx, shipped with BastionSSH (deployments spec §6, nginx mode).
#
# The one program BastionSSH runs as root, for servers whose own nginx owns
# ports 80 and 443. For one app it writes /etc/nginx/conf.d/bastion-<app>.conf
# (/etc/nginx/http.d on Alpine, whose conf.d is outside http { }; no other
# file of nginx's config is ever touched), checks it with nginx -t
# and reloads nginx, putting the previous file back when either fails; and it
# gets the app's certificate with certbot certonly --webroot, which certbot's
# own timer renews, reloading nginx through the deploy hook.
#
# Install it root-owned, outside the deployments folder, and allow only it:
#   sudo install -o root -g root -m 0755 <root>/bin/bastion-nginx /usr/local/sbin/bastion-nginx
#   echo '<ssh user> ALL=(root) NOPASSWD: /usr/local/sbin/bastion-nginx' | sudo tee /etc/sudoers.d/bastion-nginx
# BastionSSH checks the installed file's SHA-256 before every use. Do not edit.
#
# Input is <root>/proxy/nginx/<app>.site, written by bastionctl and writable
# by the SSH user: every value in it is checked again here, and the server
# block is generated from those checked values only. nginx forwards to the
# bastion-caddy container on 127.0.0.1, which routes to the app's current
# release.
#
#   bastion-nginx check                  what is installed (nginx, certbot, conf.d include)
#   bastion-nginx apply <root> <app>     write the server block, get or renew the certificate;
#                                        remove those of apps <root> no longer serves
#   bastion-nginx remove <app>           remove the server block and the app's certificates
#   bastion-nginx status <app>           the app's certificate: issuer, validity, last error
#
# Output: key=value lines on stdout (what BastionSSH reads), progress on stderr.
set -eu
set -f
umask 022
# Byte ranges in patterns: [a-z] must not match upper case in another locale
LC_ALL=C
export LC_ALL
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export PATH
CONF_DIR=/etc/nginx/conf.d
# Alpine's nginx.conf includes conf.d/*.conf at the top level, where a server
# block is refused, and http.d/*.conf inside http { }: its server blocks go there
ALPINE_CONF_DIR=/etc/nginx/http.d
STATE_DIR=/var/lib/bastion-nginx
LIVE_DIR=/etc/letsencrypt/live
IPV6_PROBE=/proc/net/if_inet6
REQUIRE_ROOT=yes
VERSION=1

# One line, printable, capped: what goes into a key=value answer. A byte
# range, not [:print:]: BusyBox tr takes that for the characters [:print]
oneline() { printf '%s' "$*" | tr -c ' -~' ' ' | cut -c1-400; }
say() { printf '%s\n' "$*"; }
log() { printf '%s\n' "$*" >&2; }
die() {
  say "error=$(oneline "$*")"
  log "bastion-nginx: $*"
  exit 1
}
usage() { die "usage: bastion-nginx check | apply <root> <app> | remove <app> | status <app>"; }
last_lines() { printf '%s\n' "$1" | tail -n 3 | tr '\n' ' '; }

valid_app() {
  case $1 in '' | -* | *[!a-z0-9-]*) return 1 ;; esac
  [ ${#1} -le 41 ]
}

valid_root() {
  case $1 in /*) ;; *) return 1 ;; esac
  case $1 in *[!A-Za-z0-9/_.-]* | */../* | */.. | */./* | */. | *//*) return 1 ;; esac
  [ ${#1} -le 1024 ]
}

# Lower-case labels of a-z, 0-9 and -, at least two, not ending in digits only (no IP addresses)
valid_domain() {
  [ ${#1} -le 253 ] || return 1
  case $1 in '' | .* | *. | *..* | *[!a-z0-9.-]*) return 1 ;; esac
  case $1 in *.*) ;; *) return 1 ;; esac
  rest=$1
  while [ -n "$rest" ]; do
    label=${rest%%.*}
    case $rest in *.*) rest=${rest#*.} ;; *) rest= ;; esac
    [ -n "$label" ] && [ ${#label} -le 63 ] || return 1
    case $label in -* | *-) return 1 ;; esac
  done
  case ${1##*.} in *[!0-9]*) return 0 ;; *) return 1 ;; esac
}

# Sets site_tls, site_upstream and site_domains from <root>/proxy/nginx/<app>.site
read_site() {
  file="$1/proxy/nginx/$2.site"
  [ -f "$file" ] && [ ! -L "$file" ] || die "$file is missing: deploy $2 first (bastionctl writes it)"
  [ "$(wc -c <"$file")" -le 16384 ] || die "$file is too large"
  site_app='' site_tls='' site_upstream='' site_domains='' count=0
  while IFS= read -r line || [ -n "$line" ]; do
    case $line in
      '' | '#'*) ;;
      app=*) site_app=${line#app=} ;;
      tls=*) site_tls=${line#tls=} ;;
      upstream=*) site_upstream=${line#upstream=} ;;
      domain=*)
        d=${line#domain=}
        valid_domain "$d" || die "$file has an invalid domain"
        site_domains="$site_domains $d"
        count=$((count + 1))
        ;;
      *) die "$file has a line bastion-nginx does not know" ;;
    esac
  done <"$file"
  [ "$site_app" = "$2" ] || die "$file is not for app $2"
  case $site_tls in auto | staging) ;; *) die "tls must be auto or staging in nginx mode" ;; esac
  case $site_upstream in '' | *[!0-9]*) die "$file has an invalid upstream port" ;; esac
  [ ${#site_upstream} -le 5 ] && [ "$site_upstream" -ge 1024 ] && [ "$site_upstream" -le 65535 ] || die "$file has an invalid upstream port"
  [ "$count" -ge 1 ] && [ "$count" -le 50 ] || die "$file must list 1 to 50 domains"
  site_domains=${site_domains# }
}

cert_name() {
  if [ "$site_tls" = staging ]; then say "bastion-$app-staging"; else say "bastion-$app"; fi
}

listen() {
  say "	listen $1;"
  if [ -e "$IPV6_PROBE" ]; then say "	listen [::]:$1;"; fi
}

# nginx is the edge: X-Forwarded-For starts afresh with the address it saw
# (\$proxy_add_x_forwarded_for would pass on whatever a client claimed, and
# Caddy trusts what nginx sends). With real_ip configured for a CDN in front,
# \$remote_addr is already the client's.
proxy_location() {
  cat <<EOF
	location / {
		proxy_pass http://127.0.0.1:$site_upstream;
		proxy_http_version 1.1;
		proxy_set_header Host \$host;
		proxy_set_header X-Real-IP \$remote_addr;
		proxy_set_header X-Forwarded-For \$remote_addr;
		proxy_set_header X-Forwarded-Proto \$scheme;
		proxy_set_header Upgrade \$http_upgrade;
		proxy_set_header Connection \$http_connection;
		proxy_read_timeout 300s;
	}
EOF
}

# The server block: port 80 answers ACME challenges and, once there is a
# certificate, redirects everything else to HTTPS on 443.
server_block() {
  live="$LIVE_DIR/$(cert_name)"
  say "# Generated by bastion-nginx for app $app from $root/proxy/nginx/$app.site."
  say "# Do not edit: it is rewritten when the app's domains change."
  say "server {"
  listen 80
  say "	server_name $site_domains;"
  say "	client_max_body_size 64m;"
  cat <<EOF

	location ^~ /.well-known/acme-challenge/ {
		root $STATE_DIR/acme;
		default_type text/plain;
	}

EOF
  if [ "$1" = yes ]; then
    say "	location / {"
    say "		return 301 https://\$host\$request_uri;"
    say "	}"
    say "}"
    say ""
    say "server {"
    listen "443 ssl"
    say "	server_name $site_domains;"
    say "	client_max_body_size 64m;"
    say "	ssl_certificate $live/fullchain.pem;"
    say "	ssl_certificate_key $live/privkey.pem;"
    say ""
  fi
  proxy_location
  say "}"
}

# The first of the app's domains nginx -t reported claimed twice
conflicting() {
  for d in $site_domains; do
    case $1 in *"conflicting server name \"$d\""*) say "$d"; return 0 ;; esac
  done
  return 1
}

restore() {
  if [ "$had" = yes ]; then mv -f "$prev" "$conf"; else rm -f "$conf"; fi
}

# Write the server block (with TLS: $1 = yes), nginx -t, reload; the previous file comes back on failure
install_conf() {
  new="$conf.new"
  prev="$conf.prev"
  server_block "$1" >"$new"
  if [ -f "$conf" ] && cmp -s "$new" "$conf"; then
    rm -f "$new"
    return 0
  fi
  had=no
  if [ -f "$conf" ]; then
    cp -p "$conf" "$prev"
    had=yes
  fi
  mv -f "$new" "$conf"
  if ! out=$(nginx -t 2>&1); then
    restore
    die "nginx -t refused the server block of $app; the previous one is back: $(last_lines "$out")"
  fi
  # nginx only warns about a name two server blocks claim, and serves the one
  # it read first: a domain of a site the host already serves (conf.d comes
  # before sites-enabled) would be taken over, and certbot asked for it
  if taken=$(conflicting "$out"); then
    restore
    die "$taken is already served by another nginx server block on this host; the previous server block of $app is back"
  fi
  if ! out=$(nginx -s reload 2>&1); then
    restore
    nginx -s reload >/dev/null 2>&1 || true
    die "reloading nginx failed; the previous server block of $app is back: $(last_lines "$out")"
  fi
  rm -f "$prev"
  log "nginx: reloaded with the new server block of $app"
  changed=yes
}

fingerprint() {
  if [ -f "$1" ]; then cksum <"$1"; else say none; fi
}

# One run at a time: nginx -t and reload see one change at a time. The lock
# names its holder: a run killed outright (the SSH session gone) leaves it
# behind, and the next run takes it over instead of waiting for an admin.
lock() {
  mkdir -p "$STATE_DIR"
  tries=0
  until mkdir "$STATE_DIR/lock" 2>/dev/null; do
    holder=$(cat "$STATE_DIR/lock/pid" 2>/dev/null || true)
    case $holder in
      '' | *[!0-9]*) ;;
      *) if ! kill -0 "$holder" 2>/dev/null; then
        log "taking over the lock of run $holder, which is gone"
        rm -rf "$STATE_DIR/lock"
        continue
      fi ;;
    esac
    tries=$((tries + 1))
    [ "$tries" -lt 120 ] || die "another bastion-nginx run holds $STATE_DIR/lock (remove it if none is running)"
    sleep 1
  done
  printf '%s\n' "$$" >"$STATE_DIR/lock/pid"
  trap 'rm -rf "$STATE_DIR/lock"' EXIT
  # Signals (the SSH session closing, a broken pipe) end the run through exit, which releases the lock
  trap 'exit 1' HUP INT TERM PIPE
}

# Server blocks of apps this root no longer serves: bastionctl removes an
# app's site file when the app leaves the proxy (deleted, from a shell too,
# or left out of it), so a bastion-<other>.conf generated from <root> whose
# site file is gone is stale. Only bastion-*.conf files whose first line says
# they were generated from this root are touched; certificates stay (remove
# deletes them). nginx -t refusing the result puts every file back.
prune_stale() {
  stale=''
  set +f
  for f in "$CONF_DIR"/bastion-*.conf; do
    [ -f "$f" ] && [ ! -L "$f" ] || continue
    other=${f##*/bastion-}
    other=${other%.conf}
    valid_app "$other" && [ "$other" != "$app" ] || continue
    [ ! -e "$root/proxy/nginx/$other.site" ] || continue
    [ "$(head -n 1 "$f")" = "# Generated by bastion-nginx for app $other from $root/proxy/nginx/$other.site." ] || continue
    stale="$stale $other"
  done
  set -f
  [ -n "$stale" ] || return 0
  for other in $stale; do mv -f "$CONF_DIR/bastion-$other.conf" "$CONF_DIR/bastion-$other.conf.prev"; done
  if out=$(nginx -t 2>&1) && nginx -s reload >/dev/null 2>&1; then
    for other in $stale; do
      rm -f "$CONF_DIR/bastion-$other.conf.prev"
      log "nginx: removed the server block of $other, which $root no longer serves"
    done
    return 0
  fi
  for other in $stale; do mv -f "$CONF_DIR/bastion-$other.conf.prev" "$CONF_DIR/bastion-$other.conf"; done
  nginx -s reload >/dev/null 2>&1 || true
  log "warning: nginx refused the config without the stale server blocks of${stale}; they are back: $(last_lines "$out")"
}

apply() {
  root=$1 app=$2
  valid_root "$root" || die "invalid root directory"
  valid_app "$app" || die "invalid app name"
  read_site "$root" "$app"
  lock
  mkdir -p "$STATE_DIR/acme"
  conf="$CONF_DIR/bastion-$app.conf"
  cn=$(cert_name)
  live="$LIVE_DIR/$cn"
  have_cert=no
  if [ -f "$live/fullchain.pem" ] && [ -f "$live/privkey.pem" ]; then have_cert=yes; fi
  changed=no
  prune_stale
  install_conf "$have_cert"

  before=$(fingerprint "$live/fullchain.pem")
  set -- certonly --webroot -w "$STATE_DIR/acme" --cert-name "$cn" --non-interactive --agree-tos \
    --register-unsafely-without-email --keep-until-expiring --expand --deploy-hook 'nginx -s reload'
  if [ "$site_tls" = staging ]; then set -- "$@" --test-cert; fi
  for d in $site_domains; do set -- "$@" -d "$d"; done
  log "certbot: $cn for $site_domains"
  if out=$(certbot "$@" 2>&1); then
    rm -f "$STATE_DIR/$cn.error"
    if [ "$have_cert" = no ]; then
      install_conf yes
      certificate=issued
    elif [ "$(fingerprint "$live/fullchain.pem")" != "$before" ]; then
      certificate=issued
    else
      certificate=present
    fi
  else
    message=$(oneline "$(last_lines "$out")")
    { date -u +%Y-%m-%dT%H:%M:%SZ; say "$message"; } >"$STATE_DIR/$cn.error"
    log "certbot failed: $message"
    if [ "$changed" = yes ]; then say "result=applied"; else say "result=unchanged"; fi
    say "certificate=failed"
    say "error=certbot: $message"
    exit 1
  fi
  if [ "$changed" = yes ]; then say "result=applied"; else say "result=unchanged"; fi
  say "certificate=$certificate"
}

remove() {
  app=$1
  valid_app "$app" || die "invalid app name"
  lock
  conf="$CONF_DIR/bastion-$app.conf"
  prev="$conf.prev"
  if [ -f "$conf" ]; then
    cp -p "$conf" "$prev"
    had=yes
    rm -f "$conf"
    if ! out=$(nginx -t 2>&1); then
      restore
      die "nginx -t failed without the server block of $app; it is back: $(last_lines "$out")"
    fi
    nginx -s reload >/dev/null 2>&1 || log "warning: reloading nginx failed"
    rm -f "$prev"
    log "nginx: removed the server block of $app"
  fi
  for cn in "bastion-$app" "bastion-$app-staging"; do
    if [ -d "$LIVE_DIR/$cn" ]; then
      certbot delete --cert-name "$cn" --non-interactive >/dev/null 2>&1 || log "warning: certbot delete $cn failed"
    fi
    rm -f "$STATE_DIR/$cn.error"
  done
  say "result=removed"
  say "certificate=skipped"
}

status() {
  app=$1
  valid_app "$app" || die "invalid app name"
  for cn in "bastion-$app" "bastion-$app-staging"; do
    cert="$LIVE_DIR/$cn/cert.pem"
    if [ -f "$cert" ]; then
      say "cert=$cn"
      say "issuer=$(oneline "$(openssl x509 -in "$cert" -noout -issuer 2>/dev/null)")"
      say "$(openssl x509 -in "$cert" -noout -startdate 2>/dev/null)"
      say "$(openssl x509 -in "$cert" -noout -enddate 2>/dev/null)"
    fi
    if [ -f "$STATE_DIR/$cn.error" ]; then
      say "error_cert=$cn"
      say "error_at=$(oneline "$(head -n 1 "$STATE_DIR/$cn.error")")"
      say "error_message=$(oneline "$(sed -n 2p "$STATE_DIR/$cn.error")")"
    fi
  done
  say "status=ok"
}

check() {
  say "version=$VERSION"
  if command -v nginx >/dev/null 2>&1; then say "nginx=yes"; else say "nginx=no"; fi
  if command -v certbot >/dev/null 2>&1; then say "certbot=yes"; else say "certbot=no"; fi
  if nginx -T 2>/dev/null | grep -qF "$CONF_DIR/*.conf"; then say "include=yes"; else say "include=no"; fi
}

if [ -d "$ALPINE_CONF_DIR" ]; then CONF_DIR=$ALPINE_CONF_DIR; fi
if [ "$REQUIRE_ROOT" = yes ] && [ "$(id -u)" != 0 ]; then die "run bastion-nginx as root (sudo)"; fi
case ${1:-} in
  check) [ $# -eq 1 ] || usage; check ;;
  apply) [ $# -eq 3 ] || usage; apply "$2" "$3" ;;
  remove) [ $# -eq 2 ] || usage; remove "$2" ;;
  status) [ $# -eq 2 ] || usage; status "$2" ;;
  *) usage ;;
esac
