/**
 * A deployment failure with the HTTP status to answer and, for the cases the
 * web acts on, a code: `not_set_up` (offer Set up), `bastionctl_mismatch`
 * (offer Reinstall), `bastionctl_missing_bundle` (this BastionSSH was built
 * without bastionctl), `locked` (another deploy of the app is running),
 * `invalid_config`.
 */
export class DeployError extends Error {
  constructor(
    message: string,
    readonly statusCode = 500,
    readonly code?: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DeployError';
  }

  toJSON() {
    return { error: this.message, ...(this.code && { code: this.code }), ...this.details };
  }
}
