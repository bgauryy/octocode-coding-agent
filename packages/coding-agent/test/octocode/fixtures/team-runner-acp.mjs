import fs from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';

const [journal, mode = 'exchange'] = process.argv.slice(2);
const record = value => fs.appendFileSync(journal, `${JSON.stringify(value)}\n`);
const wait = async file => { while (!fs.existsSync(file)) await new Promise(resolve => setTimeout(resolve, 10)); };
let servers = [], sessionId = 'team-runner-session', next = 0;
record({ event: 'start', pid: process.pid });
const app = agent({ name: 'team-runner-fixture' })
 .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { mcpCapabilities: { http: true } } }))
 .onRequest(methods.agent.session.new, ({ params }) => { servers = params.mcpServers; record({ event: 'servers', names: servers.map(server => server.name) }); return { sessionId }; })
 .onRequest(methods.agent.session.prompt, async ({ client }) => {
  const server = servers[0];
  if (!server || server.name !== 'octocode-team' || servers.length !== 1) throw new Error('Expected only the explicit team server');
  const rpc = async (method, params) => {
   const response = await fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', ...Object.fromEntries(server.headers.map(header => [header.name, header.value])) }, body: JSON.stringify({ jsonrpc: '2.0', id: ++next, method, params }) });
   const text = await response.text();
   return JSON.parse(text.startsWith('event:') ? text.split('data: ')[1].trim() : text).result;
  };
  await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'owned-fixture', version: '1' } });
  const catalog = await rpc('tools/list', {});
  record({ event: 'ready', tools: catalog.tools.map(tool => tool.name) });
  if (mode === 'wait') await new Promise(() => {});
  await wait(`${journal}.continue`);
  const call = args => rpc('tools/call', { name: 'team', arguments: args });
  const inbox = await call({ action: 'inbox' });
  const mail = JSON.parse(inbox.content[0].text);
  record({ event: 'mail', mail });
  const refused = await call({ action: 'send', to: 'parent', message: 'SPOOF', from: 'user' });
  record({ event: 'spoof', refused: refused.isError === true });
  await call({ action: 'inbox', ack: mail.map(message => message.id) });
  for (const message of mail) await call({ action: 'send', message: `EXTERNAL_REPLY_${message.id}`, replyTo: message.id });
  record({ event: 'replied' });
  await wait(`${journal}.finish`);
  await client.notify(methods.client.session.update, { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done: explicit team exchange verified\nNoticed: none' } } });
  return { stopReason: 'end_turn' };
 })
 .onNotification(methods.agent.session.cancel, () => record({ event: 'cancel' }));
const held = setInterval(() => {}, 1000);
const connection = app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
await connection.closed;
clearInterval(held);
