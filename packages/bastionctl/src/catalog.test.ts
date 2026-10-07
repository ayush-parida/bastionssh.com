import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEPLOY_ENV_KEY_PATTERN,
  SERVICE_BACKUP_FILE,
  SERVICE_CATALOG,
  SERVICE_CATEGORIES,
  compareReleases,
  defaultServiceVersion,
  serviceConfigYaml,
  serviceConnectionDetails,
  serviceLineChangeAllowed,
  serviceTemplate,
  serviceUpgradeAllowed,
  serviceVersion,
  serviceVersionOfImage,
  type ServiceTemplate,
} from '@smt/shared';
import { checkConfigText, isDigestPinned, isImageRef, memoryBytes } from './config.js';
import { NAME_PATTERN } from './names.js';

/**
 * The quick-services catalog (services spec §3.1), from packages/shared:
 * every image pinned by digest, ids unique, and every template — each line,
 * published or not, with a domain when it has a UI — makes a bastion.yml
 * this bastionctl accepts as it is.
 */

const pins = JSON.parse(fs.readFileSync(new URL('../../shared/src/services/images.json', import.meta.url), 'utf8')) as Record<string, Record<string, unknown>>;

const options = (t: ServiceTemplate) => {
  const out: Array<{ publish: { scope: 'none' | 'localhost' | 'public'; port: number | null }; domain: string | null }> = [
    { publish: { scope: 'none', port: null }, domain: null },
    { publish: { scope: 'localhost', port: 15000 }, domain: null },
    { publish: { scope: 'public', port: 25000 }, domain: null },
  ];
  if (t.ui?.domain) out.push({ publish: { scope: 'none', port: null }, domain: `${t.id}.example.com` });
  return out;
};

describe('the service catalog', () => {
  it('pins every image by digest, with a tag naming the exact release', () => {
    for (const t of SERVICE_CATALOG) {
      for (const v of t.versions) {
        expect(isDigestPinned(v.image), `${t.id} ${v.major}: ${v.image}`).toBe(true);
        expect(isImageRef(v.image), v.image).toBe(true);
        const [named] = v.image.split('@') as [string];
        // repo:tag — the release, never a moving tag like latest
        expect(named, v.image).toMatch(/:[A-Za-z0-9_.-]+$/);
        expect(named.endsWith(':latest'), v.image).toBe(false);
        expect(named.split(':')[0], v.image).toBe(v.track.split(':')[0]);
        expect(v.version, v.image).not.toBe('');
      }
    }
  });

  it('has a pin for every line and a line for every pin', () => {
    const lines = SERVICE_CATALOG.flatMap((t) => t.versions.map((v) => `${t.id}/${v.major}`)).sort();
    const pinned = Object.entries(pins)
      .flatMap(([id, majors]) => Object.keys(majors).map((m) => `${id}/${m}`))
      .sort();
    expect(lines).toEqual(pinned);
  });

  it('has unique ids, one default line per template, and known categories and docs pages', () => {
    const ids = SERVICE_CATALOG.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(expect.arrayContaining(['postgres', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey', 'memcached', 'seaweedfs', 'minio', 'rabbitmq', 'meilisearch', 'clickhouse', 'mailpit', 'adminer', 'grafana', 'uptime-kuma']));
    for (const t of SERVICE_CATALOG) {
      expect(NAME_PATTERN.test(t.id), t.id).toBe(true);
      expect(SERVICE_CATEGORIES.map((c) => c.id)).toContain(t.category);
      expect(t.versions.filter((v) => v.default), t.id).toHaveLength(1);
      expect(new Set(t.versions.map((v) => v.major)).size, t.id).toBe(t.versions.length);
      expect(t.docs, t.id).toMatch(/^services-[a-z-]+$/);
      expect(serviceTemplate(t.id)).toBe(t);
      expect(serviceVersion(t, defaultServiceVersion(t).major)).toBe(defaultServiceVersion(t));
    }
  });

  it('generates secrets and fixed values with valid names, and memory defaults within reason', () => {
    for (const t of SERVICE_CATALOG) {
      const keys = [...Object.keys(t.env), ...t.secrets.map((s) => s.key)];
      expect(new Set(keys).size, t.id).toBe(keys.length);
      for (const key of keys) expect(DEPLOY_ENV_KEY_PATTERN.test(key), `${t.id} ${key}`).toBe(true);
      for (const s of t.secrets) expect(s.bytes >= 16 && s.bytes <= 512, `${t.id} ${s.key}`).toBe(true);
      expect(memoryBytes(t.memory) >= memoryBytes(t.minMemory), t.id).toBe(true);
      // A secret never ends up in a command line BastionSSH builds: commands read it from the environment
      for (const argv of [t.command, t.entrypoint, t.healthcheck.type === 'command' ? t.healthcheck.command : null, t.backup?.dump].filter(Boolean) as string[][]) {
        for (const s of t.secrets) expect(argv.join(' '), `${t.id}`).not.toMatch(new RegExp(`(?<!\\$)${s.key}=`));
      }
    }
  });

  it('makes a bastion.yml bastionctl accepts, for every line, published or not, with a domain for a UI', () => {
    for (const t of SERVICE_CATALOG) {
      for (const v of t.versions) {
        for (const o of options(t)) {
          const text = serviceConfigYaml(t, { name: `svc-${t.id}`, version: v, memory: t.memory, publish: o.publish, domain: o.domain, tls: 'internal', proxy: 'caddy' });
          const { config, issues } = checkConfigText(text, `svc-${t.id}`);
          expect(issues, `${t.id} ${v.major} ${JSON.stringify(o)}\n${text}`).toEqual([]);
          expect(config!.service).toBe(t.id);
          expect(config!.build).toMatchObject({ type: 'image', image: v.image });
          expect(config!.run.port).toBe(t.port);
          expect(config!.healthcheck.type).toBe(t.healthcheck.type);
          expect(config!.run.command ?? null).toEqual(t.command);
          expect(config!.run.entrypoint ?? null).toEqual(t.entrypoint);
          expect(config!.domains).toEqual(o.domain ? [o.domain] : []);
          if (t.volumes.some((x) => x.exclusive) || o.publish.scope !== 'none') expect(config!.run.strategy).toBe('recreate');
          if (o.publish.scope !== 'none') {
            // MinIO publishes its S3 port, RabbitMQ AMQP, Mailpit SMTP: not the UI the domain serves
            expect(config!.run.publish).toEqual({ scope: o.publish.scope, port: o.publish.port, target: t.publishPort === t.port ? null : t.publishPort });
          }
          expect(config!.backups).toEqual({ schedule: 'off', keep: 7 });
        }
      }
    }
  });

  it('keeps PostgreSQL 18 data where its image expects it', () => {
    const pg = serviceTemplate('postgres')!;
    const text = (major: string) => serviceConfigYaml(pg, { name: 'db', version: serviceVersion(pg, major)!, memory: '512m', publish: { scope: 'none', port: null }, domain: null, tls: 'auto', proxy: 'caddy' });
    expect(checkConfigText(text('18'), 'db').config!.run.volumes).toEqual([{ name: 'data', path: '/var/lib/postgresql', readonly: false, exclusive: true }]);
    expect(checkConfigText(text('17'), 'db').config!.run.volumes).toEqual([{ name: 'data', path: '/var/lib/postgresql/data', readonly: false, exclusive: true }]);
  });

  it('knows the line of each pinned image, and refuses a major change for a database', () => {
    for (const t of SERVICE_CATALOG) for (const v of t.versions) expect(serviceVersionOfImage(t, v.image), v.image).toBe(v);
    const pg = serviceTemplate('postgres')!;
    expect(serviceVersionOfImage(pg, 'postgres:17.2-alpine@sha256:' + 'a'.repeat(64))?.major).toBe('17');
    expect(serviceVersionOfImage(pg, 'mysql:17')).toBeUndefined();
    expect(serviceUpgradeAllowed(pg, serviceVersion(pg, '17'), serviceVersion(pg, '17')!)).toEqual({ ok: true });
    const refused = serviceUpgradeAllowed(pg, serviceVersion(pg, '16'), serviceVersion(pg, '17')!);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toContain('PostgreSQL cannot be moved from PostgreSQL 16 to PostgreSQL 17 in place');
    const grafana = serviceTemplate('grafana')!;
    expect(serviceUpgradeAllowed(grafana, serviceVersion(grafana, '12'), serviceVersion(grafana, '13')!)).toEqual({ ok: true });
    // Never back to an older line, even where any line may replace another: the data was migrated forward
    const back = serviceUpgradeAllowed(grafana, serviceVersion(grafana, '13'), serviceVersion(grafana, '12')!);
    expect(back.ok).toBe(false);
    expect(!back.ok && back.reason).toContain('Grafana cannot be moved back from Grafana 13 to Grafana 12');
    const mysql = serviceTemplate('mysql')!;
    expect(serviceUpgradeAllowed(mysql, serviceVersion(mysql, '9'), serviceVersion(mysql, '8.4')!).ok).toBe(false);
    expect(compareReleases('13.2.3', '12.4.12')).toBeGreaterThan(0);
    expect(compareReleases('v1.52.4', 'v1.52.10')).toBeLessThan(0);
    expect(compareReleases('RELEASE.2026-08-04T00-00-00Z', 'RELEASE.2026-08-04T00-00-00Z')).toBe(0);
  });

  it('keeps credentials off command lines: Mongo through a --config file, Redis and Valkey through REDISCLI_AUTH', () => {
    for (const id of ['mongodb', 'redis', 'valkey']) {
      const t = serviceTemplate(id)!;
      const scripts = [t.backup!.dump, t.backup!.restore.type === 'exec' ? t.backup!.restore.command : [], t.healthcheck.type === 'command' ? t.healthcheck.command : []].map((c) => c.join(' '));
      for (const script of scripts) expect(script, `${id}: ${script}`).not.toMatch(/ -p "\$|-a "\$|--password/);
    }
    expect(serviceTemplate('mongodb')!.backup!.dump.join(' ')).toContain('mongodump --config "$c"');
    expect(serviceTemplate('valkey')!.healthcheck).toMatchObject({ command: ['sh', '-c', 'REDISCLI_AUTH="$VALKEY_PASSWORD" valkey-cli -h 127.0.0.1 ping | grep -q PONG'] });
  });

  it('health-checks RabbitMQ as its own user (a root CLI would write a cookie the server cannot read)', () => {
    expect(serviceTemplate('rabbitmq')!.healthcheck).toEqual({ type: 'command', command: ['sh', '-c', 'exec su-exec rabbitmq rabbitmq-diagnostics -q ping'], timeout: '120s' });
  });

  it('gives connection strings with host, port and fixed values filled in and secrets left to reveal', () => {
    const pg = serviceTemplate('postgres')!;
    const c = serviceConnectionDetails(pg, { host: 'orders-db', published: { host: '203.0.113.7', port: 15432 } });
    expect(c.strings[0]).toEqual({ label: 'URL', internal: 'postgres://app:{POSTGRES_PASSWORD}@orders-db:5432/app', published: 'postgres://app:{POSTGRES_PASSWORD}@203.0.113.7:15432/app' });
    expect(c.secrets).toEqual(['POSTGRES_PASSWORD']);
    expect(c.fields).toContainEqual({ label: 'Password', value: null, secret: 'POSTGRES_PASSWORD' });
    expect(c.fields).toContainEqual({ label: 'User', value: 'app', secret: null });
    const minio = serviceConnectionDetails(serviceTemplate('minio')!, { host: 'files', published: null });
    expect(minio.strings).toEqual([{ label: 'S3 endpoint', internal: 'http://files:9000', published: null }]);
    const ch = serviceConnectionDetails(serviceTemplate('clickhouse')!, { host: 'events', published: { host: '127.0.0.1', port: 18123 } });
    // The native port is not the one published: no outside string for it
    expect(ch.strings[1]).toMatchObject({ label: 'Native', internal: 'clickhouse://app:{CLICKHOUSE_PASSWORD}@events:9000/app', published: null });
  });

  it('lists a recommended template first in its category: SeaweedFS before MinIO', () => {
    for (const c of SERVICE_CATEGORIES) {
      const inCategory = SERVICE_CATALOG.filter((t) => t.category === c.id);
      const flags = inCategory.map((t) => !!t.recommended);
      // Every recommended one before the first that is not
      expect(flags, c.id).toEqual([...flags].sort((a, b) => Number(b) - Number(a)));
    }
    expect(SERVICE_CATALOG.filter((t) => t.category === 'storage').map((t) => [t.id, !!t.recommended, !!t.imageNote])).toEqual([
      ['seaweedfs', true, false],
      ['minio', false, true],
    ]);
  });

  it('runs SeaweedFS with only its S3 gateway on the network, credentials from the environment', () => {
    const t = serviceTemplate('seaweedfs')!;
    expect(t.versions.map((v) => v.image.split(':')[0])).toEqual(['chrislusf/seaweedfs']);
    expect(t.command).toEqual(['server', '-ip=127.0.0.1', '-ip.bind=127.0.0.1', '-filer', '-s3', '-s3.ip.bind=0.0.0.0', '-s3.port.iceberg=0', '-s3.port.lance=0', '-master.telemetry=false']);
    expect(t.secrets.map((s) => s.key)).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'WEED_JWT_FILER_SIGNING_KEY']);
    expect({ backup: t.backup, port: t.port, publishPort: t.publishPort, ui: t.ui }).toEqual({ backup: null, port: 8333, publishPort: 8333, ui: { label: 'S3 API', domain: true } });
    const c = serviceConnectionDetails(t, { host: 'files', published: null });
    expect(c.strings).toEqual([{ label: 'S3 endpoint', internal: 'http://files:8333', published: null }]);
    expect(c.secrets).toEqual(['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY']);
  });

  it('applies Update version’s rules to a move between any two lines, ones no longer offered too', () => {
    const pg = serviceTemplate('postgres')!;
    expect(serviceLineChangeAllowed(pg, '17', '17')).toEqual({ ok: true });
    expect(serviceLineChangeAllowed(pg, '17', '16').ok).toBe(false);
    expect(serviceLineChangeAllowed(pg, '16', '17').ok).toBe(false);
    // A line dropped from the catalog is still another line
    const dropped = serviceLineChangeAllowed(pg, '16', '15');
    expect(!dropped.ok && dropped.reason).toContain('from PostgreSQL 16 to PostgreSQL 15');
    const grafana = serviceTemplate('grafana')!;
    expect(serviceLineChangeAllowed(grafana, '12', '13')).toEqual({ ok: true });
    expect(serviceLineChangeAllowed(grafana, '13', '12').ok).toBe(false);
    expect(serviceLineChangeAllowed(grafana, '13', '11').ok).toBe(false);
  });

  it('names backup files the way bastionctl writes them', () => {
    for (const t of SERVICE_CATALOG) {
      if (!t.backup) continue;
      for (const kind of ['', '-scheduled', '-pre-restore']) expect(SERVICE_BACKUP_FILE.test(`20261007T120000Z${kind}.${t.backup.ext}`), `${t.id}${kind}`).toBe(true);
    }
    for (const bad of ['../x.dump', '20261007T120000Z.dump/..', '.20261007T120000Z.dump.partial', '20261007T120000Z-other.dump', 'x.dump']) expect(SERVICE_BACKUP_FILE.test(bad), bad).toBe(false);
    expect(SERVICE_CATALOG.filter((t) => t.backup).map((t) => t.id)).toEqual(['postgres', 'mysql', 'mariadb', 'mongodb', 'redis', 'valkey']);
  });
});
