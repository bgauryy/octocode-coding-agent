# Prompt caching

Octocode keeps reusable instructions longer than growing conversation history when the selected API supports separate cache boundaries.

## Provider configuration

Use `/login` to enter a key through the existing secret input. For environment-based authentication, set the variable for the provider you use; never put keys in prompts.

| Provider | Provider ID | API-key variable | Instruction / history policy |
|---|---|---|---|
| OpenAI | `openai` | `OPENAI_API_KEY` | 12h / implicit 30m on models declaring explicit prompt-cache support |
| Anthropic | `anthropic` | `ANTHROPIC_API_KEY` | 1h / 5m where long retention is supported |
| Grok | `xai` | `XAI_API_KEY` | Automatic provider-managed caching; no configurable TTL is assumed |
| OpenCode | `opencode`, `opencode-go` | `OPENCODE_API_KEY` | Model-specific API and capabilities; stable `x-opencode-session` routing |

OpenCode dispatches each model through its catalog API: Anthropic Messages, OpenAI Responses, Chat Completions or Google. An OpenAI-compatible endpoint alone does not establish support for 12h fields. Custom models can declare capabilities in `models.json`; only enable capabilities the endpoint actually supports. Amazon Bedrock Claude models send one-hour cache points for long retention; set `compat.supportsLongCacheRetention: false` on a Bedrock model whose region or profile rejects the `ttl` field.

Official references: [OpenAI prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching), [Anthropic prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching), [Grok caching](https://docs.x.ai/developers/advanced-api-usage/prompt-caching/best-practices), [OpenCode models and endpoints](https://opencode.ai/v2/docs/console/models/), [OpenCode Go](https://opencode.ai/v2/docs/console/go/).

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

Priority, highest first: request options, environment, model override, model definition, provider, session overrides, trusted project settings, global settings, application defaults. At each level, `cacheRetention` controls both layers unless that level also supplies `instructionCacheRetention`. An instruction-only value changes only instructions. Effective history `none` disables optional writes for both layers. Instructions precede history and a longer-lived cache breakpoint cannot follow a shorter one, so `short` instructions cap `long` history at `short`; `/cache` shows the source as capped. Invalid values are rejected without echoing their contents.

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

An explicit existing `OCTOCODE_CACHE_RETENTION` setting applies to both layers unless you separately set instruction retention. Request-level `cacheRetention` likewise applies to both layers unless `instructionCacheRetention` is supplied. `cacheRetention: "none"` overrides the instruction preference in the Anthropic and Responses adapters; providers with automatic caching may still cache on their own.

For library callers, pass these options to `streamSimple` or `completeSimple`:

```ts
{
  cacheRetention: "short",
  instructionCacheRetention: "long",
  sessionId: conversationId,
}
```

The added option is forwarded through simple requests and the agent proxy. Existing `none | short | long` values and model catalogs remain supported. For older OpenAI models, the legacy supported `24h` preference remains separate; explicit-cache models retain the old request-level `long` → `30m` mapping. The new instruction option adds the 12h breakpoint. ChatGPT subscription credentials omit these API-only fields.

## Behavior and accounting

OpenAI Responses uses direct HTTP, custom fetch injection, the shared retry policy and the existing semantic stream processor. It no longer constructs an OpenAI SDK client. SDK types for unchanged message structures remain compile-time-only; cache request fields are owned locally. Other API adapters may still use the SDK.

The leading system instructions become an explicit OpenAI content block; history remains implicit. Anthropic places long controls on initial tools/system instructions and a short control on the final eligible history block. Instructions retain their roles and ordering. An early short Anthropic control followed by a long one is rejected locally.

Stable base instructions, initial project context, and tool definitions retain their original ordering. Subsequent system-prompt changes are incremental conversation updates rather than rewrites of the initial prefix. Child identity belongs to the child task. Changed initial project context, skills or tools still changes the prefix; the application does not reorder content to manufacture a cache hit.

The native [instruction ownership guide](instructions.md) documents the common policy, subagent roles, user additions and task overlays.

MCP connections also cache validated server instructions and tool metadata in memory. Stable descriptions and input schemas reuse their definitions; reconnects validate the catalog before restoring tools. This is separate from provider prompt caching. See [MCP catalog caching](mcp.md#catalog-caching) for invalidation and lifetime.

Cache hits require matching eligible prefixes and the provider's minimum length. Different profiles, tool sets, project context or instructions can legitimately miss. There is no guarantee of sharing across sibling sessions or models. No additional cache-warming loop was introduced. Existing whole-prompt warming remains available for a single lifetime; it is inactive for mixed lifetimes because its cost estimate cannot separate the prefixes.

Usage keeps aggregate `cacheWrite` and adds optional `cacheWrite12h`, alongside existing `cacheWrite1h`. Cost calculation counts each token once and preserves model pricing tiers. No split reported means the existing catalog write rate applies. Actual cache savings and live-provider acceptance must be measured with the user's workload; mock tests verify transport and serialization, not cache hit rates.

A bounded live OpenAI check on 2026-10-21 used the catalog's `gpt-5.6-luna`: the first request reported 1,769 tokens written with a 12h lifetime, and an immediate repeat reported 1,776 cached tokens read. The two requests cost approximately $0.000935 by catalog pricing. This confirms accepted controls and immediate reuse, not a measured 12-hour idle hit. Anthropic, Grok and OpenCode were checked against docs and offline adapter tests, not live credentials.


### Refresh controls and measurements

`cacheWarming` controls the existing refresh loop: `off`, `streaming` (during an active run), or `idle` (also while waiting for the user). Active subagents and headless runs retain the same economic and cancellation checks as the main agent; they never refresh after becoming idle. Unknown lifetimes, mixed retention tiers, incompatible thinking settings, changed request context, refresh failures and zero cache reads stop or prevent refreshes. No paid startup probe is sent.

Refresh estimates use the last request's reported cached portion and include the uncached tail's cost. They are estimates, not guaranteed savings. Grok Chat Completions uses `x-grok-conv-id` for session affinity; Responses uses its protocol's cache key. Cache-off omits generated affinity data, although a provider can still cache implicitly.

Bedrock reasoning refreshes are disabled because their thinking budget can expand a nominal one-token request. A refresh that finishes after cancellation or a session switch still records any returned usage in its originating session. Failed compaction attempts and fallback requests are also recorded individually; rejecting their text does not erase their reported cost. Missing provider usage cannot be reconstructed by this accounting.

`/status` shows conversation cache hits separately from recorded refresh requests and costs. SDK and RPC session statistics expose `cache` groups for `conversation`, `warming`, `compaction`, `branchSummary`, `tools`, and `other`. Each group includes recorded usage entries, prompt tokens, cache reads/writes, token-weighted `hitRate`, and calculated cost. `hitRate` is null without input usage. Tool usage may aggregate child calls and stays separate from the parent's conversation; inspect a child's session for its own conversation rate. Compaction and branch summaries likewise do not inflate conversation hits. Inferred cache re-billing is labelled as an estimate.
