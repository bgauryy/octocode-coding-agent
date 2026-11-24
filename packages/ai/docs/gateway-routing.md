# Gateway routing and accounting

How Octocode talks to routing gateways: OpenRouter, Vercel AI Gateway and OpenResponses servers.

## OpenRouter cost

OpenRouter returns the billed cost in the response `usage`. Octocode records it instead of a catalog price, so a router model with no catalog price (`openrouter/auto`) reports its real cost.

| Reported by OpenRouter | Octocode records |
| --- | --- |
| `usage.cost` (USD, number or numeric string) | The cost total. Negative, non-finite or non-numeric values are ignored. |
| `usage.is_byok` with `cost_details.upstream_inference_cost` | The fee plus the upstream charge. |
| `cost_details.upstream_inference_prompt_cost` and `..._completions_cost` | The input and output split, when the catalog has no price. |
| Nothing | The catalog token-rate price. |

Token counts (input, output, cache read, cache write) are kept as reported; only the cost fields change. The bucket costs always sum to the total. Other OpenAI-compatible endpoints keep catalog pricing.

## Auto Router controls

`compat.openRouterAutoRouter` applies to `openrouter/auto` and its variants. Auto and Auto Code use the `auto-router` plugin id; Auto Beta uses `auto-beta-router`, whose settings are ignored under the stable id.

| Field | Meaning |
| --- | --- |
| `allowed_models` | Model patterns the router may choose, for example `anthropic/*`. |
| `excluded_models` | Patterns it never chooses. |
| `cost_tier` | `low`, `medium` or `high`. |
| `metadata` | `false` stops the metadata request. |

The request asks for router metadata with `X-OpenRouter-Metadata: enabled`. The assistant message gets an `openrouter-router` diagnostic with the requested model, strategy, attempts, selected endpoint and stage names. Free-form stage data, summaries and prompt-derived text are dropped, and strings are length-limited.

## Vercel AI Gateway

`compat.vercelGatewayRouting` is sent as `providerOptions.gateway` on the Anthropic Messages request (the path Vercel models use) and on Chat Completions requests.

| Field | Meaning |
| --- | --- |
| `only`, `order` | Provider allow list and preference order. |
| `models` | Fallback models. |
| `sort` | `cost`, `ttft` or `tps`. |
| `headquarters` | Provider countries; prefix every code with `!` to exclude. |
| `caching` | `auto` lets the gateway add cache breakpoints. |
| `zeroDataRetention`, `disallowPromptTraining` | Data-handling requirements. |
| `sessionAffinity` | `false` stops provider pinning. |
| `providerTimeouts.byok` | Milliseconds per BYOK provider before failover. |

On both APIs the session id is added as `sessionId` unless caching is off, `sessionAffinity` is `false` or the routing names its own. The model's routing is copied per request.

## OpenResponses

The `openresponses` API runs the OpenAI Responses transport against `{baseUrl}/responses` with the model's credentials, for servers that implement the OpenResponses specification. Requests, streaming events, items and usage follow the Responses contract; messages keep `openresponses` as their API.

Sources: OpenRouter [usage accounting](https://openrouter.ai/docs/cookbook/administration/usage-accounting), [BYOK cost fields](https://openrouter.ai/docs/guides/features/broadcast/otel-collector), [router metadata](https://openrouter.ai/docs/guides/routing/routers/router-metadata) and [Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router); Vercel [provider options](https://vercel.com/docs/ai-gateway/models-and-providers/provider-options) and [Anthropic Messages configuration](https://vercel.com/docs/ai-gateway/sdks-and-apis/anthropic-messages-api/advanced).
