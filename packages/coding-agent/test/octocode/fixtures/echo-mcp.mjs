import { readFileSync } from 'node:fs';
import readline from 'node:readline';

const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const text = (value) => ({ content: [{ type: 'text', text: value }] });
const object = (properties = {}, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const tools = new Map();
const register = (name, description, inputSchema, call) => tools.set(name, { definition: { name, description, inputSchema }, call });
let nextId = 0;
const pending = new Map();
const request = (method) => new Promise((resolve) => {
  const id = `server-${++nextId}`;
  pending.set(id, resolve);
  send({ id, method });
});
const changed = () => send({ method: 'notifications/tools/list_changed' });
register('shout', process.env.ECHO_SHOUT_DESCRIPTION ?? 'Uppercase the given text', object({ text: { type: 'string' } }, ['text']), ({ text: value }) => text(value.toUpperCase()));
register('pick', 'Echo union queries back (stand-in for Octocode operation branches)', object({ queries: { type: 'array', items: { oneOf: [object({ operation: { const: 'text', type: 'string' }, searchText: { type: 'string' } }, ['operation', 'searchText']), object({ operation: { const: 'tree', type: 'string' }, depth: { type: 'integer' } }, ['operation'])] } } }, ['queries']), ({ queries }) => text(JSON.stringify(queries)));
register('fail', 'Always fails', object(), () => ({ ...text('boom'), isError: true }));
register('roots', 'Report the client roots', object(), async () => text(JSON.stringify((await request('roots/list')).roots)));
register('grow', 'Register a new tool at runtime', object(), () => {
  if (!tools.has('late')) { register('late', 'Added after startup', object(), () => text('late tool works')); changed(); }
  return text('grown');
});
register('shrink', 'Remove the runtime tool again', object(), () => { if (tools.delete('late')) changed(); return text('shrunk'); });
register('localFetch', 'Read files (stand-in for Octocode)', object({ queries: { type: 'array', items: object({ path: { type: 'string' } }, ['path']) } }, ['queries']), ({ queries }) => text(queries.map((query) => readFileSync(query.path, 'utf8')).join('\n')));
register('exit', 'Stop the server process shortly after answering', object(), () => { setTimeout(() => process.exit(0), 50); return text('bye'); });
register('crash', 'Die while answering', object(), () => process.exit(0));
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (pending.has(message.id)) { pending.get(message.id)(message.result); pending.delete(message.id); return; }
  if (message.id === undefined) return;
  try {
    let result;
    if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'echo', version: '1.0.0' }, instructions: process.env.ECHO_INSTRUCTIONS ?? 'Echo test server.' };
    else if (message.method === 'tools/list') result = { tools: [...tools.values()].map(({ definition }) => definition) };
    else if (message.method === 'tools/call') result = await tools.get(message.params.name).call(message.params.arguments ?? {});
    else if (message.method === 'ping') result = {};
    else throw new Error(`Unsupported method ${message.method}`);
    send({ id: message.id, result });
  } catch (error) { send({ id: message.id, error: { code: -32603, message: error.message } }); }
});
