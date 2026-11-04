import readline from 'node:readline';

// A stdio MCP server a user adds: instructions plus three tools whose input fields all carry distinct descriptions.
const INSTRUCTIONS =
  'Inventory service rules: always search before reserving, and never reserve more than the stock reported.';
const tools = [
  {
    name: 'search_items',
    description: 'Search the warehouse catalog by free-text query.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text catalog query, such as a product name.' },
        limit: {
          type: 'number',
          minimum: 1,
          maximum: 50,
          description: 'Maximum rows to return, between one and fifty.',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'reserve_item',
    description: 'Reserve units of one catalog item for an order.',
    inputSchema: {
      type: 'object',
      properties: {
        sku: { type: 'string', description: 'Stock keeping unit of the item to reserve.' },
        priority: {
          type: 'string',
          enum: ['standard', 'express', 'overnight'],
          description: 'Shipping tier that sets the reservation priority.',
        },
        customer: {
          type: 'object',
          description: 'Customer that owns the reservation.',
          properties: {
            email: { type: 'string', description: 'Contact email address of the customer.' },
          },
          required: ['email'],
        },
      },
      required: ['sku', 'priority'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        reservationId: { type: 'string', description: 'Identifier of the created reservation.' },
      },
      required: ['reservationId'],
    },
  },
  {
    name: 'release_item',
    description: 'Release a reservation back to the stock.',
    inputSchema: {
      type: 'object',
      properties: {
        reservationId: { type: 'string', description: 'Identifier of the reservation to release.' },
      },
      required: ['reservationId'],
      additionalProperties: false,
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
        serverInfo: { name: 'inventory', version: '1.0.0' },
        instructions: INSTRUCTIONS,
      },
    });
  else if (message.method === 'tools/list') send({ id: message.id, result: { tools } });
  else if (message.method === 'tools/call') {
    const { name, arguments: args } = message.params;
    const structuredContent = name === 'reserve_item' ? { reservationId: 'RSV-4410' } : undefined;
    send({
      id: message.id,
      result: {
        content: [{ type: 'text', text: `${name} ok ${JSON.stringify(args)}` }],
        ...(structuredContent ? { structuredContent } : {}),
      },
    });
  } else send({ id: message.id, result: {} });
});
