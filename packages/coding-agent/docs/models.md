# Choose a Model

Use [`octocode models discover`](model-discovery.md) to compare documented vendor model lists with the configured catalog, including IDs that need metadata before use.

For a built-in provider, start with `/providers`, then choose a model with `/model`. Use custom model configuration only when Octocode does not already include the provider or endpoint you need.

## Choose a connection

| What you have | Recommended setup |
|---|---|
| A supported subscription | Sign in through `/providers` |
| A provider API key | Store it through `/providers` or set its environment variable |
| A local GGUF model | Connect Octocode to the llama.cpp router |
| An OpenAI-, Anthropic-, or Google-compatible endpoint | Add it to `models.json` |
| A provider with a custom protocol or authentication flow | Build or install a provider extension |

Use `/model` to inspect the models available to this installation. Octocode starts with its bundled catalog. Set `OCTOCODE_MODEL_CATALOG_URL` to a compatible catalog service to enable remote catalog overlays; the fork does not default to Pi's service. Cached catalog data remains available offline. `octocode update --models` refreshes from the configured service.

## Authenticate

Run `/providers` and select a provider, then choose account sign-in or API-key setup. The same provider page offers key replacement and removal. See [providers](providers.md) for keychain storage and Pi configuration support.

You can instead provide an API key through the provider's environment variable. This is useful in CI and other environments where Octocode should not write credentials. [Providers](providers.md) lists the variables and provider-specific setup.

When several credential sources are configured, Octocode uses a runtime `--api-key` first, then a stored `auth.json` credential, an `apiKey` from `models.json`, and finally the provider's environment variables or ambient cloud credentials. Provider extensions can define their own authentication behavior.

Keep `auth.json` and any credential commands private. Project settings and extensions can execute inside the Octocode process after you trust a project. Review [Security](../../../SECURITY.md) before loading configuration from an untrusted directory.

## Select a model

Run `/model` (or its alias `/models`) to search models grouped by provider. The picker shows models from configured providers; catalog presence does not verify account access. Choose a provider in `/providers` first to filter to only its models. Press `Ctrl+S` on a model to save it as the default for new sessions.

Run `/thinking` (alias of `/effort`) to select the thinking level for the current model. Press `Ctrl+S` there to save the startup level. Octocode limits the choices to levels supported by the selected model.

`Ctrl+P` cycles through available models. Open `/modelsettings` and choose **Model shortcuts** to control that cycle and save the selection, or configure model patterns in `settings.json`.

Use `/context` to inspect usage, `/context size` to choose a context budget, `/context 32k` to set one directly, or `/context reset` to restore the catalog capacity. Budgets apply to the selected physical model in this session, affect request limits and automatic compaction, and cannot exceed its catalog capacity. The minimum is 8,192 tokens (or the full capacity for smaller models). Changes require an idle session. Select a physical model before setting a budget for a virtual route. Budgets are not saved as defaults.

The selected-model details show catalog context, maximum output, thinking support, base input/output/cache prices and known cache lifetimes. Rates are provider-specific estimates: reasoning output, cache-write retention, long-context tiers and the served service tier can change totals. Subscription billing, account credits, regional premiums and time-based cache-storage fees are not fully represented by token estimates.

A session records model and thinking-level changes. Resuming the session restores them without changing defaults for new sessions.

## Connect local models

Octocode integrates directly with the llama.cpp router. The router discovers GGUF files and loads models on demand. Octocode's `/llama` command manages the router, while `/model` selects one of its loaded models.

Open `/llama` to inspect loaded models, download models and manage the connection. See the [command reference](commands.md#bundled-extension-commands) for availability.

For Ollama, LM Studio, vLLM, SGLang, and other compatible servers, [configure a compatible endpoint](#configure-a-compatible-endpoint) in `models.json`.

## Configure a compatible endpoint

Use `models.json` when an endpoint speaks an API Octocode already supports. This includes most Ollama, LM Studio, vLLM, SGLang, and proxy deployments.

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "qwen2.5-coder:7b" }
      ]
    }
  }
}
```

The dummy key makes the model available to Octocode; Ollama ignores it. For an authenticated endpoint, `apiKey` and header values can use `$NAME` or `${NAME}` environment interpolation, a literal value, or a leading `!command`. `$$` and `$!` produce a literal `$` and `!`. Commands in `models.json` run at request time and are not cached by Octocode.

Opening `/model` reloads the file. A `models` entry adds or replaces a model with the same ID on that provider. Use `modelOverrides` to change metadata for an existing built-in or extension-provided model without replacing the provider's model list. Unknown override IDs are ignored.

To route a built-in provider through a proxy, set only its `baseUrl`. Its models and authentication stay unchanged:

```json
{
  "providers": {
    "anthropic": { "baseUrl": "https://proxy.example.com/v1" }
  }
}
```

[Models Configuration](models-configuration.md) lists every field.

### Describe model input and caching

Image support belongs to the exact model and endpoint. `yarn start --list-models` shows an `images` column, and `/model` shows image support in the selected model's details. The web composer displays the selected model's input support and keeps attachments when you switch to a text-only model. Select a model that accepts images or remove the attachments before sending.

For a verified image-capable custom endpoint, set `"input": ["text", "image"]` in its model definition. Omitted `input` defaults to `["text"]`. The same fields work in Pi-compatible `models.json` provider definitions and `modelOverrides`; [configuration fallback](configuration.md#pi-configuration-fallback) controls which file supplies a provider. For example:

```json
{
  "providers": {
    "local-vision": {
      "api": "openai-completions",
      "baseUrl": "http://localhost:11434/v1",
      "apiKey": "ollama",
      "models": [
        { "id": "your-installed-vision-model", "input": ["text", "image"] }
      ]
    },
    "openai": {
      "modelOverrides": {
        "gpt-4o": { "input": ["text", "image"] }
      }
    }
  }
}
```

Replace the custom model ID with the image-capable model served by your endpoint. Declaring image input does not add vision to a text-only server. Native provider entries take precedence over Pi fallback entries; neither reading nor sending images rewrites Pi files. Newly submitted images are rejected for text-only models, including queued input or a virtual route that resolves to a text-only model. Previously answered image turns can still be replayed on a text-only model using omission notices; the original images remain in session history.

Use `instructionCacheRetention` and `cacheRetention` to select instruction and history preferences in settings or provider/model configuration. See [Prompt caching](prompt-caching.md) for supported durations, recommended configurations, precedence and diagnostics. `promptCache` below describes warming lifetimes; it does not select retention or enable unsupported API fields.

Use `inputLimits.images.resize` to control how Octocode encodes new image attachments and tool-result images before storing them in conversation history:

```json
{
  "id": "vision-model",
  "input": ["text", "image"],
  "inputLimits": {
    "images": {
      "resize": {
        "maxWidth": 1568,
        "maxHeight": 1568,
        "maxBytes": 524288,
        "jpegQuality": 75
      }
    }
  }
}
```

`maxBytes` limits the base64-encoded payload. Omitted resize fields use conservative defaults of 2000 by 2000 pixels, 4.5 MiB encoded, and JPEG quality 80. Images are encoded once; changing models does not rewrite historical images. `inputLimits.maxRequestBytes`, `images.maxPerMessage`, and `images.maxPerRequest` reject requests that exceed the configured limits. Image counts include history and tool results. Built-in chat adapters check the final provider payload after `onPayload`, including merged tool-result messages; the byte check measures its JSON encoding, with binary image sources counted as base64. Provider SDK transport overhead and server limits can still cause a request to be rejected. Reduce attachments or start a new session when a request exceeds a limit.

<a id="prompt-cache-lifetimes"></a>

Use `promptCache` to declare the provider's best-effort cache lifetime in seconds for the `short` or `long` retention tier:

```json
{ "id": "claude-sonnet-5", "promptCache": { "short": 300, "long": 3600 } }
```

Choose the conservative end of any published range. A model without a lifetime for the active tier is not eligible for cache warming. A `modelOverrides` entry can set `inputLimits` or `promptCache` for a built-in or extension model, including a model accessed through a validated proxy. See `cacheWarming`.

### Configure sampling by thinking level

OpenAI-compatible APIs support free-form `samplingParams` model defaults and `samplingParamsByThinkingLevel` overrides. The latter uses Octocode thinking-level keys (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`), not provider values from `thinkingLevelMap`:

```json
{
  "id": "qwen-thinking-model",
  "reasoning": true,
  "samplingParams": {
    "temperature": 1.0,
    "top_p": 0.95
  },
  "samplingParamsByThinkingLevel": {
    "off": {
      "temperature": 0.7,
      "top_p": 0.8
    },
    "high": {
      "top_k": 20
    }
  }
}
```

Octocode first clamps unsupported thinking levels, then merges model `samplingParams`, the effective level's override, and request-level `samplingParams` in that order. Later values win per key. Missing levels inherit the model defaults. `modelOverrides` merges per-level entries per key with the base model. These fields apply only to `openai-completions`, `openai-responses`, and `azure-openai-responses`; other APIs ignore them.

Compatibility settings should describe verified differences in the endpoint's request or response behavior. Do not enable them based only on an endpoint advertising OpenAI or Anthropic compatibility.

## Use classifier models

Classifier models do not chat. They answer typed questions about JSON state: pick one of several choices, answer yes or no, or give a score, each with probabilities. Octocode includes TypeSafe's Jev model from these providers, Cloudflare's Clef and Clef Flash models from Workers AI, and OpenAI's GPT-6 Luna through the [Decisions API](https://developers.openai.com/api/docs/guides/decisions):

| Provider | Model IDs | Authentication |
|---|---|---|
| `typesafe` | `jev-latest` | `TYPESAFE_API_KEY` |
| `openrouter` | `typesafe/jev-1.13`, `~typesafe/jev-latest` | `OPENROUTER_API_KEY` or `/providers` |
| `cloudflare-workers-ai` | `typesafe/jev`, `@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash` | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` |
| `vercel-ai-gateway` | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| `opencode` | `jev-1.13`, `jev-1.13-free` | `OPENCODE_API_KEY` |
| `openai` | `gpt-6-luna` | `OPENAI_API_KEY` |

Chat models on a llama.cpp router are also listed as classifier models.

OpenAI's Decisions API needs an API key. ChatGPT sign-in credentials do not work with it, so `gpt-6-luna` is not listed as available while `openai` is logged in through `/providers`, even when `OPENAI_API_KEY` is set; log out of `openai` to use the key. GPT-6 Luna also judges images passed in `images`; other classifier models return an error for them. The API rejects inputs above 922K tokens, but requests that run longer than about five seconds, currently above roughly 600K input tokens, fail with a gateway timeout.

Classifier models do not appear in `/model`. Extensions call `ctx.modelRegistry.classify()` and can inspect `result.usage` when the provider reports it. [Virtual models](virtual-models.md#route-requests) can use classifiers to route requests; see the `jev-router.ts` example. There is no built-in script executor exposing classifier calls to the conversational model.

## Use image models

Image models generate images from a prompt and optional input images. Octocode lists OpenRouter's image models, such as `google/gemini-2.5-flash-image` and `black-forest-labs/flux.2-pro`, under the `openrouter` provider; they use the same `OPENROUTER_API_KEY` or `/providers` credential as its chat models.

Image models do not appear in `/model`. Extensions call `ctx.modelRegistry.generateImages()`. Its `input` accepts text and image blocks; the result contains output image blocks and usage when supplied by the provider. Extensions decide how to expose these results through a native tool.

## Add a custom provider

Use an extension when the provider needs custom streaming, model discovery, or authentication behavior. See [Custom Providers](custom-provider.md) for the extension workflow.

## Troubleshooting

### A model does not appear

Confirm that its provider has usable authentication. Custom models can load from `models.json` but remain unavailable in `/model` until Octocode can resolve credentials. For llama.cpp, only models currently loaded by the router appear.

### Authentication works in one shell only

Check whether the key came from an environment variable rather than `auth.json`. Environment variables must be present in the process that starts Octocode.

### Sign-in opens a browser on a remote machine

Complete the provider's headless authentication flow when available. Some providers let you paste the final redirect URL or authorization code back into Octocode. See [Authenticate interactively](providers.md#authenticate-interactively).

### A compatible endpoint rejects requests

Check its API type and compatibility settings in `models.json`. The upstream server must support the corresponding request fields and behavior.

For editor validation, point `$schema` at the absolute path of the [packaged models schema](../schemas/models.schema.json) in your installation.
