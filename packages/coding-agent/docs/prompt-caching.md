# Prompt caching

Octocode keeps reusable instructions longer than growing conversation history when the selected API supports separate cache boundaries.

## Provider configuration

Use `/providers` to enter a key through the existing secret input. For environment-based authentication, set the variable for the provider you use; never put keys in prompts.

| Provider | Provider ID | API-key variable | Instruction / history policy |
|---|---|---|---|
| OpenAI | `openai` | `OPENAI_API_KEY` | 12h / implicit 30m on models declaring explicit prompt-cache support |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | 1h / 5m where long retention is supported |
| Grok | `xai` | `XAI_API_KEY` | Automatic provider-managed caching; no configurable TTL is assumed |
| OpenCode | `opencode`, `opencode-go` | `OPENCODE_API_KEY` | Claude: 1h instructions and 5m history, with Anthropic lifetimes declared for warming; other Anthropic-protocol models: 5m markers without `ttl`; Responses: `prompt_cache_key` and session headers, no TTL fields; Chat Completions and Google: session-routed implicit caching. Every request carries a stable `x-opencode-session` |

OpenCode dispatches each model through its catalog API: Anthropic Messages, OpenAI Responses, Chat Completions or Google. An OpenAI-compatible endpoint alone does not establish support for 12h fields. Custom models can declare capabilities in `models.json`; only enable capabilities the endpoint actually supports. Amazon Bedrock Claude models send one-hour cache points for long retention; set `compat.supportsLongCacheRetention: false` on a Bedrock model whose region or profile rejects the `ttl` field.

Official references: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [Grok caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices), [OpenCode models and endpoints](https://opencode.ai/v2/docs/console/models/), [OpenCode Go](https://opencode.ai/v2/docs/console/go/).

### Retention per layer

The two layers are *instructions* (tools plus the leading system prompt) and *history* (the messages). The defaults are long instructions and short history. What each choice becomes on the wire:

| Provider | Instructions | History | Notes |
|---|---|---|---|
| Anthropic, Bedrock Claude, OpenRouter Claude | `ttl: "1h"` (2× write) for `long`, 5m (1.25×) for `short` | 5m, or 1h for `long` | 1h is Anthropic's maximum; it pays off once a session idles longer than 5 minutes |
| OpenAI GPT-5.6 and later (explicit mode) | 12h (2.5× write) for `long`, 30m for `short` | implicit 30m; `long` requests 12h | No 1h tier exists. `none` for both layers sends explicit mode with no breakpoint: no caching at all, not even the automatic cache |
| Older OpenAI models | Provider default; `24h` when `long` and the endpoint supports it | same | Implicit caching only: there is no separate instruction lifetime |
| Azure OpenAI, Codex, Mistral | Provider-managed | same | A routing key is sent unless history is `none`; the retention preference is ignored |
| xAI Grok | Automatic | same | No TTL is exposed; the routing key or `x-grok-conv-id` is sent |
| Google Gemini | Implicit | same | No cache field is sent; explicit caches cannot hold request-time tools |
| Other OpenAI-compatible endpoints | Provider-managed | same | The routing key goes out with `long` where the endpoint supports it |

`/cache` reports the same mapping for the active model, including "no caching at all" for explicit OpenAI `none`, the 24h tier on older OpenAI models, and "provider-managed" for the providers above. It states what Octocode sends; the provider's cached-token usage fields remain the only proof of a hit.

### OpenCode model APIs

Use `/providers` for `opencode` or `opencode-go`, or set `OPENCODE_API_KEY`, then select an available model with `/model`. The bundled catalog supplies the model definitions; there is no need to copy them into `models.json`. Octocode runs its own agent, tools and skills while OpenCode handles model inference.

Requests use the protocol-specific OpenCode endpoints and carry Octocode's user agent and a stable conversation ID. Resuming a conversation preserves its routing identity; a different model or changed prefix can still miss cache. Explicit custom endpoints remain supported. Do not enable OpenAI-specific cache fields merely because an OpenCode model uses an OpenAI-compatible protocol.

The installed Octocode research tools are available through MCP and the CLI. Keep one configured `octocode` MCP server: shared project configuration takes precedence over automatic registration. All public Octocode skills ship with the installed research package and load through the existing skill discovery system, including `.agents/skills`; their full instructions are loaded on demand. See [MCP configuration](mcp.md) and [skills](skills.md) for precedence and controls.

As documented on 2026-10-21, Anthropic's maximum selectable duration is 1 hour; 1h writes cost 2× base input and 5m writes cost 1.25×. OpenAI's supported explicit writes last 12h or 30m and cost 2.5× or 1.25× base input respectively, with a 1,024-token minimum. Longer writes are most useful when their stable prefix will be reused. These API controls do not imply unlimited application retention.

## Recommended configurations

Use `/settings` to save instruction and history retention, or add these fields to global or trusted project `settings.json`:

```json
{
  "instructionCacheRetention": "long",
  "cacheRetention": "short"
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

Priority, highest first: request options, environment, model override, model definition, provider, session overrides, trusted project settings, global settings, application defaults. At each level, `cacheRetention` controls both layers unless that level also supplies `instructionCacheRetention`. An instruction-only value changes only instructions. Effective history `none` disables optional writes for both layers. Settings keep `short` instructions with `long` history as configured. Anthropic Messages, Bedrock Converse and Anthropic-format chat completions require 1h entries before 5m ones, so those adapters send that history at 5m and `/cache` says so; OpenAI Responses sends it as configured (a 12h history breakpoint after 30m instructions). Invalid values are rejected without echoing their contents.

`/status` shows the requested preferences, their sources, effective durations, and unsupported-policy fallbacks. Changing a direct provider's endpoint clears its direct-only cache capabilities; explicitly declare verified `compat` capabilities for a proxy. Remote catalog refresh uses the same capability rules as the bundled catalog. Unknown models remain selectable with conservative request fields.

Octocode preserves Pi fallback configuration: a provider configured in Octocode takes precedence over the same provider in Pi; those provider entries are not merged across files. An explicit configuration home disables fallback. Subagents inherit the parent's resolved retention pair, including when their working directory changes.

The default for new Octocode sessions and subagents is long instructions with short history. Choose this when the same instructions are reused across tasks or idle gaps:

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

The leading system instructions become an explicit OpenAI content block; history remains implicit. Anthropic, Bedrock Converse and OpenRouter's Anthropic-format chat completions place the instruction retention on the initial tools/system breakpoint and the history retention on the final eligible history block. Anthropic Messages also marks the previous request's tail (the last eligible block before the final assistant turn) with the history retention when a breakpoint slot is free, so a long assistant turn does not push the last cache write past Anthropic's 20-block lookback; OAuth requests mark only the last system block, so they keep that slot. Bedrock Converse places the same lookback cache point when one of its four points is free. Instructions retain their roles and ordering. Long history behind short instructions is sent at 5m on these adapters instead of failing. OpenRouter's Alibaba models that its documentation says need explicit breakpoints (`qwen/qwen3-max`, `qwen/qwen-plus`, `qwen/qwen3.6-plus`, `qwen/qwen3-coder-plus`, `qwen/qwen3-coder-flash`, `deepseek/deepseek-v3.2`) use the same format with the fixed 5-minute lifetime. OpenAI-compatible chat completions send `prompt_cache_retention: "24h"` only to `api.openai.com` or to a model whose compat sets `supportsLongCacheRetention: true`. After Anthropic rejects preferred strict tools for a model, endpoint and tool set, later requests in the process send the downgraded tools directly. Azure Responses, Google and Mistral caching is provider-managed and ignores the instruction preference.

Stable base instructions, initial project context, and tool definitions keep one order for the life of a prefix. Within a session the order of the declared tool list changes only when MCP tools are added or removed: built-in and extension tools keep the order they were given, and MCP tools follow them sorted by namespace and then name, so a late connection or a `tool_search` load inserts its tools at their sorted position. Across sessions the same configuration declares the same order, because connection timing no longer decides it; sibling sessions and subagents of one profile therefore build the same tool array. On transports with native tool loading (the model's `supportsMidConvoSystemMessages` plus a tool-change or tool-addition capability), a loaded tool is sent as a mid-conversation addition and the cached prefix is untouched; elsewhere one load rewrites the tool list once, and the cache rebuilds from the new list.

Subsequent system-prompt changes are incremental conversation updates rather than rewrites of the initial prefix on models that accept mid-conversation system messages. Adapters without them (Bedrock, Google, and models without `supportsMidConvoSystemMessages`) keep the leading system prompt byte-identical and send each update as a marked user message just before the next assistant turn, so an update does not rewrite the cached prompt prefix; only a tool change alters the top-level tool list. Mistral's native API rejects a user turn after a tool result, so there an update is held and merged into the next user message instead of rewriting the leading prompt. Child identity belongs to the child task. Changed initial project context, skills or tools still changes the prefix; the application does not reorder content to manufacture a cache hit.

An isolated subagent (`isolate: true`) runs in its own git worktree, but its system prompt keeps the working directory and the `AGENTS.md` paths of the main checkout, so every isolated child of one profile builds a byte-identical leading prompt. The child's task names its real worktree. Tools, permissions and file access use the real worktree directory; only the prompt text names the main checkout.

### Second instruction block

The leading system prompt can go out as two instruction blocks, each with its own breakpoint and the instruction retention. The first block holds the sections that depend only on the tool set (preamble, tools, rules, docs). The second starts at the first section after `docs` that is present (`addendum`, `project_context`, `skills`, `cwd`, then custom sections such as `octocode`) and holds that section and every later one. Sessions and subagents that share a tool set but differ in project context then still read the first block from cache. The two blocks concatenate to exactly the single-block prompt.

Octocode sends the boundary as the `instructionCacheBoundary` request option. Adapters use it only where a breakpoint is free: Anthropic gives the second block the slot of the tools-only marker, because the first block's marker already covers the tools that precede it, so four breakpoints still suffice; Bedrock adds a second system cache point; OpenRouter's Anthropic-format requests split only when a slot remains; OpenAI explicit mode marks both blocks within its four-write limit. Other adapters ignore it. A forced prompt (set by an extension through `before_agent_start`) has no sections and is never split. Set `OCTOCODE_INSTRUCTION_CACHE_SPLIT=off` to send one block, as before; a request that already carries `instructionCacheBoundary` keeps its value.

The native [instruction ownership guide](instructions.md) documents the common policy, subagent roles, user additions and task overlays.

MCP connections also cache validated server instructions and tool metadata in memory. Stable descriptions and input schemas reuse their definitions; reconnects validate the catalog before restoring tools. This is separate from provider prompt caching. See [MCP catalog caching](mcp.md#catalog-caching) for invalidation and lifetime.

Cache hits require matching eligible prefixes and the provider's minimum length. Different profiles, tool sets, project context or instructions can legitimately miss. There is no guarantee of sharing across sibling sessions or models. With a single lifetime, warming refreshes before that lifetime ends and prices a miss as the whole cached prompt. With layered lifetimes (the default long instructions and short history), it refreshes before the history entry expires and prices a miss as the history alone: it subtracts an upper-bound estimate of the system prompt and tool declarations, which stay readable from their longer-lived entry. Over-estimating that prefix errs toward not refreshing.

Usage keeps aggregate `cacheWrite` and adds optional `cacheWrite12h`, alongside existing `cacheWrite1h`. Cost calculation counts each token once and preserves model pricing tiers. No split reported means the existing catalog write rate applies. A 1h write costs twice the input rate and a 12h write 2.5 times it; a model whose catalog has no cache-write rate (OpenAI before explicit caching) pays no long-write premium either. Actual cache savings and live-provider acceptance must be measured with the user's workload; mock tests verify transport and serialization, not cache hit rates.

Token costs are provider-specific catalog estimates. Cached input contributes to long-context thresholds, and served OpenAI service tiers can change rates. Subscription allowances, credits, regional premiums and time-based cache-storage charges are not fully represented. See [model selection](models.md#select-a-model) for the metadata shown in the picker.

A bounded live OpenAI check on 2026-10-21 used the catalog's `gpt-5.6-luna`: the first request reported 1,769 tokens written with a 12h lifetime, and an immediate repeat reported 1,776 cached tokens read. The two requests cost approximately $0.000935 by catalog pricing. This confirms accepted controls and immediate reuse, not a measured 12-hour idle hit. Anthropic, Grok and OpenCode were checked against docs and offline adapter tests, not live credentials.


### Refresh controls and measurements

`cacheWarming` controls the existing refresh loop: `off`, `streaming` (during an active run), or `idle` (also while waiting for the user). Active subagents and headless runs retain the same economic and cancellation checks as the main agent; they never refresh after becoming idle. Unknown lifetimes, short instructions before long history, incompatible thinking settings, changed request context, refresh failures and zero cache reads stop or prevent refreshes. No paid startup probe is sent.

Refresh estimates use the last request's reported cached portion and include the uncached tail's cost. They are estimates, not guaranteed savings. Grok Chat Completions uses `x-grok-conv-id` for session affinity; Responses uses its protocol's cache key. Cache-off omits generated affinity data, although a provider can still cache implicitly.

Bedrock reasoning refreshes are disabled because their thinking budget can expand a nominal one-token request. A refresh that finishes after cancellation or a session switch still records any returned usage in its originating session. Failed compaction attempts and fallback requests are also recorded individually; rejecting their text does not erase their reported cost. Missing provider usage cannot be reconstructed by this accounting.

`/status` shows conversation cache hits separately from recorded refresh requests and costs. SDK and RPC session statistics expose `cache` groups for `conversation`, `warming`, `compaction`, `branchSummary`, `tools`, and `other`. Each group includes recorded usage entries, prompt tokens, cache reads/writes, token-weighted `hitRate`, and calculated cost. `hitRate` is null without input usage. Tool usage may aggregate child calls and stays separate from the parent's conversation; inspect a child's session for its own conversation rate. Compaction and branch summaries likewise do not inflate conversation hits. Inferred cache re-billing is labelled as an estimate.

With `showCacheMissNotices`, the transcript names the cache area each counted miss re-billed and its likely cause. A miss is counted when more than 1,024 prompt tokens of the previous request on the current branch were not read back; the first request after a compaction or branch summary is not compared. A notice appears for a counted miss of at least 20,000 tokens or $0.10. `History cache miss` means the request still read a cached prefix (normally the instructions) and re-billed the history after it; `Full cache miss` means nothing was read, so the instructions were re-billed too. The cause is `after model switch` (the provider-reported model changed), `after instruction or tool update` (a system prompt or tool-declaration update entered the conversation since the previous request), or `after Nm idle` when the gap outlasted the history lifetime of the current cache settings (5 minutes when unknown). Compaction and branch-summary cost notices add how many tokens the summary read from cache: a summary that shared the session's prefix reads it, a standalone summary reads nothing.
