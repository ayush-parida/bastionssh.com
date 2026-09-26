import {
  startAuthentication,
  startRegistration,
  WebAuthnError,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import type { BackupCodeSignedIn, PasskeyInfo, SignedIn } from '@smt/shared';
import { api, ApiError } from '@/lib/api.js';

interface Ceremony<T> {
  challengeId: string;
  options: T;
}

/** Browsers only offer WebAuthn on HTTPS pages and on localhost. */
export const insecureContext = typeof window !== 'undefined' && !window.isSecureContext;

/** The user dismissed the browser prompt, or it timed out — not worth an error toast. */
export function isPasskeyCancel(err: unknown): boolean {
  // The library wraps the DOMException; its name is on `cause`
  const name =
    err instanceof WebAuthnError
      ? ((err as { cause?: unknown }).cause as Error | undefined)?.name
      : (err as Error | undefined)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

/** A message for a failed ceremony that says what to do about it. */
export function passkeyErrorMessage(err: unknown, fallback = 'Passkey failed'): string {
  if (isPasskeyCancel(err)) return 'The passkey prompt was cancelled or timed out';
  if (err instanceof WebAuthnError) {
    switch (err.code) {
      case 'ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED':
        return 'This device already has a passkey for your account';
      case 'ERROR_INVALID_DOMAIN':
      case 'ERROR_INVALID_RP_ID':
        return 'Passkeys are not available at this address. They need HTTPS (or localhost) on the configured domain.';
      case 'ERROR_AUTHENTICATOR_MISSING_DISCOVERABLE_CREDENTIAL_SUPPORT':
      case 'ERROR_AUTHENTICATOR_MISSING_USER_VERIFICATION_SUPPORT':
        return 'This authenticator cannot store a passkey with a PIN or biometric. Try another device.';
    }
  }
  if (insecureContext) return 'Passkeys need HTTPS (or localhost)';
  return err instanceof Error ? err.message : fallback;
}

/** Second step of a password login: answer the ticket with one of the account's passkeys. */
export async function finishPasswordLogin(ticket: string, options: object): Promise<SignedIn> {
  const response = await startAuthentication({ optionsJSON: options as PublicKeyCredentialRequestOptionsJSON });
  return api.post<SignedIn>('/auth/login/passkey', { ticket, response });
}

/**
 * Second step of a password login without the passkey: spend one of the
 * account's backup codes on the same ticket. A wrong code leaves the ticket
 * usable for a few more tries; SIGN_IN_EXPIRED means start over.
 */
export function finishWithBackupCode(ticket: string, code: string): Promise<BackupCodeSignedIn> {
  return api.post<BackupCodeSignedIn>('/auth/login/backup-code', { ticket, code });
}

/** The pending sign-in is gone (expired, or too many wrong codes): back to the password. */
export function isSignInExpired(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'SIGN_IN_EXPIRED';
}

/**
 * Sign in with a passkey alone. With `autofill`, waits for the user to pick a
 * passkey from the username field's autofill list instead of prompting.
 */
export async function passwordlessLogin(autofill = false): Promise<SignedIn> {
  const { challengeId, options } = await api.post<Ceremony<PublicKeyCredentialRequestOptionsJSON>>('/auth/passkey/options');
  const response = await startAuthentication({ optionsJSON: options, useBrowserAutofill: autofill });
  return api.post<SignedIn>('/auth/passkey/verify', { challengeId, response });
}

/** Confirm an existing passkey in this session. */
export async function stepUp(): Promise<void> {
  const { challengeId, options } = await api.post<Ceremony<PublicKeyCredentialRequestOptionsJSON>>(
    '/auth/passkeys/step-up/options',
  );
  const response = await startAuthentication({ optionsJSON: options });
  await api.post('/auth/passkeys/step-up/verify', { challengeId, response });
}

/**
 * Create a passkey on this device. A first passkey also needs the account
 * password and a recent sign-in (see isReauthRequired).
 */
export async function registerPasskey(name?: string, currentPassword?: string): Promise<PasskeyInfo> {
  const { challengeId, options } = await api.post<Ceremony<PublicKeyCredentialCreationOptionsJSON>>(
    '/auth/passkeys/register/options',
    currentPassword ? { currentPassword } : {},
  );
  const response = await startRegistration({ optionsJSON: options });
  const res = await api.post<{ passkey: PasskeyInfo }>('/auth/passkeys/register/verify', {
    challengeId,
    response,
    ...(name && { name }),
    ...(currentPassword && { currentPassword }),
  });
  return res.passkey;
}

/** The server wants a fresh sign-in before a first passkey can be created. */
export function isReauthRequired(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'REAUTH_REQUIRED';
}

/**
 * Run an action; if the server wants this session to confirm a passkey first,
 * do that and run it once more. When there is no passkey to confirm with, the
 * action's own error explains more than the step-up's would.
 */
export async function withStepUp<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (err) {
    if (!(err instanceof ApiError) || err.code !== 'PASSKEY_STEP_UP_REQUIRED') throw err;
    try {
      await stepUp();
    } catch (stepErr) {
      throw stepErr instanceof ApiError && stepErr.status === 409 ? err : stepErr;
    }
    return action();
  }
}
