import readline from 'node:readline';

// A stdio MCP server a user configures: its own instructions, four tools with described schemas, one of them
// (`legacy`) with a schema the TypeScript renderer cannot express (a $ref to a definition the schema lacks).
const INSTRUCTIONS =
  'Docs server. Search with lookup before you publish. Never purge a published page; ask the user first.';
const tools = [
  {
    name: 'lookup',
    description: 'Find a document by its title words. Returns the matching pages with their ids.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Title words to search for.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Most pages to return.' },
        section: { type: 'string', enum: ['guide', 'api', 'changelog'], description: 'Restrict to one section.' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'publish',
    description: 'Publish a draft page so readers see it.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Id of the draft.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'purge',
    description: 'Delete a page permanently.',
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Id of the page.' } },
      required: ['id'],
      additionalProperties: false,
    },
  },
  {
    name: 'legacy',
    description: 'Import a page from the old wiki.',
    inputSchema: {
      type: 'object',
      properties: { source: { $ref: '#/$defs/missing' }, dryRun: { type: 'boolean', description: 'Report only.' } },
      required: ['source'],
    },
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
        serverInfo: { name: 'docs', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      },
    });
  else if (message.method === 'tools/list') send({ id: message.id, result: { tools } });
  else if (message.method === 'tools/call')
    send({ id: message.id, result: { content: [{ type: 'text', text: `${message.params.name} ok` }] } });
  else send({ id: message.id, result: {} });
});
