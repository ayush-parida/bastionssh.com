# Builds on the BastionSSH side — Design

**Date:** 2026-10-09
**Status:** Approved in conversation ("i dont want the build to be created on the server, it should be created on the bastionssh side"). Trigger: a Next.js build OOM-killed (exit 137) on a 909 MB server.

## Goal
Build deployment images next to BastionSSH and ship only the finished image to the server. The server never runs `npm install`/`next build`; it loads the image and runs the usual release flow (health check, zero-downtime switch, rollback).

## Decisions
1. **Per app:** `build.where: server | bastion` in bastion.yml (default `server`, unchanged behaviour). UI toggle in the config form and a choice in the Deploy dialog.
2. **Builder:** a BuildKit daemon as a new service in deploy/docker/docker-compose.yml (`buildkit`), **rootless**, on its own Docker network shared only with the BastionSSH container (no access to Redis or anything else), with internet egress for package installs, CPU/memory limits (configurable), one build at a time (queue), and a cache volume with a garbage-collection limit (e.g. 10 GB). BastionSSH talks to it with `buildctl` (pinned binary in the BastionSSH image) over TCP on that network (mTLS optional; network isolation required).
3. **Dockerfiles:** the same generators bastionctl uses today (nextjs standalone, static, dockerfile), shared, so a `bastion` build produces the same image a `server` build would.
4. **Platform:** read the target server's OS/architecture from its Docker `/info`; build for it (`--opt platform=linux/<arch>`). Cross-architecture builds use QEMU emulation (available on Docker Desktop; on Linux hosts install binfmt via `tonistiigi/binfmt` once, documented) and are slower — the UI says so.
5. **Source:** the upload is extracted to an ephemeral directory on the BastionSSH host (size/entry caps, same tar safety checks as bastionctl), used as the build context, and deleted after the build whether it succeeds or fails. **Uploads exclude `.env`, `.env.*` (except `.env.example`) by default** (web packer and server-side), with an explicit "include env files" option and a warning.
6. **Build-time variables:** only `NEXT_PUBLIC_*` (and any names listed in a new `build.args` allowlist in bastion.yml) are read from the server's `.env` over SSH for the duration of the build and passed as build args; nothing else from `.env` reaches the builder, and nothing is stored on the BastionSSH side.
7. **Shipping:** the build exports a Docker image tarball streamed (gzip) straight into the server's Docker `POST /images/load` over the existing SSH transport (reuse the image upload code), tagged `bastion-<app>:<release>`; then bastionctl `deploy --prebuilt <tag>` continues the normal release flow (release.json records `builtOn: bastion`, platform, digest, duration).
8. **Logs & cancel:** build output streams to the deploy log as today; cancelling stops the BuildKit solve and the transfer; nothing partial is loaded.
9. **Limits:** max context size (default 1 GiB), build timeout (default 30 min), builder memory/CPU limits — config via env.
10. **Permissions & audit:** same as deploy; audit `deploy.start/finish` gain `builtOn` and timings.
11. **Nothing app-specific is kept on the BastionSSH side** except the BuildKit cache (layer cache, prunable; a "Clear build cache" action for admins).
