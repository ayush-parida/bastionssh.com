import type { Role } from './auth.js';

/** A preset for the settings form; the server treats every kind as generic OIDC. */
export type SsoProviderKind = 'google' | 'microsoft' | 'okta' | 'generic';

/** Roles SSO may hand out. Owner is never granted by an IdP. */
export type SsoRole = Exclude<Role, 'owner'>;

export interface SsoRoleMapping {
  /** A value of the configured groups claim, matched exactly. */
  group: string;
  role: SsoRole;
}

/** GET /sso: the org's provider as its owner sees it. The client secret never leaves the server. */
export interface SsoProviderConfig {
  id: string;
  kind: SsoProviderKind;
  issuer: string;
  clientId: string;
  allowedDomains: string[];
  defaultRole: SsoRole;
  /** Create accounts for unknown users from an allowed domain on their first sign-in. */
  autoProvision: boolean;
  /** Members other than owners must sign in with SSO. */
  enforceSso: boolean;
  enabled: boolean;
  /** Count phishing-resistant MFA reported by the IdP (`amr`) as a passkey sign-in. */
  trustIdpMfa: boolean;
  groupsClaim: string | null;
  roleMappings: SsoRoleMapping[];
  /** Register this as the redirect URI at the provider. */
  redirectUri: string;
  /** Where members start SSO sign-in for this org. */
  loginUrl: string;
  createdAt: string;
  updatedAt: string;
}

/** PUT /sso. `clientSecret` may be left out when updating to keep the stored one. */
export interface SsoProviderInput {
  kind: SsoProviderKind;
  issuer: string;
  clientId: string;
  clientSecret?: string;
  allowedDomains: string[];
  defaultRole: SsoRole;
  autoProvision: boolean;
  enforceSso: boolean;
  enabled: boolean;
  trustIdpMfa: boolean;
  groupsClaim?: string | null;
  roleMappings: SsoRoleMapping[];
}

/** GET /sso answers `configured: false` with just the redirect URI when there is no provider yet. */
export type SsoSettings =
  | ({ configured: true } & SsoProviderConfig)
  | { configured: false; redirectUri: string };

/** POST /sso/test: whether the issuer's discovery document and signing keys could be fetched. */
export interface SsoTestResult {
  ok: boolean;
  issuer?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  /** Signing keys published at jwks_uri. */
  signingKeys?: number;
  error?: string;
}

/** POST /auth/sso/lookup: where "Sign in with SSO" should go for an org slug or email. */
export interface SsoLookupResult {
  orgName: string;
  orgSlug: string;
  /** Host of the identity provider, shown before the redirect. */
  providerHost: string;
  /** Path that starts the sign-in, for a full-page navigation. */
  startUrl: string;
}

/**
 * Reasons an SSO sign-in came back to /login?sso_error=… — fixed codes, so the
 * page never shows text taken from the URL.
 */
export type SsoErrorCode =
  | 'expired'
  | 'state'
  | 'denied'
  | 'unavailable'
  | 'token'
  | 'email_unverified'
  | 'domain'
  | 'not_member'
  | 'account_exists'
  | 'identity_conflict'
  | 'suspended';
