# Prompt caching

Octocode keeps reusable instructions longer than growing conversation history when the selected API supports separate cache boundaries.

## Provider configuration

Use `/login` to enter a key through the existing secret input. For environment-based authentication, set the variable for the provider you use; never put keys in prompts.

| Provider  | Provider ID               | API-key variable    | Instruction / history policy                                                                                                                                                                                                                                                                                                          |
| --------- | ------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenAI    | `openai`                  | `OPENAI_API_KEY`    | 12h / implicit 30m on models declaring explicit prompt-cache support                                                                                                                                                                                                                                                                  |
| Anthropic | `anthropic`               | `ANTHROPIC_API_KEY` | 1h / 5m where long retention is supported                                                                                                                                                                                                                                                                                             |
| Grok      | `xai`                     | `XAI_API_KEY`       | Automatic provider-managed caching; no configurable TTL is assumed                                                                                                                                                                                                                                                                    |
| OpenCode  | `opencode`, `opencode-go` | `OPENCODE_API_KEY`  | Claude: 1h instructions and 5m history, with Anthropic lifetimes declared for warming; other Anthropic-protocol models: 5m markers without `ttl`; Responses: `prompt_cache_key` and session headers, no TTL fields; Chat Completions and Google: session-routed implicit caching. Every request carries a stable `x-opencode-session` |

OpenCode dispatches each model through its catalog API: Anthropic Messages, OpenAI Responses, Chat Completions or Google. An OpenAI-compatible endpoint alone does not establish support for 12h fields. Custom models can declare capabilities in `models.json`; only enable capabilities the endpoint actually supports. Amazon Bedrock Claude models send one-hour cache points for long retention; set `compat.supportsLongCacheRetention: false` on a Bedrock model whose region or profile rejects the `ttl` field.

Official references: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [Grok caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices), [OpenCode models and endpoints](https://opencode.ai/v2/docs/console/models/), [OpenCode Go](https://opencode.ai/v2/docs/console/go/).

### Retention per layer

The two layers are _instructions_ (tools plus the leading system prompt) and _history_ (the messages). Both default to long. What each choice becomes on the wire:

| Provider                                     | Instructions                                                     | History                           | Notes                                                                                                                                                                                                                 |
| -------------------------------------------- | ---------------------------------------------------------------- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Anthropic, Bedrock Claude, OpenRouter Claude | `ttl: "1h"` (2× write) for `long`, 5m (1.25×) for `short`        | 5m, or 1h for `long`              | 1h is Anthropic's maximum; it pays off once a session idles longer than 5 minutes                                                                                                                                     |
| OpenAI GPT-5.6 and later (explicit mode)     | 12h (2.5× write) for `long`, 30m for `short`                     | implicit 30m; `long` requests 12h | No 1h tier exists. `none` for both layers sends explicit mode with no breakpoint: no caching at all, not even the automatic cache                                                                                     |
| Older OpenAI models                          | Provider default; `24h` when `long` and the endpoint supports it | same                              | Implicit caching only: there is no separate instruction lifetime                                                                                                                                                      |
| Azure OpenAI, Codex, Mistral                 | Provider-managed                                                 | same                              | A routing key is sent unless history is `none`; the retention preference is ignored                                                                                                                                   |
| xAI Grok                                     | Automatic                                                        | same                              | No TTL is exposed; the routing key or `x-grok-conv-id` is sent                                                                                                                                                        |
| Google Gemini                                | Implicit                                                         | same                              | No cache field is sent; explicit caches cannot hold request-time tools. Through OpenCode, hits need the session header and come in blocks of about 4k tokens, so shorter prompts read nothing (measured October 2026) |
| Other OpenAI-compatible endpoints            | Provider-managed                                                 | same                              | The routing key goes out with `long` where the endpoint supports it                                                                                                                                                   |

`/status` reports the same mapping for the active model under Cache Warming, including "no caching at all" for explicit OpenAI `none`, the 24h tier on older OpenAI models, and "provider-managed" for the providers above. It states what Octocode sends; the provider's cached-token usage fields remain the only proof of a hit.

### OpenCode model APIs

Use `/login` for `opencode` or `opencode-go`, or set `OPENCODE_API_KEY`, then select an available model with `/model`. The bundled catalog supplies the model definitions; there is no need to copy them into `models.json`. Octocode runs its own agent, tools and skills while OpenCode handles model inference.

Requests use the protocol-specific OpenCode endpoints and carry Octocode's user agent and a stable conversation ID. Resuming a conversation preserves its routing identity; a different model or changed prefix can still miss cache. Explicit custom endpoints remain supported. Do not enable OpenAI-specific cache fields merely because an OpenCode model uses an OpenAI-compatible protocol.

The installed Octocode research tools are available through MCP and the CLI. Keep one configured `octocode` MCP server: shared project configuration takes precedence over automatic registration. All public Octocode skills ship with the installed research package and load through the existing skill discovery system, including `.agents/skills`; their full instructions are loaded on demand. See [MCP configuration](mcp.md) and [skills](skills.md) for precedence and controls.

As documented on 2026-10-21, Anthropic's maximum selectable duration is 1 hour; 1h writes cost 2× base input and 5m writes cost 1.25×. OpenAI's supported explicit writes last 12h or 30m and cost 2.5× or 1.25× base input respectively, with a 1,024-token minimum. Longer writes are most useful when their stable prefix will be reused. These API controls do not imply unlimited application retention.

## Recommended configurations

Use `/settings` to save instruction and history retention, or add these fields to global or trusted project `settings.json`:

```json
{
	"instructionCacheRetention": "long",
	"cacheRetention": "long"
}
```

The same optional fields work on a provider, model definition, or `modelOverrides` entry in `models.json`. Built-in models need only their provider credentials, not copied model definitions. For example:

```json
{
	"providers": {
		"anthropic": {
			"apiKey": "$ANTHROPIC_API_KEY",
			"cacheRetention": "long"
		},
		"openai": {
			"apiKey": "$OPENAI_API_KEY",
			"instructionCacheRetention": "long",
			"cacheRetention": "short"
		}
	}
}
```

Priority, highest first: request options, environment, model override, model definition, provider, session overrides, trusted project settings, global settings, application defaults. At each level, `cacheRetention` controls both layers unless that level also supplies `instructionCacheRetention`. An instruction-only value changes only instructions. Effective history `none` disables optional writes for both layers. Settings keep `short` instructions with `long` history as configured. Anthropic Messages, Bedrock Converse and Anthropic-format chat completions require 1h entries before 5m ones, so those adapters send that history at 5m and `/status` says so; OpenAI Responses sends it as configured (a 12h history breakpoint after 30m instructions). Invalid values are rejected without echoing their contents.

`/status` shows the requested preferences, their sources, effective durations, and unsupported-policy fallbacks. Changing a direct provider's endpoint clears its direct-only cache capabilities; explicitly declare verified `compat` capabilities for a proxy. Remote catalog refresh uses the same capability rules as the bundled catalog. Unknown models remain selectable with conservative request fields.

Octocode preserves Pi fallback configuration: a provider configured in Octocode takes precedence over the same provider in Pi; those provider entries are not merged across files. An explicit configuration home disables fallback. A subagent does not inherit the parent's resolved pair: before it starts, Octocode resolves the pair for the model the child runs on, from the parent's settings (global, trusted project and session overrides), that model's provider and `models.json` entries, and the parent's environment. The child receives the result as `OCTOCODE_CACHE_RETENTION` and `OCTOCODE_INSTRUCTION_CACHE_RETENTION`, which outrank its own settings, including when its working directory changes.

A headless `--print` run that no setting or environment variable gave a retention uses long instructions (the block every run with the same tools shares) over short history, since a one-shot run has no second turn to profit from a one-hour entry. Otherwise the default for new Octocode sessions and subagents is long instructions and long history: after a pause of up to an hour between turns, the provider can still read the unchanged prompt at its cache-read rate when it honors the one-hour lifetime. That lifetime counts from the start of the request that wrote or read the entry, so long replies shorten it, and a byte-identical prefix only enables reuse: it does not prove a hit, retention or what is billed. Long instructions over short history cost less per write when turns follow each other without pauses:

```bash
export OCTOCODE_INSTRUCTION_CACHE_RETENTION=long
export OCTOCODE_CACHE_RETENTION=short
```

For a brief, continuously active run, short writes can cost less:

```bash
export OCTOCODE_INSTRUCTION_CACHE_RETENTION=short
export OCTOCODE_CACHE_RETENTION=short
```

For Anthropic conversations with pauses longer than five minutes, request one hour for both:

```bash
export OCTOCODE_INSTRUCTION_CACHE_RETENTION=long
export OCTOCODE_CACHE_RETENTION=long
```

An explicit existing `OCTOCODE_CACHE_RETENTION` setting applies to both layers unless you separately set instruction retention. Request-level `cacheRetention` likewise applies to both layers unless `instructionCacheRetention` is supplied. `cacheRetention: "none"` overrides the instruction preference in every adapter that places breakpoints; providers with automatic caching may still cache on their own. The same `short` instructions cap on `long` history applies when library callers set only the environment variables.

For library callers, pass these options to `streamSimple` or `completeSimple`:

```ts
{
  cacheRetention: "short",
  instructionCacheRetention: "long",
  sessionId: conversationId,
}
```

The added option is forwarded through simple requests and the agent proxy. Existing `none | short | long` values and model catalogs remain supported. For older OpenAI models, the legacy supported `24h` preference remains separate. On explicit-cache models (GPT-5.6 and later) a `long` history preference requests the 12h tier and `short` leaves the implicit 30m default, so `long` differs from `short`; the instruction option sets the lifetime of the explicit instruction breakpoint. ChatGPT subscription credentials omit these API-only fields.

## Behavior and accounting

OpenAI Responses uses direct HTTP, custom fetch injection, the shared retry policy and the existing semantic stream processor. It no longer constructs an OpenAI SDK client. SDK types for unchanged message structures remain compile-time-only; cache request fields are owned locally. Other API adapters may still use the SDK.

The leading system instructions become an explicit OpenAI content block; history remains implicit. Anthropic, Bedrock Converse and OpenRouter's Anthropic-format chat completions place the instruction retention on the initial tools/system breakpoint and the history retention on the final eligible history block. Anthropic Messages also marks the previous request's tail (the last eligible block before the final assistant turn) with the history retention when a breakpoint slot is free, so a long assistant turn does not push the last cache write past Anthropic's 20-block lookback; OAuth requests leave the added identity block unmarked (the prompt blocks' breakpoints cover it), so they keep that slot. Bedrock Converse places the same lookback cache point when one of its four points is free. Instructions retain their roles and ordering. Long history behind short instructions is sent at 5m on these adapters instead of failing. OpenRouter's Alibaba models that its documentation says need explicit breakpoints (`qwen/qwen3-max`, `qwen/qwen-plus`, `qwen/qwen3.6-plus`, `qwen/qwen3-coder-plus`, `qwen/qwen3-coder-flash`, `deepseek/deepseek-v3.2`) use the same format with the fixed 5-minute lifetime. OpenAI-compatible chat completions send `prompt_cache_retention: "24h"` only to `api.openai.com` or to a model whose compat sets `supportsLongCacheRetention: true`. After Anthropic rejects preferred strict tools for a model, endpoint and tool set, later requests in the process send the downgraded tools directly. Azure Responses, Google and Mistral caching is provider-managed and ignores the instruction preference.

Stable base instructions, initial project context, and tool definitions keep one order for the life of a prefix. Within a session the declared tool list is rewritten whenever the active tool set changes (an MCP tool added, removed or redefined, or any other tool switched on or off): built-in and extension tools keep the order they were given, and the MCP tools declared at the first request follow them sorted by namespace and then name. Across sessions the same configuration at the first request declares the same order, because connection timing does not decide it; sibling sessions and subagents of one profile therefore build the same tool array. Only a model whose compat sets `supportsMidConvoSystemMessages` together with a tool-change or tool-addition flag keeps the prefix (`resolveToolLoadingMode`, `packages/ai/src/utils/tool-loading.ts`). On the Anthropic Messages API that flag is `supportsMidConvoToolChanges`, which the model generator sets for the direct `anthropic` provider only (`packages/ai/scripts/generate-models/anthropic.ts`; OpenCode Zen and GitHub Copilot forward mid-conversation system messages but reject tool changes), so tools added or removed after the first request go out as mid-conversation blocks and the cached prefix is untouched. Responses and Chat Completions models need `supportsAdditionalTools`, `supportsToolSearch` or `supportsMidConvoToolAdditions` instead, and the additions-only modes do not cover a removal. Everywhere else the change rewrites the top-level tool list once, and the cache rebuilds from the new list: a tool added or redefined after the first request goes to the end of that list, not to its sorted position, so that session's order can differ from a fresh session's. The first prompt waits for selected MCP servers ([connections](mcp-reference.md#connections-and-caching)), so such additions are rare.

Subsequent system-prompt changes are incremental conversation updates rather than rewrites of the initial prefix on models that accept mid-conversation system messages. Adapters without them (Bedrock, Google, and models without `supportsMidConvoSystemMessages`) keep the leading system prompt byte-identical and send each update as a marked user message just before the next assistant turn, so an update does not rewrite the cached prompt prefix; only a tool change alters the top-level tool list. The Mistral adapter avoids sending a user turn directly after a tool result (whether the hosted API accepts that role order is unverified), while the changed tools go out at once. An update that changes the prompt and whose first delivery point comes right after a tool result (after a result, between a tool call and its result, or between parallel results; typically an MCP server that connects, changes or drops during a tool loop) is therefore folded into the leading system prompt together with every earlier update, so its text keeps system authority and reaches the model in the same request as the tool list it describes, and no older update follows a newer one. This deliberately changes the cacheable prefix, which can reduce cache reuse for that request (how much a provider still reuses is not measured): the leading prompt is rewritten once per such update and stays the same in later requests. An update elsewhere still travels as a marked user message, and one that changes nothing is held and merged into the next user message. Offline serialization tests cover this; it has not been checked against the live Mistral API. Sending the update as a user message after the tool result would keep the prefix, but it waits for a live check that the hosted API accepts that role order. Child identity belongs to the child task. Changed initial project context, skills or tools still changes the prefix; the application does not reorder content to manufacture a cache hit.

### Subagent prefixes

A child's request is cached in the provider's order: tool list, system prompt, then messages. Its profile and model fix the tool list and the system prompt; its name, parent, scratch folder and skills ride in its task message. When the parent names skills (the task's `skills`, or the profile's `skills:`), the child's prompt has no skills section and its `skill` tool stays declared even with none, so the choice of skills changes only the task. Measured on Haiku (2026-10-29), a sibling with a different skill list wrote 338 tokens and one with `skills: []` wrote 170, against 5,037 and a full 39,000-token rewrite before. A `lean: true` profile is its own prefix with a much shorter tool list and prompt. The launch stagger groups children by profile, model, whether their prompt lists the inherited catalog, and a hash of their tool selection, lean or read-only mode and added MCP servers; foreground and background launches both go through it, and a group counts as warm for the child's resolved cache lifetime (less a tenth), not a fixed four minutes.

An isolated subagent (`isolate: true`) runs in its own git worktree, but its system prompt keeps the working directory and the `AGENTS.md` paths of the main checkout, so every isolated child of one profile builds a byte-identical leading prompt. The child's task names its real worktree. Tools, permissions and file access use the real worktree directory; only the prompt text names the main checkout.

Siblings in one parent session and prefix group receive the same opaque `OCTOCODE_PROMPT_CACHE_KEY`. OpenAI Responses, Codex, Azure Responses, Mistral and supported Chat Completions endpoints use it for `prompt_cache_key`; each child's session headers, WebSocket pool, transcript and cancellation stay separate. The key is replaced when a child is launched, retained for its message-based continuation, and never contains task text or paths. A stable key permits reuse; provider routing, model minimum cache length, expiry and an exact prefix match still determine actual hits. Disabling caching omits the key.

Every child compaction sends the user's interface a start notice and a finished, failed or cancelled notice, including background and resumed runs. Finished notices include the recorded context sizes when available. Counts and billed summary usage remain in the final report. Main-session compactions use the shared application lifecycle events and terminal status indicator.

Each run's `cache` details record conversation request counts, cumulative prompt/read/write tokens and the latest reply's buckets and provider cache-miss reason when supplied. These values update after each completed assistant message and are retained in foreground results and background reports. Live tool rows show the latest request’s reads and writes, expanded finished rows show the conversation rate, and `/agents stats` shows the token-weighted read rate and write volume per profile. Summary, warming and nested-tool usage remain in total spend and do not inflate this conversation rate. After compaction, the changed history normally needs a new cache write; unchanged leading instructions can still be reused. Zero reads on a first or below-minimum prompt alone do not establish a cache failure.

### Second instruction block

The leading system prompt can go out as two instruction blocks, each with its own breakpoint and the instruction retention. The first block holds the sections that depend only on the tools and the install: preamble, tools, rules, docs, and the base sections placed after them, such as `mcps`, one block per MCP server with its file ([agent context](mcp.md#discovery-and-agent-context)). The second starts at the first known section outside the base tier that is present (`addendum`, `project_context`, `skills`, `cwd`, the policy sections `work`, `research`, `delegation`, `safety` and `communication`, a subagent's `role`, then the volatile `environment`, `planning` and `mcp_status`) and holds that section and every later one; `src/core/system-prompt-spec.ts` declares the order and tiers. The policy stays there because its profile list, and a project-defined role, can be project specific. MCP connection state lives in `mcp_status`, last, so a server that connects, fails or drops patches only that small section. A drop or failed reconnect also leaves the server's tool declarations, which come first in the prefix, byte-identical and in place: the tools stay declared, a call made while the server is down fails at once with an error naming its state and the `mcp` restart, and the tools are withdrawn only when the server is stopped, disabled or removed, or a reconnected server no longer offers them (withdrawing or re-adding a tool changes the top-level tool list, so every transport without native mid-conversation tool changes rewrites the cached prefix). Sessions and subagents that share a tool set and MCP servers but differ in project, working directory or date then send an identical first block, MCP files included, which the provider may read at its cache-read rate once an earlier request has written it and before it expires; a request started before a cold prefix has been written cannot reuse that entry. The two blocks concatenate to exactly the single-block prompt.

Native sessions add an `environment` section: platform, shell and the local date, checked at every prompt. A new day changes only that section, which reaches the model as a section update after the unchanged prefix instead of rewriting the prompt the session started with.

Octocode sends the boundary as the `instructionCacheBoundary` request option. Adapters use it only where a breakpoint is free: Anthropic gives the second block the slot of the tools-only marker, because the first block's marker already covers the tools that precede it, so four breakpoints still suffice; Bedrock adds a second system cache point; OpenRouter's Anthropic-format requests split only when a slot remains; OpenAI explicit mode marks both blocks within its four-write limit. Other adapters ignore it. A forced prompt (set by an extension through `before_agent_start`) has no sections and is never split. Set `OCTOCODE_INSTRUCTION_CACHE_SPLIT=off` to send one block, as before; a request that already carries `instructionCacheBoundary` keeps its value.

The native [instruction ownership guide](instructions.md) documents the common policy, subagent roles, user additions and task overlays.

MCP connections also cache validated server instructions and tool metadata in memory. Stable descriptions and input schemas reuse their definitions; reconnects validate the catalog before restoring tools. This is separate from provider prompt caching. See [MCP catalog caching](mcp.md#catalog-caching) for invalidation and lifetime.

Cache hits require matching eligible prefixes and the provider's minimum length. Different profiles, tool sets, project context or instructions can legitimately miss. There is no guarantee of sharing across sibling sessions or models. With a single lifetime, warming refreshes before that lifetime ends and prices a miss as the whole cached prompt. With layered lifetimes (long instructions over short history), it refreshes before the history entry expires and prices a miss as the history alone: it subtracts an upper-bound estimate of the system prompt and tool declarations, which stay readable from their longer-lived entry. Over-estimating that prefix errs toward not refreshing.

Usage keeps aggregate `cacheWrite` and adds optional `cacheWrite12h`, alongside existing `cacheWrite1h`. Cost calculation counts each token once and preserves model pricing tiers. No split reported means the existing catalog write rate applies. A 1h write costs twice the input rate and a 12h write 2.5 times it; a model whose catalog has no cache-write rate (OpenAI before explicit caching) pays no long-write premium either. Actual cache savings and live-provider acceptance must be measured with the user's workload; mock tests verify transport and serialization, not cache hit rates.

Token costs are provider-specific catalog estimates. Cached input contributes to long-context thresholds, and served OpenAI service tiers can change rates. Subscription allowances, credits, regional premiums and time-based cache-storage charges are not fully represented. See [model selection](models.md#select-a-model) for the metadata shown in the picker.

A bounded live OpenAI check on 2026-10-21 used the catalog's `gpt-5.6-luna`: the first request reported 1,769 tokens written with a 12h lifetime, and an immediate repeat reported 1,776 cached tokens read. The two requests cost approximately $0.000935 by catalog pricing. This confirms accepted controls and immediate reuse, not a measured 12-hour idle hit. Anthropic, Grok and OpenCode were checked against docs and offline adapter tests, not live credentials.

### Provider-reported miss reasons

Set `OCTOCODE_CACHE_DIAGNOSTICS=on` (also `1` or `true`) to ask the Anthropic API why a request could not reuse the previous request's prefix. Every request then carries `diagnostics.previous_message_id` (the id of the conversation's previous Anthropic reply, `null` on the first request), and the API reports the earliest divergence: `model_changed`, `system_changed`, `tools_changed` or `messages_changed`, with the approximate input tokens that would have been read. The reply records it as a `cache_miss` diagnostic, and a counted miss in the transcript and `/status` then reads `History cache miss: provider reports tools changed` instead of an inferred cause. `previous_message_not_found`, `unavailable` and a still-pending comparison record nothing.

The field is sent only to `api.anthropic.com` with the `anthropic` provider; Bedrock, Vertex, OpenCode and other gateways never receive it, because the feature exists on the Claude API alone and a gateway may reject an unknown body field. It is off by default and has been verified against the SDK types and the [documented response format](https://platform.claude.com/docs/en/build-with-claude/cache-diagnostics), not against a live account. Fingerprints are retained only briefly, so the comparison is useful between closely spaced requests. A miss after an idle gap longer than the cache lifetime reports no divergence (the request matched; the entry had expired), which separates an expired entry from a changed prefix.

### Refresh controls and measurements

`cacheWarming` controls the existing refresh loop: `off`, `streaming` (during an active run), or `idle` (the default; also while waiting for the user). An idle refresh is sent only when its expected saving reaches $0.05: the chance of a real request before the history expires, times the miss cost, less the refresh cost (a read of the cached prompt). That chance is 15% by default and 50% while the user is visibly at the terminal, meaning the terminal reports focus or a key was pressed in the last two minutes; both values are estimates, not measurements. A miss is priced at the tier the request wrote its history at. An idle run may refresh until the later of thirty minutes and one cache lifetime after it started, so a one-hour entry gets exactly one idle refresh when the gate says it pays. Active subagents and headless runs retain the same economic and cancellation checks as the main agent; they never refresh after becoming idle. Unknown lifetimes, short instructions before long history, incompatible thinking settings, changed request context, refresh failures and zero cache reads stop or prevent refreshes. No paid startup probe is sent.

Refresh estimates use the last request's reported cached portion and include the uncached tail's cost. They are estimates, not guaranteed savings. Grok Chat Completions uses `x-grok-conv-id` for session affinity; Responses uses its protocol's cache key. Cache-off omits generated affinity data, although a provider can still cache implicitly.

Bedrock reasoning refreshes are disabled because their thinking budget can expand a nominal one-token request. A refresh that finishes after cancellation or a session switch still records any returned usage in its originating session. Failed compaction attempts and fallback requests are also recorded individually; rejecting their text does not erase their reported cost. Missing provider usage cannot be reconstructed by this accounting.

`/status` shows conversation cache hits separately from recorded refresh requests and costs. RPC session statistics (`get_session_stats`) expose `cache` groups for `conversation`, `warming`, `compaction`, `branchSummary`, `tools`, and `other`. Each group includes recorded usage entries, prompt tokens, cache reads/writes, token-weighted `hitRate`, and calculated cost. `hitRate` is null without input usage. Tool usage may aggregate child calls and stays separate from the parent's conversation; inspect a child's session for its own conversation rate. Compaction and branch summaries likewise do not inflate conversation hits. Inferred cache re-billing is labelled as an estimate.

With `showCacheMissNotices`, the transcript names the cache area each counted miss re-billed and its likely cause. A miss is counted when more than 1,024 prompt tokens of the previous request on the current branch were not read back; the first request after a compaction or branch summary is not compared. A notice appears for a counted miss of at least 20,000 tokens or $0.10. `History cache miss` means the request still read a cached prefix (normally the instructions) and re-billed the history after it; `Full cache miss` means nothing was read, so the instructions were re-billed too. The cause is `after model switch` (the provider-reported model changed), `after instruction or tool update` (a system prompt or tool-declaration update entered the conversation since the previous request), or `after Nm idle` when the gap outlasted the history lifetime of the current cache settings (5 minutes when unknown). While `cacheWarming` is not `idle`, an idle miss also names that setting and what one refresh would have cost. Compaction and branch-summary cost notices add how many tokens the summary read from cache: a summary that shared the session's prefix reads it; a standalone summary serializes the conversation under its own system prompt, so it reads little or nothing although it carries the session's routing id and cache preferences.
