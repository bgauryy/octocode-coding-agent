# Virtual Models

> **Removed API.** Octocode no longer supports user code extensions, and the package root exports no extension API. This page describes the extension loader's last behavior and is removed with it.


A virtual model is a selectable model that picks a physical model for each request. Use one to route by task, cost, or conversation state. For example, a router can send quick questions to a small model and hard problems to a large one, while the user selects a single model.

Register virtual models from an extension. They appear in `/model`, `--model`, scoped models, and settings like any other model. A virtual model can be listed under any provider, including one with physical models, such as `openai-codex/auto`.

## Selection and dispatch

A virtual model selects a model and a thinking level. A router maps that pair to a physical pair for each request:

```
selected (virtual model, virtual level)  ->  dispatched (physical model, physical level)
jev/auto:low                             ->  anthropic/claude-sonnet-4-5:high
```

The virtual thinking level is an input to the router. Its meaning is up to the router; it need not correspond to a reasoning budget.

Octocode keeps the two pairs apart:

|             | Selection                                                                                | Dispatch                                                            |
| ----------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Recorded in | `model_change` and `thinking_level_change` entries                                       | Each assistant message: `provider`, `api`, `model`, `thinkingLevel` |
| Visible as  | `ctx.model`, `ctx.thinkingLevel`, `OCTOCODE_MODEL`, `OCTOCODE_REASONING_LEVEL`, `/model` | The assistant message of each response                              |

Providers only receive physical models. Assistant messages name the physical model, so replaying a conversation across different physical models works the same as after a manual model switch. Resuming a session restores the virtual selection from its latest `model_change` entry. If the virtual model is no longer registered, Octocode falls back to the physical model that answered last.

In interactive mode, the built-in footer keeps the selected provider/model and thinking level visible on a coordinator line, for example `Coordinator · thinking high · router/auto`. A separate line shows the latest physical route, such as `Latest route · openai-codex/gpt-5.6-luna · thinking medium`. On narrow terminals the coordinator identity wraps onto a separate model line. `/effort` changes the selected virtual level; the router decides the physical effort. `/status` lists the cost for each physical model.

Context usage uses the limits of the physical model that produced the latest response, even if that response came before switching to the virtual model. Without such a response, it uses the limits declared on the virtual model, if any. Compaction checks the same limits, and again the limits of the model each request is routed to. If that model's context window is too small for the conversation, Octocode compacts before sending the request; the route stays as the router chose it.

`/context` reports those effective limits and their output reserve. `/context size`, `/context <tokens>` and `/context reset` require a physical model selection because a virtual route has no single capacity. A working budget set while a physical model is selected applies when selecting that model directly; it does not override the limits of routes chosen by a virtual model.

## Register a virtual model

```typescript
import type { ExtensionAPI } from "@octocodeai/octocodecode";

export default function (octocode: ExtensionAPI) {
	octocode.registerVirtualModel({
		provider: "router",
		id: "auto",
		name: "Auto",
		thinkingLevels: ["low", "high"],
		route(request, ctx) {
			// Tool follow-ups and retries stay on the model that handled the turn.
			const sticky = request.failed ?? request.previous;
			if (request.reason !== "user" && sticky) {
				return { model: sticky.model, thinkingLevel: sticky.thinkingLevel ?? "medium" };
			}
			const id = request.thinkingLevel === "high" ? "claude-sonnet-4-5" : "claude-haiku-4-5";
			return { model: ctx.modelRegistry.find("anthropic", id)!, thinkingLevel: "medium" };
		},
	});
}
```

- `provider` is the provider the model is listed under. It can be any provider ID. A provider can list several virtual models next to its physical ones. On a physical provider, the virtual model is available when that provider has credentials. Under an ID that no provider uses, it is always available.
- `id` must not be the ID of a physical model of that provider. If a catalog refresh later adds a physical model with the same ID, the virtual model hides it.
- `thinkingLevels` lists the levels offered for selection. It defaults to `["off"]`.
- `contextWindow` and `maxTokens` are shown before the first response. Unset limits are unknown.
- `input` lists the input types offered for selection. It defaults to text and images; physical models without image support receive placeholders.

Registration follows the same queuing and reload rules as `octocode.registerProvider()`. Registering the same provider and ID again replaces the virtual model. `octocode.unregisterVirtualModel(provider, id)` (deprecated and possibly removed in a future release) removes it; `octocode.unregisterProvider()` does not. SDK code can register one without an extension: `modelRuntime.registerVirtualModel(definition)`.

## Route requests

`route(request, ctx)` runs before every request made with the virtual model and returns `{ model, thinkingLevel }`. The model can be any physical model in the catalog whose provider has credentials; look it up with `ctx.modelRegistry`. A virtual model cannot route to another virtual model. Octocode clamps the thinking level to the returned model.

| Field                    | Meaning                                                                                                                                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`, `thinkingLevel` | The selected virtual model and level                                                                                                                                                                                    |
| `reason`                 | Why the request is made, see below                                                                                                                                                                                      |
| `previous`               | Physical model and thinking level of the latest successful response in `messages`                                                                                                                                       |
| `failed`                 | For `retry`: physical model, thinking level, and assistant `message` of the failed request, which `messages` no longer contains. The message carries `stopReason` and `errorMessage`. Absent when routing itself failed |
| `state`                  | Router state last returned on this session branch, see below                                                                                                                                                            |
| `messages`               | The conversation for this request, including system messages                                                                                                                                                            |
| `signal`                 | Abort signal of the request                                                                                                                                                                                             |

| `reason`       | Request                                                                                                                      |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `user`         | First request after a message the user wrote, including steering and follow-up messages                                      |
| `continuation` | Any other request in the agent loop, such as after tool results or extension messages                                        |
| `retry`        | Automatic retry after a failed request, including after compaction for a context overflow                                    |
| `direct`       | Request made outside the agent loop, such as a compaction summary or an extension calling `ctx.modelRegistry.streamSimple()` |

Returning `previous` for `continuation` and `failed` for `retry` keeps prompt caches and thinking signatures valid. Switching models between turns is allowed but loses the prompt cache. A retry can also switch to another model, for example when `failed.message.errorMessage` reports that a provider is overloaded or the context overflowed.

If `route()` throws, or returns a virtual model or a model without credentials, the request ends with an error response.

## Keep routing state

`route()` can return `state` next to the model. Octocode stores it on the session branch and passes it back as `request.state` on later requests. Use it for decisions the transcript does not record, such as classifier results or a routing phase:

```typescript
octocode.registerVirtualModel<{ phase: "plan" | "build" }>({
	provider: "router",
	id: "phased",
	name: "Phased",
	route(request, ctx) {
		const state = request.state ?? { phase: "plan" };
		const id = state.phase === "plan" ? "claude-opus-4-5" : "claude-haiku-4-5";
		return { model: ctx.modelRegistry.find("anthropic", id)!, thinkingLevel: "medium", state };
	},
});
```

- State must be JSON-serializable. Returning `undefined` or `request.state` itself keeps the current state.
- Octocode stores any other returned object as new state, before the request is sent, even when it equals the current state. Return a new object only when the state changes. The state stays stored if the request later fails.
- State follows the session tree, so forks and `/tree` navigation see the state of their branch. It survives compaction.
- `direct` requests have no state, and Octocode ignores state they return.

The transcript already records the selection and every dispatched model, and `ctx.sessionManager.getBranch()` exposes both.

Routers can call other models through `ctx.modelRegistry`, for example `ctx.modelRegistry.classify()` with a classifier model from `ctx.modelRegistry.findOfType("classifier", provider, id)`. The call adds latency before the first token of the turn.

