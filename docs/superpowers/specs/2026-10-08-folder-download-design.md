# Folder Download — Design

**Date:** 2026-10-08
**Status:** Approved in conversation ("proceed with ultracode").

## Goal
Download a whole folder as one archive from every file viewer: **Servers → Files** (SFTP on managed servers), **FTP/SFTP connections**, and **Object Storage** (a prefix). Archives are built while streaming; nothing is staged on disk on the BastionSSH host or the remote side.

## Decisions
1. **Formats:** `.zip` by default (opens natively on macOS/Windows) with ZIP64 for files > 4 GiB or > 65 535 entries, written as a streaming zip (data descriptors, CRC computed on the fly, deflate per entry with a store fallback for already-compressed types); `.tar.gz` as an option.
2. **Shared engine** (`apps/server/src/archive/`): a source-agnostic walker interface (`list(dir)`, `open(file)`) feeding a streaming zip/tar writer with backpressure, limits and cancellation; used by all three viewers.
3. **Servers → Files fast path:** when the SSH account has a shell, run `tar -cz` (or `tar -c` piped through the zip-less path for `.tar.gz`; for `.zip`, use the engine over SFTP) via the existing SSH connection — `tar` only for `.tar.gz`, engine for `.zip`. Fallback to the engine over SFTP for shell-less accounts. Arguments shell-quoted; paths validated.
4. **Symlinks** stored as links, never followed (tar `--no-dereference` default; engine stores link entries in tar, skips with a note in zip).
5. **Errors on individual files** (permission denied, vanished) skip the file and are listed in `_skipped.txt` at the archive root; the download does not abort.
6. **Limits:** configurable `SMT_FOLDER_DOWNLOAD_MAX_BYTES` (default 10 GiB) and `SMT_FOLDER_DOWNLOAD_MAX_FILES` (default 100 000), enforced while streaming (archive ends with a `_TRUNCATED.txt` note and the response trailer/audit records truncation); per-user stream cap applies; client disconnect cancels the remote walk/transfer.
7. **Paths & confinement:** same validation as single-file download; FTP/SFTP connections honour the root-path jail; storage prefixes validated; archive entry names relative to the chosen folder, no `..`, no absolute paths.
8. **Permissions & audit:** same permission as downloading a single file in that viewer; audited as `<viewer>.folder_download` with path, format, files, bytes, skipped, truncated, duration.
9. **UI:** "Download folder" on each folder row and for the current folder, with a format choice (zip / tar.gz), a size/file-count estimate when cheap (object storage, small trees) and progress (bytes received); cancel.
10. **Docs:** in-app docs updates for each viewer + README/ARCHITECTURE.

## Testing
Unit tests for the zip writer (valid archives readable by `unzip -t` and Node unzip libs, ZIP64 boundaries, unicode names, empty dirs, data descriptors), tar writer, limits, skipping, cancellation; route tests per viewer (permissions, jail, audit, limits); live tests: throwaway openssh-server (shell and shell-less sftp-only accounts), atmoz/sftp, an FTP server image, and SeaweedFS/MinIO S3 — download nested folders with large and many files, compare checksums after extracting.
