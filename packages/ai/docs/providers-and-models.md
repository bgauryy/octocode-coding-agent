# Providers and models

Part of the [`@octocodeai/octocode-ai` guide](../README.md). Snippets assume a `models` collection set up as in the [Quick Start](../README.md#quick-start).

## Providers and models

A **provider** is the runtime unit: it owns its model catalog, its auth (API key resolution, OAuth flows), and its stream behavior. A `Models` collection holds providers and routes every request to the provider that owns the model.

Providers internally share **API implementations** (the wire protocols): Anthropic models use `anthropic-messages`, OpenAI and xAI use `openai-responses`, while Groq, Cerebras, OpenRouter, and most others share `openai-completions`. Mixed-API providers (GitHub Copilot, OpenCode Zen) dispatch per model.

HTTP and error handling for Chat Completions, Responses, Mistral and classifiers comes from `@ai-sdk/provider-utils`, with shared SSE framing for those streams plus Anthropic; adapters keep grammar tools, reasoning replay, cache boundaries and usage accounting. Official Anthropic, Google, AWS and Azure SDKs remain where they own the vendor protocol. See [library boundaries](../../../docs/FEATURES.md#library-boundaries).

### Provider Factories

For apps that only need specific providers, there is one factory per built-in provider, each a subpath import that pulls only that provider's catalog:

```typescript
import { anthropicProvider } from "@octocodeai/octocode-ai/providers/anthropic";
import { openaiProvider } from "@octocodeai/octocode-ai/providers/openai";
import { openrouterProvider } from "@octocodeai/octocode-ai/providers/openrouter";
import { amazonBedrockProvider } from "@octocodeai/octocode-ai/providers/amazon-bedrock";
// ...one module per provider in the Supported Providers list

const models = createModels();
models.setProvider(anthropicProvider());
models.setProvider(openrouterProvider());
```

Provider factories import their model catalog and a lazy API wrapper. They do not import other providers. With bundler code splitting, SDK implementations (`@anthropic-ai/sdk`, `openai`, `@google/genai`, etc.) stay in lazy chunks loaded on the first request to a model of that API.

### All Built-in Providers

For apps that want everything (as in Quick Start):

```typescript
import { builtinModels } from "@octocodeai/octocode-ai/providers/all";

const models = builtinModels(); // a Models collection with every built-in provider registered
```

This imports all catalogs and every built-in provider factory. It is the heavy, explicit entrypoint. `builtinModels()` accepts the same options as `createModels()` (`credentials`, `authContext`); `builtinProviders()` returns the provider array if you want to register them on your own collection.

### Querying Models

Reads are synchronous and return the last-known lists:

```typescript
const providers = models.getProviders(); // registered Provider objects
const provider = models.getProvider("anthropic"); // one provider

const all = models.getModels(); // every chat model across providers
const anthropicModels = models.getModels("anthropic");
const model = models.getModel("anthropic", "claude-sonnet-4-5");

for (const m of anthropicModels) {
	console.log(`${m.id}: ${m.name}`);
	console.log(`  API: ${m.api}`);
	console.log(`  Context: ${m.contextWindow} tokens`);
	console.log(`  Vision: ${m.input.includes("image")}`);
	console.log(`  Reasoning: ${m.reasoning}`);
}
```

The unqualified reads `getModels()`/`getModel()`/`getAvailable()` return chat models (`Model<Api>`) usable with `stream()`. The `*OfType` reads return one model type, and `getAllModels()`/`getAllAvailable()` return every type as `AnyModel`:

```typescript
const images = models.getModelsOfType("image", "openrouter"); // ImageModel[]
const flux = models.getModelOfType("image", "openrouter", "black-forest-labs/flux.2-pro");
const jev = models.getModelOfType("classifier", "typesafe", "jev-latest");
const availableImages = await models.getAvailableOfType("image");
const everything = models.getAllModels(); // AnyModel[]
```

The model's `type` decides which operation accepts it: chat models stream, `type: "image"` models generate images, and `type: "classifier"` models classify structured state. `type` is optional on chat models, so a model without `type` is a chat model. Do not compare `type` directly; narrow mixed lists with `isModelType()` or read the effective type with `getModelType()`:

```typescript
import { isModelType } from "@octocodeai/octocode-ai";

for (const model of models.getAllModels()) {
	if (isModelType(model, "image")) {
		// model: ImageModel<ImageApi>
	}
}
```

IDs are unique within each provider and type; one upstream model may have separate entries for different operations. On a provider, `getModels()` returns chat models and the optional `getAllModels()` returns every type; providers with only chat models can omit it.

Dynamically listed chat models are typed `Model<Api>`. Narrow with the `hasApi()` guard when you need API-specific option typing:

```typescript
import { hasApi } from "@octocodeai/octocode-ai";

const m = models.getModel("anthropic", "claude-sonnet-4-5");
if (m && hasApi(m, "anthropic-messages")) {
	// m: Model<'anthropic-messages'> — stream options fully typed
	models.stream(m, context, { thinkingEnabled: true, thinkingBudgetTokens: 2048 });
}
```

### Static Catalog Reads

For tooling that wants the generated built-in catalog with full literal typing (provider and model IDs auto-complete), independent of any collection:

```typescript
import {
	getAllBuiltinModels,
	getBuiltinClassifierModel,
	getBuiltinClassifierModels,
	getBuiltinImageModel,
	getBuiltinImageModels,
	getBuiltinModel,
	getBuiltinModels,
	getBuiltinProviders,
} from "@octocodeai/octocode-ai/providers/all";

const model = getBuiltinModel("openai", "gpt-4o-mini"); // typed Model<'openai-responses'>
const flux = getBuiltinImageModel("openrouter", "black-forest-labs/flux.2-pro");
const jev = getBuiltinClassifierModel("typesafe", "jev-latest");
const providers = getBuiltinProviders();
const openrouterChat = getBuiltinModels("openrouter"); // Model[]
const openrouterImages = getBuiltinImageModels("openrouter"); // ImageModel[]
const typesafeClassifiers = getBuiltinClassifierModels("typesafe"); // ClassifierModel[]
const openrouterAll = getAllBuiltinModels("openrouter"); // AnyModel[]
```

### Dynamic Providers

Providers may have dynamic model lists (a llama.cpp server, a live OpenRouter listing). Reads stay sync; fetching is an explicit async verb:

```typescript
// getModels() returns the last-known list (empty before the first refresh)
await models.refresh({ providers: ["llamacpp"] }); // refresh one provider
await models.refresh(); // refresh all providers concurrently, best-effort
const fresh = models.getModel("llamacpp", "qwen3-30b");
```

Static built-in providers are no-ops for `refresh()`. See [createProvider()](custom-providers.md#createprovider) for building a dynamic provider.

## Compat Entrypoint

`@octocodeai/octocode-ai/compat` exposes the global dispatch surface: `stream()`/`complete()` dispatching on `model.api` through a registry, `registerApiProvider()`, `getEnvApiKey()` and the global image `generateImages()`. It is a strict superset of the root entrypoint, and the coding agent dispatches through its registry.

```typescript
import { complete } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
```

Catalog reads are `getBuiltinModel()`/`getBuiltinModels()`/`getBuiltinProviders()` in `providers/all`, and per-API stream functions are `stream`/`streamSimple` in `api/<api>`. Code that wants no global state uses `createModels()` and the provider factories (`models.getModel()`, `models.stream()`, `createProvider({ id, auth, models, api })` with `models.setProvider()`, `models.getAuth()`, `fauxProvider()`, `models.getModelOfType('image', ...)`, `models.generateImages()`).
