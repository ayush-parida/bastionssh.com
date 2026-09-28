export type Role = 'owner' | 'admin' | 'operator' | 'viewer';

export interface User {
  id: string;
  email: string;
  displayName: string;
  avatarUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
  updatedAt: string;
}

export interface Membership {
  userId: string;
  orgId: string;
  role: Role;
  joinedAt: string;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: string;
}

/** One of the caller's signed-in browsers. `id` is a handle, never the cookie value. */
export interface SessionInfo {
  id: string;
  createdAt: string;
  lastSeenAt: string | null;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

/** A browser/network the account has signed in from; a sign-in from a new one is emailed. */
export interface KnownDevice {
  id: string;
  /** Browser and OS family, e.g. "Firefox on Linux". */
  label: string;
  /** The network it was seen on, coarsened: 203.0.113.0/24 or 2001:db8:1::/48. */
  ipPrefix: string;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** An organization the caller belongs to, for the org switcher. */
export interface OrgSummary {
  orgId: string;
  name: string;
  slug: string;
  role: Role;
  status: 'active' | 'suspended';
  current: boolean;
}

/** 'read' alone caps a token at viewer, whatever role its owner holds. */
export type TokenScope = 'read' | 'write';

export interface ApiToken {
  id: string;
  name: string;
  /** Public half of the token, shown so a row can be identified after creation. */
  prefix: string;
  scopes: TokenScope[];
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  createdAt: string;
  expired: boolean;
  /** Created from a passkey-verified session; only such tokens work in orgs that require passkeys. */
  passkeyVerified: boolean;
}

export type PasskeyDeviceType = 'singleDevice' | 'multiDevice';

/** A registered passkey, as listed in settings. The credential itself never leaves the server. */
export interface PasskeyInfo {
  id: string;
  name: string;
  createdAt: string;
  lastUsedAt: string | null;
  deviceType: PasskeyDeviceType;
  /** Synced to a cloud keychain, so it survives losing the device. */
  backedUp: boolean;
}

/**
 * Error codes a 403 may carry. PASSKEY_REQUIRED: the org requires a passkey
 * sign-in and this session has not done one. PASSKEY_STEP_UP_REQUIRED: the
 * action needs this session to confirm with an existing passkey first.
 */
export type PasskeyErrorCode = 'PASSKEY_REQUIRED' | 'PASSKEY_STEP_UP_REQUIRED';

/** A signed-in session, as returned by every sign-in endpoint. */
export interface SignedIn {
  user: { id: string; email: string; displayName: string };
  orgId: string | null;
  role: Role;
  passkeyVerified: boolean;
  /** The org requires passkeys and this account has none: enroll before anything else. */
  passkeyEnrollmentRequired: boolean;
}

/**
 * The password was right, but the account has passkeys: finish with one. The
 * ticket stands in for the password for five minutes, once.
 */
export interface PasskeyLoginStep {
  step: 'passkey';
  ticket: string;
  /** PublicKeyCredentialRequestOptionsJSON for `startAuthentication`. */
  options: object;
}

export type LoginResponse = SignedIn | PasskeyLoginStep;

/** POST /auth/login/backup-code: a sign-in that spent one of the account's backup codes. */
export interface BackupCodeSignedIn extends SignedIn {
  /** Unused codes left after this one. */
  backupCodesRemaining: number;
}

/** GET /auth/backup-codes. The codes themselves are only ever returned when generated. */
export interface BackupCodeStatus {
  /** Codes in the current set; 0 when none were ever generated (or they were cleared). */
  total: number;
  remaining: number;
  createdAt: string | null;
}

/** POST /auth/backup-codes: a new set, replacing any earlier one. Shown once. */
export interface GeneratedBackupCodes extends BackupCodeStatus {
  /** Formatted XXXXX-XXXXX. */
  codes: string[];
}

/** GET /auth/me */
export interface Me {
  id: string;
  email: string;
  displayName: string;
  orgId: string;
  role: Role;
  /** This session signed in (or stepped up) with a passkey. Always false for API tokens. */
  passkeyVerified: boolean;
  /** The current org requires passkeys. */
  requirePasskey: boolean;
  passkeyCount: number;
  /** Unused backup codes, so the app can warn when they run low. */
  backupCodesRemaining: number;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface RegisterRequest {
  email: string;
  password: string;
  displayName: string;
  orgName?: string;
}

export interface InviteRequest {
  email: string;
  role: Role;
}
