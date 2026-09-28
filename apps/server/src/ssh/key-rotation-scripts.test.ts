import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { INSTALL_SCRIPT, REMOVE_SCRIPT, scriptCommand } from './key-rotation.js';

// The authorized_keys scripts run for real under the local /bin/sh, against a
// throwaway $HOME, exactly as the server would run them over SSH.

const OLD = 'AAAAC3NzaC1lZDI1NTE5AAAAIElIFDlvr3BbqwqJML2vALk7zEJk8g6g/KL13zhz+dh8';
const NEW = 'AAAAC3NzaC1lZDI1NTE5AAAAIOr8XmDhc4ptfzPZ3SJ4hzBVVyzT6lrqmxw0vxHfG5Cc';
const OTHER = 'AAAAC3NzaC1lZDI1NTE5AAAAIGb3ktn9ovvqyOm2NmT2JUeOrOkDz8V5l3jpPFxcdszP';
// Starts with the old blob — must never be taken for it
const OLD_PREFIXED = `${OLD.slice(0, -4)}Zdh8`;

let home: string;
let file: string;

function run(script: string, args: string[]) {
  const r = spawnSync('sh', ['-c', scriptCommand(args)], {
    input: script,
    env: { PATH: process.env.PATH, HOME: home },
    encoding: 'utf8',
  });
  return { stdout: r.stdout.trim(), stderr: r.stderr.trim(), code: r.status };
}

function write(content: string, mode = 0o600) {
  fs.writeFileSync(file, content);
  fs.chmodSync(file, mode);
}

const read = () => fs.readFileSync(file, 'utf8');
const modeOf = () => fs.statSync(file).mode & 0o777;
const install = () => run(INSTALL_SCRIPT, [OLD, 'ssh-ed25519', NEW, 'bastionssh-key-k2']);

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'rotation-'));
  fs.mkdirSync(path.join(home, '.ssh'), { mode: 0o700 });
  file = path.join(home, '.ssh', 'authorized_keys');
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('install script', () => {
  it('appends one tagged line and leaves every existing byte and the mode alone', () => {
    const before = `# managed by hand\nssh-rsa ${OTHER} alice@laptop\n\nssh-ed25519 ${OLD} old-key\n`;
    write(before);

    expect(install()).toMatchObject({ code: 0, stdout: 'added' });
    expect(read()).toBe(`${before}ssh-ed25519 ${NEW} bastionssh-key-k2\n`);
    expect(modeOf()).toBe(0o600);
  });

  it('is idempotent: a second run changes nothing', () => {
    write(`ssh-ed25519 ${OLD} old\n`);
    install();
    const once = read();
    expect(install()).toMatchObject({ code: 0, stdout: 'present' });
    expect(read()).toBe(once);
  });

  it('starts a new line when the file does not end with one', () => {
    write(`ssh-ed25519 ${OLD} old`);
    expect(install().code).toBe(0);
    expect(read()).toBe(`ssh-ed25519 ${OLD} old\nssh-ed25519 ${NEW} bastionssh-key-k2\n`);
  });

  it('finds the old key behind options and CRLF line ends', () => {
    write(`from="10.0.0.0/8",no-pty ssh-ed25519 ${OLD}\r\n`);
    expect(install()).toMatchObject({ code: 0, stdout: 'added' });
  });

  it("copies the old key's options onto the new line, so the rotation widens nothing", () => {
    const before = `  from="10.0.0.0/8",environment="A=b  c",no-pty\tssh-ed25519 ${OLD} old\r\n`;
    write(before);
    expect(install()).toMatchObject({ code: 0, stdout: 'added' });
    expect(read()).toBe(`${before}from="10.0.0.0/8",environment="A=b  c",no-pty ssh-ed25519 ${NEW} bastionssh-key-k2\n`);
  });

  it('skips a forced-command line of the old key when copying options', () => {
    const before = `command="/usr/bin/backup",no-pty ssh-ed25519 ${OLD} backup\nfrom="192.0.2.1" ssh-ed25519 ${OLD} login\n`;
    write(before);
    expect(install().code).toBe(0);
    expect(read()).toBe(`${before}from="192.0.2.1" ssh-ed25519 ${NEW} bastionssh-key-k2\n`);
  });

  it('refuses, changing nothing, when the current key is not listed', () => {
    const before = `ssh-ed25519 ${OLD_PREFIXED} lookalike\n# ssh-ed25519 ${OLD} commented out\n`;
    write(before);
    expect(install()).toMatchObject({ code: 4 });
    expect(read()).toBe(before);
  });

  it('refuses a missing file or a symbolic link', () => {
    expect(install().code).toBe(3);
    expect(fs.existsSync(file)).toBe(false);

    const real = path.join(home, 'keys');
    fs.writeFileSync(real, `ssh-ed25519 ${OLD}\n`);
    fs.symlinkSync(real, file);
    expect(install().code).toBe(3);
    expect(fs.readFileSync(real, 'utf8')).toBe(`ssh-ed25519 ${OLD}\n`);
  });
});

describe('remove script', () => {
  const remove = (removeBlob = OLD, keepBlob = NEW) => run(REMOVE_SCRIPT, [removeBlob, keepBlob]);

  it('deletes exactly the lines of that key, keeping every other line as it was', () => {
    write(
      [
        '# Team keys',
        `ssh-rsa ${OTHER} alice@laptop`,
        `ssh-ed25519 ${OLD} old-key`,
        '',
        `# ssh-ed25519 ${OLD} a commented-out copy stays`,
        `ssh-ed25519 ${OLD_PREFIXED} lookalike stays`,
        `command="/usr/bin/backup",no-pty ssh-ed25519 ${OLD} restricted copy`,
        `ssh-ed25519 ${OLD}\r`,
        `  environment="X=1" ssh-rsa ${OTHER} bob with spaces  `,
        `ssh-ed25519 ${NEW} bastionssh-key-k2`,
        '',
      ].join('\n'),
      0o640,
    );

    expect(remove()).toMatchObject({ code: 0, stdout: 'removed' });
    expect(read()).toBe(
      [
        '# Team keys',
        `ssh-rsa ${OTHER} alice@laptop`,
        '',
        `# ssh-ed25519 ${OLD} a commented-out copy stays`,
        `ssh-ed25519 ${OLD_PREFIXED} lookalike stays`,
        `  environment="X=1" ssh-rsa ${OTHER} bob with spaces  `,
        `ssh-ed25519 ${NEW} bastionssh-key-k2`,
        '',
      ].join('\n'),
    );
    // Same permissions as before, and no temporary file left behind
    expect(modeOf()).toBe(0o640);
    expect(fs.readdirSync(path.join(home, '.ssh'))).toEqual(['authorized_keys']);
  });

  it('refuses, changing nothing, when the key that must stay is not listed', () => {
    const before = `ssh-ed25519 ${OLD} old\n`;
    write(before);
    expect(remove()).toMatchObject({ code: 4 });
    expect(read()).toBe(before);
  });

  it('reports a key that is already gone without rewriting the file', () => {
    const before = `ssh-ed25519 ${NEW} new\nssh-rsa ${OTHER} other`;
    write(before);
    const inode = fs.statSync(file).ino;
    expect(remove()).toMatchObject({ code: 0, stdout: 'absent' });
    expect(read()).toBe(before);
    expect(fs.statSync(file).ino).toBe(inode);
  });

  it('undoes an install exactly (the rollback path)', () => {
    const before = `ssh-rsa ${OTHER} alice\nssh-ed25519 ${OLD} old\n`;
    write(before);
    install();
    expect(remove(NEW, OLD)).toMatchObject({ code: 0, stdout: 'removed' });
    expect(read()).toBe(before);
  });
});

describe('scriptCommand', () => {
  it('single-quotes arguments and refuses anything a shell would interpret', () => {
    expect(scriptCommand([OLD, 'bastionssh-key-abc_1'])).toBe(`sh -s -- '${OLD}' 'bastionssh-key-abc_1'`);
    expect(() => scriptCommand(["x'; rm -rf ~; '"])).toThrow();
    expect(() => scriptCommand(['$(id)'])).toThrow();
  });
});
