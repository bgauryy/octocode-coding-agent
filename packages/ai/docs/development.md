# Development

Part of the [`@octocodeai/octocode-ai` guide](../README.md).

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
- Response parsing to emit standardized events (`text`, `tool_call`, `thinking`, `usage`, `stop`)

Add a lazy wrapper `src/api/<api-id>.lazy.ts` (`<name>Api()` via `lazyApi()`) so providers can reference the implementation without importing its SDK. Add any root-level `export type` re-exports in `src/index.ts` that should remain available from `@octocodeai/octocode-ai`.

### 3. Model Generation (`scripts/generate-models.ts`)

- Add logic to fetch and parse models from the provider's source (e.g., models.dev API)
- Map chat/tool-capable provider data to `Model`, image-generation data to `ImageModel`, and models.dev `type: "decision"` entries to `ClassifierModel`; hydration groups the ignored `src/providers/data/<id>.json` values by API while stable `src/providers/<id>.models.ts` wrappers derive exact model/API types directly from those JSON keys
- Keep model ids unique within each provider and model type; emit separate entries when an upstream model supports multiple operations
- Handle provider-specific quirks (pricing format, capability flags, model ID transformations)

Each catalog fetch times out after 60 seconds (`scripts/generate-models/fetchers.ts`), and providers and models are sorted in code-unit order, never `localeCompare`, so the output does not depend on the generating machine's locale. The root `tsc` checks `packages/ai/scripts`. A generator fix reaches users with the next release built from a commit that contains it: the package `build` script and the root `scripts/release.mjs` and `scripts/local-release.mjs` regenerate the catalog from the network. Nothing in this repository publishes `models.all.json`; `generate-models --json-output <dir>` writes it for an external consumer that hydrates with `scripts/hydrate-model-catalog.ts`.

### 4. Provider Factory (`src/providers/<id>.ts`)

- `createProvider()` wiring catalog + auth + the lazy API wrapper
- Auth: `envApiKeyAuth` for standard key providers, a custom `ApiKeyAuth` for ambient auth (AWS profiles, ADC), `lazyOAuth` where an OAuth flow exists
- Register the factory in `src/providers/all.ts`
- If it is a new API: register it in the builtin list in `src/compat.ts` and add the package subpath export in `package.json`

### 5. Tests (`test/`)

The local Ollama tests are opt-in: they run only with `OCTOCODE_LOCAL_LLM=1`, after `ollama pull gpt-oss:20b`, and `OCTOCODE_NO_LOCAL_LLM` still disables them (`test/local-ollama.ts`).

Create or update test files to cover the new provider:

- `stream.test.ts` - Basic streaming and tool use
- `tokens.test.ts` - Token usage reporting
- `abort.test.ts` - Request cancellation
- `empty.test.ts` - Empty message handling
- `context-overflow.test.ts` - Context limit errors
- `image-limits.test.ts` - Image support (if applicable)
- `unicode-surrogate.test.ts` - Unicode handling
- `tool-call-without-result.test.ts` - Orphaned tool calls
- `image-tool-result.test.ts` - Images in tool results
- `total-tokens.test.ts` - Token counting accuracy
- `cross-provider-handoff.test.ts` - Cross-provider context replay
- `providers.test.ts` - Provider listing and auth resolution

For `cross-provider-handoff.test.ts`, add at least one provider/model pair. If the provider exposes multiple model families (for example GPT and Claude), add at least one pair per family.

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

Provider SSE framing for Anthropic, OpenAI Responses, Codex SSE and Mistral is shared in `src/utils/server-sent-events.ts`. Adapters retain their own event schemas, completion validation and errors. Mistral initial HTTP requests use the shared retry policy; a stream that has emitted content is never replayed automatically. See the [dated protocol and library audit](../../../docs/PROVIDER_PROTOCOL_AUDIT.md#streaming-cache-and-library-follow-up-2026-10-29).
