# A throwaway server for nginx.integration.test.ts: its own Docker daemon
# (docker:dind, run --privileged), sshd, and a host nginx owning ports 80 and
# 443 with certbot — what nginx mode is for. The SSH user smt (password
# bastion-it-pass) may use Docker but has no sudo at all: the test runs the
# one-time steps BastionSSH shows (install the helper, the sudoers rule for
# it) as the administrator would. nginx.conf is Alpine's own: conf.d is
# included outside http { }, http.d inside it.
#
# certbot asks Pebble (the pebble container, network alias `pebble`) instead
# of Let's Encrypt, and trusts Pebble's API certificate — in this container
# only.
FROM docker:dind
ARG PEBBLE=v2.10.1
ADD https://raw.githubusercontent.com/letsencrypt/pebble/${PEBBLE}/test/certs/pebble.minica.pem /usr/local/share/ca-certificates/pebble-minica.crt
RUN apk add --no-cache openssh-server sudo nginx certbot openssl ca-certificates \
  && chmod 0644 /usr/local/share/ca-certificates/pebble-minica.crt \
  && update-ca-certificates \
  && (addgroup -S docker 2>/dev/null || true) \
  && adduser -D -u 1000 -s /bin/sh smt \
  && echo 'smt:bastion-it-pass' | chpasswd \
  && addgroup smt docker \
  && ssh-keygen -A \
  && sed -i -E 's/^#?PasswordAuthentication .*/PasswordAuthentication yes/' /etc/ssh/sshd_config \
  && mkdir -p /etc/letsencrypt \
  && printf 'server = https://pebble:14000/dir\n' > /etc/letsencrypt/cli.ini
COPY host-entrypoint.sh /usr/local/bin/host-entrypoint.sh
ENV DOCKER_TLS_CERTDIR=
ENTRYPOINT ["/bin/sh", "/usr/local/bin/host-entrypoint.sh"]
