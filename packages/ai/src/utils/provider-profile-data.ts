/**
 * The provider profile table: one entry per provider family, holding the cache facts and the request-format quirks that
 * used to be spread over host and provider-id checks. A model's profile is the one models.json declares (`profile`), else
 * the first entry whose `match` fits the model's provider id or host (`resolveProviderProfile`). Adapters read the
 * resolved facts and let the model's own `compat` win over them.
 *
 * The split: this table holds provider facts (which host honours cache markers, which tier a host verifies, which
 * request fields it rejects). The generated flags (`cache-capability-flags.generated.ts`, shape in
 * `cache-capability-data.ts`) hold model facts (which model ids document explicit mode or 24h retention), and are
 * stamped into `compat` per model; `cache-capabilities.ts` picks the flag table through this table's profile.
 */

import type { OpenAICompletionsCompat, ProviderProfileId } from "../types.ts";
import { isBedrockInferenceHost } from "./provider-host.ts";

/** How a provider id or host selects a profile when a model declares none. */
export interface ProfileMatch {
	/** Exact provider ids. */
	readonly providers?: readonly string[];
	/** Provider id prefixes. */
	readonly providerPrefixes?: readonly string[];
	/** The host or one of its subdomains. */
	readonly domains?: readonly string[];
	/** Exactly this host. */
	readonly hosts?: readonly string[];
	/** Any other host rule. */
	readonly hostTest?: (baseUrl: string) => boolean;
	/** Only models of these APIs match by detection (a declared profile applies to any API). */
	readonly apis?: readonly string[];
	/** Host-bound facts follow the host alone: a provider id on a custom endpoint does not inherit them. */
	readonly hostBound?: true;
}

/** What a profile says about prompt caching. */
export interface ProfileCacheFacts {
	/** Honours Anthropic `cache_control` markers: on every model, or only on ids with one of these prefixes. */
	readonly markers?: "all" | { readonly modelPrefixes: readonly string[] };
	/** The 1h marker tier: on every model, or only on ids with this prefix. */
	readonly longRetention?: true | { readonly modelPrefix: string };
	/** Chat Completions takes no long tier (`always`), or none unless the model sends markers (`unlessMarkers`). */
	readonly noLongRetention?: "always" | "unlessMarkers";
	/** Serves other upstreams too: only ids with this prefix share Anthropic's cache entries; the rest cache on their own. */
	readonly anthropicIdPrefix?: string;
	/** Session-affinity header format the host reads. */
	readonly sessionAffinity?: "openrouter";
	/** Chat Completions `prompt_cache_key` follows caching being on. */
	readonly keyWhenCached?: true;
	/** `prompt_cache_key` is the host's cache group, so a session shards its keys. */
	readonly groupsByPrefix?: true;
	/** Only ids with this prefix get request-level cache fields; every other model caches by itself, with none sent. */
	readonly explicitCacheModelPrefix?: string;
}

/** What a profile says about the request format. */
export interface ProfileQuirks {
	/** Not a plain OpenAI endpoint: no `store`, no `developer` role. */
	readonly nonStandard?: true;
	/** Takes `max_tokens`, not `max_completion_tokens`. */
	readonly maxTokens?: true;
	/** Rejects `reasoning_effort`. */
	readonly noReasoningEffort?: true;
	/** Accepts the `developer` role. */
	readonly developerRole?: true;
	/** Model id prefixes that take the `developer` role although the host does not list it. */
	readonly developerRoleModelPrefixes?: readonly string[];
	readonly thinkingFormat?: NonNullable<OpenAICompletionsCompat["thinkingFormat"]>;
	/** Sends reasoning content back on assistant messages. */
	readonly reasoningContentOnAssistant?: true;
	/** Moonshot's strict tool-schema flavor. */
	readonly moonshotToolSchema?: true;
	/** Longest tool-call id. */
	readonly toolCallIdMaxLength?: number;
	/** Accepts `none` as a reasoning effort when thinking is off. */
	readonly reasoningOffEffort?: "none";
}

export interface ProviderProfile {
	readonly match: ProfileMatch;
	readonly cache?: ProfileCacheFacts;
	readonly quirks?: ProfileQuirks;
}

/** In match order: the first entry that fits wins. */
export const PROVIDER_PROFILES: Readonly<Record<ProviderProfileId, ProviderProfile>> = {
	openrouter: {
		match: { providers: ["openrouter"], hosts: ["openrouter.ai"] },
		// Claude ids only: its Alibaba ids declare their own markers in the catalog compat.
		cache: {
			markers: { modelPrefixes: ["anthropic/", "~anthropic/"] },
			longRetention: { modelPrefix: "anthropic/" },
			sessionAffinity: "openrouter",
		},
		quirks: { thinkingFormat: "openrouter", developerRoleModelPrefixes: ["anthropic/", "openai/"] },
	},
	anthropic: {
		match: { providers: ["anthropic"], hosts: ["api.anthropic.com"], apis: ["anthropic-messages"], hostBound: true },
		cache: { markers: "all", longRetention: true },
	},
	openai: {
		match: { providers: ["openai"], hosts: ["api.openai.com"], hostBound: true },
		cache: { keyWhenCached: true, groupsByPrefix: true, noLongRetention: "unlessMarkers" },
		quirks: { developerRole: true, toolCallIdMaxLength: 40, reasoningOffEffort: "none" },
	},
	bedrock: {
		match: { hostTest: isBedrockInferenceHost },
		cache: { explicitCacheModelPrefix: "openai." },
	},
	vercel: {
		match: { providers: ["vercel-ai-gateway"], hosts: ["ai-gateway.vercel.sh"] },
		cache: { anthropicIdPrefix: "anthropic/" },
	},
	opencode: {
		match: { providers: ["opencode"], domains: ["opencode.ai"], hostBound: true },
		// OpenCode serves Claude through Anthropic's API and bills 1h writes separately.
		cache: { longRetention: true },
		quirks: { nonStandard: true },
	},
	groq: {
		match: { providers: ["groq"], hosts: ["api.groq.com"] },
		quirks: { developerRole: true },
	},
	xiaomi: {
		match: { providerPrefixes: ["xiaomi"], domains: ["xiaomimimo.com"] },
		quirks: { developerRole: true },
	},
	zai: {
		match: { providers: ["zai", "zai-coding-cn"], domains: ["api.z.ai", "open.bigmodel.cn"] },
		quirks: { nonStandard: true, maxTokens: true, noReasoningEffort: true, thinkingFormat: "zai" },
	},
	together: {
		match: { providers: ["together"], domains: ["api.together.ai", "api.together.xyz"] },
		cache: { noLongRetention: "always" },
		quirks: { nonStandard: true, maxTokens: true, noReasoningEffort: true, thinkingFormat: "together" },
	},
	moonshot: {
		match: {
			providers: ["moonshotai", "moonshotai-cn", "kimi-coding"],
			domains: ["api.moonshot.ai", "api.moonshot.cn", "api.kimi.com"],
		},
		quirks: { nonStandard: true, maxTokens: true, noReasoningEffort: true, moonshotToolSchema: true },
	},
	"cloudflare-workers-ai": {
		match: { providers: ["cloudflare-workers-ai"], domains: ["api.cloudflare.com"] },
		cache: { noLongRetention: "always" },
		quirks: { nonStandard: true },
	},
	"cloudflare-ai-gateway": {
		match: { providers: ["cloudflare-ai-gateway"], domains: ["gateway.ai.cloudflare.com"] },
		cache: { noLongRetention: "always" },
		quirks: { nonStandard: true, maxTokens: true, noReasoningEffort: true },
	},
	nvidia: {
		match: { providers: ["nvidia"], domains: ["integrate.api.nvidia.com"] },
		cache: { noLongRetention: "always" },
		quirks: { nonStandard: true, maxTokens: true, noReasoningEffort: true },
	},
	"ant-ling": {
		match: { providers: ["ant-ling"], domains: ["api.ant-ling.com"] },
		cache: { noLongRetention: "always" },
		quirks: { nonStandard: true, maxTokens: true, noReasoningEffort: true, thinkingFormat: "ant-ling" },
	},
	cerebras: {
		match: { providers: ["cerebras"], domains: ["cerebras.ai"] },
		quirks: { nonStandard: true },
	},
	deepseek: {
		match: { providers: ["deepseek"], domains: ["deepseek.com"] },
		quirks: {
			nonStandard: true,
			maxTokens: true,
			thinkingFormat: "deepseek",
			reasoningContentOnAssistant: true,
		},
	},
	xai: {
		match: { providers: ["xai"], domains: ["api.x.ai"] },
		quirks: { nonStandard: true, noReasoningEffort: true },
	},
	chutes: {
		match: { domains: ["chutes.ai"] },
		quirks: { nonStandard: true, maxTokens: true },
	},
};
