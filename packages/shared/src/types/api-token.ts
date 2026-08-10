import type { ApiToken, TokenScope } from './auth.js';

/** Creation is the only response that carries the secret. */
export interface CreatedApiToken extends ApiToken {
  token: string;
}

export interface CreateApiTokenRequest {
  name: string;
  scopes?: TokenScope[];
  expiresInDays?: number;
}

export interface ChangePasswordRequest {
  currentPassword: string;
  newPassword: string;
}

export interface UpdateProfileRequest {
  displayName: string;
}
