import { createHash } from 'node:crypto';
import fs from 'node:fs';
import type { DeployContainer } from '@smt/shared';
import { appNames, tryLoadConfig } from './config.js';
import type { Ctx } from './context.js';
import { NODE_IMAGE } from './images.js';
import { LABEL_MANAGED } from './names.js';

/**
 * Scheduled backups (services spec §3.4) run from `bastion-cron`, one small
 * container per server, created only while some service has a schedule:
 * the pinned Node.js image bastionctl itself runs in, with the root folder
 * and the Docker socket mounted exactly as the bastionctl wrapper mounts
 * them, the same user and groups, no network. Every minute it runs
 * `node <root>/bin/bastionctl.mjs backups run-due`.
 *
 * Why a container and not the host's crontab: the server needs nothing but
 * Docker (no cron daemon, no crontab access, no root), the restart policy
 * brings it back after a reboot, it is set up and removed by the same
 * commands that change schedules, and because it starts bastionctl.mjs anew
 * on each tick it always runs the bastionctl BastionSSH last installed (and
 * verified). Its log is the container's (`docker logs bastion-cron`), and
 * each service's last scheduled run is in its backups folder.
 */

export const CRON_CONTAINER = 'bastion-cron';
const LABEL_SPEC = 'bastion.cron-spec';
/** Seconds between checks. */
export const CRON_INTERVAL_S = 60;

/** Some app on the server has `backups.schedule` other than off. */
export function cronNeeded(ctx: Pick<Ctx, 'layout'>): boolean {
  return appNames(ctx.layout).some((app) => {
    const s = tryLoadConfig(ctx.layout, app).config?.backups?.schedule;
    return s !== undefined && s !== 'off';
  });
}

/** The container bastion-cron runs as: what the wrapper gives bastionctl, minus stdin and the network. */
export function cronSpec(ctx: Pick<Ctx, 'layout' | 'docker' | 'hostSocket'>): Record<string, unknown> {
  const root = ctx.layout.root;
  const uid = process.getuid?.() ?? 0;
  const gid = process.getgid?.() ?? 0;
  let socketGid: number | null = null;
  try {
    socketGid = fs.statSync(ctx.docker.socketPath).gid;
  } catch {
    // no socket to stat (it is the host's that counts; the wrapper checked it)
  }
  const spec = {
    Image: NODE_IMAGE,
    User: `${uid}:${gid}`,
    WorkingDir: root,
    Env: [`BASTION_ROOT=${root}`, 'BASTION_ACTOR=bastion-cron', 'HOME=/tmp', `BASTION_HOST_SOCKET=${ctx.hostSocket ?? '/var/run/docker.sock'}`],
    Entrypoint: ['sh', '-c'],
    // A fresh node each tick: the bastionctl installed now, never a copy kept in memory
    Cmd: [`while :; do node "$BASTION_ROOT/bin/bastionctl.mjs" backups run-due --json; sleep ${CRON_INTERVAL_S}; done`],
    Labels: { [LABEL_MANAGED]: 'cron' } as Record<string, string>,
    HostConfig: {
      Binds: [`${root}:${root}`, `${ctx.hostSocket ?? '/var/run/docker.sock'}:/var/run/docker.sock`],
      ...(socketGid !== null && socketGid !== gid && { GroupAdd: [String(socketGid)] }),
      NetworkMode: 'none',
      Init: true,
      RestartPolicy: { Name: 'unless-stopped' },
      Memory: 256 * 1024 ** 2,
      LogConfig: { Type: 'json-file', Config: { 'max-size': '5m', 'max-file': '2' } },
    },
  };
  spec.Labels[LABEL_SPEC] = createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16);
  return spec;
}

export async function cronContainer(ctx: Pick<Ctx, 'docker'>): Promise<DeployContainer | null> {
  const info = await ctx.docker.inspectContainer(CRON_CONTAINER);
  if (!info) return null;
  return {
    name: CRON_CONTAINER,
    id: info.Id.slice(0, 12),
    state: info.State.Status,
    status: info.State.Running ? `running since ${info.State.StartedAt ?? '?'}` : `${info.State.Status} (exit ${info.State.ExitCode ?? '?'})`,
    health: null,
  };
}

/**
 * bastion-cron as the schedules on the server need it: created (or
 * recreated when its spec changed — a new Node.js image, another root),
 * started, or removed when no service has a schedule left.
 */
export async function ensureCron(ctx: Pick<Ctx, 'layout' | 'docker' | 'log' | 'hostSocket'>): Promise<DeployContainer | null> {
  const info = await ctx.docker.inspectContainer(CRON_CONTAINER);
  if (!cronNeeded(ctx)) {
    if (info) {
      ctx.log(`No backup schedules left: removing ${CRON_CONTAINER}`);
      await ctx.docker.remove(CRON_CONTAINER);
    }
    return null;
  }
  const spec = cronSpec(ctx);
  const wanted = (spec.Labels as Record<string, string>)[LABEL_SPEC];
  if (info && info.Config.Labels?.[LABEL_SPEC] !== wanted) {
    ctx.log(`Replacing ${CRON_CONTAINER} (its settings changed)`);
    await ctx.docker.remove(CRON_CONTAINER);
  }
  if (!info || info.Config.Labels?.[LABEL_SPEC] !== wanted) {
    ctx.log(`Creating ${CRON_CONTAINER}: it runs scheduled backups every minute`);
    await ctx.docker.createContainer(CRON_CONTAINER, spec);
  }
  await ctx.docker.start(CRON_CONTAINER);
  return cronContainer(ctx);
}
