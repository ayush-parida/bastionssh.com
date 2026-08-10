import type { Role } from './auth.js';

export interface OrgMember {
  userId: string;
  email: string;
  displayName: string;
  role: Role;
  joinedAt: string;
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
}

export interface AcceptInviteRequest {
  /** Must match the invited address; possession of the link is not enough. */
  email: string;
  displayName: string;
  password: string;
}
