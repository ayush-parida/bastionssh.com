# Pebble, Let's Encrypt's ACME test server, for nginx.integration.test.ts.
# Validates HTTP-01 challenges on port 80 (as Let's Encrypt does) and finds
# the test domains through Docker's DNS (network aliases of the test server).
FROM alpine:3
ARG TARGETARCH
ARG PEBBLE=v2.10.1
ADD https://github.com/letsencrypt/pebble/releases/download/${PEBBLE}/pebble-linux-${TARGETARCH}.tar.gz /tmp/pebble.tar.gz
ADD https://raw.githubusercontent.com/letsencrypt/pebble/${PEBBLE}/test/certs/localhost/cert.pem /pebble/cert.pem
ADD https://raw.githubusercontent.com/letsencrypt/pebble/${PEBBLE}/test/certs/localhost/key.pem /pebble/key.pem
RUN tar xzf /tmp/pebble.tar.gz -C /tmp \
  && install -m 0755 /tmp/pebble-linux-${TARGETARCH}/linux/${TARGETARCH}/pebble /usr/local/bin/pebble \
  && rm -rf /tmp/pebble* \
  && chmod 0644 /pebble/*.pem
COPY pebble-config.json /pebble/config.json
# No random nonce rejections or sleeps: the test checks bastion-nginx, not certbot's retries
ENV PEBBLE_VA_NOSLEEP=1 PEBBLE_WFE_NONCEREJECT=0
EXPOSE 14000 15000
CMD ["pebble", "-config", "/pebble/config.json"]
