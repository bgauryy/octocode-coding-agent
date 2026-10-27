# Providers

Most hosted providers support one or both of these authentication methods:

- Sign in through a browser or device flow backed by OAuth.
- Provide an API key.

Use `/providers [provider]` (`/login` is an alias) to see status and the methods supported by a provider. Amazon Bedrock and Google Vertex AI can also use ambient cloud credentials.

GitHub Copilot model access uses `/providers github-copilot`. The separate `/github` command manages GitHub code-search credentials; signing in there does not configure Copilot inference.

For instruction and conversation retention, see [Prompt caching](prompt-caching.md).

## Authenticate interactively

Run `/providers` and choose a provider. Each provider appears once with its credential source and available model count. “Configured” means credentials are present; it does not verify that the provider will accept a request. Choose **Sign in** for the provider’s browser/device authentication flow, or **Add API key** / **Replace API key** for a key. Only supported methods appear. Choose **Choose a model for this chat** to open that provider’s models. Successful sign-in opens this picker automatically; Esc keeps the current model and Ctrl+S explicitly changes the default. A session API-key override is labeled separately and can be cleared without removing saved credentials; saving a key while that override is active reports that the override still takes priority.

On a remote or headless machine, an OAuth callback may not reach the local process. When prompted, paste the final redirect URL or authorization code back into Octocode.

Choose **Remove saved credential** on the provider’s page, or run `/logout` and select a provider, then confirm removal. This does not unset environment variables, remove authentication from `models.json`, or revoke the credential at the provider.

Secret input and pasted authorization codes are hidden. When macOS Keychain or Linux Secret Service is available, API-key entry offers it first: only a command reference is written to `auth.json`. A failed keychain write aborts without silently saving plaintext. You can explicitly choose local-file storage; new files use mode `0600` and new directories `0700`. Existing administrator-managed modes and ACLs are preserved. Startup warns when its credential file has group/world permissions or is inside a Git worktree; injected SDK model runtimes retain responsibility for their own credential storage. OAuth tokens and file-stored API keys remain plaintext; keep `auth.json` private and out of Git. Removal also attempts to delete an owned keychain entry.

## Use Pi configuration

Select **Pi (config)** in `/providers`, or run `/providers pi`. It lists providers found in Pi’s `models.json` and saved sign-ins from `auth.json`. Model definitions follow the existing [Pi fallback precedence](configuration.md#pi-configuration-fallback); models retain their real provider IDs and use those providers’ APIs, authentication and pricing. Pi is a setup source, not a network model service.

Saved Pi sign-ins are copied only after you select a provider and confirm import. Existing Octocode credentials can be replaced; Pi files are never modified. API keys can be imported into the system keychain. File imports preserve environment references; keychain imports resolve the key once and reject missing values. Command-based Pi keys are not executed or imported by this flow; configure those providers directly. Explicit home overrides and custom SDK directories disable discovery. After import, the model picker shows only that provider. Providers defined only in Pi’s model file remain usable through the normal fallback loader.

## Use OpenCode and choose a model

Run `/providers opencode` for OpenCode Console (Zen), or `/providers opencode-go` for Go. Choose **Add API key** (or **Replace API key**) and paste your key when prompted. After saving it, Octocode opens the model picker with that provider as the search term; your current model stays selected until you choose another. Press Esc to keep it.

To choose later, run `/model opencode/` or `/model opencode-go/`; the trailing slash restricts the picker to that exact provider. You can also select an exact model with `/model <provider>/<model-id>`. Both providers support `OPENCODE_API_KEY` for environment-based authentication. A saved key takes precedence over that variable.

The [OpenCode Console model list](https://opencode.ai/v2/docs/console/models/) and [Go documentation](https://opencode.ai/v2/docs/console/go/) describe availability and account requirements. A model appearing in the local catalog does not guarantee that your account can use it.

## Use an API key from the environment

Environment variables are useful in CI and anywhere Octocode should not store the key. Set the variable before starting Octocode:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
octocode
```

This table covers providers with a single primary API-key variable. Providers that need additional configuration or support ambient credentials are covered under [Provider Specific Config](#provider-specific-config).

| Provider                                                        | Environment variable                                                     |
| --------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Anthropic                                                       | `ANTHROPIC_API_KEY`                                                      |
| Ant Ling                                                        | `ANT_LING_API_KEY`                                                       |
| OpenAI                                                          | `OPENAI_API_KEY`                                                         |
| DeepSeek                                                        | `DEEPSEEK_API_KEY`                                                       |
| NVIDIA NIM                                                      | `NVIDIA_API_KEY`                                                         |
| Google Gemini                                                   | `GOOGLE_API_KEY` or `GEMINI_API_KEY` (`GOOGLE_API_KEY` takes precedence) |
| GitHub Copilot                                                  | `COPILOT_GITHUB_TOKEN`                                                   |
| Mistral                                                         | `MISTRAL_API_KEY`                                                        |
| Groq                                                            | `GROQ_API_KEY`                                                           |
| Cerebras                                                        | `CEREBRAS_API_KEY`                                                       |
| xAI                                                             | `XAI_API_KEY`                                                            |
| OpenRouter                                                      | `OPENROUTER_API_KEY`                                                     |
| Vercel AI Gateway                                               | `AI_GATEWAY_API_KEY`                                                     |
| ZAI Coding Plan (Global)                                        | `ZAI_API_KEY`                                                            |
| ZAI Coding Plan (China)                                         | `ZAI_CODING_CN_API_KEY`                                                  |
| OpenCode Zen and Go                                             | `OPENCODE_API_KEY`                                                       |
| TypeSafe ([classifier models](models.md#use-classifier-models)) | `TYPESAFE_API_KEY`                                                       |
| Hugging Face                                                    | `HF_TOKEN`                                                               |
| Fireworks                                                       | `FIREWORKS_API_KEY`                                                      |
| Together AI                                                     | `TOGETHER_API_KEY`                                                       |
| Baseten                                                         | `BASETEN_API_KEY`                                                        |
| Kimi For Coding                                                 | `KIMI_API_KEY`                                                           |
| Meta                                                            | `META_API_KEY` or `MODEL_API_KEY` (`META_API_KEY` takes precedence)      |
| MiniMax                                                         | `MINIMAX_API_KEY`                                                        |
| MiniMax (China)                                                 | `MINIMAX_CN_API_KEY`                                                     |
| Moonshot AI (Global and China)                                  | `MOONSHOT_API_KEY`                                                       |
| Qwen Token Plan and Individual                                  | `QWEN_TOKEN_PLAN_API_KEY`                                                |
| Qwen Token Plan (China)                                         | `QWEN_TOKEN_PLAN_CN_API_KEY`                                             |
| Xiaomi MiMo                                                     | `XIAOMI_API_KEY`                                                         |
| Xiaomi MiMo Token Plan (China)                                  | `XIAOMI_TOKEN_PLAN_CN_API_KEY`                                           |
| Xiaomi MiMo Token Plan (Amsterdam)                              | `XIAOMI_TOKEN_PLAN_AMS_API_KEY`                                          |
| Xiaomi MiMo Token Plan (Singapore)                              | `XIAOMI_TOKEN_PLAN_SGP_API_KEY`                                          |

Anthropic also recognizes `ANTHROPIC_OAUTH_TOKEN` as an API credential and `ANTHROPIC_AUTH_TOKEN` as bearer authentication.

The [provider protocol and authentication audit](../../../docs/PROVIDER_PROTOCOL_AUDIT.md) records the 2026-10-25 documentation review, repairs, and remaining limitations. Anthropic's published policy does not permit offering Claude.ai subscription login in third-party applications, so the built-in Anthropic provider does not register subscription OAuth. Use an API key or supported cloud provider. Legacy subscription tokens do not mark this provider as configured.

Sign in with ChatGPT retains account/client registrations and offers a saved account or a new account on the next login. Saved account selection reuses its issued client ID and available ID-token hint, then verifies the returned account. Logout revokes saved renewable sessions and removes their local tokens; nonsecret registrations remain for reuse. If remote revocation cannot be confirmed, local tokens are still removed and the error explains how to disconnect the app in account settings. Model availability comes from the selected account's vendor list; see [model discovery](model-discovery.md).

With no key or token set, Anthropic uses workload identity federation when `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID` and `ANTHROPIC_IDENTITY_TOKEN_FILE` are set: the Anthropic SDK exchanges the identity token for a short-lived access token and refreshes it itself (re-reading the identity token file, so keep that file fresh for long sessions). `ANTHROPIC_SERVICE_ACCOUNT_ID` and `ANTHROPIC_WORKSPACE_ID` are passed through when set.

## Load an API key from a command

To use a secret manager without writing the resolved key to disk, set a provider's `key` in `auth.json` to a command prefixed with `!`:

```json
{
	"anthropic": {
		"type": "api_key",
		"key": "!security find-generic-password -ws 'anthropic'"
	}
}
```

Octocode runs the command when the key is first needed and caches its standard output for the process lifetime. Empty output, a timeout, or a nonzero exit leaves the key unresolved until Octocode restarts.

## Provider Specific Config

The providers below have additional setup, need additional settings, or can use credentials supplied by their platform.

A stored API-key credential can include an `env` object. Its values take priority over the process environment for that provider:

```json
{
	"cloudflare-workers-ai": {
		"type": "api_key",
		"key": "...",
		"env": {
			"CLOUDFLARE_ACCOUNT_ID": "account-id"
		}
	}
}
```

### OpenRouter

Authenticate with `/providers openrouter` or `OPENROUTER_API_KEY`.

With a key, Octocode lists only the OpenRouter chat models that key may use, with the key's context size, max output, and prices. These come from OpenRouter's `/models/user` endpoint and reflect guardrails and provider restrictions set in OpenRouter. Image and classifier models are not filtered.

Octocode refreshes the list in the background at startup in interactive mode, when `/model` opens, after provider sign-in, and on `octocode update --models`. The last list is saved and used offline and in `octocode -p` and RPC mode. After switching keys outside `/providers`, the previous key's list stays until the next refresh.

Regional endpoints filter models to their region. To use one, set the base URL in [`models.json`](models.md#configure-a-compatible-endpoint):

```json
{
	"providers": {
		"openrouter": { "baseUrl": "https://us.openrouter.ai/api/v1" }
	}
}
```

If the base URL rejects the key at `/models/user` or does not have that endpoint, for example a proxy configured as the OpenRouter base URL, Octocode lists every OpenRouter model.

### Azure OpenAI

The provider ID is `azure` (formerly `azure-openai-responses`). Use it as the key in `auth.json`, `models.json`, and `settings.json`, and in model references such as `--model azure/gpt-5.4`.

The `azure` provider serves OpenAI models through the Responses API and Microsoft Foundry models through Chat Completions, such as `azure/deepseek-v4-pro`.

Set an API key plus either a base URL or resource name:

```bash
export AZURE_OPENAI_API_KEY=...
export AZURE_OPENAI_BASE_URL=https://your-resource.ai.azure.com
# Or:
export AZURE_OPENAI_RESOURCE_NAME=your-resource
```

Resource root URLs under `ai.azure.com`, `cognitiveservices.azure.com`, and `openai.azure.com` are normalized to the OpenAI API path.

Octocode sends the model ID as the deployment name. If a deployment has a different name, map it with `AZURE_OPENAI_DEPLOYMENT_NAME_MAP`:

```bash
export AZURE_OPENAI_DEPLOYMENT_NAME_MAP=gpt-5.4=my-gpt-deployment,deepseek-v4-pro=my-deepseek
```

`AZURE_OPENAI_API_VERSION` overrides the API version for OpenAI models (default `v1`).

Azure login also offers an Entra bearer token. Set `AZURE_OPENAI_AD_TOKEN` or select that option in `/providers`; acquire the token through Azure Identity or Azure CLI. Stored API keys take precedence. This token is short-lived and must be renewed externally; Octocode does not refresh a manually supplied Entra token. SDK users can supply `azureADTokenProvider` to the Azure Responses adapter for automatic credential acquisition. Bearer auth suppresses the SDK's ambient API-key default.

To use a Foundry model that Octocode does not include, add it under `azure` in [`models.json`](models.md#configure-a-compatible-endpoint) with `api: "openai-completions"`. Custom models require a `baseUrl`; `AZURE_OPENAI_BASE_URL` and `AZURE_OPENAI_RESOURCE_NAME` take priority over it when set:

```json
{
	"providers": {
		"azure": {
			"baseUrl": "https://your-resource.services.ai.azure.com",
			"models": [{ "id": "your-deployment", "api": "openai-completions" }]
		}
	}
}
```

### Amazon Bedrock

Bedrock can use a bearer token or an ambient AWS credential source:

```bash
# Named profile
export AWS_PROFILE=your-profile

# IAM keys
export AWS_ACCESS_KEY_ID=AKIA...
export AWS_SECRET_ACCESS_KEY=...
# Required for temporary credentials
export AWS_SESSION_TOKEN=...

# Bedrock bearer token
export AWS_BEARER_TOKEN_BEDROCK=...

# Region, when not supplied by the profile or AWS SDK configuration
export AWS_REGION=us-west-2
# AWS_DEFAULT_REGION is also supported
```

Octocode also supports ECS task credentials and IRSA through the standard `AWS_CONTAINER_CREDENTIALS_*` and `AWS_WEB_IDENTITY_TOKEN_FILE` variables.

### Cloudflare AI Gateway

The gateway requires a token, account ID, and gateway ID:

```bash
export CLOUDFLARE_API_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
export CLOUDFLARE_GATEWAY_ID=...
```

The account and gateway IDs can come from the process environment or the credential's `env` object in `auth.json`.

`CLOUDFLARE_API_KEY` authenticates Octocode to the gateway. Upstream access can use Cloudflare unified billing, credentials stored in the gateway, or an `Authorization` header configured for the provider in `models.json`.

### Cloudflare Workers AI

Workers AI requires a token and account ID:

```bash
export CLOUDFLARE_API_KEY=...
export CLOUDFLARE_ACCOUNT_ID=...
```

The account ID can also be stored in the credential's `env` object.

### Google Vertex AI

Use a Google Cloud API key:

```bash
export GOOGLE_CLOUD_API_KEY=...
```

To use Application Default Credentials, configure a project and location:

```bash
export GOOGLE_CLOUD_PROJECT=your-project
# GCLOUD_PROJECT is also supported
export GOOGLE_CLOUD_LOCATION=us-central1
```

Then authenticate:

```bash
gcloud auth application-default login
```

To use a service-account key file instead, set `GOOGLE_APPLICATION_CREDENTIALS` along with the project and location.
