/**
 * Reported by `bastionctl version` and `setup`: `0.1.0+<build>`, where the
 * build id is the first 7 hex digits of the bundle hash build.mjs computes
 * over the shipped files (BASTION_VERSION). Run from source (tests) it is the
 * plain package version. BastionSSH pins the exact files by their SHA-256,
 * not by this; it reads it to show which build a server has.
 */
declare const BASTION_VERSION: string | undefined;

export const BASTIONCTL_VERSION: string = typeof BASTION_VERSION === 'string' ? BASTION_VERSION : '0.1.0';
