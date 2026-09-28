import type { FastifyReply, FastifyRequest } from 'fastify';
import { and, asc, eq, inArray, ne, type SQL } from 'drizzle-orm';
import { getDb } from '../db/index.js';
import { memberships, organizations, sessions, ssoProviders } from '../db/schema.js';

/**
 * Where single sign-on constrains a request. Kept apart from the OIDC flow in
 * sso.ts so the auth middleware can use it without pulling that in.
 *
 * Two rules:
 *  - An org that enforces SSO refuses every other kind of session from its
 *    members, owners excepted (break-glass: an IdP outage must not lock the
 *    org out). API tokens are not affected.
 *  - A session that signed in through an org's SSO only works in that org.
 *    That org's IdP vouches for its own members, not for whatever else the
 *    same account can reach.
 */

type Membership = typeof memberships.$inferSelect;

export const SSO_SESSION_ORG_MESSAGE =
  'This session signed in with single sign-on for another organization. Sign in again to use this one.';

export const SSO_SESSION_CREDENTIALS_MESSAGE =
  'You signed in with single sign-on, and your account also belongs to other organizations. Sign in with your password or passkey to change its credentials.';

export function ssoRequiredMessage(orgName: string) {
  return `${orgName} requires single sign-on. Use "Sign in with SSO" instead.`;
}

/** The org a provider belongs to; null when it is gone. */
export function ssoProviderOrgId(providerId: string): string | null {
  return (
    getDb()
      .select({ orgId: ssoProviders.orgId })
      .from(ssoProviders)
      .where(eq(ssoProviders.id, providerId))
      .get()?.orgId ?? null
  );
}

/** Whether the org has an enabled provider set to enforce SSO. */
export function orgEnforcesSso(orgId: string): boolean {
  return !!getDb()
    .select({ id: ssoProviders.id })
    .from(ssoProviders)
    .where(and(eq(ssoProviders.orgId, orgId), eq(ssoProviders.enabled, true), eq(ssoProviders.enforceSso, true)))
    .get();
}

/** Enforcement applies to this member: everyone but owners. */
export function ssoRequiredFor(membership: Pick<Membership, 'orgId' | 'role'>): boolean {
  return membership.role !== 'owner' && orgEnforcesSso(membership.orgId);
}

export type LocalSignIn =
  | { status: 'ok'; membership: Membership | undefined }
  /** Every active membership is in an org that requires SSO from this user. */
  | { status: 'sso_required'; orgSlug: string; orgName: string };

/**
 * Where a password or passkey sign-in may land: the oldest active membership
 * whose org does not require SSO of this user. Suspension is checked by the
 * caller first.
 */
export function localSignInMembership(userId: string): LocalSignIn {
  const active = getDb()
    .select()
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.status, 'active')))
    .orderBy(asc(memberships.joinedAt))
    .all();
  const allowed = active.find((m) => !ssoRequiredFor(m));
  if (allowed || !active.length) return { status: 'ok', membership: allowed };

  const org = getDb()
    .select({ slug: organizations.slug, name: organizations.name })
    .from(organizations)
    .where(eq(organizations.id, active[0]!.orgId))
    .get();
  return { status: 'sso_required', orgSlug: org?.slug ?? '', orgName: org?.name ?? 'Your organization' };
}

/**
 * An SSO session must not add or remove account-wide credentials (passkeys,
 * API tokens, backup codes) when the account belongs to other orgs as well:
 * those credentials would carry one org's IdP's say-so into the others.
 * Sends 403 and returns false when refused.
 */
export function ssoSessionMayChangeCredentials(req: FastifyRequest, reply: FastifyReply): boolean {
  if (!req.ssoOrgId || !memberElsewhere(req.user.id, req.ssoOrgId)) return true;
  reply.status(403).send({ error: SSO_SESSION_CREDENTIALS_MESSAGE, code: 'SSO_SESSION_CREDENTIALS' });
  return false;
}

/** Whether the account belongs to any org besides `orgId`. */
function memberElsewhere(userId: string, orgId: string): boolean {
  return !!getDb()
    .select({ orgId: memberships.orgId })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), ne(memberships.orgId, orgId)))
    .get();
}

/**
 * Which of the account's sessions the requesting session may list and sign
 * out (GET/DELETE /api/auth/sessions), as a WHERE fragment on `sessions`, or
 * undefined for all of them.
 *
 * A password, passkey or backup-code session proves the account itself and
 * manages every session. An SSO session proves only what its org's IdP vouches
 * for: when the account also belongs to other orgs it sees and signs out only
 * sessions that signed in through that same org's SSO (itself included).
 * Password/passkey sessions — which can switch to any org — and other orgs'
 * SSO sessions stay hidden and untouched; their IPs and browsers are not that
 * IdP's business, and it must not be able to sign the account out of them.
 * An account in that one org only is not restricted.
 */
export function manageableSessionsFilter(req: FastifyRequest): SQL | undefined {
  if (!req.ssoOrgId || !memberElsewhere(req.user.id, req.ssoOrgId)) return undefined;
  const providerIds = getDb()
    .select({ id: ssoProviders.id })
    .from(ssoProviders)
    .where(eq(ssoProviders.orgId, req.ssoOrgId))
    .all()
    .map((p) => p.id);
  return inArray(sessions.ssoProviderId, providerIds);
}
