/**
 * Decides whether a shell command the AI wants to run could change anything on
 * the server. Read-only commands run straight away; everything else waits for
 * the user to approve it.
 *
 * This is a conservative allowlist, not a sandbox: a command is read-only only
 * if every segment (split on `;`, `&&`, `||`, `|`, `&`, newlines and
 * parentheses) runs a known read-only program with arguments that keep it
 * read-only. Anything the parser does not understand — an unknown program,
 * command substitution, a redirect into a file, an odd quote — counts as a
 * change. Misclassifying a harmless command only costs one extra click, so the
 * rules stay strict rather than clever.
 */

export interface CommandClassification {
  mutating: boolean;
  /** Human-readable why, shown to the user next to Approve / Deny */
  reason: string;
}

export function classifyCommand(command: string): CommandClassification {
  const trimmed = command.trim();
  if (!trimmed) return { mutating: false, reason: 'Empty command' };

  try {
    rejectExpansions(trimmed);
    const segments = tokenize(trimmed);
    for (const words of segments) checkSegment(words);
  } catch (err) {
    if (err instanceof Unsafe) return { mutating: true, reason: err.message };
    throw err;
  }
  return { mutating: false, reason: 'Every command in it is read-only' };
}

// ── Tokenizer ────────────────────────────────────────────────────────────────

class Unsafe extends Error {}

interface Word {
  /** The word after quote removal, as the program would see it */
  text: string;
  /** Contains unquoted glob or brace characters, so the shell may rewrite it */
  glob: boolean;
  /** Contains a `$VAR` / `${VAR}` / `$1` expansion outside single quotes */
  expands: boolean;
}

/**
 * Constructs that make the shell run or build text we cannot see statically.
 * Checked on the raw string, quotes included — `'$(x)'` is harmless but rare
 * enough that refusing it is fine.
 */
function rejectExpansions(command: string) {
  if (command.includes('`') || command.includes('$(')) {
    throw new Unsafe('Uses command substitution, which runs another command');
  }
  if (/[<>]\(/.test(command)) {
    throw new Unsafe('Uses process substitution, which runs another command');
  }
  // `${VAR}` is fine; `${VAR:=x}` and friends can assign and inject arguments.
  for (const m of command.matchAll(/\$\{([^}]*)\}?/g)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(m[1] ?? '') || !m[0].endsWith('}')) {
      throw new Unsafe('Uses a parameter expansion that can change its arguments');
    }
  }
}

const SEPARATORS = new Set([';', '&', '|', '(', ')', '\n']);
const WORD_END = new Set([' ', '\t', '\n', ';', '&', '|', '(', ')', '<', '>']);
const GLOB_CHARS = new Set(['*', '?', '[', '{', '}']);

/** Split into segments of words, validating every redirection on the way. */
function tokenize(src: string): Word[][] {
  const segments: Word[][] = [];
  let current: Word[] = [];
  let i = 0;

  const endSegment = () => {
    if (current.length > 0) segments.push(current);
    current = [];
  };

  while (i < src.length) {
    const ch = src[i]!;

    if (ch === ' ' || ch === '\t') {
      i++;
    } else if (ch === '\\' && src[i + 1] === '\n') {
      i += 2; // line continuation
    } else if (ch === '&' && src[i + 1] === '>') {
      // `&>file` / `&>>file`: stdout and stderr to a file
      i += src[i + 2] === '>' ? 3 : 2;
      const target = readTarget(src, i);
      i = target.end;
      requireSinkTarget(target.word);
    } else if (ch === '>' || ch === '<') {
      i = readRedirect(src, i);
    } else if (SEPARATORS.has(ch)) {
      endSegment();
      i++;
    } else {
      const { word, end } = readWord(src, i);
      // `2>` / `2>&1`: a bare number directly before a redirect is an fd, not a word
      if ((src[end] === '>' || src[end] === '<') && /^\d+$/.test(word.text)) {
        i = readRedirect(src, end);
      } else {
        current.push(word);
        i = end;
      }
    }
  }
  endSegment();
  return segments;
}

/** Characters that make a following `$` start a parameter expansion. */
const EXPANSION_START = /[A-Za-z0-9_{@*#?$!-]/;

/** Read one shell word starting at `start`, removing quotes and escapes. */
function readWord(src: string, start: number): { word: Word; end: number } {
  // An unquoted `#` at the start of a word begins a comment that runs to the end
  // of the line. Quotes inside a comment mean nothing to bash but would throw
  // this tokenizer out of step (it could read the next, executed line as quoted
  // text), so comments are refused rather than stripped.
  if (src[start] === '#') throw new Unsafe('Contains a shell comment, which is not allowed');
  let text = '';
  let glob = false;
  let expands = false;
  let i = start;

  while (i < src.length && !WORD_END.has(src[i]!)) {
    const ch = src[i]!;
    if (ch === '\\') {
      if (src[i + 1] === '\n') {
        i += 2;
        continue;
      }
      if (i + 1 >= src.length) throw new Unsafe('Ends with a dangling escape');
      text += src[i + 1];
      i += 2;
    } else if (ch === "'") {
      const close = src.indexOf("'", i + 1);
      if (close === -1) throw new Unsafe('Has an unterminated quote');
      text += src.slice(i + 1, close);
      i = close + 1;
    } else if (ch === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length && '"\\$`\n'.includes(src[i + 1]!)) {
          if (src[i + 1] !== '\n') text += src[i + 1];
          i += 2;
        } else {
          if (src[i] === '$' && EXPANSION_START.test(src[i + 1] ?? '')) expands = true;
          text += src[i];
          i++;
        }
      }
      if (i >= src.length) throw new Unsafe('Has an unterminated quote');
      i++;
    } else if (ch === '$' && `'"[`.includes(src[i + 1] ?? '')) {
      // `$'\x2d…'`, `$"…"` and `$[…]` build text the checker cannot follow
      throw new Unsafe('Uses shell quoting the checker cannot follow');
    } else {
      if (GLOB_CHARS.has(ch)) glob = true;
      if (ch === '$' && EXPANSION_START.test(src[i + 1] ?? '')) expands = true;
      text += ch;
      i++;
    }
  }
  return { word: { text, glob, expands }, end: i };
}

function readTarget(src: string, start: number) {
  let i = start;
  while (src[i] === ' ' || src[i] === '\t') i++;
  if (i >= src.length || WORD_END.has(src[i]!))
    throw new Unsafe('Has a redirection without a target');
  return readWord(src, i);
}

/** Output may only be thrown away or sent to the terminal, never into a file. */
const SINKS = new Set(['/dev/null', '/dev/stdout', '/dev/stderr']);

function requireSinkTarget(word: Word) {
  if (word.glob || !SINKS.has(word.text)) {
    throw new Unsafe('Redirects output into a file');
  }
}

/** Handle `>`, `>>`, `>|`, `>&N`, `<`, `<<<`, `<&N` at `start`; returns the index after. */
function readRedirect(src: string, start: number): number {
  let i = start;
  if (src[i] === '>') {
    i++;
    if (src[i] === '>' || src[i] === '|') i++;
    if (src[i] === '&') {
      // `2>&1`, `>&2`, `>&-` duplicate or close an fd; `>&file` writes a file
      const target = readTarget(src, i + 1);
      if (!/^(\d+|-)$/.test(target.word.text)) requireSinkTarget(target.word);
      return target.end;
    }
    const target = readTarget(src, i);
    requireSinkTarget(target.word);
    return target.end;
  }

  // Input side
  i++;
  if (src[i] === '<') {
    if (src[i + 1] === '<') {
      // `<<< word` here-string: the word is just input text
      return readTarget(src, i + 2).end;
    }
    throw new Unsafe('Uses a here-document the checker does not follow');
  }
  if (src[i] === '>') throw new Unsafe('Opens a file for writing (`<>`)');
  if (src[i] === '&') {
    const target = readTarget(src, i + 1);
    if (!/^(\d+|-)$/.test(target.word.text)) throw new Unsafe('Has an unusual redirection');
    return target.end;
  }
  return readTarget(src, i).end; // reading a file is fine
}

// ── Per-program rules ────────────────────────────────────────────────────────

/** Returns a reason if the arguments make the program change something, else null. */
type Rule = (args: Word[]) => string | null;

const WRAPPERS: Record<string, string> = {
  sudo: 'runs a command with elevated privileges',
  su: 'runs a command as another user',
  doas: 'runs a command with elevated privileges',
  pkexec: 'runs a command with elevated privileges',
  runuser: 'runs a command as another user',
  tee: 'writes its input to files',
  xargs: 'runs other commands built from its input',
  eval: 'executes arbitrary shell code',
  exec: 'replaces the shell with another command',
  source: 'executes a script',
  '.': 'executes a script',
  sh: 'starts a shell that can run anything',
  bash: 'starts a shell that can run anything',
  zsh: 'starts a shell that can run anything',
  dash: 'starts a shell that can run anything',
  ksh: 'starts a shell that can run anything',
  fish: 'starts a shell that can run anything',
  nohup: 'runs another command',
  timeout: 'runs another command',
  watch: 'runs another command repeatedly',
  nice: 'runs another command',
  ionice: 'runs another command',
  awk: 'can write files and run commands',
  gawk: 'can write files and run commands',
  perl: 'runs a script',
  python: 'runs a script',
  python3: 'runs a script',
  node: 'runs a script',
};

const always: Rule = () => null;

/** Programs whose output-only behaviour does not depend on their arguments. */
const PLAIN = [
  'ls',
  'cat',
  'tac',
  'head',
  'tail',
  'grep',
  'egrep',
  'fgrep',
  'zcat',
  'zgrep',
  'stat',
  'du',
  'df',
  'free',
  'uptime',
  'uname',
  'whoami',
  'id',
  'groups',
  'w',
  'who',
  'last',
  'ps',
  'pgrep',
  'pidof',
  'printenv',
  'echo',
  'printf',
  'pwd',
  'which',
  'whereis',
  'type',
  'wc',
  'cut',
  'tr',
  'column',
  'rev',
  'nl',
  'netstat',
  'lsof',
  'lsblk',
  'findmnt',
  'getent',
  'dig',
  'nslookup',
  'host',
  'traceroute',
  'tracepath',
  'vmstat',
  'iostat',
  'mpstat',
  'nproc',
  'lscpu',
  'lsmod',
  'lspci',
  'lsusb',
  'arch',
  'lsb_release',
  'getconf',
  'locale',
  'realpath',
  'readlink',
  'basename',
  'dirname',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'jq',
  'strings',
  'od',
  'base64',
  'diff',
  'cmp',
  'dpkg-query',
  'cd',
  'true',
  'false',
  'test',
  'sleep',
];

const RULES: Record<string, Rule> = {
  ...Object.fromEntries(PLAIN.map((p) => [p, always])),

  find: (args) =>
    noGlob(args, 'find') ??
    (args.some((a) => FIND_ACTIONS.has(a.text) || a.text.startsWith('-fprint'))
      ? '`find` with -delete, -exec or a file-writing action changes files'
      : null),

  sed: sedRule,

  sort: (args) =>
    noGlob(args, 'sort') ??
    (args.some(
      (a) =>
        (isShortCluster(a.text) && a.text.includes('o')) ||
        a.text.startsWith('--output') ||
        a.text.startsWith('--compress-program'),
    )
      ? '`sort -o` writes a file'
      : null),

  uniq: (args) => {
    const bad = noGlob(args, 'uniq');
    if (bad) return bad;
    const positional = args.filter((a) => !a.text.startsWith('-'));
    const flagsOk = args
      .filter((a) => a.text.startsWith('-'))
      .every(
        (a) =>
          /^-[cduiDz]+$/.test(a.text) ||
          ['--count', '--repeated', '--unique', '--ignore-case', '--zero-terminated'].includes(
            a.text,
          ),
      );
    // `uniq in out` writes `out`
    return flagsOk && positional.length <= 1 ? null : '`uniq` with an output file writes it';
  },

  less: pagerRule,
  more: pagerRule,

  tree: (args) =>
    noGlob(args, 'tree') ??
    (args.some((a) => a.text === '-o' || a.text.startsWith('--output'))
      ? '`tree -o` writes a file'
      : null),

  file: (args) =>
    args.some((a) => (isShortCluster(a.text) && a.text.includes('C')) || a.text === '--compile')
      ? '`file -C` writes a magic file'
      : null,

  dmesg: (args) =>
    args.some(
      (a) =>
        (isShortCluster(a.text) && /[cCDEn]/.test(a.text)) ||
        ['--clear', '--read-clear', '--console-off', '--console-on', '--console-level'].some((f) =>
          a.text.startsWith(f),
        ),
    )
      ? '`dmesg` with these options clears the buffer or changes the console'
      : null,

  top: (args) =>
    noGlob(args, 'top') ??
    (args.some((a) => /^-[a-zA-Z]*b/.test(a.text) || a.text === '--batch')
      ? null
      : '`top` is only allowed in batch mode (-b)'),

  date: dateRule,

  hostname: (args) =>
    args.every((a) => HOSTNAME_FLAGS.has(a.text))
      ? null
      : '`hostname` with an argument renames the host',

  env: (args) =>
    args.every((a) => a.text === '-0' || a.text === '--null')
      ? null
      : '`env` with arguments runs another command',

  mount: (args) =>
    args.every((a) => a.text === '-l') ? null : '`mount` with arguments mounts a filesystem',

  blkid: (args) =>
    args.some(
      (a) => (isShortCluster(a.text) && a.text.includes('g')) || a.text === '--garbage-collect',
    )
      ? '`blkid -g` rewrites the cache'
      : null,

  journalctl: (args) =>
    args.some((a) => JOURNALCTL_WRITES.some((f) => a.text.startsWith(f)))
      ? '`journalctl` with these options deletes or rotates logs'
      : null,

  systemctl: (args) =>
    subcommandIn(args, SYSTEMCTL_READ, SYSTEMCTL_LEADING, 'systemctl', SYSTEMCTL_LEADING_VALUE),

  service: (args) => {
    const t = args.map((a) => a.text);
    if (t.length === 1 && t[0] === '--status-all') return null;
    if (t.length === 2 && t[1] === 'status') return null;
    return 'Only `service <name> status` is read-only';
  },

  timedatectl: (args) =>
    args.length === 0
      ? null
      : subcommandIn(args, new Set(['status', 'show', 'list-timezones']), NO_PAGER, 'timedatectl'),
  hostnamectl: (args) =>
    args.length === 0 ? null : subcommandIn(args, new Set(['status']), NO_PAGER, 'hostnamectl'),

  docker: dockerRule,
  ip: ipRule,

  // `-K` / `--kill` closes matching sockets; `-D` / `--diag` dumps into a file
  ss: (args) =>
    noGlob(args, 'ss') ??
    (args.some(
      (a) =>
        (isShortCluster(a.text) && /[KD]/.test(a.text)) ||
        a.text === '--kill' ||
        a.text.startsWith('--diag'),
    )
      ? '`ss -K` kills sockets and `ss -D` writes a file'
      : null),

  ping: (args) =>
    args.some((a) => /^-[a-zA-Z]*c\d*$/.test(a.text) || a.text.startsWith('--count'))
      ? null
      : '`ping` needs a count (-c) so it ends',

  curl: curlRule,
  git: gitRule,
  kubectl: kubectlRule,

  nginx: (args) => {
    for (let i = 0; i < args.length; i++) {
      const t = args[i]!.text;
      if (t === '-c') {
        i++;
        continue;
      }
      if (!/^-[tTvVq]+$/.test(t)) return '`nginx` is only read-only with -t, -T, -v or -V';
    }
    return null;
  },
  apachectl: apacheRule,
  apache2ctl: apacheRule,

  apt: (args) =>
    firstIn(args, ['list', 'show', 'search', 'policy', 'depends', 'rdepends', 'madison'], 'apt'),
  'apt-cache': (args) =>
    firstIn(
      args,
      [
        'policy',
        'show',
        'search',
        'depends',
        'rdepends',
        'madison',
        'showpkg',
        'stats',
        'pkgnames',
      ],
      'apt-cache',
    ),
  dpkg: (args) =>
    firstIn(
      args,
      [
        '-l',
        '-L',
        '-s',
        '-S',
        '-p',
        '--list',
        '--listfiles',
        '--status',
        '--search',
        '--print-avail',
        '--get-selections',
        '--print-architecture',
        '--print-foreign-architectures',
        '-V',
        '--verify',
        '--audit',
      ],
      'dpkg',
    ),
  rpm: (args) => {
    const first = args[0]?.text ?? '';
    if (!/^-q[a-zA-Z]*$/.test(first) && first !== '--query')
      return 'Only `rpm -q` queries are read-only';
    return args.some((a) => /^--(set|restore|import|rebuilddb|initdb)/.test(a.text))
      ? '`rpm` with this option changes the package database'
      : null;
  },
  yum: pkgQueryRule('yum'),
  dnf: pkgQueryRule('dnf'),

  crontab: (args) => {
    const t = args.map((a) => a.text);
    const rest = [...t];
    const u = rest.indexOf('-u');
    if (u !== -1) rest.splice(u, 2);
    return rest.length === 1 && rest[0] === '-l' ? null : 'Only `crontab -l` is read-only';
  },

  ufw: (args) => (args[0]?.text === 'status' ? null : 'Only `ufw status` is read-only'),

  // nft reads options anywhere on the line (`-f FILE` loads a ruleset), so every
  // flag must be a display option, not just the ones before `list`.
  nft: (args) =>
    onlyFlags(args, NFT_FLAGS, 'nft') ?? subcommandIn(args, new Set(['list']), NFT_FLAGS, 'nft'),

  iptables: iptablesRule,
  ip6tables: iptablesRule,

  sysctl: (args) => {
    for (const a of args) {
      if (a.text.startsWith('-')) {
        if (!/^-[aneNbAX]+$/.test(a.text) && !['--all', '--values', '--names'].includes(a.text)) {
          return '`sysctl` with this option changes kernel settings';
        }
      } else if (a.text.includes('=')) {
        return '`sysctl key=value` changes a kernel setting';
      }
    }
    return null;
  },

  command: (args) =>
    args[0]?.text === '-v' || args[0]?.text === '-V' ? null : '`command` runs another command',
};

const NFT_FLAGS = new Set(['-a', '-n', '-nn', '-s', '--handle', '--numeric', '--stateless']);

const FIND_ACTIONS = new Set(['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fls']);

const HOSTNAME_FLAGS = new Set([
  '-f',
  '-i',
  '-I',
  '-s',
  '-d',
  '-A',
  '-a',
  '-y',
  '--fqdn',
  '--long',
  '--short',
  '--ip-address',
  '--all-ip-addresses',
  '--domain',
  '--all-fqdns',
  '--alias',
  '--nis',
]);

const JOURNALCTL_WRITES = [
  '--vacuum',
  '--rotate',
  '--flush',
  '--sync',
  '--relinquish-var',
  '--smart-relinquish-var',
  '--setup-keys',
  '--update-catalog',
];

const NO_PAGER = new Set(['--no-pager']);

const SYSTEMCTL_READ = new Set([
  'status',
  'is-active',
  'is-enabled',
  'is-failed',
  'list-units',
  'list-unit-files',
  'list-timers',
  'list-sockets',
  'list-dependencies',
  'show',
  'cat',
  '--version',
]);

const SYSTEMCTL_LEADING = new Set([
  '--no-pager',
  '--no-legend',
  '-l',
  '--full',
  '-a',
  '--all',
  '--plain',
  '-q',
  '--quiet',
  '--user',
  '--system',
  '--failed',
]);
/** `--name=value` options allowed before the systemctl subcommand (never -H / --host). */
const SYSTEMCTL_LEADING_VALUE = ['--type=', '--state=', '--property=', '--output=', '--lines='];

/** Program-level check shared by rules whose safety depends on literal flags. */
function noGlob(args: Word[], program: string): string | null {
  return args.some((a) => a.glob)
    ? `\`${program}\` with an unquoted wildcard could expand into unsafe options`
    : null;
}

function isShortCluster(text: string) {
  return /^-[a-zA-Z0-9]+$/.test(text);
}

/**
 * The first argument after any `leading` no-value flags (or `--x=y` flags whose
 * prefix is in `leadingValue`) must be one of `allowed`. A leading flag outside
 * the lists could take the next word as its value and make a later word the
 * real subcommand, or change what the program loads (config files, rulesets,
 * install roots), so it is refused. There is deliberately no generic
 * `--name=value` pass-through: each program lists the ones it accepts.
 */
function subcommandIn(
  args: Word[],
  allowed: Set<string>,
  leading: Set<string>,
  program: string,
  leadingValue: string[] = [],
): string | null {
  const bad = noGlob(args, program);
  if (bad) return bad;
  for (const a of args) {
    if (allowed.has(a.text)) return null;
    if (leading.has(a.text) || leadingValue.some((p) => a.text.startsWith(p))) continue;
    break;
  }
  return `This \`${program}\` subcommand can make changes`;
}

/** Every argument that looks like an option must be in `flags`, wherever it sits. */
function onlyFlags(args: Word[], flags: Set<string>, program: string): string | null {
  return args.some((a) => a.text.startsWith('-') && !flags.has(a.text))
    ? `\`${program}\` with this option can load files or change settings`
    : null;
}

function firstIn(args: Word[], allowed: string[], program: string): string | null {
  return (
    noGlob(args, program) ??
    (allowed.includes(args[0]?.text ?? '') ? null : `This \`${program}\` command can make changes`)
  );
}

/**
 * Options yum/dnf accept anywhere on a query line. Anything else (`-c` config,
 * `--setopt`, `--installroot`, `--downloaddir`, plugin options…) can make the
 * package manager load code or write outside its cache, so it is refused.
 */
const PKG_QUERY_FLAGS = new Set([
  '-q',
  '--quiet',
  '-C',
  '--cacheonly',
  '-v',
  '--verbose',
  '--installed',
  '--available',
  '--updates',
  '--upgrades',
  '--extras',
  '--obsoletes',
  '--recent',
  '--all',
  '--enabled',
  '--disabled',
  '--showduplicates',
]);

function pkgQueryRule(program: string): Rule {
  return (args) =>
    onlyFlags(args, PKG_QUERY_FLAGS, program) ??
    subcommandIn(
      args,
      new Set([
        'list',
        'info',
        'search',
        'repolist',
        'provides',
        'whatprovides',
        'check-update',
        '--version',
      ]),
      PKG_QUERY_FLAGS,
      program,
    );
}

function pagerRule(args: Word[]): string | null {
  return args.some(
    (a) =>
      a.text.startsWith('+') ||
      (isShortCluster(a.text) && /[oO]/.test(a.text)) ||
      /^--(log-file|LOG-FILE)/.test(a.text),
  )
    ? 'This pager option writes a file or runs a command'
    : null;
}

/** Address: line number, `$`, or a `/regex/`. */
const SED_ADDR = String.raw`(?:\d+|\$|/(?:[^/\\\n]|\\.)*/)`;
const SED_RE = String.raw`(?:[^/\\\n]|\\.)*`;
/** One command: optional address range and `!`, then p/d/q/=/n or `s/re/repl/flags`. */
const SED_CMD = String.raw`\s*(?:${SED_ADDR}(?:,${SED_ADDR})?)?\s*!?\s*(?:[pdqn=]|s/${SED_RE}/${SED_RE}/[gpiI0-9]*)\s*`;
const SAFE_SED_SCRIPT = new RegExp(String.raw`^${SED_CMD}(?:;${SED_CMD})*;?\s*$`);

/**
 * sed is allowed only without -i/-f and with scripts made of print, delete,
 * quit and plain substitutions — no `w` (write), `e` (execute) or `r` commands
 * and no `s///w` / `s///e` flags.
 */
function sedRule(args: Word[]): string | null {
  const bad = noGlob(args, 'sed');
  if (bad) return bad;
  const scripts: string[] = [];
  let sawScriptFlag = false;
  const positional: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text;
    const glued = /^-[nErsuz]*e(.*)$/.exec(t);
    if (t === '--expression' || glued) {
      // `-e SCRIPT`, `-ne SCRIPT`, or the script glued on: `-e'p'`
      const value = glued?.[1] || args[++i]?.text;
      if (value === undefined) return '`sed` is missing its script';
      scripts.push(value);
      sawScriptFlag = true;
    } else if (t.startsWith('--expression=')) {
      scripts.push(t.slice('--expression='.length));
      sawScriptFlag = true;
    } else if (
      /^-[nErsuz]+$/.test(t) ||
      [
        '--quiet',
        '--silent',
        '--regexp-extended',
        '--separate',
        '--unbuffered',
        '--null-data',
      ].includes(t)
    ) {
      // harmless option
    } else if (t.startsWith('-') && t !== '-') {
      return '`sed` with this option (e.g. -i) edits files';
    } else {
      positional.push(t);
    }
  }
  if (!sawScriptFlag) {
    const script = positional.shift();
    if (script === undefined) return '`sed` is missing its script';
    scripts.push(script);
  }
  return scripts.every((s) => SAFE_SED_SCRIPT.test(s))
    ? null
    : '`sed` script may write files or run commands';
}

const DATE_VALUE_FLAGS = new Set(['-d', '--date', '-r', '--reference']);

function dateRule(args: Word[]): string | null {
  const bad = noGlob(args, 'date');
  if (bad) return bad;
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text;
    if (DATE_VALUE_FLAGS.has(t)) {
      i++;
    } else if (
      t.startsWith('+') ||
      t.startsWith('-I') ||
      ['-R', '-u', '--utc', '--universal', '--rfc-email', '--rfc-2822'].includes(t) ||
      /^--(iso-8601|rfc-3339|date=|reference=)/.test(t)
    ) {
      // formatting only
    } else {
      return '`date` with this argument sets the clock';
    }
  }
  return null;
}

const DOCKER_READ = new Set(['ps', 'images', 'logs', 'inspect', 'version', 'info', 'top', 'stats']);
const DOCKER_OBJECT_READ: Record<string, Set<string>> = {
  container: new Set(['ls', 'list', 'ps', 'inspect', 'logs', 'top', 'stats']),
  image: new Set(['ls', 'list', 'inspect', 'history']),
  network: new Set(['ls', 'list', 'inspect']),
  volume: new Set(['ls', 'list', 'inspect']),
  compose: new Set(['ps', 'logs', 'ls', 'config', 'images', 'top', 'version']),
};

function dockerRule(args: Word[]): string | null {
  const bad = noGlob(args, 'docker');
  if (bad) return bad;
  const [first, second] = args.map((a) => a.text);
  let sub: string | undefined;
  if (first && DOCKER_READ.has(first)) sub = first;
  else if (
    first &&
    second &&
    Object.hasOwn(DOCKER_OBJECT_READ, first) &&
    DOCKER_OBJECT_READ[first]!.has(second)
  ) {
    sub = second;
  }
  if (!sub) return 'This `docker` command can change containers or images';
  if (sub === 'stats' && !args.some((a) => a.text === '--no-stream')) {
    return '`docker stats` needs --no-stream so it ends';
  }
  return null;
}

const IP_OBJECTS = new Set([
  'a',
  'addr',
  'address',
  'r',
  'ro',
  'route',
  'l',
  'link',
  'n',
  'neigh',
  'neighbor',
  'neighbour',
  'rule',
  'maddr',
]);
const IP_READ = new Set(['show', 'list', 'ls', 'lst', 'sh', 's', 'get']);

function ipRule(args: Word[]): string | null {
  const bad = noGlob(args, 'ip');
  if (bad) return bad;
  let i = 0;
  while (
    i < args.length &&
    /^-(4|6|br|brief|s|stats|statistics|d|details|o|oneline|j|json|p|pretty|c|color)$/.test(
      args[i]!.text,
    )
  )
    i++;
  const object = args[i]?.text;
  if (!object || !IP_OBJECTS.has(object)) return 'This `ip` command can change network settings';
  const verb = args[i + 1]?.text;
  // No verb means "show"; `ip a dev eth0` style filters are shown too
  if (verb === undefined || IP_READ.has(verb) || ['dev', 'to', 'table'].includes(verb)) return null;
  return 'This `ip` command can change network settings';
}

/** Short curl flags that take no value and never write or send data. */
const CURL_SHORT = /^-[ILSfikLsv46]+$/;
const CURL_LONG = new Set([
  '--head',
  '--silent',
  '--show-error',
  '--location',
  '--insecure',
  '--verbose',
  '--include',
  '--fail',
  '--compressed',
  '--ipv4',
  '--ipv6',
  '--http1.1',
  '--http2',
  '--no-progress-meter',
]);
const CURL_VALUE = new Set([
  '-m',
  '--max-time',
  '--connect-timeout',
  '-H',
  '--header',
  '-A',
  '--user-agent',
  '--resolve',
]);

/** curl is read-only as a plain GET/HEAD that prints to the terminal. */
function curlRule(args: Word[]): string | null {
  const bad = noGlob(args, 'curl');
  if (bad) return bad;
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text;
    if (t === '-X' || t === '--request') {
      const method = args[i + 1]?.text.toUpperCase();
      if (method !== 'GET' && method !== 'HEAD')
        return '`curl` with a non-GET method can change remote state';
      i++;
    } else if (/^--request=/.test(t) || /^-X./.test(t)) {
      const method = t.replace(/^--request=|^-X/, '').toUpperCase();
      if (method !== 'GET' && method !== 'HEAD')
        return '`curl` with a non-GET method can change remote state';
    } else if (CURL_VALUE.has(t)) {
      i++;
    } else if (/^--(max-time|connect-timeout|header|user-agent)=/.test(t)) {
      // value attached
    } else if (CURL_SHORT.test(t) || CURL_LONG.has(t)) {
      // harmless switch
    } else if (t.startsWith('-')) {
      return '`curl` with this option can send data or write files';
    }
    // anything else is a URL
  }
  return null;
}

/**
 * Git reads the repository's own config, and several settings in it name
 * programs git will run on otherwise read-only commands — so a hostile
 * repository can turn "look at it" into code execution:
 *
 * - `core.fsmonitor` runs whenever git refreshes the index: `status`,
 *   `ls-files`, `describe --dirty`, `blame` on the working tree…
 * - `diff.external` / `diff.<driver>.command` (external diff) and
 *   `diff.<driver>.textconv` run while any diff is rendered, including
 *   `log -p`, `--stat` and pickaxe searches.
 * - `gpg.program` (and the ssh/x509 variants) runs to verify signatures:
 *   `log.showSignature`, or a `%G?` placeholder in `format.pretty` or a
 *   `pretty.<alias>` format.
 *
 * Only `rev-parse` (which never touches the index, diffs or signatures) runs
 * as-is. `diff`, `log` and `show` are allowed only when the switches that turn
 * each of these off come straight after the subcommand, where no other option
 * can swallow them as its value. Everything else, including `status`,
 * `ls-files`, `shortlog`, `describe` and `blame`, needs approval.
 */
const GIT_READ = new Set(['rev-parse']);

/** Switches each diff-rendering subcommand must lead with. */
const GIT_DIFFING: Record<string, { required: string[]; needsFormat: boolean }> = {
  diff: { required: ['--no-ext-diff', '--no-textconv'], needsFormat: false },
  log: { required: ['--no-ext-diff', '--no-textconv', '--no-show-signature'], needsFormat: true },
  show: { required: ['--no-ext-diff', '--no-textconv', '--no-show-signature'], needsFormat: true },
};

/** Flags that turn a program from the repository config back on (last one wins). */
const GIT_REENABLE = new Set(['--ext-diff', '--textconv', '--show-signature']);

/** Built-in pretty formats; any other name is a `pretty.<alias>` from config. */
const GIT_PRETTY_BUILTIN = new Set([
  'oneline',
  'short',
  'medium',
  'full',
  'fuller',
  'reference',
  'email',
  'mboxrd',
  'raw',
]);

/**
 * Is this a `--format` / `--pretty` / `--oneline` flag, and is its format safe?
 * A format string may not use `%G…` (signature checks run gpg.program) or
 * `%(describe…)`, and a bare name must be built in, not an alias from config.
 */
function gitFormat(t: string): 'none' | 'safe' | 'unsafe' {
  if (t === '--oneline') return 'safe';
  const m = /^--(?:format|pretty)(?:=(.*))?$/.exec(t);
  if (!m) return 'none';
  const value = m[1];
  // bare `--pretty` means medium; bare `--format` is not a valid flag
  if (value === undefined) return t === '--pretty' ? 'safe' : 'unsafe';
  if (/%G|%\(describe/.test(value)) return 'unsafe';
  if (/^t?format:/.test(value) || value.includes('%')) return 'safe';
  return GIT_PRETTY_BUILTIN.has(value) ? 'safe' : 'unsafe';
}

const GIT_HINT =
  ' To run without approval, use `git diff --no-ext-diff --no-textconv …`, or for `git log` / `git show` put `--no-ext-diff --no-textconv --no-show-signature` and an explicit format such as `--oneline` or `--format=medium` right after the subcommand.';

const GIT_BRANCH_FLAGS = new Set([
  '-a',
  '-r',
  '-v',
  '-vv',
  '-l',
  '--all',
  '--remotes',
  '--verbose',
  '--list',
  '--show-current',
  '--merged',
  '--no-merged',
  '--contains',
  '--no-contains',
  '--no-color',
]);
const GIT_BRANCH_LISTING = new Set([
  '--list',
  '--merged',
  '--no-merged',
  '--contains',
  '--no-contains',
]);

function gitRule(args: Word[]): string | null {
  const bad = noGlob(args, 'git');
  if (bad) return bad;
  let i = 0;
  // Only flags that cannot inject config (`-c core.pager=…` would run a program)
  while (i < args.length) {
    const t = args[i]!.text;
    if (t === '--no-pager') i++;
    else if (t === '-C') i += 2;
    else break;
  }
  const sub = args[i]?.text;
  const rest = args.slice(i + 1).map((a) => a.text);
  if (rest.some((t) => t.startsWith('--output'))) return '`git --output` writes a file';

  if (sub && Object.hasOwn(GIT_DIFFING, sub)) {
    const { required, needsFormat } = GIT_DIFFING[sub]!;
    if (rest.some((t) => GIT_REENABLE.has(t))) {
      return `\`git\` with --ext-diff, --textconv or --show-signature runs programs from the repository config.${GIT_HINT}`;
    }
    if (rest.some((t) => gitFormat(t) === 'unsafe')) {
      return `This \`git ${sub}\` format can verify signatures with a program from the repository config.${GIT_HINT}`;
    }
    // The leading run of switches, before anything that could take a value
    const lead: string[] = [];
    for (const t of rest) {
      if (required.includes(t) || GIT_DIFFING.log!.required.includes(t) || gitFormat(t) === 'safe')
        lead.push(t);
      else break;
    }
    const ok =
      required.every((f) => lead.includes(f)) &&
      (!needsFormat || lead.some((t) => gitFormat(t) === 'safe'));
    return ok
      ? null
      : `\`git ${sub}\` can run diff or signature programs from the repository config.${GIT_HINT}`;
  }
  if (sub && GIT_READ.has(sub)) return null;
  if (sub === 'branch') {
    // No `--format`: the `%(signature)` atom verifies signatures with gpg.program
    const flagsOk = rest
      .filter((t) => t.startsWith('-'))
      .every(
        (t) => GIT_BRANCH_FLAGS.has(t) || /^--(sort|color|column)=/.test(t) || /^-[arvl]+$/.test(t),
      );
    // Positional names are patterns only in list mode; otherwise they create a branch
    const listing = rest.some((t) => GIT_BRANCH_LISTING.has(t) || /^-[arv]*l[arv]*$/.test(t));
    const positional = rest.filter((t) => !t.startsWith('-'));
    if (flagsOk && (positional.length === 0 || listing)) return null;
    return '`git branch` with these arguments creates, renames or deletes a branch';
  }
  if (sub === 'remote') {
    return rest.every((t) => t === '-v' || t === '--verbose')
      ? null
      : 'This `git remote` command changes remotes';
  }
  if (sub === 'tag') {
    // List mode with patterns only: `-v` verifies with gpg.program, `--format` can too
    const listing = rest.length === 0 || rest[0] === '-l' || rest[0] === '--list';
    const extraFlagsOk = rest
      .slice(1)
      .every((t) => !t.startsWith('-') || /^-n\d*$/.test(t) || /^--sort=/.test(t));
    return listing && extraFlagsOk
      ? null
      : '`git tag` with these arguments creates, deletes or verifies a tag';
  }
  return `This \`git\` command can change the repository or run programs from its config.${GIT_HINT}`;
}

const KUBECTL_READ = new Set([
  'get',
  'describe',
  'logs',
  'top',
  'version',
  'explain',
  'api-resources',
  'api-versions',
  'cluster-info',
  'events',
]);
const KUBECTL_VALUE_FLAGS = new Set(['-n', '--namespace', '--context', '--cluster']);
/**
 * kubectl reads global flags anywhere on the line. A chosen kubeconfig can name
 * an exec credential plugin (a local program kubectl runs), the log/profile
 * flags write files, and `-k` runs kustomize, so these are refused wherever
 * they appear.
 */
const KUBECTL_UNSAFE_FLAG =
  /^(--kubeconfig|--log-file|--log-dir|--profile|--cache-dir|-k$|--kustomize)/;

function kubectlRule(args: Word[]): string | null {
  const bad = noGlob(args, 'kubectl');
  if (bad) return bad;
  if (args.some((a) => KUBECTL_UNSAFE_FLAG.test(a.text))) {
    return '`kubectl` with this option can run local programs or write files';
  }
  let i = 0;
  while (i < args.length) {
    const t = args[i]!.text;
    if (KUBECTL_VALUE_FLAGS.has(t)) i += 2;
    else if (/^--(namespace|context|cluster)=/.test(t)) i++;
    else break;
  }
  const sub = args[i]?.text;
  if (sub && KUBECTL_READ.has(sub)) return null;
  if (
    sub === 'config' &&
    ['view', 'get-contexts', 'current-context'].includes(args[i + 1]?.text ?? '')
  ) {
    return null;
  }
  return 'This `kubectl` command can change the cluster';
}

function apacheRule(args: Word[]): string | null {
  const ok = new Set([
    '-t',
    '-S',
    '-M',
    '-v',
    '-V',
    'configtest',
    '-D',
    'DUMP_VHOSTS',
    'DUMP_MODULES',
    'DUMP_RUN_CFG',
  ]);
  return args.length > 0 && args.every((a) => ok.has(a.text))
    ? null
    : 'Only config tests and dumps are read-only for the Apache control script';
}

function iptablesRule(args: Word[]): string | null {
  const bad = noGlob(args, 'iptables');
  if (bad) return bad;
  let lists = false;
  for (let i = 0; i < args.length; i++) {
    const t = args[i]!.text;
    if (t === '-t' || t === '--table') {
      i++;
    } else if (/^-[nvxLS]+$/.test(t)) {
      if (/[LS]/.test(t)) lists = true;
    } else if (t === '--list' || t === '--list-rules') {
      lists = true;
    } else if (
      t === '--line-numbers' ||
      t === '--numeric' ||
      t === '--verbose' ||
      t === '--exact'
    ) {
      // display option
    } else if (t.startsWith('-')) {
      return '`iptables` with this option changes firewall rules';
    }
    // positional: a chain name to list
  }
  return lists ? null : 'Only `iptables -L` / `-S` listings are read-only';
}

/** Paths a program may be invoked by and still count as the named program. */
const SYSTEM_BIN = /^\/(usr\/)?(local\/)?s?bin\/[^/]+$/;

function checkSegment(words: Word[]) {
  const first = words[0]!;
  if (first.glob) throw new Unsafe('The program name contains a wildcard');
  let program = first.text;
  if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(program)) {
    throw new Unsafe('Sets an environment variable, which can change how commands behave');
  }
  if (program.includes('/')) {
    if (!SYSTEM_BIN.test(program))
      throw new Unsafe(`\`${program}\` is a script or program outside the system paths`);
    program = program.slice(program.lastIndexOf('/') + 1);
  }

  const wrapper = Object.hasOwn(WRAPPERS, program) ? WRAPPERS[program] : undefined;
  if (wrapper) throw new Unsafe(`\`${program}\` ${wrapper}`);

  const rule = Object.hasOwn(RULES, program) ? RULES[program] : undefined;
  if (!rule) throw new Unsafe(`\`${program}\` is not a known read-only command`);
  const args = words.slice(1);
  // A variable can expand into any option (`find . $X` with X=-delete). Only the
  // PLAIN programs, whose behaviour does not depend on their arguments, may
  // take one; every rule that inspects flags would be checking the wrong text.
  if (rule !== always && args.some((a) => a.expands)) {
    throw new Unsafe(
      `\`${program}\` with a variable in its arguments could expand into unsafe options`,
    );
  }
  const reason = rule(args);
  if (reason) throw new Unsafe(reason);
}
