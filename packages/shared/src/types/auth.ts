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
