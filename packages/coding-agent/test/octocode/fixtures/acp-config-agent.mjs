import { appendFileSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { agent, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk';

// Offers a grouped `model` select and a mode select; a prompt sends a large command catalog, switches the model through
// config_option_update, then answers with the model it is on.
const mode = process.argv[2] ?? 'modern';
const record = (method) => appendFileSync('requests.jsonl', JSON.stringify({ method, pid: process.pid }) + '\n');
const legacy = () => ({ currentModelId: current, availableModels: models.map(modelId => ({ modelId })) });
const models = ['small', 'large'];
let current = 'small';
const config = () => [
  { id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }] },
  {
    id: 'model-choice',
    name: 'Model',
    category: 'model',
    type: 'select',
    currentValue: current,
    options: [{ group: 'fixture', name: 'Fixture', options: models.map((value) => ({ value, name: value })) }],
  },
];
const app = agent({ name: 'ACP config fixture' })
  .onRequest(methods.agent.initialize, () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: {} }))
  .onRequest(methods.agent.session.new, () => { record('new'); return { sessionId: 'config-session', models: legacy(), ...(mode.startsWith('legacy') ? {} : { configOptions: config() }) }; })
  .onRequest('session/set_model', { parse: value => value }, async ({ params }) => {
    record('set_model');
    if (!mode.startsWith('legacy')) throw new Error('modern must not fall back');
    if (mode === 'legacy-reject') throw new RequestError(-32602, 'legacy selection denied');
    if (mode === 'legacy-hang') await new Promise(() => {});
    current = params.modelId;
    return {};
  })
  .onRequest(methods.agent.session.setConfigOption, ({ params }) => {
    record('set_config_option');
    if (mode === 'modern-reject') throw new RequestError(-32602, 'modern selection denied');
    if (params.configId !== 'model-choice') throw new Error(`unexpected config ${params.configId}`);
    current = params.value;
    return { configOptions: config() };
  })
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    record('prompt');
    const notify = (update) => client.notify(methods.client.session.update, { sessionId: params.sessionId, update });
    const availableCommands = Array.from({ length: 50 }, (_, index) => ({ name: `command-${index}`, description: 'catalog entry', input: null }));
    await notify({ sessionUpdate: 'available_commands_update', availableCommands });
    const before = current;
    current = 'large';
    await notify({ sessionUpdate: 'config_option_update', configOptions: config() });
    await notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `started on ${before}` } });
    return { stopReason: 'end_turn' };
  });
await app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin))).closed;
