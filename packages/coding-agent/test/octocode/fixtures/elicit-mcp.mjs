// An MCP server that asks its client for user input (`elicitation/create`) while a tool call waits.
import readline from 'node:readline';

const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const text = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
const object = (properties = {}) => ({ type: 'object', properties });
const FORM = { message: 'Which project?', requestedSchema: object({ project: { type: 'string', title: 'Project id' } }) };
let capabilities;
let nextId = 0;
const pending = new Map();
// The client's answer to a request of this server: its result, or its error.
const request = (method, params) => new Promise((resolve) => {
  const id = `server-${++nextId}`;
  pending.set(id, resolve);
  send({ id, method, params });
});
const tools = {
  // Asks with `params` (a one-field form by default) and reports what the client answered.
  ask: { description: 'Ask the user through the client', inputSchema: object({ params: { type: 'object' } }), call: ({ params }) => request('elicitation/create', params ?? FORM) },
  capabilities: { description: 'Report the client capabilities', inputSchema: object(), call: () => capabilities },
};
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (pending.has(message.id)) { pending.get(message.id)(message.error ? { error: message.error } : message.result); pending.delete(message.id); return; }
  if (message.id === undefined) return;
  try {
    let result;
    if (message.method === 'initialize') { capabilities = message.params.capabilities; result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'elicit', version: '1.0.0' } }; }
    else if (message.method === 'tools/list') result = { tools: Object.entries(tools).map(([name, { description, inputSchema }]) => ({ name, description, inputSchema })) };
    else if (message.method === 'tools/call') result = text(await tools[message.params.name].call(message.params.arguments ?? {}));
    else if (message.method === 'ping') result = {};
    else throw new Error(`Unsupported method ${message.method}`);
    send({ id: message.id, result });
  } catch (error) { send({ id: message.id, error: { code: -32603, message: error.message } }); }
});
