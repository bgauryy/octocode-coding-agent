import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

// A stand-in for claude-agent-acp that calls back into the MCP server its session was given, as Claude Code does.
// argv: a journal path and a JSON script: { prompts: [[step, ...], ...] }, one list of steps per prompt, in order.
// Steps: { say }, { list: true }, { call, args }, { usage: { used, size } }, { wait: true } (until cancelled).
const [journal, json] = process.argv.slice(2);
const script = JSON.parse(json);
const record = (value) => appendFileSync(journal, `${JSON.stringify(value)}\n`);
const watched = Object.keys(process.env).filter((name) => /^(ANTHROPIC_|OPENAI_|CODEX_|CLAUDE_|OCTOCODE_|ENABLE_TOOL_SEARCH)/.test(name));
record({
  event: 'start',
  pid: process.pid,
  env: watched,
  model: process.env.ANTHROPIC_MODEL,
  executable: process.env.CLAUDE_CODE_EXECUTABLE,
  toolSearch: process.env.ENABLE_TOOL_SEARCH,
});
const held = setInterval(() => undefined, 1000);
let server;
let sessionId = 'peer-session-1';
// A restarted peer (a resumed session) continues the script where the one before it stopped.
let prompts = existsSync(journal) ? readFileSync(journal, 'utf8').split('\n').filter((line) => line.includes('"event":"prompt"')).length : 0;
let cancelled;

/** One JSON-RPC exchange with the MCP server; a streamed answer is read from its event stream. */
let mcpSession;
let rpcId = 0;
async function rpc(method, params, notify = false) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  for (const header of server.headers) headers[header.name] = header.value;
  if (mcpSession) headers['mcp-session-id'] = mcpSession;
  const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++rpcId, method, params };
  const response = await fetch(server.url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (notify) return undefined;
  mcpSession ??= response.headers.get('mcp-session-id') ?? undefined;
  const text = await response.text();
  const data = response.headers.get('content-type')?.includes('text/event-stream')
    ? text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6)).at(-1)
    : text;
  return JSON.parse(data).result;
}

async function mcpReady() {
  if (mcpSession) return;
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code-peer', version: '1' } });
  await rpc('notifications/initialized', {}, true);
}

const opened = (params) => {
  server = params.mcpServers?.[0];
  record({ event: 'session', cwd: params.cwd, mcpServers: params.mcpServers, meta: params._meta, sessionId: params.sessionId });
};

const app = agent({ name: 'claude-code-peer' })
  .onRequest(methods.agent.initialize, async () => ({
    protocolVersion: PROTOCOL_VERSION,
    authMethods: [],
    agentCapabilities: { loadSession: true, mcpCapabilities: { http: true }, sessionCapabilities: { resume: {}, close: {} } },
  }))
  .onRequest(methods.agent.session.new, async ({ params }) => {
    opened(params);
    return { sessionId };
  })
  .onRequest(methods.agent.session.resume, async ({ params }) => {
    opened(params);
    sessionId = params.sessionId;
    record({ event: 'resume', sessionId });
    return {};
  })
  .onRequest(methods.agent.session.close, async () => ({}))
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    const text = params.prompt.map((block) => block.text ?? '').join('');
    const steps = script.prompts[prompts] ?? [{ say: 'ok' }];
    record({ event: 'prompt', index: prompts, text });
    prompts++;
    const update = (value) => client.notify(methods.client.session.update, { sessionId, update: value });
    for (const step of steps) {
      if (step.say) await update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: step.say } });
      if (step.usage) await update({ sessionUpdate: 'usage_update', used: step.usage.used, size: step.usage.size, cost: { amount: 0.5, currency: 'USD' } });
      if (step.list) {
        await mcpReady();
        const listed = await rpc('tools/list', {});
        record({ event: 'tools', names: listed.tools.map((tool) => tool.name) });
      }
      if (step.call) {
        await mcpReady();
        await update({ sessionUpdate: 'tool_call', toolCallId: `toolu_${rpcId}`, title: `mcp__octocode__${step.call}`, kind: 'other' });
        const result = await rpc('tools/call', { name: step.call, arguments: step.args ?? {} });
        record({ event: 'result', name: step.call, isError: result.isError === true, text: result.content.map((block) => block.text ?? '').join('') });
      }
      if (step.wait) {
        await new Promise((resolve) => (cancelled = resolve));
        return { stopReason: 'cancelled' };
      }
    }
    return { stopReason: 'end_turn', usage: { inputTokens: 1200, outputTokens: 80, cachedReadTokens: 22000, cachedWriteTokens: 500, totalTokens: 23780 } };
  })
  .onNotification(methods.agent.session.cancel, () => {
    record({ event: 'cancel' });
    cancelled?.();
  });

const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
clearInterval(held);
