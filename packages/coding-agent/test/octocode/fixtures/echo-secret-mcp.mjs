import readline from 'node:readline';

// A tiny stdio MCP server a user adds: one tool, `echo_secret`, that returns a fixed token.
const TOKEN = 'EXT-MCP-OK-7731';
const tools = [
  {
    name: 'echo_secret',
    description: 'Return the secret echo service token.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
];
const send = (value) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...value })}\n`);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);
  if (message.id === undefined) return;
  if (message.method === 'initialize')
    send({
      id: message.id,
      result: {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'secretecho', version: '1.0.0' },
        instructions: 'Secret echo service. Call echo_secret to read the service token.',
      },
    });
  else if (message.method === 'tools/list') send({ id: message.id, result: { tools } });
  else if (message.method === 'tools/call')
    send({ id: message.id, result: { content: [{ type: 'text', text: TOKEN }] } });
  else send({ id: message.id, result: {} });
});
