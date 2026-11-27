/**
 * Prompt-cache profiles: what each provider family accepts, as data. Adapters build requests from a profile and
 * {@link planCacheMarkers}; none of them hard-codes marker counts, tiers or which layer carries a marker.
 *
 * Layers, in prompt order: tools, then the cached instruction blocks (base, generic session sections, workspace
 * sections), then history. A marker caches everything before it, so one marker per layer end is enough.
 */

/**
 * How a provider caches a prefix: `markers` are Anthropic-style breakpoints, `explicit-breakpoint` is OpenAI's explicit
 * mode, `key` is implicit prefix caching routed by `prompt_cache_key`, `implicit` sends nothing, `none` caches nothing.
 */
type CacheProfileMechanism = "markers" | "explicit-breakpoint" | "key" | "implicit" | "none";

/** When a request carries `prompt_cache_key`: `cached` whenever caching is on, `long` only with long retention. */
export type PromptCacheKeyRule = "cached" | "long" | "never";

export interface CacheProfile {
	id: string;
	mechanism: CacheProfileMechanism;
	/** Most explicit markers one request may carry. */
	maxMarkers: number;
	/** Most tokens a request can cache; undefined where unbounded. Prefixes beyond it must carry no markers. */
	maxCachedTokens?: number;
	/** Layers that accept a marker. */
	markers: { tools: boolean; instructions: boolean; history: boolean };
	/** Marker lifetime tiers; `long` is absent where the provider takes only the default tier. */
	ttl: { default: string; long?: string };
	/** The key rule for `prompt_cache_key`. */
	key: PromptCacheKeyRule;
	/** Request-level retention (`prompt_cache_retention`) sent with long retention, where the provider takes it. */
	extendedRetention?: "24h";
	/** The provider page the entry comes from. */
	source: string;
}

const OPENAI_DOC = "https://developers.openai.com/api/docs/guides/prompt-caching";
const BEDROCK_DOC = "https://docs.aws.amazon.com/bedrock/latest/userguide/prompt-caching.html";

/** Anthropic Messages API and Bedrock Claude: tools, system and messages take markers; four per request. */
const ANTHROPIC_MARKERS = {
	mechanism: "markers",
	maxMarkers: 4,
	markers: { tools: true, instructions: true, history: true },
	ttl: { default: "5m", long: "1h" },
	key: "never",
} as const;

export const CACHE_PROFILES = {
	anthropic: {
		id: "anthropic",
		...ANTHROPIC_MARKERS,
		source: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
	},
	bedrockClaude: { id: "bedrock-claude", ...ANTHROPIC_MARKERS, source: BEDROCK_DOC },
	/** Nova 2 Lite, Pro, Lite and Micro: system and messages only, 5 minutes, at most 20K cached tokens. */
	bedrockNova: {
		id: "bedrock-nova",
		mechanism: "markers",
		maxMarkers: 4,
		maxCachedTokens: 20_000,
		markers: { tools: false, instructions: true, history: true },
		ttl: { default: "5m" },
		key: "never",
		source: BEDROCK_DOC,
	},
	/**
	 * Bedrock models outside the explicit-caching table (Z.AI GLM, Qwen, Kimi, DeepSeek and others): the page lists no
	 * explicit controls for them, so no marker is sent; any implicit reuse is the host's and is reported only where it
	 * bills it.
	 */
	bedrockOther: {
		id: "bedrock-other",
		mechanism: "implicit",
		maxMarkers: 0,
		markers: { tools: false, instructions: false, history: false },
		ttl: { default: "5m" },
		key: "never",
		source: BEDROCK_DOC,
	},
	/**
	 * OpenAI Responses and Chat Completions on OpenAI-style hosts: implicit prefix caching of 1024 tokens or more, routed
	 * by `prompt_cache_key`; `prompt_cache_retention: "24h"` extends the lifetime (about 30 minutes otherwise).
	 */
	openaiKey: {
		id: "openai-key",
		mechanism: "key",
		maxMarkers: 0,
		markers: { tools: false, instructions: false, history: false },
		ttl: { default: "30m", long: "24h" },
		key: "cached",
		extendedRetention: "24h",
		source: OPENAI_DOC,
	},
	/** GPT-5.6 and later (and opted-in Azure deployments): per-block explicit breakpoints with 30m and 12h lifetimes, four write slots. */
	openaiExplicit: {
		id: "openai-explicit",
		mechanism: "explicit-breakpoint",
		maxMarkers: 4,
		markers: { tools: false, instructions: true, history: true },
		ttl: { default: "30m", long: "12h" },
		key: "cached",
		source: OPENAI_DOC,
	},
	/**
	 * Azure GPT-6 Astra outside explicit mode: `prompt_cache_key` plus a 30m breakpoint on each cached instruction block
	 * (history stays implicit). Microsoft documents 12h only for explicit mode. No `extendedRetention`: GPT-6 and later take
	 * no `prompt_cache_retention` (the AI SDK drops it for them), even where a deployment sets `supportsLongCacheRetention`.
	 */
	azureInstructionBreakpoints: {
		id: "azure-instruction-breakpoints",
		mechanism: "explicit-breakpoint",
		maxMarkers: 4,
		markers: { tools: false, instructions: true, history: false },
		ttl: { default: "30m" },
		key: "cached",
		source: "https://learn.microsoft.com/azure/ai-foundry/openai/how-to/prompt-caching",
	},
	/** Chat Completions hosts whose compat sets `cacheControlFormat: "anthropic"`: Anthropic markers on the wire, four per request. */
	completionsMarkers: {
		id: "completions-markers",
		...ANTHROPIC_MARKERS,
		source: "https://platform.claude.com/docs/en/build-with-claude/prompt-caching",
	},
	/** xAI, Gemini, Mistral and other hosts that cache a stable prefix by themselves: nothing is sent but a byte-stable prefix. */
	implicit: {
		id: "implicit",
		mechanism: "implicit",
		maxMarkers: 0,
		markers: { tools: false, instructions: false, history: false },
		ttl: { default: "5m" },
		key: "never",
		source: "https://ai.google.dev/gemini-api/docs/caching, https://docs.x.ai/docs/guides/caching",
	},
	none: {
		id: "none",
		mechanism: "none",
		maxMarkers: 0,
		markers: { tools: false, instructions: false, history: false },
		ttl: { default: "5m" },
		key: "never",
		source: "",
	},
} as const satisfies Record<string, CacheProfile>;

export interface CacheLayout {
	/** Number of cached instruction blocks (the trailing volatile block is not counted). */
	instructionBlocks: number;
	/** Whether the last cached instruction block holds workspace-specific text (project instructions). */
	workspaceBlock?: boolean;
	/** Whether the instructions are cached at all (retention is not `none`). */
	instructions: boolean;
	/** Whether history is cached. */
	history: boolean;
	/** User and tool-result turns the history can mark (the last one and the one before it); default 2. */
	historyTurns?: number;
	/** Number of tools sent. */
	tools: number;
	/** Whether a tool before the role-variant tools can carry the tools marker. */
	toolBoundary: boolean;
}

export interface CacheMarkerPlan {
	/** Per cached instruction block: whether it carries a marker. */
	blocks: boolean[];
	/** Whether the tools marker is placed (on the boundary tool, else the last tool). */
	tool: boolean;
	/** History markers: 0, 1 (last turn) or 2 (last two turns). */
	history: 0 | 1 | 2;
}

/**
 * Which layers carry a marker, in priority order: the tools, the instruction blocks shared across workspaces, the
 * history (last turn, then the previous turn that anchors the 20-block lookback of a turn with many parallel tool
 * calls), and last the workspace block. The workspace block only saves rewriting project instructions when a new
 * session starts in the same workspace within the lifetime, while a lost lookback anchor rewrites the whole history,
 * so it takes only a slot the others leave. The shared blocks are marked at their end: with a tools boundary marker
 * covering the tools and several shared blocks, the first shared block's marker is dropped (the last covers it), but
 * a lone shared block always keeps its own, so the part before the workspace block is never left unmarked.
 */
export function planCacheMarkers(profile: CacheProfile, layout: CacheLayout): CacheMarkerPlan {
	const none: CacheMarkerPlan = { blocks: Array(layout.instructionBlocks).fill(false), tool: false, history: 0 };
	if (profile.mechanism !== "markers") return none;
	const instructions = layout.instructions && profile.markers.instructions;
	const toolsMarked = layout.instructions && profile.markers.tools && layout.tools > 0;
	const workspaceIndex = layout.workspaceBlock ? layout.instructionBlocks - 1 : -1;
	const shared = layout.instructionBlocks - (workspaceIndex >= 0 ? 1 : 0);
	const dropBase = toolsMarked && layout.toolBoundary && shared > 1;
	const blocks = Array.from(
		{ length: layout.instructionBlocks },
		(_, index) => instructions && !(dropBase && index === 0) && index !== workspaceIndex,
	);
	const tool = toolsMarked && (layout.toolBoundary || shared < 2);
	let room = profile.maxMarkers - blocks.filter(Boolean).length - (tool ? 1 : 0);
	const turns = layout.historyTurns ?? 2;
	const history = layout.history && profile.markers.history ? Math.max(0, Math.min(2, room, turns)) : 0;
	room -= history;
	if (instructions && workspaceIndex >= 0 && room > 0) blocks[workspaceIndex] = true;
	return { blocks, tool, history: history as 0 | 1 | 2 };
}

/** Messages after the leading system messages that are not the assistant's: the turns a history marker can sit on. */
export function countHistoryTurns(messages: readonly { role: string }[]): number {
	const start = messages.findIndex((message) => message.role !== "system");
	return start < 0 ? 0 : messages.slice(start).filter((message) => message.role !== "assistant").length;
}
