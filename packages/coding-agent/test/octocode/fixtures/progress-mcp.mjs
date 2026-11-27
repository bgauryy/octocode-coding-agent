import readline from 'node:readline';

// A minimal MCP server: `progress` reports progress on the request's token, `hostenv` echoes a host variable.
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
const text = (value) => ({ content: [{ type: 'text', text: value }] });
const schema = { type: 'object', properties: { name: { type: 'string' } }, additionalProperties: false };
const tools = [
  { name: 'progress', description: 'Report progress, then answer', inputSchema: schema },
  { name: 'hostenv', description: 'Report a host environment variable', inputSchema: schema },
];
readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  let result;
  if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'progress', version: '1.0.0' } };
  else if (message.method === 'tools/list') result = { tools };
  else if (message.method === 'tools/call' && message.params.name === 'progress') {
    send({ method: 'notifications/progress', params: { progressToken: message.params._meta?.progressToken, progress: 1, total: 2, message: 'halfway' } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    result = text('done');
  } else if (message.method === 'tools/call') result = text(process.env[message.params.arguments?.name] ?? '<unset>');
  else if (message.method === 'ping') result = {};
  else return send({ id: message.id, error: { code: -32601, message: 'unsupported' } });
  send({ id: message.id, result });
});
