/**
 * A refusal meant for the person deploying (an upload that cannot build as
 * configured, an unsafe archive entry). bastionctl reports it as its own
 * error; BastionSSH as the failure of the build.
 */
export class DeployBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeployBuildError';
  }
}
