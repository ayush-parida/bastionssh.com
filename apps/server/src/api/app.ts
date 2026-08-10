import Fastify from 'fastify';
import { ZodError } from 'zod';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import websocket from '@fastify/websocket';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import path from 'path';
import fastifyStatic from '@fastify/static';
import { config } from '../config/index.js';
import logger from '../logger.js';
import { authRoutes } from './routes/auth.js';
import { serverRoutes } from './routes/servers.js';
import { sshKeyRoutes } from './routes/ssh-keys.js';
import { savedCommandRoutes } from './routes/saved-commands.js';
import { cronJobRoutes } from './routes/cron-jobs.js';
import { aiRoutes } from './routes/ai.js';
import { auditRoutes } from './routes/audit.js';
import { sshSessionRoutes } from './routes/ssh-sessions.js';
import { sftpRoutes } from './routes/sftp.js';
import { monitoringRoutes } from './routes/monitoring.js';
import { notificationRoutes } from './routes/notifications.js';
import { teamRoutes, publicInviteRoutes } from './routes/team.js';
import { healthRoutes } from './routes/health.js';

export async function buildApp() {
  const app = Fastify({
    loggerInstance: logger,
    trustProxy: true,
  });

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: config.baseUrl,
    credentials: true,
  });
  await app.register(cookie, { secret: config.sessionSecret });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(websocket);

  // A rejected schema is the caller's mistake, not a server fault. Without this
  // every bad field surfaced as a 500 carrying the raw Zod dump — including on
  // the unauthenticated invite endpoints.
  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ZodError) {
      const issue = err.issues[0];
      const field = issue?.path.join('.');
      return reply.status(400).send({
        error: field ? `${field}: ${issue?.message}` : (issue?.message ?? 'Invalid request'),
      });
    }
    const statusCode = (err as { statusCode?: number }).statusCode;
    if (statusCode && statusCode < 500) {
      return reply.status(statusCode).send({ error: (err as Error).message });
    }
    req.log.error({ err }, 'Unhandled error');
    return reply.status(500).send({ error: 'Internal Server Error' });
  });

  // Routes
  await app.register(healthRoutes);
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(serverRoutes, { prefix: '/api/servers' });
  await app.register(sshKeyRoutes, { prefix: '/api/keys' });
  await app.register(savedCommandRoutes, { prefix: '/api/commands' });
  await app.register(cronJobRoutes, { prefix: '/api/cron-jobs' });
  await app.register(aiRoutes, { prefix: '/api/ai' });
  await app.register(auditRoutes, { prefix: '/api/audit' });
  await app.register(sshSessionRoutes, { prefix: '/api/ssh-sessions' });
  await app.register(sftpRoutes, { prefix: '/api/sftp' });
  await app.register(monitoringRoutes, { prefix: '/api/monitoring' });
  await app.register(notificationRoutes, { prefix: '/api/notifications' });
  await app.register(teamRoutes, { prefix: '/api/team' });
  // Unauthenticated: reading and accepting an invite happens before an account exists
  await app.register(publicInviteRoutes, { prefix: '/api/invites' });

  if (config.staticDir) {
    const staticPath = path.resolve(config.staticDir);
    logger.info(`Serving static files from ${staticPath}`);
    await app.register(fastifyStatic, {
      root: staticPath,
      wildcard: false,
    });

    // Fallback all non-API routes to index.html for SPA routing
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) {
        reply.code(404).send({ error: 'Not Found' });
      } else {
        reply.sendFile('index.html');
      }
    });
  }

  return app;
}
