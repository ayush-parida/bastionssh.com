import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ADMIN_EMAIL, ADMIN_PASSWORD } from './env.js';
import { expect, ownerApi, signInWithPassword, test } from './fixtures.js';

/**
 * A stand-in for an OpenAI-compatible provider. The first turn asks to run a
 * command that changes the server, which the app must hold for approval; once
 * the tool result comes back, it answers in plain text.
 */
interface ChatRequest {
  messages: { role: string; content?: string | null; tool_call_id?: string }[];
}

const COMMAND = 'rm -rf /var/www/e2e-cache';
const FINAL_ANSWER = 'Understood, I left the cache alone.';

let stub: http.Server;
/** Unique per run: approvals are keyed by the tool call id. */
let toolCallId: string;
let providerId: string;
let providerName: string;
let received: ChatRequest[];

function completion(message: Record<string, unknown>, finishReason: string) {
  return {
    id: `chatcmpl-${received.length}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: 'e2e-stub',
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  };
}

test.beforeAll(async () => {
  toolCallId = `call_e2e_${Date.now()}`;
  providerName = `E2E stub ${Date.now()}`;
  received = [];
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end();
        return;
      }
      const request = JSON.parse(body) as ChatRequest;
      received.push(request);
      const answeredTool = request.messages.some((m) => m.role === 'tool');
      const reply = answeredTool
        ? completion({ role: 'assistant', content: FINAL_ANSWER }, 'stop')
        : completion(
            {
              role: 'assistant',
              content: 'I will clear the cache.',
              tool_calls: [
                {
                  id: toolCallId,
                  type: 'function',
                  function: { name: 'run_command', arguments: JSON.stringify({ command: COMMAND }) },
                },
              ],
            },
            'tool_calls',
          );
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply));
    });
  });
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const stubUrl = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/v1`;

  const api = await ownerApi();
  const res = await api.post('/api/ai/providers', {
    data: {
      name: providerName,
      provider: 'openai_compatible',
      baseUrl: stubUrl,
      model: 'e2e-stub',
      apiKey: 'sk-e2e-not-a-real-key',
      isDefault: true,
    },
  });
  expect(res.status(), await res.text()).toBe(201);
  providerId = ((await res.json()) as { id: string }).id;
  await api.dispose();
});

test.afterAll(async () => {
  if (providerId) {
    const api = await ownerApi();
    await api.delete(`/api/ai/providers/${providerId}`);
    await api.dispose();
  }
  await new Promise((resolve) => stub?.close(resolve));
});

test('holds a changing command for approval and reports the denial to the model', async ({ page }) => {
  await signInWithPassword(page, ADMIN_EMAIL, ADMIN_PASSWORD);
  await page.getByRole('link', { name: 'AI Assistant' }).click();
  await expect(page.getByRole('heading', { name: 'AI Assistant' })).toBeVisible();
  // Sending needs a provider picked, which happens once the list loads
  await expect(page.getByRole('combobox')).toContainText(providerName);
  await page.getByRole('combobox').selectOption({ label: providerName });

  await page.getByPlaceholder(/Ask a question/).fill('Please clear the web cache');
  await page.keyboard.press('Enter');

  // The approval card, with what would run and why it needs a decision:
  // the innermost box holding both the title and the command
  const card = page
    .locator('div', { has: page.getByText('Approval needed', { exact: true }) })
    .filter({ has: page.locator('pre') })
    .last();
  await expect(card).toBeVisible();
  await expect(card.locator('pre')).toHaveText(COMMAND);
  await expect(card.getByText('current session server')).toBeVisible();
  await expect(card.getByRole('button', { name: 'Approve' })).toBeEnabled();

  await card.getByRole('button', { name: 'Deny' }).click();

  await expect(page.getByText('Command approval', { exact: true })).toBeVisible();
  await expect(page.getByText('denied', { exact: true })).toBeVisible();
  await expect(page.getByText(FINAL_ANSWER)).toBeVisible();

  // The model was told the command did not run
  const toolMessage = received.at(-1)?.messages.find((m) => m.role === 'tool');
  expect(toolMessage?.tool_call_id).toBe(toolCallId);
  expect(toolMessage?.content).toContain('declined');
});
