# Classification

Part of the [`@octocodeai/octocode-ai` guide](../README.md).

Classifier models consume structured JSON state, and optionally images, and answer one or more typed questions. They do not use chat or image-generation APIs. TypeSafe's Jev model, Cloudflare's Clef models, and OpenAI's GPT-6 Luna are available from these built-in providers:

| Provider                | Model IDs                                                          | Auth                                             |
| ----------------------- | ------------------------------------------------------------------ | ------------------------------------------------ |
| `typesafe`              | `jev-latest`                                                       | `TYPESAFE_API_KEY`                               |
| `openrouter`            | `typesafe/jev-1.13`, `~typesafe/jev-latest`                        | `OPENROUTER_API_KEY` or OpenRouter OAuth         |
| `cloudflare-workers-ai` | `typesafe/jev`, `@cf/cloudflare/clef`, `@cf/cloudflare/clef-flash` | `CLOUDFLARE_API_KEY` and `CLOUDFLARE_ACCOUNT_ID` |
| `vercel-ai-gateway`     | `typesafe-ai/jev`                                                  | `AI_GATEWAY_API_KEY`                             |
| `opencode`              | `jev-1.13`, `jev-1.13-free`                                        | `OPENCODE_API_KEY`                               |
| `openai`                | `gpt-6-luna`                                                       | `OPENAI_API_KEY`                                 |

```typescript
import { builtinModels } from "@octocodeai/octocode-ai/providers/all";

const models = builtinModels();
const model = models.getModelOfType("classifier", "typesafe", "jev-latest")!;
const result = await models.classify(model, {
	state: { message: "The change works perfectly, thanks." },
	questions: {
		category: {
			type: "choice",
			instructions: "Classify the message.",
			criteria: {
				approval: "The user approves of the result",
				correction: "The user requests a correction",
			},
		},
		satisfaction: {
			type: "score",
			instructions: "Score user satisfaction.",
			criteria: ["dissatisfied", "neutral", "satisfied"],
		},
		approved: {
			type: "bool",
			instructions: "Does the user approve?",
			criteria: { true: "Approval", false: "No approval" },
		},
	},
});

console.log(result.answers);
```

The public contract uses `bool` questions and `{ type: "bool", probability }` answers. The TypeSafe adapter translates those to and from its `noul` wire representation. Like image generation, `classify()` resolves to a result with `stopReason: "error"` instead of rejecting for provider, authentication, or response errors.

When the service reports token counts, `result.usage` carries them with their cost at the model's catalog price, the same `Usage` shape as chat messages. All System One services report token counts; a request that was answered with malformed answers keeps its usage.

`ClassifierOptions.temperature` divides the answer logits by the given value before they are normalized; values above 1 soften the distribution. APIs that cannot apply it, such as System One and OpenAI Decisions, ignore it.

`ClassifierContext.images` holds image blocks (`{ type: "image", data, mimeType }`) judged together with the state. Only models whose `input` includes `"image"` accept them; `classify()` returns an error result for other models.

## OpenAI Decisions

The `openai-decisions` API calls OpenAI's [Decisions API](https://developers.openai.com/api/docs/guides/decisions) (`POST /v1/decisions`). GPT-6 Luna is its only model. The state is sent as JSON text; with images, the input is one user message with the state followed by the images as data URLs (at most 128). `choice` and `score` questions map to the Decisions types of the same name. `bool` questions become `predicate` questions; predicates have no criteria field, so the meanings of true and false are appended to the instructions. If OpenAI refuses to answer a question, the whole result is an error. Usage reports input tokens only, priced at the catalog input rate with OpenAI's long-context multiplier.

The endpoint needs an OpenAI API key; Sign in with ChatGPT credentials are rejected, so the `openai` provider hides `gpt-6-luna` from `getAvailableOfType('classifier')` while it uses OAuth. The API rejects inputs above 922K tokens, but requests that run longer than about five seconds, currently above roughly 600K input tokens, fail with a gateway timeout (504).

## Decision models on llama.cpp

llama.cpp also serves decision models such as Julia-1 or Kev natively through `/v1/systemone`. Since llama.cpp 0.6.0, `GET /models` lists `decisions` in a model's `architecture.output_modalities` for these models. They use the `typesafe-system-one` API with the server's `/v1` URL as `baseUrl` (for example `http://127.0.0.1:8080/v1`); it needs an `apiKey`, which llama.cpp ignores unless it was started with `--api-key`.

Custom providers register classifier models and implementations by API ID:

```typescript
createProvider({
	id: "classifier-service",
	auth,
	models: [model],
	classifiers: {
		"classifier-api": { classify: async (model, context, options) => result },
	},
});
```
