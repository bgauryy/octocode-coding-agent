import { spawn } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';

const [mode, journal] = process.argv.slice(2);
const record = (value) => appendFileSync(journal, `${JSON.stringify(value)}\n`);
const pending = () => new Promise(() => undefined);
record({ event: 'start', pid: process.pid, cwd: process.cwd(), args: process.argv.slice(2), env: Object.keys(process.env).filter((name) => /^(ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|OCTOCODE_)/.test(name)) });
if (mode === 'descendant') {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  record({ event: 'descendant', pid: child.pid });
}
const held = setInterval(() => undefined, 1000);
let sessionId = 'fixture-session';
const app = agent({ name: 'external-acp-fixture' })
  .onRequest(methods.agent.initialize, async ({ params }) => {
    record({ event: 'initialize', params });
    if (mode === 'hang-initialize') await pending();
    if (mode === 'crash-initialize') process.exit(9);
    return { protocolVersion: mode === 'wrong-version' ? PROTOCOL_VERSION + 1 : PROTOCOL_VERSION, agentCapabilities: { loadSession: mode !== 'no-load' } };
  })
  .onRequest(methods.agent.session.new, async ({ params }) => {
    record({ event: 'new', params });
    if (mode === 'hang-new') await pending();
    return { sessionId: mode === 'empty-id' ? '' : sessionId };
  })
  .onRequest(methods.agent.session.load, async ({ params }) => {
    record({ event: 'load', params });
    if (mode === 'hang-load') await pending();
    if (mode === 'missing-session') throw RequestError.resourceNotFound('No saved conversation exists.');
    sessionId = params.sessionId;
    return {};
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const text = params.prompt[0]?.text;
    record({ event: 'prompt', text });
    const chunk = async (text, id = sessionId, kind = 'agent_message_chunk') => client.notify(methods.client.session.update, {
      sessionId: id, update: { sessionUpdate: kind, content: { type: 'text', text } },
    });
    if (mode === 'report') {
      // A runner's turn: a tool call, a usage update with a cost, the report, and token totals with the response.
      await client.notify(methods.client.session.update, {
        sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read src/app.ts', kind: 'read' },
      });
      await client.notify(methods.client.session.update, {
        sessionId, update: { sessionUpdate: 'usage_update', used: 1200, size: 200000, cost: { amount: 0.42, currency: 'USD' } },
      });
      await chunk('done: the runner read src/app.ts\nNoticed: none');
      return { stopReason: 'end_turn', usage: { inputTokens: 1000, outputTokens: 200, cachedReadTokens: 50, totalTokens: 1250 } };
    }
    await chunk('wrong-session-output', 'unrelated-session');
    await chunk('private-thought', sessionId, 'agent_thought_chunk');
    await chunk('first\n');
    record({ event: 'streamed', text: 'first\n' });
    if (mode.startsWith('overflow')) {
      await client.notify(methods.client.session.update, {
        sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'large', title: 'Read', rawOutput: 'evidence'.repeat(200_000) },
      });
      await chunk('final answer');
      if (mode === 'overflow-fail') {
        await new Promise((resolve) => process.stderr.write('x'.repeat(100_000) + '\nfinal diagnostic\n', resolve));
        throw RequestError.internalError(undefined, 'fixture failure after overflow');
      }
      return { stopReason: 'max_tokens' };
    }
    if (mode === 'wait' || mode === 'descendant') await pending();
    if (mode === 'gated') while (!existsSync(`${journal}.release`)) await new Promise((resolve) => setTimeout(resolve, 20));
    if (mode === 'delayed') await new Promise((resolve) => setTimeout(resolve, 500));
    if (mode === 'crash-prompt') {
      process.stderr.write('fixture diagnostic\n');
      process.exit(8);
    }
    if (mode === 'fail-prompt') throw new Error('fixture prompt failure');
    if (mode === 'permission' || mode === 'wrong-permission') {
      const response = await client.request(methods.client.session.requestPermission, {
        sessionId: mode === 'wrong-permission' ? 'unrelated-session' : sessionId,
        toolCall: { toolCallId: 'call-1', title: 'Edit a file', kind: 'edit', rawInput: { path: '/tmp/example' } },
        options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
      });
      record({ event: 'permission', response });
      await chunk(JSON.stringify(response.outcome));
    } else if (mode === 'require-fs') {
      await client.request(methods.client.fs.readTextFile, { sessionId, path: '/tmp/example' });
    } else {
      await client.notify(methods.client.session.update, {
        sessionId, update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'Read', kind: 'read', rawOutput: { evidence: 'evidence\n'.repeat(25_000) } },
      });
      await client.notify(methods.client.session.update, {
        sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'aGVsbG8=' } },
      });
      // Streamed in pieces, as a real agent does token by token.
      for (const piece of text.match(/.{1,4}/gs) ?? []) await chunk(piece);
    }
    return { stopReason: 'end_turn', _meta: { fixture: true } };
  })
  .onNotification(methods.agent.session.cancel, () => { record({ event: 'cancel' }); });

const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
clearInterval(held);
