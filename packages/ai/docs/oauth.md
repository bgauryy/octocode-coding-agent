# OAuth Providers

Part of the [`@octocodeai/octocode-ai` guide](../README.md).

Several providers support OAuth authentication instead of static API keys:

- **OpenAI** (Sign in with ChatGPT: uses the ChatGPT subscription with the OpenAI API)
- **OpenAI Codex (legacy)** (ChatGPT Plus/Pro subscription, access to GPT-5.x Codex models)
- **GitHub Copilot** (Copilot subscription)
- **OpenRouter** (OAuth PKCE that mints a user-controlled API key)

Each of these providers carries an `OAuthAuth` on `provider.auth.oauth` with three required operations: `login(interaction)` uses the provider-neutral `AuthInteraction.prompt()`/`notify()` protocol and returns a credential, `refresh(credential, signal)` refreshes expiring credentials when applicable, and `toAuth(credential)` derives request auth (GitHub Copilot's per-account base URL comes from here). Provider login interactions and refresh calls always carry a concrete abort signal. Refresh is automatic: `models.getAuth(providerId)` and request paths refresh expired tokens under a credential-store lock, so concurrent requests and processes cannot double-refresh. OpenRouter's OAuth flow instead returns a permanent API key, so its refresh operation is a no-op.

```typescript
import { createModels } from "@octocodeai/octocode-ai";
import { openaiProvider } from "@octocodeai/octocode-ai/providers/openai";

const models = createModels({ credentials: myStore }); // persistent CredentialStore
models.setProvider(openaiProvider());

// Login: Models drives the flow and persists the credential
await models.login("openai", "oauth", {
	prompt: async (p) => {
		// p.type: 'text' | 'secret' | 'select' | 'manual_code'
		// manual_code prompts race a local callback server; p.signal aborts them when the server wins
		return await askUser(p.message);
	},
	notify: (event) => {
		// event.type: 'info' | 'auth_url' | 'device_code' | 'progress'
		if (event.type === "info") {
			console.log(event.message);
			for (const link of event.links ?? []) console.log(`${link.label ?? "More information"}: ${link.url}`);
		}
		if (event.type === "auth_url") console.log(`Open: ${event.url}`);
		if (event.type === "device_code") console.log(`Code: ${event.userCode} at ${event.verificationUri}`);
		if (event.type === "progress") console.log(event.message);
	},
});

// From here on, requests resolve and refresh the token automatically
const model = models.getModels("openai")[0]!;
await models.complete(model, context);

// Logout
await models.logout("openai");
```

Built-in Anthropic subscription OAuth is not offered: use API keys or supported cloud credentials. OpenAI login reuses saved account/client registrations, validates returned identity, and accepts `LoginOptions.getDeviceId` (a stable installation UUID) and `agentName`. `Models.login` passes the previous credential to the provider. Providers can implement an optional `OAuthAuth.logout` hook; OpenAI revokes renewable sessions under the credential-store lock, clears local tokens even when revocation is unconfirmed, and retains only nonsecret signed-out registrations. `signedOut` records never count as authentication. When a device-flow or token response fails validation, the error lists the names of the fields the response carried (or says it was not a JSON object), never their values, because those bodies carry device codes and tokens.

## Vertex AI

Vertex AI models support either a Google Cloud API key or Application Default Credentials (ADC). Its provider-owned API-key login flow can configure either method:

- **API key**: Set `GOOGLE_CLOUD_API_KEY` or pass `apiKey` in the call options.
- **Local development (ADC)**: Run `gcloud auth application-default login`
- **CI/Production (ADC)**: Set `GOOGLE_APPLICATION_CREDENTIALS` to point to a service account JSON key file

When using ADC, also set `GOOGLE_CLOUD_PROJECT` (or `GCLOUD_PROJECT`) and `GOOGLE_CLOUD_LOCATION`. You can also pass `project`/`location` in the call options. The location must be a region id such as `us-central1`, or `global` (lowercase letters, digits and hyphens): the SDK builds the request host from it, so any other value is refused before a request is sent. When using `GOOGLE_CLOUD_API_KEY`, `project` and `location` are not required.

```bash
# Local (uses your user credentials)
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT="my-project"
export GOOGLE_CLOUD_LOCATION="us-central1"

# CI/Production (service account key file)
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

Official docs: [Application Default Credentials](https://cloud.google.com/docs/authentication/application-default-credentials)

## CLI Login

The quickest way to authenticate:

```bash
npx @octocodeai/octocode-ai login              # interactive provider selection
npx @octocodeai/octocode-ai login openai       # login to specific provider
npx @octocodeai/octocode-ai list               # list available providers
```

Credentials are saved to `auth.json` in the current directory with owner-only permissions. The development CLI retains its installation UUID in `auth.json.host-id` and passes existing registrations on returning login.

## Programmatic OAuth

Built-in login and refresh flows are private provider implementations. Use provider-owned `OAuthAuth`, which composes with `CredentialStore` and gets locked auto-refresh through `Models`. The `@octocodeai/octocode-ai/oauth` entry point retains only type declarations required by coding-agent extension OAuth compatibility.

Provider notes:

**OpenAI Codex (legacy)**: Superseded by Sign in with ChatGPT on the OpenAI provider. Requires a ChatGPT Plus or Pro subscription. Provides access to GPT-5.x Codex models with extended context windows and reasoning capabilities. The library automatically handles session-based prompt caching when `sessionId` is provided in stream options unless `cacheRetention` is `"none"`. You can set `transport` in stream options to `"sse"`, `"websocket"`, or `"auto"` for Codex Responses transport selection. When using WebSocket with a `sessionId` and cache retention enabled, connections are reused per session and expire after 5 minutes of inactivity. Call `cleanupSessionResources(sessionId)` when finished so the pooled connection does not keep the process alive.

**Azure OpenAI**: Serves Responses and compatible Chat models. Use `AZURE_OPENAI_API_KEY` or `AZURE_OPENAI_AD_TOKEN` (an externally renewed Entra bearer token). The Azure Responses adapter also accepts `azureADTokenProvider` for SDK-managed token acquisition. Set either `AZURE_OPENAI_BASE_URL` or `AZURE_OPENAI_RESOURCE_NAME`. `AZURE_OPENAI_BASE_URL` supports both `https://<resource>.openai.azure.com` and `https://<resource>.cognitiveservices.azure.com`; root endpoints are normalized to `.../openai/v1` automatically. Use `AZURE_OPENAI_API_VERSION` (defaults to `v1`) to override the API version if needed. Deployment names are treated as model IDs by default, override with `azureDeploymentName` or `AZURE_OPENAI_DEPLOYMENT_NAME_MAP` using comma-separated `model-id=deployment` pairs (for example `gpt-4o-mini=my-deployment,gpt-4o=prod`). Legacy deployment-based URLs are intentionally unsupported.

**GitHub Copilot**: If you get "The requested model is not supported" error, enable the model manually in VS Code: open Copilot Chat, click the model selector, select the model (warning icon), and click "Enable".
