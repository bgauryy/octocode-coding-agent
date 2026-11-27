// A real stdio server that connects normally, then sends one frame that is not a JSON-RPC message.
import readline from 'node:readline';

const send = (value) => console.log(JSON.stringify(value));
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === 'initialize') {
    send({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'malformed', version: '1' } } });
  }
  if (request.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: request.id, result: { tools: [{ name: 'one', inputSchema: { type: 'object' } }] } });
    setTimeout(() => send({ jsonrpc: '2.0', unexpected: true }), 20);
  }
});
