import { startAgent } from './agent.js';
import { parsePortList } from './protocol.js';
import { AGENT_VERSION } from './version.js';

/**
 * Entry point of the single-file agent (dist/bastion-agent.cjs). Configured
 * through the environment, which the systemd unit loads from
 * /etc/bastion-agent/agent.env:
 *
 *   BASTION_URL             the app's base URL, e.g. https://ssh.example.com
 *   BASTION_AGENT_TOKEN     the token shown once when the agent was created
 *   BASTION_ALLOWED_PORTS   local ports the app may open (default: 22)
 *   BASTION_ALLOW_INSECURE  1 to allow a plain http:// app URL
 */

function fail(message: string): never {
  console.error(`bastion-agent: ${message}`);
  process.exit(2);
}

if (process.argv.includes('--version')) {
  console.log(AGENT_VERSION);
  process.exit(0);
}

const url = process.env.BASTION_URL?.trim();
const token = process.env.BASTION_AGENT_TOKEN?.trim();
if (!url) fail('BASTION_URL is not set');
if (!token) fail('BASTION_AGENT_TOKEN is not set');

let allowedPorts: number[];
try {
  allowedPorts = parsePortList(process.env.BASTION_ALLOWED_PORTS ?? '22');
} catch (err) {
  fail(`BASTION_ALLOWED_PORTS: ${(err as Error).message}`);
}

let agent: ReturnType<typeof startAgent>;
try {
  agent = startAgent({
    url,
    token,
    allowedPorts,
    allowInsecure: /^(1|true|yes)$/i.test(process.env.BASTION_ALLOW_INSECURE ?? ''),
  });
} catch (err) {
  fail((err as Error).message);
}

console.log(`bastion-agent ${AGENT_VERSION} starting`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    agent.stop().finally(() => process.exit(0));
  });
}
