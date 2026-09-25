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
}

export interface MemberServerAccess {
  serverAccess: ServerAccessMode;
  serverIds: string[];
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
