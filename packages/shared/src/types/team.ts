import type { Role } from './auth.js';

export type MembershipStatus = 'active' | 'suspended';

/** `restricted` limits an operator or viewer to an explicit server list. */
export type ServerAccessMode = 'all' | 'restricted';

export interface OrgMember {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  joinedAt: string;
  status: MembershipStatus;
  suspendedAt: string | null;
  serverAccess: ServerAccessMode;
  /** Servers granted while `serverAccess` is `restricted`. */
  serverCount: number;
  /** Most recent activity across the member's sessions, if any. */
  lastActiveAt: string | null;
  /** Passkeys registered to the account (they are per account, not per org). Admins and owners only. */
  passkeyCount?: number;
}

/** Org-wide security policy, readable by every member; only owners change it. */
export interface OrgSecuritySettings {
  requirePasskey: boolean;
  /** A backup-code sign-in may only enroll a new passkey, then must verify with it. */
  backupCodeRecoveryOnly: boolean;
  /** Active members who have no passkey yet — they must enroll at their next sign-in. Admins and owners only. */
  membersWithoutPasskey?: number;
}

export interface MemberServerAccess {
  serverAccess: ServerAccessMode;
  /** Every server currently granted (expired grants never appear). */
  serverIds: string[];
  /** The same grants with their details; `expiresAt` null means permanent. */
  grants?: ServerGrant[];
  /** Kubernetes clusters granted to a restricted member (expired grants never appear). */
  clusterIds?: string[];
  clusterGrants?: ClusterGrant[];
}

export interface ClusterGrant {
  clusterId: string;
  expiresAt: string | null;
  grantedBy: string | null;
  reason: string | null;
}

export interface ServerGrant {
  serverId: string;
  expiresAt: string | null;
  grantedBy: string | null;
  reason: string | null;
}

/**
 * Body of `PUT /team/members/:id/access`. `expiresInMinutes` makes grants
 * time-bound: a number is minutes from now, null makes the grant permanent,
 * and a server left out keeps whatever expiry it already has (new ones are permanent).
 */
export interface UpdateMemberServerAccess {
  serverAccess: ServerAccessMode;
  serverIds: string[];
  expiresInMinutes?: Record<string, number | null>;
  /**
   * Kubernetes clusters a restricted member may use, replaced wholesale; left
   * out, cluster grants stay as they are. `clusterExpiresInMinutes` works like
   * `expiresInMinutes`.
   */
  clusterIds?: string[];
  clusterExpiresInMinutes?: Record<string, number | null>;
}

export type AccessRequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface AccessRequest {
  id: string;
  userId: string;
  userEmail: string;
  userDisplayName: string;
  servers: { id: string; name: string | null }[];
  reason: string;
  durationMinutes: number;
  status: AccessRequestStatus;
  /** Set on approval; may be shorter than requested. */
  approvedMinutes: number | null;
  decidedBy: string | null;
  decidedByEmail: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  createdAt: string;
  /** Pending: when the request lapses undecided. Approved: when the granted access ends. */
  expiresAt: string;
}

export interface CreateAccessRequest {
  serverIds: string[];
  reason: string;
  durationMinutes: number;
}

export interface DecideAccessRequest {
  /** Approve only: grant for less time than was asked. */
  durationMinutes?: number;
  note?: string;
}

/** Org-wide access request policy. Every member may read it; admins change it. */
export interface AccessRequestSettings {
  /** Restricted members see the names (only) of servers they cannot use, so they can ask for them. */
  restrictedSeeServerNames: boolean;
  /** Longest access a member may request, in minutes. */
  maxRequestMinutes: number;
}

/** A server a restricted member may ask for, or already has. Names only — never hosts. */
export interface RequestableServer {
  id: string;
  name: string;
  /** Present when the member has access now; null expiry means permanent. */
  granted: { expiresAt: string | null } | null;
}

export interface RequestableServers {
  /** False for members who already see every server — they have nothing to request. */
  restricted: boolean;
  settings: AccessRequestSettings;
  servers: RequestableServer[];
}

/** Returned once when an admin issues a reset — the link is never readable again. */
export interface PasswordResetLink {
  link: string;
  expiresAt: string;
}

export type PasswordResetState = 'valid' | 'expired' | 'used';

/** What the reset page shows before a new password is set. */
export interface PasswordResetPreview {
  emailHint: string;
  state: PasswordResetState;
}

export type InviteState = 'valid' | 'expired' | 'accepted';

export interface Invite {
  id: string;
  email: string;
  role: Role;
  expiresAt: string;
  createdAt?: string;
  state: InviteState;
}

/**
 * Only the create call returns the accept URL, and only once — it is never
 * readable from the invite list afterwards.
 */
export interface CreatedInvite extends Invite {
  link: string;
  /** The address already has an account; they sign in to accept rather than register. */
  existingAccount?: boolean;
}

export interface CreateInviteRequest {
  email: string;
  role?: Role;
}

/** What the accept page shows before an account exists. */
export interface InvitePreview {
  /** Partially masked, e.g. `de•@ex•••••.com` — the link must not reveal it. */
  emailHint: string;
  role: Role;
  organizationName: string;
  state: InviteState;
  // Deliberately says nothing about whether the address already has an
  // account; the page offers both paths and the accept endpoint decides.
}

export interface AcceptInviteRequest {
  /** Must match the invited address; possession of the link is not enough. */
  email: string;
  /** Required for a new account; ignored when joining with an existing one. */
  displayName?: string;
  password: string;
}
