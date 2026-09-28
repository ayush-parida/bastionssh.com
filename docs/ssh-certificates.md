# Short-lived SSH certificates: why BastionSSH does not use them (yet)

OpenSSH user certificates would let BastionSSH sign a certificate that is valid
for a few minutes for each connection, from a per-org CA key, and have servers
trust that CA (`TrustedUserCAKeys`) rather than individual keys in
`authorized_keys`. A leaked key would then be useless within minutes.

We looked at this and **did not build it**, because the SSH library every
connection goes through cannot authenticate with a certificate. This page
explains the limitation, what was built instead, and the options for later.

## The limitation: ssh2 1.17 has no client certificate authentication

All SSH traffic — terminals, exec, SFTP, health checks, key rotation — uses
[`ssh2`](https://github.com/mscdex/ssh2) 1.17.0, with connect options built by
`sshConnectConfig` (`apps/server/src/ssh/host-keys.ts`) so the host key is
always verified. Certificate authentication needs the client to send the
certificate blob (type `ssh-ed25519-cert-v01@openssh.com` and so on) in its
`publickey` request, signed by the matching private key. ssh2 cannot do that:

- **Parsing drops the certificate.** `OpenSSH_Public.parse` in
  `lib/protocol/keyParser.js` accepts a `*-cert-v01@openssh.com` line, but then
  `parseDER` reads the fields after the type as if the blob were a plain key.
  In a certificate, the next field is the nonce, so the result is neither the
  certificate nor the user's key. Checked with a certificate from
  `ssh-keygen -s`: the parsed key's `getPublicSSH()` is 51 bytes, the
  certificate is 439, and it doesn't match the user's own public key either.
- **Auth sends only a plain public key.** `Protocol.authPK`
  (`lib/protocol/Protocol.js`) writes `key.getPublicSSH()` and the key's
  algorithm. There is no option to pair a private key with a certificate, and
  `getKeyAlgos` in `lib/client.js` knows no `*-cert-v01@openssh.com` signature
  algorithms.
- The only way in would be a hand-made "parsed key" object for ssh2's agent
  interface that returns the certificate blob and signs with the private key.
  That depends on ssh2 internals, would break silently on upgrade, and this is
  the authentication path for every server. We chose not to do that.

A server that trusts only the CA (no `authorized_keys` entry) would therefore
reject every BastionSSH connection.

## What is built instead: key rotation

For key-authenticated servers, admins can rotate the key from the Servers or
SSH Keys page, for one server or a selection
(`apps/server/src/ssh/key-rotation.ts`):

1. generate a new key pair;
2. over the current key, append the new public key to `~/.ssh/authorized_keys`
   (idempotent, tagged `bastionssh-key-<id>`, file mode preserved);
3. log in with the new key alone, in a fresh connection;
4. save the new key and switch the server to it;
5. over the new key, remove only the old key's lines;
6. retire the old key once no server or cloud account uses it.

Any failure rolls back, and the server is never left on a key it does not
accept. Every rotation is recorded in `key_rotations` (visible as rotation
history) and audited. Keys older than 180 days are flagged in the UI.

Rotation limits how long a leaked key is useful, but in days, not minutes.

## Options for the future

1. **ssh2 gains certificate support** (upstream change, or a small maintained
   patch that keeps the certificate blob next to the private key and offers
   the `-cert-v01` algorithms). This is the cleanest route: everything else
   stays as it is. The design would be:
   - a per-org CA key pair, generated with the existing keygen and stored with
     `vault.encrypt` like any other private key;
   - a "Trust CA" admin action (with step-up, audited) that installs the CA over
     exec, which needs `sudo`:

     ```sh
     # on the server, as root (or via sudo)
     echo 'ssh-ed25519 AAAA… bastionssh-ca-<org>' > /etc/ssh/bastionssh_user_ca.pub
     chmod 644 /etc/ssh/bastionssh_user_ca.pub
     grep -q '^TrustedUserCAKeys /etc/ssh/bastionssh_user_ca.pub' /etc/ssh/sshd_config \
       || echo 'TrustedUserCAKeys /etc/ssh/bastionssh_user_ca.pub' >> /etc/ssh/sshd_config
     sshd -t && (systemctl reload sshd || systemctl reload ssh || service ssh reload)
     ```

     Always run `sshd -t` before reloading, and keep an existing session open
     until a fresh login has worked;
   - on each connection, an ephemeral key pair plus a certificate for that
     server's login user, valid for 5 minutes (`valid_after` a little in the
     past to allow for clock skew), with a key id naming the BastionSSH user,
     so the server's auth log shows who connected.
2. **Use the OpenSSH client for connections**, which supports
   `CertificateFile`. This means running `ssh`/`sftp` as child processes
   instead of ssh2 for terminals, exec and SFTP, and writing a `known_hosts`
   file from the pinned host keys. It works, but it is a large change to the
   connection layer.
3. **A sidecar in another language** (for example Go's
   `golang.org/x/crypto/ssh`, which supports certificates) that the server
   proxies connections through. Same trade-off as option 2, plus another
   process to deploy.
4. **Time-limited keys without certificates.** OpenSSH 8.2+ accepts an
   `expiry-time="YYYYMMDDHHMM"` option in `authorized_keys`. Rotation could
   install each new key with an expiry. This does not give per-connection
   credentials, and a key whose expiry passes before the next rotation locks
   BastionSSH out, so it would need careful scheduling. Not implemented.

Until one of these is in place, a regular rotation is the recommended
practice. Use bulk rotation from the SSH Keys page for keys flagged as old.
