# Auth

Part of the [`@octocodeai/octocode-ai` guide](../README.md).

Every provider owns its auth: how API keys resolve (stored credentials, environment variables, ambient sources like AWS profiles or gcloud ADC) and, where supported, OAuth login/refresh flows.

## How Auth Resolves

When you call `models.stream()`, the collection resolves auth through the owning provider and merges it into the request. Explicit per-request values always win:

```typescript
// Resolved through the provider (env var, stored credential, OAuth token):
await models.complete(model, context);

// Explicit key wins over anything the provider would resolve:
await models.complete(model, context, { apiKey: "sk-explicit" });
```

You can inspect resolution without making a request. Pass a provider ID for provider-scoped auth, or a model to include its static `model.headers`:

```typescript
const providerAuth = await models.getAuth(model.provider);
const modelAuth = await models.getAuth(model);

if (modelAuth) {
	console.log(`configured via ${modelAuth.source}`); // e.g. "ANTHROPIC_API_KEY", "OAuth", "stored credential"
	console.log(modelAuth.auth.headers); // Provider auth headers + model.headers
} else {
	console.log("not configured");
}
```

Both overloads resolve credentials, refresh expired OAuth when necessary, and may return an auth-derived `apiKey`, `headers`, or `baseUrl`. `getAuth()` resolves `undefined` for unconfigured providers and rejects with `ModelsError` when something is actually broken (`"oauth"`: token refresh failed, credential preserved for re-login; `"auth"`: key resolution or credential store failure). Request paths surface the same failures as stream errors.

`getAuth()`, `checkAuth()`, `getAvailable()`, login, and logout accept optional caller cancellation through their existing options or interaction objects and remain unbounded when no signal is supplied. Provider `login`, `ApiKeyAuth.check`, `ApiKeyAuth.resolve`, and `OAuthAuth.refresh` implementations always receive a concrete signal and must honor it for blocking work.

## Transforming Request Headers

`Models.stream()`, `complete()`, `streamSimple()`, and `completeSimple()` accept a Models-only `transformHeaders` option. It runs once after provider auth, `model.headers`, and explicit `options.headers` have been merged, but before provider dispatch:

```typescript
const response = await models.completeSimple(model, context, {
	headers: { "X-Client": "my-app" },
	transformHeaders: async (headers) => ({
		...headers,
		"X-Request-ID": crypto.randomUUID(),
	}),
});
```

The ordering is:

```text
provider auth headers -> model.headers -> explicit options.headers -> transformHeaders -> Provider.stream*()
```

Header names are merged case-insensitively. Explicit headers override auth/model headers, and the transform has final control; returning `null` for a header suppresses lower-level defaults that support deletion.

`transformHeaders` belongs to `Models`, not `Provider`. A `Models` implementation must consume it and remove it before calling `Provider.stream*()`. Provider implementations continue receiving ordinary `ApiStreamOptions` or `SimpleStreamOptions` and never handle the transform themselves. Use this option instead of calling `getAuth(model)` before `stream*()`, which would resolve request auth twice.

## Credential Store

Stored credentials (API keys entered interactively, OAuth tokens) live in a `CredentialStore` — one type-tagged credential per provider. `@octocodeai/octocode-ai` ships an in-memory default; apps inject persistent storage:

```typescript
import { createModels, type CredentialStore } from "@octocodeai/octocode-ai";

const models = createModels({ credentials: myFileBackedStore });
// builtinModels() takes the same options:
// const models = builtinModels({ credentials: myFileBackedStore });
```

The contract is small: `read(providerId)`, `list()` for non-secret `{ providerId, type }` metadata, `modify(providerId, fn)` (the only write path — a serialized read-modify-write), and `delete(providerId)`. Each operation accepts optional cancellation options. Enumeration must not resolve secrets or execute configured key commands. OAuth token refresh runs inside `modify`, so concurrent requests and processes cannot double-refresh a rotated token. A stored credential _owns_ its provider: environment variables are only consulted when nothing is stored, and a failed refresh never silently falls back to an env key.

API-key credentials use the same discriminator as Octocode's `auth.json` and can carry provider-scoped env/config values:

```typescript
const credential = {
	type: "api_key",
	key: "...",
	env: {
		CLOUDFLARE_ACCOUNT_ID: "account-id",
		CLOUDFLARE_GATEWAY_ID: "gateway-id",
	},
} as const;
```

## Environment Variables

Built-in providers resolve these env vars (Node.js; in browsers pass `apiKey` explicitly):

| Provider                           | Environment Variable(s)                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI                             | `OPENAI_API_KEY`                                                                                                                                                                                                                                                                                                                                        |
| Ant Ling                           | `ANT_LING_API_KEY`                                                                                                                                                                                                                                                                                                                                      |
| Azure OpenAI                       | `AZURE_OPENAI_API_KEY` + `AZURE_OPENAI_BASE_URL` (e.g. `https://{resource}.ai.azure.com`) or `AZURE_OPENAI_RESOURCE_NAME`. Supports `*.openai.azure.com`, `*.cognitiveservices.azure.com` and `*.ai.azure.com`; root endpoints auto-normalize to `/openai/v1`. Optional: `AZURE_OPENAI_API_VERSION` (default `v1`), `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`. |
| Anthropic                          | `ANTHROPIC_API_KEY`; a Claude subscription token in `ANTHROPIC_OAUTH_TOKEN` is refused                                                                                                                                                                                                                                                                  |
| TypeSafe                           | `TYPESAFE_API_KEY`                                                                                                                                                                                                                                                                                                                                      |
| DeepSeek                           | `DEEPSEEK_API_KEY`                                                                                                                                                                                                                                                                                                                                      |
| NVIDIA NIM                         | `NVIDIA_API_KEY`                                                                                                                                                                                                                                                                                                                                        |
| Google                             | `GOOGLE_API_KEY` or `GEMINI_API_KEY` (`GOOGLE_API_KEY` wins when both are set)                                                                                                                                                                                                                                                                          |
| Vertex AI                          | `GOOGLE_CLOUD_API_KEY` or `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) + `GOOGLE_CLOUD_LOCATION` + ADC                                                                                                                                                                                                                                                  |
| Mistral                            | `MISTRAL_API_KEY`                                                                                                                                                                                                                                                                                                                                       |
| Groq                               | `GROQ_API_KEY`                                                                                                                                                                                                                                                                                                                                          |
| Cerebras                           | `CEREBRAS_API_KEY`                                                                                                                                                                                                                                                                                                                                      |
| Cloudflare AI Gateway              | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_GATEWAY_ID`                                                                                                                                                                                                                                                                                |
| Cloudflare Workers AI              | `CLOUDFLARE_API_KEY` + `CLOUDFLARE_ACCOUNT_ID`                                                                                                                                                                                                                                                                                                          |
| xAI                                | `XAI_API_KEY`                                                                                                                                                                                                                                                                                                                                           |
| Fireworks                          | `FIREWORKS_API_KEY`                                                                                                                                                                                                                                                                                                                                     |
| Together AI                        | `TOGETHER_API_KEY`                                                                                                                                                                                                                                                                                                                                      |
| Baseten                            | `BASETEN_API_KEY`                                                                                                                                                                                                                                                                                                                                       |
| OpenRouter                         | `OPENROUTER_API_KEY`                                                                                                                                                                                                                                                                                                                                    |
| Vercel AI Gateway                  | `AI_GATEWAY_API_KEY`                                                                                                                                                                                                                                                                                                                                    |
| ZAI Coding Plan (Global)           | `ZAI_API_KEY`                                                                                                                                                                                                                                                                                                                                           |
| ZAI Coding Plan (China)            | `ZAI_CODING_CN_API_KEY`                                                                                                                                                                                                                                                                                                                                 |
| MiniMax (Global)                   | `MINIMAX_API_KEY`                                                                                                                                                                                                                                                                                                                                       |
| MiniMax (China)                    | `MINIMAX_CN_API_KEY`                                                                                                                                                                                                                                                                                                                                    |
| Moonshot AI / Moonshot AI (China)  | `MOONSHOT_API_KEY`                                                                                                                                                                                                                                                                                                                                      |
| Hugging Face                       | `HF_TOKEN`                                                                                                                                                                                                                                                                                                                                              |
| OpenCode Zen / OpenCode Go         | `OPENCODE_API_KEY`                                                                                                                                                                                                                                                                                                                                      |
| Kimi For Coding                    | `KIMI_API_KEY`                                                                                                                                                                                                                                                                                                                                          |
| Meta                               | `META_API_KEY` or `MODEL_API_KEY` (`META_API_KEY` wins when both are set)                                                                                                                                                                                                                                                                               |
| Qwen Token Plan (existing catalog) | `QWEN_TOKEN_PLAN_API_KEY`                                                                                                                                                                                                                                                                                                                               |
| Qwen Token Plan (Individual)       | `QWEN_TOKEN_PLAN_API_KEY`                                                                                                                                                                                                                                                                                                                               |
| Qwen Token Plan (China)            | `QWEN_TOKEN_PLAN_CN_API_KEY`                                                                                                                                                                                                                                                                                                                            |
| Xiaomi MiMo (API billing)          | `XIAOMI_API_KEY`                                                                                                                                                                                                                                                                                                                                        |
| Xiaomi MiMo Token Plan (China)     | `XIAOMI_TOKEN_PLAN_CN_API_KEY`                                                                                                                                                                                                                                                                                                                          |
| Xiaomi MiMo Token Plan (Amsterdam) | `XIAOMI_TOKEN_PLAN_AMS_API_KEY`                                                                                                                                                                                                                                                                                                                         |
| Xiaomi MiMo Token Plan (Singapore) | `XIAOMI_TOKEN_PLAN_SGP_API_KEY`                                                                                                                                                                                                                                                                                                                         |
| GitHub Copilot                     | `COPILOT_GITHUB_TOKEN`                                                                                                                                                                                                                                                                                                                                  |

`qwen-token-plan-individual` and `qwen-token-plan` share the international endpoint and
`QWEN_TOKEN_PLAN_API_KEY`. The Individual provider exposes only the models documented for Individual
subscriptions, while the existing provider retains its broader catalog for backward compatibility.
Stored credentials remain provider-scoped, so save the key under the provider ID you register.

Amazon Bedrock resolves ambient AWS credentials (`AWS_PROFILE`, access key pairs, `AWS_BEARER_TOKEN_BEDROCK`, ECS task roles, web identity tokens, and shared configuration files); its provider-owned login flow supports bearer tokens, AWS profiles, and the existing credential chain. Explicit credential-chain login delegates to the AWS SDK, including instance roles and credential processes. Vertex AI resolves either an explicit key or gcloud Application Default Credentials plus project/location, with a provider-owned login flow for API keys, ADC, and service-account files. Explicit ADC login also permits attached service accounts without a local credential file; the Google SDK resolves the credentials at request time.

## OAuth

Providers with OAuth: OpenAI (Sign in with ChatGPT), OpenAI Codex (legacy, ChatGPT Plus/Pro), GitHub Copilot, OpenRouter (PKCE; mints a permanent API key, so refresh is a no-op). Anthropic subscription OAuth is not offered.

Each carries `provider.auth.oauth` with `login(interaction)` (provider-neutral `prompt()`/`notify()` protocol, returns a credential), `refresh(credential, signal)` and `toAuth(credential)` (derives request auth; Copilot's per-account base URL comes from here). Both calls always receive a concrete abort signal. `models.getAuth()` and request paths refresh expired tokens under a credential-store lock, so concurrent requests and processes never double-refresh.

```typescript
const models = createModels({ credentials: myStore }); // persistent CredentialStore
models.setProvider(openaiProvider());

await models.login("openai", "oauth", {
	prompt: async (p) => askUser(p.message), // p.type: text | secret | select | manual_code
	notify: (event) => {
		// event.type: info | auth_url | device_code | progress
		if (event.type === "auth_url") console.log(`Open: ${event.url}`);
		if (event.type === "device_code") console.log(`Code: ${event.userCode} at ${event.verificationUri}`);
	},
});
await models.complete(models.getModels("openai")[0]!, context); // token resolves and refreshes automatically
await models.logout("openai");
```

`manual_code` prompts race a local callback server; `p.signal` aborts them when the server wins. OpenAI login reuses saved registrations, validates the returned identity and accepts `LoginOptions.getDeviceId` (stable installation UUID) and `agentName`; `Models.login` passes the previous credential to the provider. The optional `OAuthAuth.logout` hook lets OpenAI revoke renewable sessions under the store lock; local tokens are cleared even when revocation is unconfirmed, and `signedOut` records never count as authentication. Failed device-flow or token validation errors list field names, never values.

The built-in flows are private to the providers; `@octocodeai/octocode-ai/oauth` exports only the types the coding agent's extension OAuth needs.

### Vertex AI

An API key or Application Default Credentials (ADC); the provider's login flow configures either.

| Method     | Setup                                                                          |
| ---------- | ------------------------------------------------------------------------------ |
| API key    | `GOOGLE_CLOUD_API_KEY` or `apiKey` option; `project` and `location` not needed |
| ADC, local | `gcloud auth application-default login`                                        |
| ADC, CI    | `GOOGLE_APPLICATION_CREDENTIALS` pointing at a service-account JSON file       |

ADC also needs `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) and `GOOGLE_CLOUD_LOCATION`, or `project`/`location` options. The location is a region id such as `us-central1`, or `global` (lowercase letters, digits, hyphens); anything else is refused before a request because the SDK builds the host from it.

### Provider notes

- **OpenAI Codex (legacy):** superseded by Sign in with ChatGPT. With `sessionId` it caches prompts unless `cacheRetention` is `"none"`. `transport` is `"sse"`, `"websocket"` or `"auto"`; WebSocket connections are reused per session (5 minutes idle). Call `cleanupSessionResources(sessionId)` when done so the pooled connection does not keep the process alive.
- **Azure OpenAI:** `AZURE_OPENAI_API_KEY` or `AZURE_OPENAI_AD_TOKEN` (externally renewed Entra token); the Responses adapter also takes `azureADTokenProvider`. Set `AZURE_OPENAI_BASE_URL` (`*.openai.azure.com`, `*.cognitiveservices.azure.com`, `*.ai.azure.com`; roots normalize to `/openai/v1`) or `AZURE_OPENAI_RESOURCE_NAME`. `AZURE_OPENAI_API_VERSION` defaults to `v1`. Deployment names equal model ids unless `azureDeploymentName` or `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` (`model-id=deployment,...`) overrides; legacy deployment URLs are unsupported.
- **GitHub Copilot:** on "The requested model is not supported", enable the model in VS Code (Copilot Chat, model selector, Enable).
