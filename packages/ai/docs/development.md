# Development

Part of the [`@octocodeai/octocode-ai`](../README.md) guide. For contributors to this repository.

## Adding a New Provider

Adding a new LLM provider requires changes across multiple files. The layered layout: API implementations live in `src/api/`, provider factories in `src/providers/`, stable generated catalog wrappers live in `src/providers/<id>.models.ts`, and `src/models.generated.ts` registers them. This checklist covers all necessary steps:

### 1. Core Types (`src/types.ts`)

- Add the API identifier to `KnownApi` (for example `"bedrock-converse-stream"`), if it is a new API
- Add the provider name to `KnownProvider` (for example `"amazon-bedrock"`)
- Add the options type to `ApiOptionsMap`

### 2. API Implementation (`src/api/<api-id>.ts`, only for a new API)

Create a new API implementation file (for example `bedrock-converse-stream.ts`) that exports exactly `stream` and `streamSimple`, plus:

- An options interface extending `StreamOptions` (for example `BedrockOptions`)
- Message conversion functions to transform the `TranscriptContext` messages to provider format; read the prompt and tools from the transcript with `getInitialSystemMessage()`, `getCurrentTools()`, and `resolveTranscript()`
- Tool conversion if the provider supports tools
- Response parsing to emit the standard stream events (`start`, `text_*`, `thinking_*`, `toolcall_*`, `content_update`, then `done` or `error`; usage travels on the message), listed in the [event reference](tools.md#complete-event-reference)

Add a lazy wrapper `src/api/<api-id>.lazy.ts` (`<name>Api()` via `lazyApi()`) so providers can reference the implementation without importing its SDK. Add any root-level `export type` re-exports in `src/index.ts` that should remain available from `@octocodeai/octocode-ai`.

### 3. Model Generation (`scripts/generate-models.ts`)

- Add logic to fetch and parse models from the provider's source (e.g., models.dev API)
- Map chat/tool-capable provider data to `Model`, image-generation data to `ImageModel`, and models.dev `type: "decision"` entries to `ClassifierModel`; hydration groups the ignored `src/providers/data/<id>.json` values by API while stable `src/providers/<id>.models.ts` wrappers derive exact model/API types directly from those JSON keys
- Keep model ids unique within each provider and model type; emit separate entries when an upstream model supports multiple operations
- Handle provider-specific quirks (pricing format, capability flags, model ID transformations)

The AI package owns each built-in provider’s authentication and protocol implementations. A public listing supplies model metadata. Registering a provider or granting an account access requires separate setup. For a custom endpoint with an existing protocol, add a distinct provider ID to Octocode or Pi-compatible `models.json`.

The generator reads the models.dev snapshot that the pinned `@opencode-ai/models` package ships, so a regenerated catalog depends on that package version and needs no network for models.dev; `--live` fetches models.dev itself instead. It intersects NVIDIA IDs with NVIDIA’s serving list, and reads the OpenRouter and Vercel listings for their own routes. Azure derives models from OpenAI and DeepSeek. Compatibility corrections and explicit aliases are applied before grouping models by provider, operation, and ID. The summary counts distinct published chat models. A provider can filter them further for the current client or credential. The data manifest records, per provider built from a models.dev listing, which listing (for example `zai-coding-plan` for `zai`), where its prices come from when the listing has none, and the ids the generator left out; the runtime catalog update reads it, so it reprices or adds models only from that listing and never adds a left-out id.

The root `yarn run build` and release commands refresh the catalog before compiling. The AI package’s build verifies the hydrated data and compiles offline. Full refreshes require every registered provider and required source. Each fetch times out after 60 seconds, and a failed or empty required listing leaves the previous catalog available. A scoped refresh (`yarn run generate:models --providers openrouter` from the workspace root) fetches only the selected providers’ dependencies and retains other providers and historical IDs. Provider and model IDs sort in code-unit order for reproducible output. The root typecheck covers the generator. To export `models.all.json` for an external consumer, use `--json-output <dir>`. The consumer can hydrate it with `scripts/hydrate-model-catalog.ts`. Release commands leave publication of that optional export to its consumer.

### 4. Provider Factory (`src/providers/<id>.ts`)

- `createProvider()` wiring catalog + auth + the lazy API wrapper
- Auth: `envApiKeyAuth` for standard key providers, a custom `ApiKeyAuth` for ambient auth (AWS profiles, ADC), `lazyOAuth` where an OAuth flow exists
- Register the factory in `src/providers/all.ts`
- If it is a new API: register it in the builtin list in `src/compat.ts`; the `./api/*` subpath export in `package.json` already exports the new file

### 5. Tests (`test/`)

The local Ollama tests are opt-in: they run only with `OCTOCODE_LOCAL_LLM=1`, after `ollama pull gpt-oss:20b`, and `OCTOCODE_NO_LOCAL_LLM` still disables them (`test/local-ollama.ts`).

Tests that send requests to a provider are paid, so they are named `*.live.test.ts`: `yarn test` leaves them out even when API keys are exported, and `yarn test:live` runs only them, each still skipped without its provider's credentials. Free tests (payload capture with a fake key, scripted responses) stay in plain `*.test.ts` files.

Cover the new provider in `test/`:

| Test                                                                                                        | Covers                                               |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `stream.live.test.ts`                                                                                       | Streaming and tool use                               |
| `tokens.live.test.ts`, `total-tokens.live.test.ts`                                                          | Usage reporting and counting                         |
| `abort.live.test.ts`, `empty.live.test.ts`, `context-overflow.live.test.ts`                                 | Cancellation, empty messages, context limit errors   |
| `unicode-surrogate.live.test.ts`, `tool-call-without-result.live.test.ts`, `image-tool-result.live.test.ts` | Unicode, orphaned tool calls, images in tool results |
| `cross-provider-handoff.live.test.ts`                                                                       | Context replay across providers                      |
| `providers.test.ts`                                                                                         | Provider listing and auth resolution                 |

For `cross-provider-handoff.live.test.ts`, add at least one provider/model pair. If the provider exposes multiple model families (for example GPT and Claude), add at least one pair per family.

For providers with non-standard auth (AWS, Google Vertex), create a utility like `bedrock-utils.ts` with credential detection helpers.

### 6. Coding Agent Integration (`../coding-agent/`)

Update `src/core/model-resolver/default-models.ts`:

- Add a default model ID for the provider in `defaultModelPerProvider`

Update `src/cli/args/help.ts`:

- Add environment variable documentation in the help text

Update `docs/providers.md`:

- Add the provider's setup instructions

### 7. Documentation

Update this package's documentation:

- Add the provider to the [Supported Providers](../README.md#supported-providers) list
- Document any provider-specific options or authentication requirements
- Add its environment variable to [Environment Variables](auth.md#environment-variables)

## Shared stream framing

Provider SSE framing for Anthropic, OpenAI Responses and Mistral is shared in `src/utils/server-sent-events.ts`. Adapters retain their own event schemas, completion validation and errors. Mistral initial HTTP requests use the shared retry policy; a stream that has emitted content is never replayed automatically.

## Faux provider

`fauxProvider()` builds an in-memory provider with scripted responses for tests and demos.

```typescript
import {
	createModels,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxThinking,
	fauxToolCall,
} from "@octocodeai/octocode-ai";

const faux = fauxProvider({ tokensPerSecond: 50 }); // pacing optional
const models = createModels();
models.setProvider(faux.provider);
const model = faux.getModel();

faux.setResponses([
	fauxAssistantMessage([fauxThinking("Inspect first."), fauxToolCall("echo", { text: "package.json" })], {
		stopReason: "toolUse",
	}),
]);
const first = await models.complete(model, context, { sessionId: "session-1", cacheRetention: "short" });

faux.appendResponses([fauxAssistantMessage([fauxText("Here is the summary.")])]);
for await (const event of models.stream(model, context)) console.log(event.type);

// Several models for model-switching tests
const multi = fauxProvider({
	provider: "faux-multi",
	models: [
		{ id: "faux-fast", reasoning: false },
		{ id: "faux-thinker", reasoning: true },
	],
});
const thinker = multi.getModel("faux-thinker");
```

| Behavior    | Detail                                                                                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Queue       | Responses are consumed in request start order; `setResponses` replaces the queue, `appendResponses` adds. An empty queue returns an assistant error with `errorMessage: "No more faux responses queued"` |
| Inspection  | `faux.models`, `faux.getModel(id?)`, `faux.getPendingResponseCount()`, `faux.state.callCount`                                                                                                            |
| Usage       | Estimated at about 1 token per 4 characters; with `sessionId` and `cacheRetention` not `"none"`, cache reads and writes are simulated                                                                    |
| Streaming   | Tool arguments stream as `toolcall_delta` chunks; each chunk takes its own microtask unless `tokensPerSecond` paces it                                                                                   |
| Concurrency | One scripted flow per handle; use separate providers with distinct `provider` ids for concurrent flows                                                                                                   |
