import type { Readable } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { dockerPlatform, type DockerImageLoadResult, type DockerLoadedImage } from '@smt/shared';
import { requireAuth } from '../../auth/middleware.js';
import { requireModule } from '../../auth/access/modules.js';
import { audit } from '../../audit/index.js';
import { config } from '../../config/index.js';
import { reserveStream } from '../sse.js';
import { DockerError } from '../../docker/errors.js';
import { requireDocker } from '../../docker/permissions.js';
import { imageApiPath } from '../../docker/validation.js';
import { withDockerClient } from '../../docker/service.js';
import { openDockerSse, TOO_MANY_STREAMS, type DockerSse } from '../../docker/sse.js';
import { ArchiveMeter, engineAccepts, platformWarning, readLoadOutput, sendArchive, tagIndex, toLoadedImage, tooLarge } from '../../docker/image-load.js';
import { sendDockerError, serverParams } from './docker.js';

/**
 * Upload an image built elsewhere — what `docker save` writes — into a
 * server's Docker Engine: `POST /api/docker/servers/:id/images/load` with
 * the archive as the raw request body. The body is piped straight into the
 * engine's `POST /images/load` over the server's SSH connection: no file is
 * written on this host or on the server, and nothing is buffered beyond the
 * stream's own backpressure. The engine reads gzip, xz, bzip2 and (Docker
 * 23+) zstd archives itself (docker/image-load.ts).
 *
 * Gated like a pull (`pull`: operate on the server, Servers module), capped
 * by `SMT_DOCKER_IMAGE_UPLOAD_MAX_BYTES`, and holding one of the user's
 * stream places from the start of the request — the upload can take minutes
 * before the event stream opens. The engine answers only once it has read the
 * whole archive, so the stream opens then: `uploaded` (bytes, format), the
 * engine's `load` lines, then `loaded` with each image checked against the
 * server's platform, then `end`. Errors before that (413 too large, 400 not
 * an archive, the engine refusing it) are answered as JSON, and the engine
 * never gets a whole archive, so nothing is loaded.
 *
 * The browser going away during the upload cancels it; once the engine has
 * the whole archive, the load runs to its end (and is audited) either way.
 */

type RawJson = Record<string, unknown>;

/** Content types the archive may arrive as; the format is read from its bytes, not from these. */
const ARCHIVE_TYPES = [
  'application/octet-stream',
  'application/x-tar',
  'application/gzip',
  'application/x-gzip',
  'application/x-xz',
  'application/zstd',
  'application/x-bzip2',
];

/**
 * Most loaded images inspected, reported and audited one by one; an archive
 * may name any number of tags, and the rest are only counted.
 */
export const MAX_REPORTED_IMAGES = 100;

/** After the last byte arrived, how long the engine may take to import before the call is given up. */
const LOAD_TIMEOUT_MS = 30 * 60_000;

const querySchema = z.object({
  /** The file's name, for the audit log. */
  name: z.string().trim().max(255).optional(),
});

export async function dockerImageLoadRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth);
  // Docker on one server is the server's Docker tab: the Servers module (unified roles spec §3.1)
  app.addHook('preHandler', requireModule('servers'));

  // The archive arrives as the raw body and is handed over unread, so it streams
  app.addContentTypeParser(ARCHIVE_TYPES, (_req, payload, done) => {
    done(null, payload);
  });

  app.post('/servers/:id/images/load', { preHandler: requireDocker('pull') }, async (req, reply) => {
    const { id } = serverParams.parse(req.params);
    const { name } = querySchema.parse(req.query);
    const limit = config.dockerImageUploadMaxBytes;
    const body = req.body as Readable | undefined;
    if (!body || typeof body.pipe !== 'function') {
      return reply.status(415).send({ error: 'Send the image archive as the request body (Content-Type: application/octet-stream)' });
    }
    // Answered before anything is read; the rest of the body is not wanted, so the connection closes after
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      return reply.status(413).header('Connection', 'close').send(tooLarge(limit).toJSON());
    }
    const slot = reserveStream(req, { feature: 'docker', resourceId: id });
    if (!slot) return reply.status(429).header('Connection', 'close').send({ error: TOO_MANY_STREAMS });

    // Cancels the engine request while the archive is still arriving
    const upload = new AbortController();
    const interrupted = () => {
      if (!req.raw.complete) upload.abort(new DockerError('The upload was interrupted', 499));
    };
    req.raw.on('close', interrupted);
    // Once the engine has the whole archive the load runs to its end; only its deadline still cuts it
    let bodySent = false;
    slot.signal.addEventListener(
      'abort',
      () => {
        if (!bodySent) upload.abort(new DockerError('Your access has changed. The upload was stopped.', 403));
      },
      { once: true },
    );

    // Filled in as the request goes; `started` once the engine was asked, which is when it is audited
    const run: {
      serverName?: string;
      started: boolean;
      meter?: ArchiveMeter;
      outcome: 'loaded' | 'failed' | 'too_large' | 'cancelled';
      images: DockerLoadedImage[];
      /** Every image the engine reported loaded, listed or not. */
      loadedCount: number;
      error?: string;
      cut?: Error;
    } = { started: false, outcome: 'cancelled', images: [], loadedCount: 0 };
    let sse: DockerSse | null = null;
    let timer: NodeJS.Timeout | undefined;
    // A failure that is not Docker's (a host key mismatch) goes to the app's error handler, after the audit
    let unhandled: unknown = null;

    try {
      await withDockerClient(req, id, async (ctx) => {
        run.serverName = ctx.server.name;
        const [version, before] = await Promise.all([
          ctx.docker.json<RawJson>({ path: '/version', signal: upload.signal }),
          ctx.docker.json<RawJson[]>({ path: '/images/json', signal: upload.signal }),
        ]);
        const engine = {
          os: typeof version.Os === 'string' && version.Os ? version.Os : 'linux',
          arch: typeof version.Arch === 'string' ? version.Arch : '',
        };
        const meter = new ArchiveMeter(limit, engineAccepts(ctx.docker, ctx.server.dockerVersion));
        run.meter = meter;
        // Why the upload was cut, when it was (the engine's side then only sees a broken request)
        meter.on('error', (e) => (run.cut ??= e));
        // The engine imports after the last byte; give that a deadline of its own
        meter.once('end', () => {
          bodySent = true;
          timer = setTimeout(() => upload.abort(new DockerError('Docker did not finish loading the image in time', 504)), LOAD_TIMEOUT_MS);
        });
        body.pipe(meter);
        run.started = true;
        const res = await sendArchive(ctx.docker, meter, upload.signal).finally(() => clearTimeout(timer));

        // The engine has the whole archive: from here the load runs to its end, watched or not
        slot.release();
        sse = openDockerSse(req, reply, id);
        const send: DockerSse['send'] = (event) => {
          if (sse && !sse.closed) sse.send(event);
        };
        send({ type: 'uploaded', bytes: meter.bytes, format: meter.format! });

        const { loaded, count } = await readLoadOutput(res, { max: MAX_REPORTED_IMAGES, onProgress: (progress) => send({ type: 'load', progress }) });
        run.loadedCount = count;

        const previous = tagIndex(before);
        for (const item of loaded) {
          const ref = 'ref' in item ? item.ref : null;
          const inspect = await ctx.docker.json<RawJson>({ path: imageApiPath(ref ?? (item as { id: string }).id, 'json') });
          run.images.push(toLoadedImage(ref, inspect, engine, previous));
        }
        const warnings = run.images.filter((i) => i.platformMismatch).map((i) => platformWarning(i, engine));
        if (run.images.length === 0) warnings.push('Docker read the archive but did not report any image as loaded.');
        if (run.loadedCount > run.images.length) {
          warnings.push(`Docker loaded ${run.loadedCount} images; only the first ${run.images.length} are listed and checked here.`);
        }
        run.outcome = 'loaded';
        const result: DockerImageLoadResult = {
          images: run.images,
          bytes: meter.bytes,
          format: meter.format!,
          serverPlatform: dockerPlatform(engine.os, engine.arch || 'unknown'),
          warnings,
        };
        send({ type: 'loaded', result });
        send({ type: 'end' });
      });
    } catch (caught) {
      const err = run.cut ?? caught;
      const status = (err as { statusCode?: unknown }).statusCode;
      run.outcome = status === 413 ? 'too_large' : status === 499 ? 'cancelled' : 'failed';
      run.error = err instanceof Error ? err.message : String(err);
      const stream = sse as DockerSse | null;
      if (stream) stream.fail(err);
      else if (!reply.sent && !reply.raw.destroyed) {
        // The rest of an upload refused halfway is not read: close the connection after answering
        if (!req.raw.complete) reply.header('Connection', 'close');
        try {
          void sendDockerError(reply, err);
        } catch (other) {
          unhandled = other;
        }
      }
    } finally {
      clearTimeout(timer);
      req.raw.off('close', interrupted);
      slot.release();
      (sse as DockerSse | null)?.end();
    }

    if (run.started) {
      await audit(req, 'docker.image_load', 'server', id, run.serverName, {
        ...(name && { file: name }),
        bytes: run.meter?.bytes ?? 0,
        format: run.meter?.format ?? null,
        outcome: run.outcome,
        images: run.images.map((i) => ({ ref: i.ref, id: i.id, platform: `${i.os}/${i.architecture}`, replaced: i.replacedId })),
        ...(run.loadedCount > run.images.length && { imagesLoaded: run.loadedCount }),
        ...(run.images.some((i) => i.platformMismatch) && { platformMismatch: true }),
        ...(run.error && { error: run.error.slice(0, 500) }),
      });
    }
    if (unhandled) throw unhandled;
    return reply;
  });
}
