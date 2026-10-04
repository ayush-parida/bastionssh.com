import type { FastifyReply, FastifyRequest } from 'fastify';
import type { ModuleKey, ModuleLevel } from '@smt/shared';
import { hasModule, visibleModules } from './modules.js';
import { moduleDefinition } from './levels.js';
import type { AccessSubject } from './resolve.js';

/**
 * Routes shared by more than one module (unified roles spec §3): a shell
 * session is a server terminal, a container shell (Servers) or a pod shell
 * (Kubernetes). They answer like `requireModule` does for the first of their
 * modules the caller has: 404 when none of them is on and shown, 403 when
 * one is but below `level`. The route then checks its own module and item.
 */

/** True when the subject has `module` on and shown (the spec §3.1 visibility rule). */
export function moduleShown(who: AccessSubject, module: ModuleKey): boolean {
  return visibleModules(who).some((m) => m.module === module);
}

/** preHandler gate: any one of `modules` at `level` will do. Must run after `requireAuth`. */
export function requireAnyModule(modules: readonly ModuleKey[], level: Exclude<ModuleLevel, 'none'> = 'view') {
  return async function anyModuleGuard(req: FastifyRequest, reply: FastifyReply) {
    if (!req.user) return reply.status(401).send({ error: 'Unauthorized' });
    const shown = modules.filter((m) => moduleShown(req, m));
    if (!shown.length) return reply.status(404).send({ error: 'Not found' });
    if (!shown.some((m) => hasModule(req, m, level))) {
      return reply.status(403).send({
        error: `This needs ${level} access to ${shown.map((m) => moduleDefinition(m).label).join(' or ')}`,
      });
    }
  };
}
