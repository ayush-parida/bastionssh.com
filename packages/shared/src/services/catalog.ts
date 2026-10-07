import type { DeployConnectionField, DeployConnectionString, DeployProxyMode, DeployPublishScope } from '../types/deploy.js';
import pins from './images.json' with { type: 'json' };

/**
 * The quick-services catalog (services spec §3.1): common backing services a
 * manager deploys onto a server in one step. It is code, versioned and
 * reviewed with BastionSSH — the web shows it, the server makes a
 * `bastion.yml` from it, and bastionctl (which bundles it) runs a template's
 * backup and restore commands. Nothing here is per organization.
 *
 * Every image is pinned by digest in `images.json`
 * (`pnpm --filter @smt/shared run update-service-images` re-pins them); a
 * service only ever runs an image of its template's offered lines.
 *
 * Commands run inside the service's container, through `sh -c` when they
 * read a credential from the container's environment (the `.env` values),
 * so no secret is ever on a command line BastionSSH builds. `{file}` in a
 * restore command is the backup's path inside the container.
 */

export type ServiceCategory = 'database' | 'cache' | 'storage' | 'queue' | 'search' | 'analytics' | 'mail' | 'admin' | 'monitoring';

export const SERVICE_CATEGORIES: ReadonlyArray<{ id: ServiceCategory; label: string }> = [
  { id: 'database', label: 'Databases' },
  { id: 'cache', label: 'Caches' },
  { id: 'storage', label: 'Object storage' },
  { id: 'queue', label: 'Queues' },
  { id: 'search', label: 'Search' },
  { id: 'analytics', label: 'Analytics' },
  { id: 'mail', label: 'Mail' },
  { id: 'admin', label: 'Admin tools' },
  { id: 'monitoring', label: 'Monitoring' },
];

/** A lucide icon the web shows for the template (a hint; the server never reads it). */
export type ServiceIcon = 'database' | 'zap' | 'layers' | 'hard-drive' | 'rabbit' | 'search' | 'bar-chart' | 'mail' | 'table' | 'gauge' | 'activity';

export interface ServiceVersion {
  /** The line offered (`17`, `8.4`, `v1.52`); what upgrades are measured in. */
  major: string;
  /** In the version picker: `PostgreSQL 17`. */
  label: string;
  /** The moving tag the update script follows (`postgres:17-alpine`). */
  track: string;
  /** The exact image, digest pinned: `postgres:17.6-alpine@sha256:…`. */
  image: string;
  /** The exact release the digest is (`17.6`). */
  version: string;
  /** Picked unless the person picks another. */
  default?: boolean;
  /** Container paths of this line that differ from the template's (PostgreSQL 18 keeps data one folder up). */
  volumePaths?: Record<string, string>;
  /** Said next to the version (LTS, innovation release…). */
  note?: string;
}

export interface ServiceSecret {
  /** The `.env` variable, generated on the server (never seen by BastionSSH until revealed). */
  key: string;
  /** Random bytes, written base64url (`bastionctl env generate --bytes`). */
  bytes: number;
  description: string;
}

export interface ServiceVolume {
  name: string;
  path: string;
  /** Only one container at a time (data files): the service is replaced with `run.strategy: recreate`. */
  exclusive: boolean;
}

export type ServiceHealthcheck =
  | { type: 'command'; command: string[]; timeout: string }
  | { type: 'tcp'; timeout: string }
  | { type: 'http'; path: string; timeout: string };

export interface ServiceConnectionFormat {
  label: string;
  /** `{host}` and `{port}` are filled in; `{KEY}` names a `.env` variable (a fixed value, or a secret shown masked). */
  template: string;
  /** The container port it goes to (default: the template's `publishPort`). */
  port?: number;
}

export interface ServiceBackupSpec {
  /** The file extension (`dump`, `sql`, `archive.gz`, `rdb`). */
  ext: string;
  /** What the file is, for the docs and the Backups tab. */
  format: string;
  /** Run in the container; writes the backup to stdout, which bastionctl streams to the backup file. */
  dump: string[];
  /**
   * `exec`: the file is copied into the container (`{file}`) and the command
   * restores it there; `replace-file`: the container is stopped, the file
   * replaces `path` (Redis's `dump.rdb`) and the container starts again.
   */
  restore: { type: 'exec'; command: string[] } | { type: 'replace-file'; path: string };
}

/** How far Update version may move: within the same `major` line, within the same minor (`v1.52` → `v1.52.x`), or anywhere. */
export type ServiceUpgradeScope = 'major' | 'minor' | 'any';

export interface ServiceTemplate {
  id: string;
  name: string;
  /** One line in the catalog. */
  description: string;
  category: ServiceCategory;
  icon: ServiceIcon;
  /** The in-app docs page (`/docs/deployments/<slug>`). */
  docs: string;
  /** Where the image comes from, when it is not the project's own. */
  imageNote?: string;
  versions: ServiceVersion[];
  /** `run.port`: health-checked, and what a domain is proxied to. */
  port: number;
  /** The port apps connect to and `run.publish` exposes (default `port`). */
  publishPort: number;
  ports: Array<{ port: number; label: string }>;
  /** An HTTP UI on `port`; `domain`: offered a domain in the create form. */
  ui: { label: string; domain: boolean } | null;
  entrypoint: string[] | null;
  command: string[] | null;
  /** Fixed `.env` values (`{domain}` is the domain picked, when there is one; a value naming it is left out without one). */
  env: Record<string, string>;
  secrets: ServiceSecret[];
  volumes: ServiceVolume[];
  healthcheck: ServiceHealthcheck;
  /** `run.memory` unless the person picks another; `minMemory` is the least the form allows. */
  memory: string;
  minMemory: string;
  connection: { fields: Array<{ label: string; template: string }>; strings: ServiceConnectionFormat[] };
  backup: ServiceBackupSpec | null;
  upgrade: { within: ServiceUpgradeScope; note: string };
  /** Shown in the create form (no authentication, a setup page anyone can claim…). */
  warning?: string;
}

type Pins = Record<string, Record<string, { track: string; image: string; version: string; match?: string; community?: boolean }>>;

/** A line of `id` with its pinned image from images.json. */
function line(id: string, major: string, label: string, extra: Omit<ServiceVersion, 'major' | 'label' | 'track' | 'image' | 'version'> = {}): ServiceVersion {
  const pin = (pins as Pins)[id]?.[major];
  if (!pin) throw new Error(`images.json has no ${id} ${major}`);
  return { major, label, track: pin.track, image: pin.image, version: pin.version, ...extra };
}

const sh = (script: string): string[] => ['sh', '-c', script];
/** A mongodump/mongorestore `--config` file `$c` holding the root password (umask 077, removed when the shell exits). */
const MONGO_AUTH = 'umask 077; c=$(mktemp) || exit 1; trap \'rm -f "$c"\' EXIT; printf \'password: "%s"\\n\' "$MONGO_INITDB_ROOT_PASSWORD" > "$c"';
const SAME_MAJOR = 'Updates stay within the line: a new major version changes the data format, so move with a backup and restore into a new service.';

const redisLike = (id: 'redis' | 'valkey', name: string, server: string, cli: string, key: string): ServiceTemplate => ({
  id,
  name,
  description: id === 'redis' ? 'In-memory key-value store: caches, sessions, queues.' : 'The open-source Redis fork from the Linux Foundation; a drop-in replacement.',
  category: 'cache',
  icon: 'zap',
  docs: 'services-redis',
  versions:
    id === 'redis'
      ? [line('redis', '8', 'Redis 8', { default: true }), line('redis', '7', 'Redis 7.4')]
      : [line('valkey', '9', 'Valkey 9', { default: true }), line('valkey', '8', 'Valkey 8')],
  port: 6379,
  publishPort: 6379,
  ports: [{ port: 6379, label: 'RESP' }],
  ui: null,
  entrypoint: null,
  // Through the image's entrypoint, which drops to the unprivileged user; the password comes from the environment
  command: sh(`exec docker-entrypoint.sh ${server} --requirepass "$${key}" --appendonly no --save 60 1 --dir /data`),
  env: {},
  secrets: [{ key, bytes: 24, description: 'The password clients authenticate with (AUTH)' }],
  volumes: [{ name: 'data', path: '/data', exclusive: true }],
  // The password through REDISCLI_AUTH (valkey-cli reads it too), never on the CLI's command line where `ps` on the host shows it
  healthcheck: { type: 'command', command: sh(`REDISCLI_AUTH="$${key}" ${cli} -h 127.0.0.1 ping | grep -q PONG`), timeout: '60s' },
  memory: '256m',
  minMemory: '32m',
  connection: {
    fields: [{ label: 'Password', template: `{${key}}` }],
    strings: [{ label: 'URL', template: `redis://default:{${key}}@{host}:{port}/0` }],
  },
  backup: {
    ext: 'rdb',
    format: `RDB snapshot (${cli} --rdb)`,
    // To a file first, then out: --rdb's progress messages never mix with the snapshot
    dump: sh(`f=/tmp/bastion-backup.rdb; REDISCLI_AUTH="$${key}" ${cli} -h 127.0.0.1 --rdb "$f" >&2 && cat "$f"; s=$?; rm -f "$f"; exit $s`),
    restore: { type: 'replace-file', path: '/data/dump.rdb' },
  },
  upgrade: { within: 'major', note: SAME_MAJOR },
});

export const SERVICE_CATALOG: readonly ServiceTemplate[] = [
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description: 'The relational database most apps reach for; Prisma, Drizzle, Django and Rails all speak it.',
    category: 'database',
    icon: 'database',
    docs: 'services-postgres',
    versions: [
      line('postgres', '18', 'PostgreSQL 18', { volumePaths: { data: '/var/lib/postgresql' } }),
      line('postgres', '17', 'PostgreSQL 17', { default: true }),
      line('postgres', '16', 'PostgreSQL 16'),
    ],
    port: 5432,
    publishPort: 5432,
    ports: [{ port: 5432, label: 'PostgreSQL' }],
    ui: null,
    entrypoint: null,
    command: null,
    env: { POSTGRES_USER: 'app', POSTGRES_DB: 'app' },
    secrets: [{ key: 'POSTGRES_PASSWORD', bytes: 24, description: 'The password of the app user' }],
    volumes: [{ name: 'data', path: '/var/lib/postgresql/data', exclusive: true }],
    // The init scripts run on a socket-only server first: TCP answers once the real one is up
    healthcheck: { type: 'command', command: sh('pg_isready -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'), timeout: '120s' },
    memory: '512m',
    minMemory: '128m',
    connection: {
      fields: [
        { label: 'User', template: '{POSTGRES_USER}' },
        { label: 'Password', template: '{POSTGRES_PASSWORD}' },
        { label: 'Database', template: '{POSTGRES_DB}' },
      ],
      strings: [
        { label: 'URL', template: 'postgres://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{host}:{port}/{POSTGRES_DB}' },
        { label: 'Prisma DATABASE_URL', template: 'postgresql://{POSTGRES_USER}:{POSTGRES_PASSWORD}@{host}:{port}/{POSTGRES_DB}?schema=public' },
      ],
    },
    backup: {
      ext: 'dump',
      format: 'pg_dump custom format (pg_dump -Fc)',
      dump: sh('exec pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"'),
      restore: { type: 'exec', command: ['sh', '-c', 'exec pg_restore --clean --if-exists --no-owner --single-transaction --exit-on-error -U "$POSTGRES_USER" -d "$POSTGRES_DB" "$0"', '{file}'] },
    },
    upgrade: { within: 'major', note: SAME_MAJOR },
  },
  {
    id: 'mysql',
    name: 'MySQL',
    description: 'The widely deployed relational database; WordPress, Laravel and many ORMs default to it.',
    category: 'database',
    icon: 'database',
    docs: 'services-mysql',
    versions: [line('mysql', '8.4', 'MySQL 8.4', { default: true, note: 'LTS' }), line('mysql', '9', 'MySQL 9', { note: 'Innovation release' })],
    port: 3306,
    publishPort: 3306,
    ports: [{ port: 3306, label: 'MySQL' }],
    ui: null,
    entrypoint: null,
    command: null,
    env: { MYSQL_USER: 'app', MYSQL_DATABASE: 'app' },
    secrets: [
      { key: 'MYSQL_PASSWORD', bytes: 24, description: 'The password of the app user' },
      { key: 'MYSQL_ROOT_PASSWORD', bytes: 24, description: 'The root password (backups and administration)' },
    ],
    volumes: [{ name: 'data', path: '/var/lib/mysql', exclusive: true }],
    // The first start initializes on a server without networking: TCP answers once the real one is up
    healthcheck: { type: 'command', command: sh('MYSQL_PWD="$MYSQL_ROOT_PASSWORD" mysqladmin ping -h 127.0.0.1 -u root --silent'), timeout: '180s' },
    memory: '1g',
    minMemory: '384m',
    connection: {
      fields: [
        { label: 'User', template: '{MYSQL_USER}' },
        { label: 'Password', template: '{MYSQL_PASSWORD}' },
        { label: 'Database', template: '{MYSQL_DATABASE}' },
      ],
      strings: [{ label: 'URL', template: 'mysql://{MYSQL_USER}:{MYSQL_PASSWORD}@{host}:{port}/{MYSQL_DATABASE}' }],
    },
    backup: {
      ext: 'sql',
      format: 'SQL script (mysqldump --single-transaction)',
      dump: sh('export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysqldump -u root --single-transaction --routines --triggers --events --databases "$MYSQL_DATABASE"'),
      restore: { type: 'exec', command: ['sh', '-c', 'export MYSQL_PWD="$MYSQL_ROOT_PASSWORD"; exec mysql -u root < "$0"', '{file}'] },
    },
    upgrade: { within: 'major', note: SAME_MAJOR },
  },
  {
    id: 'mariadb',
    name: 'MariaDB',
    description: 'The community fork of MySQL, compatible with its clients and drivers.',
    category: 'database',
    icon: 'database',
    docs: 'services-mysql',
    versions: [line('mariadb', '11.8', 'MariaDB 11.8', { default: true, note: 'LTS' }), line('mariadb', '11.4', 'MariaDB 11.4', { note: 'LTS' })],
    port: 3306,
    publishPort: 3306,
    ports: [{ port: 3306, label: 'MySQL protocol' }],
    ui: null,
    entrypoint: null,
    command: null,
    env: { MARIADB_USER: 'app', MARIADB_DATABASE: 'app' },
    secrets: [
      { key: 'MARIADB_PASSWORD', bytes: 24, description: 'The password of the app user' },
      { key: 'MARIADB_ROOT_PASSWORD', bytes: 24, description: 'The root password (backups and administration)' },
    ],
    volumes: [{ name: 'data', path: '/var/lib/mysql', exclusive: true }],
    healthcheck: { type: 'command', command: sh('MYSQL_PWD="$MARIADB_ROOT_PASSWORD" mariadb-admin ping -h 127.0.0.1 -u root --silent'), timeout: '180s' },
    memory: '512m',
    minMemory: '256m',
    connection: {
      fields: [
        { label: 'User', template: '{MARIADB_USER}' },
        { label: 'Password', template: '{MARIADB_PASSWORD}' },
        { label: 'Database', template: '{MARIADB_DATABASE}' },
      ],
      strings: [{ label: 'URL', template: 'mysql://{MARIADB_USER}:{MARIADB_PASSWORD}@{host}:{port}/{MARIADB_DATABASE}' }],
    },
    backup: {
      ext: 'sql',
      format: 'SQL script (mariadb-dump --single-transaction)',
      dump: sh('export MYSQL_PWD="$MARIADB_ROOT_PASSWORD"; exec mariadb-dump -u root --single-transaction --routines --triggers --events --databases "$MARIADB_DATABASE"'),
      restore: { type: 'exec', command: ['sh', '-c', 'export MYSQL_PWD="$MARIADB_ROOT_PASSWORD"; exec mariadb -u root < "$0"', '{file}'] },
    },
    upgrade: { within: 'major', note: SAME_MAJOR },
  },
  {
    id: 'mongodb',
    name: 'MongoDB',
    description: 'Document database for JSON-shaped data; Mongoose and the official drivers connect directly.',
    category: 'database',
    icon: 'layers',
    docs: 'services-mongodb',
    versions: [line('mongodb', '8.0', 'MongoDB 8.0', { default: true }), line('mongodb', '7.0', 'MongoDB 7.0')],
    port: 27017,
    publishPort: 27017,
    ports: [{ port: 27017, label: 'MongoDB' }],
    ui: null,
    entrypoint: null,
    command: null,
    env: { MONGO_INITDB_ROOT_USERNAME: 'root' },
    secrets: [{ key: 'MONGO_INITDB_ROOT_PASSWORD', bytes: 24, description: 'The password of the root user' }],
    // The image declares both: named, so a recreate keeps them rather than leaving anonymous volumes behind
    volumes: [
      { name: 'data', path: '/data/db', exclusive: true },
      { name: 'config', path: '/data/configdb', exclusive: true },
    ],
    healthcheck: { type: 'command', command: ['mongosh', '--quiet', '--norc', '--eval', 'quit(db.adminCommand({ ping: 1 }).ok ? 0 : 1)'], timeout: '120s' },
    memory: '1g',
    minMemory: '256m',
    connection: {
      fields: [
        { label: 'User', template: '{MONGO_INITDB_ROOT_USERNAME}' },
        { label: 'Password', template: '{MONGO_INITDB_ROOT_PASSWORD}' },
        { label: 'Auth database', template: 'admin' },
      ],
      strings: [{ label: 'URL', template: 'mongodb://{MONGO_INITDB_ROOT_USERNAME}:{MONGO_INITDB_ROOT_PASSWORD}@{host}:{port}/?authSource=admin' }],
    },
    backup: {
      ext: 'archive.gz',
      format: 'mongodump archive, gzip (mongodump --archive --gzip)',
      // The password in a 0600 --config file (removed on exit), never on the tool's command line where `ps` on the host shows it
      dump: sh(`${MONGO_AUTH}; mongodump --config "$c" --archive --gzip --quiet -u "$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase admin`),
      restore: {
        type: 'exec',
        command: ['sh', '-c', `${MONGO_AUTH}; mongorestore --config "$c" --archive="$0" --gzip --drop --quiet -u "$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase admin`, '{file}'],
      },
    },
    upgrade: { within: 'major', note: SAME_MAJOR },
  },
  redisLike('redis', 'Redis', 'redis-server', 'redis-cli', 'REDIS_PASSWORD'),
  redisLike('valkey', 'Valkey', 'valkey-server', 'valkey-cli', 'VALKEY_PASSWORD'),
  {
    id: 'memcached',
    name: 'Memcached',
    description: 'A simple, fast in-memory cache with nothing on disk.',
    category: 'cache',
    icon: 'zap',
    docs: 'services-others',
    versions: [line('memcached', '1.6', 'Memcached 1.6', { default: true })],
    port: 11211,
    publishPort: 11211,
    ports: [{ port: 11211, label: 'Memcached' }],
    ui: null,
    entrypoint: null,
    command: null,
    env: {},
    secrets: [],
    volumes: [],
    healthcheck: { type: 'tcp', timeout: '30s' },
    memory: '128m',
    minMemory: '32m',
    connection: { fields: [], strings: [{ label: 'Server', template: '{host}:{port}' }] },
    backup: null,
    upgrade: { within: 'any', note: 'A cache holds nothing to migrate: any version can replace another.' },
    warning: 'Memcached has no authentication: anything that can reach the port can read and write the cache. Keep it unpublished.',
  },
  {
    id: 'minio',
    name: 'MinIO',
    description: 'S3-compatible object storage for uploads and backups, with a web console.',
    category: 'storage',
    icon: 'hard-drive',
    docs: 'services-minio',
    imageNote:
      'MinIO no longer publishes container images (minio/minio is gone from Docker Hub). This template runs the community build of the same server from Pigsty (pgsty/minio), pinned by digest.',
    versions: [line('minio', 'RELEASE', 'MinIO (community build)', { default: true })],
    port: 9001,
    publishPort: 9000,
    ports: [
      { port: 9000, label: 'S3 API' },
      { port: 9001, label: 'Console' },
    ],
    ui: { label: 'Console', domain: true },
    entrypoint: null,
    command: ['server', '/data', '--console-address', ':9001'],
    env: { MINIO_ROOT_USER: 'admin' },
    secrets: [{ key: 'MINIO_ROOT_PASSWORD', bytes: 24, description: 'The root secret key (console login and S3 secret)' }],
    volumes: [{ name: 'data', path: '/data', exclusive: true }],
    healthcheck: { type: 'tcp', timeout: '60s' },
    memory: '512m',
    minMemory: '256m',
    connection: {
      fields: [
        { label: 'Access key', template: '{MINIO_ROOT_USER}' },
        { label: 'Secret key', template: '{MINIO_ROOT_PASSWORD}' },
        { label: 'Region', template: 'us-east-1' },
      ],
      strings: [{ label: 'S3 endpoint', template: 'http://{host}:{port}' }],
    },
    backup: null,
    upgrade: { within: 'any', note: 'MinIO releases read the data of earlier ones.' },
  },
  {
    id: 'rabbitmq',
    name: 'RabbitMQ',
    description: 'Message broker (AMQP 0-9-1) with the management UI.',
    category: 'queue',
    icon: 'rabbit',
    docs: 'services-rabbitmq',
    versions: [line('rabbitmq', '4', 'RabbitMQ 4 (management)', { default: true })],
    port: 15672,
    publishPort: 5672,
    ports: [
      { port: 5672, label: 'AMQP' },
      { port: 15672, label: 'Management UI' },
    ],
    ui: { label: 'Management UI', domain: true },
    entrypoint: null,
    command: null,
    // A fixed node name: the data folder is named after it, and a new container's hostname would start an empty node
    env: { RABBITMQ_DEFAULT_USER: 'app', RABBITMQ_NODENAME: 'rabbit@localhost' },
    secrets: [{ key: 'RABBITMQ_DEFAULT_PASS', bytes: 24, description: 'The password of the app user (AMQP and the management UI)' }],
    volumes: [{ name: 'data', path: '/var/lib/rabbitmq', exclusive: true }],
    // As the rabbitmq user: run as root on a new volume, the CLI would write a root-owned .erlang.cookie before
    // the server does, and the server (the entrypoint drops to rabbitmq) could not read it (eacces at first start)
    healthcheck: { type: 'command', command: sh('exec su-exec rabbitmq rabbitmq-diagnostics -q ping'), timeout: '120s' },
    memory: '512m',
    minMemory: '256m',
    connection: {
      fields: [
        { label: 'User', template: '{RABBITMQ_DEFAULT_USER}' },
        { label: 'Password', template: '{RABBITMQ_DEFAULT_PASS}' },
        { label: 'Virtual host', template: '/' },
      ],
      strings: [{ label: 'AMQP URL', template: 'amqp://{RABBITMQ_DEFAULT_USER}:{RABBITMQ_DEFAULT_PASS}@{host}:{port}/' }],
    },
    backup: null,
    upgrade: { within: 'major', note: 'Minor versions upgrade in place; a new major needs its feature flags enabled first (see the RabbitMQ upgrade guide).' },
  },
  {
    id: 'meilisearch',
    name: 'Meilisearch',
    description: 'Fast, typo-tolerant full-text search with a simple HTTP API.',
    category: 'search',
    icon: 'search',
    docs: 'services-others',
    versions: [line('meilisearch', 'v1.52', 'Meilisearch 1.52', { default: true })],
    port: 7700,
    publishPort: 7700,
    ports: [{ port: 7700, label: 'HTTP API' }],
    ui: { label: 'HTTP API', domain: true },
    entrypoint: null,
    command: null,
    env: { MEILI_ENV: 'production', MEILI_NO_ANALYTICS: 'true' },
    secrets: [{ key: 'MEILI_MASTER_KEY', bytes: 32, description: 'The master key (create search and admin API keys with it)' }],
    volumes: [{ name: 'data', path: '/meili_data', exclusive: true }],
    healthcheck: { type: 'http', path: '/health', timeout: '60s' },
    memory: '1g',
    minMemory: '256m',
    connection: { fields: [{ label: 'Master key', template: '{MEILI_MASTER_KEY}' }], strings: [{ label: 'URL', template: 'http://{host}:{port}' }] },
    backup: null,
    upgrade: { within: 'minor', note: 'Meilisearch reads only the database of its own minor version: move to a newer one with a dump (see the Meilisearch docs).' },
  },
  {
    id: 'clickhouse',
    name: 'ClickHouse',
    description: 'Column-oriented database for analytics and event data.',
    category: 'analytics',
    icon: 'bar-chart',
    docs: 'services-others',
    versions: [line('clickhouse', '25.8', 'ClickHouse 25.8', { default: true, note: 'LTS' }), line('clickhouse', '26.3', 'ClickHouse 26.3', { note: 'LTS' })],
    port: 8123,
    publishPort: 8123,
    ports: [
      { port: 8123, label: 'HTTP' },
      { port: 9000, label: 'Native' },
    ],
    ui: null,
    entrypoint: null,
    command: null,
    env: { CLICKHOUSE_USER: 'app', CLICKHOUSE_DB: 'app', CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: '1' },
    secrets: [{ key: 'CLICKHOUSE_PASSWORD', bytes: 24, description: 'The password of the app user' }],
    volumes: [{ name: 'data', path: '/var/lib/clickhouse', exclusive: true }],
    healthcheck: { type: 'http', path: '/ping', timeout: '120s' },
    memory: '2g',
    minMemory: '1g',
    connection: {
      fields: [
        { label: 'User', template: '{CLICKHOUSE_USER}' },
        { label: 'Password', template: '{CLICKHOUSE_PASSWORD}' },
        { label: 'Database', template: '{CLICKHOUSE_DB}' },
      ],
      strings: [
        { label: 'HTTP URL', template: 'http://{CLICKHOUSE_USER}:{CLICKHOUSE_PASSWORD}@{host}:{port}/?database={CLICKHOUSE_DB}' },
        { label: 'Native', template: 'clickhouse://{CLICKHOUSE_USER}:{CLICKHOUSE_PASSWORD}@{host}:{port}/{CLICKHOUSE_DB}', port: 9000 },
      ],
    },
    backup: null,
    upgrade: { within: 'major', note: SAME_MAJOR },
  },
  {
    id: 'mailpit',
    name: 'Mailpit',
    description: 'Catches the email your apps send, with a web UI to read it. For staging and development.',
    category: 'mail',
    icon: 'mail',
    docs: 'services-others',
    versions: [line('mailpit', 'v1', 'Mailpit 1', { default: true })],
    port: 8025,
    publishPort: 1025,
    ports: [
      { port: 1025, label: 'SMTP' },
      { port: 8025, label: 'Web UI' },
    ],
    ui: { label: 'Web UI', domain: true },
    // The UI login comes from the generated password: put together in the container, never on a command line we build
    entrypoint: ['/bin/sh', '-c'],
    command: ['export MP_UI_AUTH="admin:$MAILPIT_UI_PASSWORD"; exec /mailpit'],
    env: { MP_DATABASE: '/data/mailpit.db', MP_SMTP_AUTH_ACCEPT_ANY: 'true', MP_SMTP_AUTH_ALLOW_INSECURE: 'true' },
    secrets: [{ key: 'MAILPIT_UI_PASSWORD', bytes: 18, description: 'The web UI password (user admin)' }],
    volumes: [{ name: 'data', path: '/data', exclusive: true }],
    healthcheck: { type: 'http', path: '/readyz', timeout: '60s' },
    memory: '128m',
    minMemory: '64m',
    connection: {
      fields: [
        { label: 'UI user', template: 'admin' },
        { label: 'UI password', template: '{MAILPIT_UI_PASSWORD}' },
      ],
      strings: [{ label: 'SMTP', template: 'smtp://{host}:{port}' }],
    },
    backup: null,
    upgrade: { within: 'any', note: 'Mailpit upgrades its database itself.' },
  },
  {
    id: 'adminer',
    name: 'Adminer',
    description: 'A database admin UI in one page: PostgreSQL, MySQL, MariaDB and more on the same server.',
    category: 'admin',
    icon: 'table',
    docs: 'services-others',
    versions: [line('adminer', '5', 'Adminer 5', { default: true })],
    port: 8080,
    publishPort: 8080,
    ports: [{ port: 8080, label: 'Web UI' }],
    ui: { label: 'Web UI', domain: true },
    entrypoint: null,
    command: null,
    env: {},
    secrets: [],
    volumes: [],
    healthcheck: { type: 'tcp', timeout: '30s' },
    memory: '128m',
    minMemory: '64m',
    connection: { fields: [], strings: [] },
    backup: null,
    upgrade: { within: 'any', note: 'Adminer keeps nothing: any version can replace another.' },
    warning: 'Adminer shows a login form for every database on the server’s private network. Give it a domain only while you use it, and delete it afterwards.',
  },
  {
    id: 'grafana',
    name: 'Grafana',
    description: 'Dashboards and alerting over Prometheus, PostgreSQL, ClickHouse, Loki and more.',
    category: 'monitoring',
    icon: 'gauge',
    docs: 'services-others',
    versions: [line('grafana', '13', 'Grafana 13', { default: true }), line('grafana', '12', 'Grafana 12')],
    port: 3000,
    publishPort: 3000,
    ports: [{ port: 3000, label: 'Web UI' }],
    ui: { label: 'Web UI', domain: true },
    entrypoint: null,
    command: null,
    env: { GF_SECURITY_ADMIN_USER: 'admin', GF_SERVER_ROOT_URL: 'https://{domain}/', GF_ANALYTICS_REPORTING_ENABLED: 'false' },
    secrets: [{ key: 'GF_SECURITY_ADMIN_PASSWORD', bytes: 18, description: 'The password of the admin user' }],
    volumes: [{ name: 'data', path: '/var/lib/grafana', exclusive: true }],
    healthcheck: { type: 'http', path: '/api/health', timeout: '120s' },
    memory: '512m',
    minMemory: '128m',
    connection: {
      fields: [
        { label: 'User', template: '{GF_SECURITY_ADMIN_USER}' },
        { label: 'Password', template: '{GF_SECURITY_ADMIN_PASSWORD}' },
      ],
      strings: [],
    },
    backup: null,
    upgrade: { within: 'any', note: 'Grafana migrates its database forward; it cannot go back afterwards.' },
  },
  {
    id: 'uptime-kuma',
    name: 'Uptime Kuma',
    description: 'Self-hosted uptime monitoring with status pages and notifications.',
    category: 'monitoring',
    icon: 'activity',
    docs: 'services-others',
    versions: [line('uptime-kuma', '2', 'Uptime Kuma 2', { default: true })],
    port: 3001,
    publishPort: 3001,
    ports: [{ port: 3001, label: 'Web UI' }],
    ui: { label: 'Web UI', domain: true },
    entrypoint: null,
    command: null,
    env: {},
    secrets: [],
    volumes: [{ name: 'data', path: '/app/data', exclusive: true }],
    healthcheck: { type: 'tcp', timeout: '120s' },
    memory: '512m',
    minMemory: '128m',
    connection: { fields: [], strings: [] },
    backup: null,
    upgrade: { within: 'major', note: SAME_MAJOR },
    warning: 'The first visitor creates the admin account: open it as soon as it is deployed and set the account up.',
  },
];

export function serviceTemplate(id: string | null | undefined): ServiceTemplate | undefined {
  return id ? SERVICE_CATALOG.find((t) => t.id === id) : undefined;
}

export function defaultServiceVersion(t: ServiceTemplate): ServiceVersion {
  return t.versions.find((v) => v.default) ?? t.versions[0]!;
}

export function serviceVersion(t: ServiceTemplate, major: string): ServiceVersion | undefined {
  return t.versions.find((v) => v.major === major);
}

/** `postgres:17.6-alpine@sha256:…` → `postgres` (`valkey/valkey`), and the tag. */
export function imageRepoAndTag(ref: string): { repo: string; tag: string | null; digest: string | null } {
  const at = ref.indexOf('@');
  const named = at === -1 ? ref : ref.slice(0, at);
  const digest = at === -1 ? null : ref.slice(at + 1);
  const slash = named.lastIndexOf('/');
  const colon = named.lastIndexOf(':');
  return colon > slash ? { repo: named.slice(0, colon), tag: named.slice(colon + 1), digest } : { repo: named, tag: null, digest };
}

/** The line an image belongs to: same repository, and its tag starts with the line (`17.6-alpine` is of `17`). */
export function serviceVersionOfImage(t: ServiceTemplate, ref: string): ServiceVersion | undefined {
  const { repo, tag } = imageRepoAndTag(ref);
  return t.versions.find((v) => {
    const pinned = imageRepoAndTag(v.image);
    if (pinned.repo !== repo || !tag) return false;
    return tag === v.major || tag.startsWith(`${v.major}.`) || tag.startsWith(`${v.major}-`);
  });
}

/** Compare two release strings numerically by their parts (`v1.52.4`, `13.2.3`, `RELEASE.2026-08-04T00-00-00Z`). */
export function compareReleases(a: string, b: string): number {
  const parts = (s: string) => (s.match(/\d+/g) ?? []).map(Number);
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Whether Update version may move a service from `from` to `to` (both lines
 * of `t`): within the line always; across lines only when the template says
 * its data carries over (`within: any`). Databases never cross a major: the
 * data files of one major are not the next one's (dump and restore).
 */
export function serviceUpgradeAllowed(t: ServiceTemplate, from: ServiceVersion | undefined, to: ServiceVersion): { ok: true } | { ok: false; reason: string } {
  if (from && from.major === to.major) return { ok: true };
  if (t.upgrade.within === 'any') {
    // Forward only: a release migrates its data forward and an older one cannot read it (Grafana 13 → 12)
    if (from && compareReleases(to.version, from.version) < 0) {
      return { ok: false, reason: `${t.name} cannot be moved back from ${from.label} to ${to.label}: its data was migrated by the newer release. Restore a backup into a new service instead.` };
    }
    return { ok: true };
  }
  const what = from ? `${from.label} to ${to.label}` : `this image to ${to.label}`;
  return { ok: false, reason: `${t.name} cannot be moved from ${what} in place. ${t.upgrade.note}` };
}

/** Container paths of `t`'s volumes for line `v`. */
export function serviceVolumes(t: ServiceTemplate, v: ServiceVersion): ServiceVolume[] {
  return t.volumes.map((vol) => ({ ...vol, path: v.volumePaths?.[vol.name] ?? vol.path }));
}

/** The fixed `.env` values for a new service; ones naming `{domain}` only when it has one. */
export function serviceFixedEnv(t: ServiceTemplate, domain: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(t.env)) {
    if (value.includes('{domain}')) {
      if (domain) out[key] = value.split('{domain}').join(domain);
    } else out[key] = value;
  }
  return out;
}

export interface ServiceCreateOptions {
  name: string;
  version: ServiceVersion;
  /** `run.memory` (`512m`, `1g`). */
  memory: string;
  publish: { scope: DeployPublishScope; port: number | null };
  /** For a template with a UI: served through the proxy. */
  domain: string | null;
  tls: 'auto' | 'staging' | 'internal';
  proxy: DeployProxyMode;
}

/** A YAML double-quoted scalar (JSON's string syntax is one). */
const q = (s: string) => JSON.stringify(s);
/** A flow sequence, spaced the way the yaml library writes one back (Update version and Backups edit the file). */
const list = (items: string[]) => `[ ${items.map(q).join(', ')} ]`;

/** Default `backups.keep`. */
export const SERVICE_BACKUP_KEEP = 7;

/**
 * The `bastion.yml` of a new service (services spec §3.2): the pinned image,
 * recreate with exclusive volumes, the health check, publish, and a domain
 * for a UI when one was picked. bastionctl validates it like any other.
 */
export function serviceConfigYaml(t: ServiceTemplate, o: ServiceCreateOptions): string {
  const vols = serviceVolumes(t, o.version);
  const exclusive = vols.some((v) => v.exclusive);
  const publish =
    o.publish.scope === 'none' || o.publish.port === null
      ? 'none'
      : `${o.publish.scope}:${o.publish.port}${t.publishPort !== t.port ? `:${t.publishPort}` : ''}`;
  const h = t.healthcheck;
  const lines = [
    `# ${t.name} from the BastionSSH quick-services catalog (${o.version.label}).`,
    '# Update version and Backups on the service page rewrite build.image and backups.',
    `name: ${o.name}`,
    `service: ${t.id}`,
    `domains: [${o.domain ?? ''}]`,
    ...(o.domain ? [`tls: ${o.tls}`] : []),
    'build:',
    '  type: image',
    `  image: ${q(o.version.image)}`,
    'run:',
    `  port: ${t.port}`,
    '  env_file: .env',
    `  memory: ${o.memory}`,
    ...(exclusive ? ['  strategy: recreate'] : []),
    `  publish: ${q(publish)}`,
    ...(t.entrypoint ? [`  entrypoint: ${list(t.entrypoint)}`] : []),
    ...(t.command ? [`  command: ${list(t.command)}`] : []),
    ...(vols.length > 0 ? ['  volumes:', ...vols.map((v) => `    - { name: ${v.name}, path: ${q(v.path)}${v.exclusive ? ', exclusive: true' : ''} }`)] : []),
    'healthcheck:',
    `  type: ${h.type}`,
    ...(h.type === 'command' ? [`  command: ${list(h.command)}`] : h.type === 'http' ? [`  path: ${h.path}`] : []),
    `  timeout: ${h.timeout}`,
    ...(t.backup ? [`backups: { schedule: "off", keep: ${SERVICE_BACKUP_KEEP} }`] : []),
    'keep_releases: 3',
    `proxy: ${o.proxy}`,
    '',
  ];
  return lines.join('\n');
}

/** `{KEY}` placeholders in a connection template. */
const PLACEHOLDER = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** Fill `{host}`, `{port}` and fixed values; secrets stay `{KEY}` (the browser fills them in after a reveal). */
export function fillServiceTemplate(template: string, values: Record<string, string>): string {
  return template.replace(PLACEHOLDER, (whole, key: string) => values[key] ?? whole);
}

/** The secret `.env` keys a filled template still names, in order. */
export function templateSecrets(text: string, secrets: readonly string[]): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PLACEHOLDER)) if (secrets.includes(m[1]!) && !out.includes(m[1]!)) out.push(m[1]!);
  return out;
}

/**
 * Connection strings and fields of a service, as BastionSSH shows them:
 * host, port and the template's fixed values filled in; secrets left as
 * `{KEY}` for a reveal to fill.
 */
export function serviceConnectionDetails(
  t: ServiceTemplate,
  o: { host: string; published: { host: string; port: number } | null },
): { fields: DeployConnectionField[]; strings: DeployConnectionString[]; secrets: string[] } {
  const secretKeys = t.secrets.map((s) => s.key);
  const fixed = serviceFixedEnv(t, null);
  const fill = (template: string, host: string, port: number) => fillServiceTemplate(template, { ...fixed, host, port: String(port) });
  const strings = t.connection.strings.map((s) => {
    const port = s.port ?? t.publishPort;
    // Only the published port reaches the outside
    const viaPublish = o.published && port === t.publishPort ? fill(s.template, o.published.host, o.published.port) : null;
    return { label: s.label, internal: fill(s.template, o.host, port), published: viaPublish };
  });
  const fields: DeployConnectionField[] = [
    { label: 'Host', value: o.host, secret: null },
    { label: 'Port', value: String(t.publishPort), secret: null },
    ...t.connection.fields.map((f) => {
      const secret = templateSecrets(f.template, secretKeys)[0] ?? null;
      return { label: f.label, value: secret ? null : fillServiceTemplate(f.template, fixed), secret };
    }),
  ];
  const secrets: string[] = [];
  for (const text of [...strings.flatMap((s) => [s.internal, s.published ?? '']), ...fields.map((f) => (f.secret ? `{${f.secret}}` : ''))]) {
    for (const key of templateSecrets(text, secretKeys)) if (!secrets.includes(key)) secrets.push(key);
  }
  return { fields, strings, secrets };
}

/** Backup files bastionctl writes: `<UTC yyyymmddThhmmssZ>[-scheduled|-pre-restore].<ext>`. */
export const SERVICE_BACKUP_FILE = /^\d{8}T\d{6}Z(?:-(?:scheduled|pre-restore))?\.[a-z0-9]{1,8}(?:\.[a-z0-9]{1,8})?$/;
