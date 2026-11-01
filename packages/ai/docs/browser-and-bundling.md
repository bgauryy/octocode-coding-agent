# Browser usage and bundling

Part of the [`@octocodeai/octocode-ai` guide](../README.md).

## Browser Usage

The library supports browser environments. The core entrypoint and provider factories are side-effect free and bundle cleanly. Environment variables are not available in browsers, so pass API keys explicitly — or inject a `CredentialStore` (e.g. localStorage-backed) and let provider auth resolve from stored credentials:

```typescript
import { createModels } from "@octocodeai/octocode-ai";
import { anthropicProvider } from "@octocodeai/octocode-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());

const model = models.getModel("anthropic", "claude-3-5-haiku-20241022")!;
const response = await models.complete(
	model,
	{
		messages: [{ role: "user", content: "Hello!", timestamp: Date.now() }],
	},
	{
		apiKey: "your-api-key",
	},
);
```

> **Security Warning**: Exposing API keys in frontend code is dangerous. Anyone can extract and abuse your keys. Only use this approach for internal tools or demos. For production applications, use a backend proxy that keeps your API keys secure.

Browser compatibility notes:

- Amazon Bedrock (`bedrock-converse-stream`) is not supported in browser environments. It can still appear in model lists; calls fail at runtime.
- OAuth login flows are Node-only. They are lazy-loaded behind bundler-opaque imports, so registering an OAuth-capable provider does not pull Node-only code into a browser bundle — only actually logging in would.
- Use a server-side proxy or backend service if you need Bedrock or OAuth-based auth from a web app.

## Bundling and Tree Shaking

For small bundles and low-overhead unbundled scripts, import the model runtime and only the providers you need:

```typescript
import { createModels } from "@octocodeai/octocode-ai/models";
import { openaiProvider } from "@octocodeai/octocode-ai/providers/openai";

const models = createModels();
models.setProvider(openaiProvider());
```

Rules:

- `@octocodeai/octocode-ai/models` exports the model runtime (`createModels`, `createProvider`, model helpers, and their types) without TypeBox, built-in catalogs, or SDK implementations. Other types can still use `import type` from the root.
- `@octocodeai/octocode-ai` is the core entrypoint and does not import built-in catalogs, real provider factories, or SDK implementations, but it eagerly imports TypeBox and schema validation. Unbundled Node scripts do not tree-shake its unused exports; prefer `./models`, `./providers/faux`, and specific `./utils/*` subpaths when those are all you need.
- `@octocodeai/octocode-ai/providers/<provider>` imports that provider's catalog and lazy API wrapper only.
- `@octocodeai/octocode-ai/providers/all` imports every built-in provider factory and all catalogs. Use it only when you want the full built-in set.
- With code splitting, provider SDKs stay in lazy chunks and load on first request.
- Without code splitting, bundlers fold reachable lazy API implementations into the single bundle. A single-provider bundle then includes that provider's SDK; `providers/all` includes all statically visible SDKs. Bedrock is the exception: its AWS SDK implementation is loaded through a bundler-opaque Node-only import.
- Importing `@octocodeai/octocode-ai/api/<api-id>` directly loads that API implementation and its SDK immediately.

Avoid `@octocodeai/octocode-ai/compat` in new bundled apps; it preserves the old global API and imports the full built-in catalog surface.

For single-file Node ESM bundles, some SDK dependencies may still use dynamic CommonJS `require()` internally. If you see errors such as `Dynamic require of "child_process" is not supported`, add a Node `require` shim to the bundle. With esbuild:

```bash
esbuild app.js --bundle --platform=node --format=esm \
  --banner:js='import { createRequire } from "module";const require = createRequire(import.meta.url);' \
  --outfile=app.bundle.js
```

This is only for Node bundles; it is not a browser or Cloudflare Workers workaround.

Bedrock is Node-only. Add it like any other provider:

```typescript
import { createModels } from "@octocodeai/octocode-ai";
import { amazonBedrockProvider } from "@octocodeai/octocode-ai/providers/amazon-bedrock";

const models = createModels();
models.setProvider(amazonBedrockProvider());
```

In normal Node package usage and code-split bundles, Bedrock loads its AWS SDK implementation lazily. For a standalone single-file bundle that must include Bedrock support, register the implementation module explicitly:

```typescript
import { setBedrockProviderModule } from "@octocodeai/octocode-ai/api/bedrock-converse-stream.lazy";
import { bedrockProviderModule } from "@octocodeai/octocode-ai/bedrock-provider";

setBedrockProviderModule(bedrockProviderModule);
```

That explicit override bundles the AWS SDK. Without it, Bedrock's opaque runtime import expects the package's Bedrock implementation file to be available at runtime.

### Provider-Scoped Environment Overrides

Pass `env` in stream options to scope provider configuration to a request. Values in `env` are used before process environment variables for provider auth and configuration such as Cloudflare account IDs, Azure OpenAI settings, Vertex project/location, Bedrock settings, `OCTOCODE_CACHE_RETENTION`, and `HTTP_PROXY`/`HTTPS_PROXY`.

```typescript
const models = builtinModels();
const model = models.getModel("cloudflare-ai-gateway", "workers-ai/@cf/moonshotai/kimi-k2.6")!;

const response = await models.complete(model, context, {
	env: {
		CLOUDFLARE_API_KEY: "...",
		CLOUDFLARE_ACCOUNT_ID: "account-id",
		CLOUDFLARE_GATEWAY_ID: "gateway-id",
	},
});
```

Use this when one process needs different provider settings per request, or when ambient environment variables should not leak into a provider call.

## Vendor model discovery

`discoverProviderModels(models, providerId, options)` from `@octocodeai/octocode-ai/providers/discovery` compares documented vendor model IDs with configured definitions. Set `allowNetwork: false` for a catalog-only result without resolving credentials. The source registry covers every built-in provider, including explicit control-plane and subscription-catalog guidance where no inference list contract is verified. The helper does not add models or guess prices, capabilities or context limits. See [model discovery](../../coding-agent/docs/model-discovery.md) for status meanings, the CLI and an SDK example.
