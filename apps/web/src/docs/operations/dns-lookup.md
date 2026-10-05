---
title: DNS lookup
section: operations
order: 50
summary: Check a domain's records and nameservers, see which of your servers it points at, and confirm a change has propagated.
keywords: [dns, lookup, records, nameservers, propagation, a record, cname, mx, txt, caa, domain]
---

**DNS Lookup** answers two everyday questions without leaving BastionSSH: "which of my servers does this domain point at?" and "has my DNS change reached everyone yet?"

## Run a lookup

1. Open **DNS Lookup** in the sidebar.
2. Type a domain, for example `example.com`, and click **Look up**.

You can paste whatever you have: a bare domain, a full URL (`https://www.example.com/path`), a name with a trailing dot, or an internationalised (unicode) domain. It is normalised before the query.

## What you get back

### Nameservers

The domain's authoritative nameservers, each with the addresses it resolves to.

### Records

Every record of these types, with TTLs where the resolver reports them:

| Type | What it tells you |
| --- | --- |
| A / AAAA | IPv4 / IPv6 addresses |
| CNAME | Alias to another name |
| MX | Mail servers, lowest preference first |
| NS | Authoritative nameservers |
| TXT | Verification, SPF and other text |
| SOA | Zone authority and serial |
| CAA | Who may issue certificates |

A type with nothing in it shows **No records**. A domain that does not exist at all is called out as such, so you can tell it apart from one that simply has no records of a type.

### Server matches

An A, AAAA or CNAME value that equals the host of one of your servers is labelled with that server's name and links to its health page. Only servers you are allowed to see are matched, so the labels never reveal servers you cannot access.

### Propagation

The same A lookup is run against four public resolvers and the domain's own nameservers:

| Resolver | Address |
| --- | --- |
| Cloudflare | 1.1.1.1 |
| Google | 8.8.8.8 |
| Quad9 | 9.9.9.9 |
| OpenDNS | 208.67.222.222 |
| The domain's nameservers | up to four of those listed above, at a public address |

Any resolver whose answer differs from the most common one is flagged **differs**; when all agree the table says **every resolver agrees**. A domain that does not exist skips this comparison. Right after you repoint a domain, expect the authoritative nameservers to show the new address first and public resolvers to catch up as cached answers expire (see the record's TTL).

## Typical uses

- **Before a deploy or migration:** confirm the domain points at the server you think it does.
- **After changing an A record:** watch the propagation table until every resolver agrees.
- **Certificate problems:** check CAA records and that A/AAAA records match the server that requests the certificate (see [Deployments](/docs/deployments/overview)).
- **Mail problems:** check MX and the SPF record in TXT.

## Limits and safety

- Lookups are read-only.
- The resolver list is fixed, so the feature cannot be used to send traffic to an arbitrary host. A nameserver that resolves to a private or link-local address is never queried.
- Records are looked up from the BastionSSH host. A split-horizon or internal-only zone shows what that host sees.
- Each lookup is recorded in the audit log as `dns.lookup`.

## Who can use it

DNS Lookup belongs to the **DNS Lookup & Diagnostics** module. At **view**, a member can run lookups; every built-in role except **No access** has it. The **operate** level adds diagnostics with a login (see [Diagnostics](/docs/servers/diagnostics)).
