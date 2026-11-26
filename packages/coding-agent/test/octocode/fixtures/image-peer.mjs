import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

// A stand-in ACP agent that takes images and records the content blocks of each prompt. argv: a journal path.
// The first prompt takes 400 ms, so a follow-up arrives while it runs.
const [journal] = process.argv.slice(2);
let prompts = 0;
const held = setInterval(() => undefined, 1000);
const app = agent({ name: 'image-peer' })
  .onRequest(methods.agent.initialize, async () => ({
    protocolVersion: PROTOCOL_VERSION,
    authMethods: [],
    agentCapabilities: { promptCapabilities: { image: true }, mcpCapabilities: { http: true }, sessionCapabilities: { close: {} } },
  }))
  .onRequest(methods.agent.session.new, async () => ({ sessionId: 'image-session' }))
  .onRequest(methods.agent.session.close, async () => ({}))
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    appendFileSync(journal, `${JSON.stringify({ event: 'prompt', types: params.prompt.map((block) => block.type), text: params.prompt.map((block) => block.text ?? '').join('') })}\n`);
    if (prompts++ === 0) await new Promise((resolve) => setTimeout(resolve, 400));
    await client.notify(methods.client.session.update, { sessionId: 'image-session', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ok' } } });
    return { stopReason: 'end_turn' };
  });
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
clearInterval(held);
