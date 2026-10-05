---
title: Domains and HTTPS
section: deployments
order: 70
summary: Several sites on one server, the DNS records to create, automatic certificates, www redirects, other TLS modes, and certificate alerts.
keywords: [domain, domains, dns, a record, aaaa, cname, https, tls, ssl, certificate, lets encrypt, letsencrypt, www, redirect, wildcard, staging, internal, rate limit, alerts]
---

## Several sites on one server

Each site is its own app: its own folder, `bastion.yml`, `.env`, volumes, container and image. All of them sit behind the one proxy, which routes each request by its domain. A deploy or rollback of one app never touches the others.

- A domain belongs to one app; a second app listing it is refused.
- Nothing but the proxy publishes a port, so apps can all listen on 3000 inside their containers.
- Changing one app's domains reloads the proxy without dropping requests to the others.

## DNS records

Point each domain at the server's public address at your DNS provider:

| Record | Name | Value |
| --- | --- | --- |
| `A` | `example.com` (often written `@`) | the server's IPv4 address |
| `A` (or `CNAME` to `example.com`) | `www.example.com` (`www`) | the server's IPv4 address |
| `AAAA` | as above | the server's IPv6 address — only if the server really answers on it |

> **Warning:** A stale `AAAA` record pointing somewhere else breaks certificates: Let's Encrypt prefers IPv6 when there is one. Remove it, or point it at this server.

The app's **Domains** tab checks every domain now: its A/AAAA records against the server's public address — with the exact record to create when they do not match — and, for `tls: auto` and `staging`, whether ports 80 and 443 answer from outside. A domain is saved even when its DNS is not ready; the certificate follows once it is.

DNS changes can take minutes to hours to reach everyone. Once **Domains** shows the records as correct, the proxy gets the certificate on its next try (or click **Apply nginx again** in nginx mode).

## Automatic certificates

With `tls: auto` (the default) the proxy obtains a certificate from Let's Encrypt for every domain when the app first goes live or a domain is added, and renews it automatically. Plain HTTP requests are redirected to HTTPS.

What it needs:

- The domain's DNS pointing at this server.
- Ports **80 and 443** open to the internet (firewall, cloud security group). Let's Encrypt connects to port 80 or 443 to check you control the domain.

## www redirect

```yaml
domains: [example.com, www.example.com]
redirect_www: apex      # www.example.com → example.com (301)
```

`www` redirects the other way. Both names must be in `domains`; each gets a certificate, so the redirect works over HTTPS too.

## TLS modes

| `tls:` | Certificate | Needs |
| --- | --- | --- |
| `auto` | Let's Encrypt, obtained and renewed automatically | DNS pointing at the server; ports 80 and 443 open |
| `staging` | Let's Encrypt's staging CA — not trusted by browsers | as `auto`; for testing without using up rate limits |
| `internal` | Caddy's own CA | nothing; browsers trust it only with Caddy's root installed — for private names and intranets |
| `dns:<provider>` | via the DNS provider's API; the only way to get wildcards (`*.example.com`) | the provider's API token in `<root>/proxy/.env` as `<PROVIDER>_API_TOKEN` (never in BastionSSH), and a Caddy build with that provider's DNS module |
| `{ cert: …, key: … }` | your own files | the files in the app folder; you renew them |

> **Note:** The pinned standard Caddy image has no DNS provider modules yet, so `dns:<provider>` does not obtain certificates out of the box. For a wildcard today, use your own certificate files or `internal`.

**Your own certificate.** Put the PEM files in the app folder (for example `/opt/bastion/apps/site1/certs/cert.pem` and `key.pem` — with the Files module or `scp`) and set:

```yaml
tls: { cert: certs/cert.pem, key: certs/key.pem }
```

When you replace the files, deploy, save the config, or run `bastionctl proxy apply` to have the proxy load them.

In [nginx mode](nginx.md), only `auto` and `staging` are available: certificates come from certbot on the host.

## Certificate checks and alerts

- The app list shows each app's certificate — days left, or an error.
- **Domains** shows each certificate's issuer, expiry and last issuance or renewal error, read from the proxy (or from certbot in nginx mode).
- A certificate that is past its renewal point, has a renewal error logged, has expired, or has under 14 days left without being renewed raises a **Certificate expiring or failing** alert through your notification channels — when it starts (again if it expires) and when it recovers.
- Besides every visit to **Domains**, BastionSSH checks the certificates on every monitored server every 6 hours. Only the alert itself is kept.

## Let's Encrypt limits

Let's Encrypt limits how many certificates you can get. At the time of writing the ones you are most likely to meet are:

- **5 certificates for exactly the same set of names per week** — reached by repeatedly deleting and re-creating an app, or wiping the proxy's data.
- **50 certificates per registered domain per week** — many subdomains of one domain.
- **5 failed validations per domain per hour** — usually DNS not pointing at the server yet, or port 80 closed.

Fix DNS and firewall first, test with `tls: staging` if you are unsure, then switch to `auto`. Current limits: [letsencrypt.org/docs/rate-limits](https://letsencrypt.org/docs/rate-limits/). If a certificate is not issued, see [Troubleshooting](troubleshooting.md#certificate-not-issued).
