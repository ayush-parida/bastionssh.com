import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TOKEN_HEREDOC, installCommand, installScript } from './install.js';

/**
 * The agent token must reach the installer on stdin, never as a process
 * argument (visible to every user in `ps`). These run the real command and
 * script with stand-ins for curl, sudo and id on PATH.
 */

const TOKEN = 'bsa_' + 'A1b2_C3-d4'.repeat(4) + 'xyz';

let dir: string;

function stub(name: string, body: string) {
  const file = path.join(dir, name);
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'smt-agent-install-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('installCommand', () => {
  it('keeps the token off the command line and passes it in a here-doc', () => {
    const command = installCommand('https://ssh.example.com/', TOKEN, [22, 2222]);
    const [first, second, third, ...rest] = command.split('\n');
    expect(rest).toHaveLength(0);
    expect(first).not.toContain(TOKEN);
    expect(first).toContain("'https://ssh.example.com/api/agents/install.sh'");
    expect(first).toContain("BASTION_ALLOWED_PORTS='22,2222'");
    expect(first).toContain(`<<'${TOKEN_HEREDOC}'`);
    expect(second).toBe(TOKEN);
    expect(third).toBe(TOKEN_HEREDOC);
    expect(installCommand('https://x', TOKEN)).not.toContain('BASTION_ALLOWED_PORTS');
  });

  it('runs the downloaded script with the token on stdin and no process sees it in its arguments', () => {
    const log = path.join(dir, 'argv.log');
    // curl writes a stand-in installer that reports what it received
    stub(
      'curl',
      `echo "curl $*" >> '${log}'
while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done
cat > "$out" <<'EOF'
echo "script $*" >> '${log}'
IFS= read -r t
echo "stdin $t" >> '${log}'
echo "ports \${BASTION_ALLOWED_PORTS:-}" >> '${log}'
EOF`,
    );
    stub('sudo', `echo "sudo $*" >> '${log}'\nexec "$@"`);

    const result = spawnSync('/bin/sh', ['-c', installCommand('https://ssh.example.com', TOKEN, [2222])], {
      env: { PATH: `${dir}:/usr/bin:/bin` },
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);

    const lines = readFileSync(log, 'utf8').trim().split('\n');
    expect(lines.find((l) => l.startsWith('stdin '))).toBe(`stdin ${TOKEN}`);
    expect(lines).toContain('ports 2222');
    for (const line of lines.filter((l) => !l.startsWith('stdin '))) {
      expect(line).not.toContain(TOKEN);
    }
    expect(lines.some((l) => l.startsWith('sudo env BASTION_ALLOWED_PORTS=2222 sh '))).toBe(true);
  });
});

describe('installScript', () => {
  /** Run the script from a file as "root" (a stubbed id) with no systemd on PATH. */
  function run(input: string | undefined, fromFile = true) {
    stub('id', 'echo 0');
    const script = installScript('https://ssh.example.com', 'a'.repeat(64));
    const file = path.join(dir, 'install.sh');
    writeFileSync(file, script);
    return fromFile
      ? spawnSync('/bin/sh', [file], { env: { PATH: dir }, input: input ?? '', encoding: 'utf8' })
      : spawnSync('/bin/sh', [], { env: { PATH: dir }, input: script, encoding: 'utf8' });
  }

  it('reads the token from stdin', () => {
    // Accepted: it gets as far as looking for systemd, which this PATH lacks
    const result = run(`${TOKEN}\n`);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('systemd is required');
  });

  it('ignores a token in the environment and refuses to run without one on stdin', () => {
    stub('id', 'echo 0');
    const file = path.join(dir, 'install.sh');
    writeFileSync(file, installScript('https://ssh.example.com', 'a'.repeat(64)));
    const result = spawnSync('/bin/sh', [file], {
      env: { PATH: dir, BASTION_AGENT_TOKEN: TOKEN },
      input: '',
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('give the token shown when the agent was created on stdin');
  });

  it('rejects a malformed token', () => {
    const result = run('bsa_bad token;rm\n');
    expect(result.stderr).toContain('unexpected characters');
  });

  it('refuses to be piped into sh, where stdin is the script itself', () => {
    const result = run(undefined, false);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('run it from a file');
  });

  it('writes the token only to the root-only env file the unit loads', () => {
    const script = installScript('https://ssh.example.com', 'a'.repeat(64));
    expect(script).toContain('install -d -m 0700 /etc/bastion-agent');
    expect(script).toContain('chmod 0600 /etc/bastion-agent/agent.env');
    expect(script).toContain('EnvironmentFile=/etc/bastion-agent/agent.env');
    expect(script).toMatch(/ExecStart=@NODE@ \/opt\/bastion-agent\/bastion-agent\.cjs\n/);
  });
});
