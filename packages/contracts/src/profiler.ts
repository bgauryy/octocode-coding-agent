/**
 * The cache profiler's wire shapes: every agent of a session (the coordinator and its descendants), the requests each
 * sent, and each request's prompt in layers with what the provider served from its prompt cache. The host derives them
 * from session transcripts (exactly where an assistant entry recorded its request layers, estimated otherwise); the
 * page only renders them.
 */

import type { Endpoint, FeedCursor, TrafficDelivery, TrafficDrop, TranscriptRef } from "./team.ts";

/** What a layer of a request is, in the order the provider matched the prompt prefix. */
export const PROFILE_LAYER_KINDS = [
	"tools",
	"system",
	"message",
	"tool-result",
	"notice",
	"steer",
	"interrupt",
	"summary",
] as const;
export type ProfileLayerKind = (typeof PROFILE_LAYER_KINDS)[number];

/**
 * What the provider did with a layer's tokens: read from cache, written to cache, sent uncached, or sent in a prompt
 * shorter than the model's minimum cacheable length (the provider reports zero cache tokens then, which is not a miss).
 */
export const PROFILE_CACHE_STATES = ["cached", "written", "uncached", "too-short"] as const;
export type ProfileCacheState = (typeof PROFILE_CACHE_STATES)[number];

/** Token counts as the provider reported them for one request; `input` excludes cached and written tokens. */
export interface ProfileUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Dollars, when the model's prices are known. */
	cost?: number;
}

export interface ProfileAgent {
	/** The team member id (`tidal-coral`); the session's own agent is the coordinator. */
	id: string;
	parentId?: string;
	/** `main` for the coordinator, the profile name for a subagent, `external` for an agent that exposes only text. */
	role: string;
	model?: string;
	provider?: string;
	status: "idle" | "working";
	/** What it works on. */
	goal?: string;
	/** How its run ended (done, failed, stopped…); set once it ended. Absent while it runs. */
	outcome?: string;
	requests: number;
	totals: ProfileUsage;
	/** cacheRead / (input + cacheRead + cacheWrite) over all requests, 0 to 1; absent before the first request. */
	hitRate?: number;
	/** When its last request finished (epoch ms): with the model's cache lifetime, when its cache goes cold. */
	lastRequestAt?: number;
	/** False for an agent whose requests cannot be read (an external CLI): listed without requests. */
	profiled: boolean;
	/** The context window the agent compacts against, in tokens. Absent when its model is unknown. */
	contextWindow?: number;
	/** Tokens at which auto-compaction triggers (window minus its reserve). Absent when unknown. */
	compactAt?: number;
	/** Tokens in its context as of its latest request (prompt plus that request's output); absent before one and after a compaction with no later request. */
	contextTokens?: number;
	/** The latest request's prompt tokens by layer kind. */
	contextLayers?: { kind: ProfileLayerKind; tokens: number }[];
	/** The latest request's largest layers, at most 5, biggest first. */
	contextTop?: { kind: ProfileLayerKind; label: string; tokens: number }[];
	/** True when the layer split is estimated from sizes rather than recorded per request (the total stays exact). */
	contextEstimated?: boolean;
	/** When it started (epoch ms). */
	startedAt?: number;
	/** When it ended (epoch ms); set with `outcome`. */
	endedAt?: number;
	/** What it is doing now; present only while `status` is "working". */
	activity?: ProfileActivity;
	/** How long its provider keeps the prompt cache warm after a request, in ms: with `lastRequestAt`, when the cache goes cold. */
	cacheTtlMs?: number;
	/** The cache group of its latest request; absent when it recorded none. */
	cacheGroup?: ProfileCacheGroup;
}

export const PROFILE_ACTIVITY_KINDS = ["request", "tool", "wait", "compaction"] as const;

/** What a working agent is doing now, inferred from its transcript tail and team status. */
export interface ProfileActivity {
	kind: (typeof PROFILE_ACTIVITY_KINDS)[number];
	/** The model, the tool name, `permission`, or `reply`; never message text. */
	label: string;
	/** When it began (epoch ms); the page shows the time since, ticking. */
	since: number;
	/** The other agent for a reply wait; `user` for a permission or a question. */
	peer?: string;
	/** Tools in flight, when more than one. */
	count?: number;
}

export interface ProfileLayer {
	kind: ProfileLayerKind;
	/** Short label: the section name, `tools (42)`, `user`, `assistant`, the notice type or the tool name. */
	label: string;
	/** Tokens attributed to the layer (estimated from its size, scaled so a request's layers sum to its input total). */
	tokens: number;
	state: ProfileCacheState;
	/** True when the layer differs from the same position in the agent's previous request. */
	changed: boolean;
	/** True where the request placed a cache breakpoint at the end of this layer. */
	breakpoint?: boolean;
	/** Index of the transcript entry the layer came from, to open it; absent for tools and system blocks. */
	entry?: number;
}

/**
 * The prompt-cache group a child's requests belong to, as the child recorded it. The same `prefix` with a different
 * `key` points at provider routing, a different `prefix` at a prompt or tool difference.
 */
export interface ProfileCacheGroup {
	/** The shared prompt cache key (`OCTOCODE_PROMPT_CACHE_KEY`) the parent gave the child; absent when none was given. */
	key?: string;
	/** 16-hex hash of the system prompt and the active tool declarations. */
	prefix: string;
}

export interface ProfileRequest {
	agentId: string;
	/** 0-based position among the agent's requests; pages continue with `after`. */
	index: number;
	/** When the request finished (epoch ms). */
	at: number;
	durationMs?: number;
	model: string;
	provider?: string;
	usage: ProfileUsage;
	layers: ProfileLayer[];
	/** Index into `layers` of the first layer that changed and broke the cached prefix; absent when the prefix held. */
	firstBreak?: number;
	/** Why the cache missed, as the provider or Octocode's own accounting explains it (`idle past the cache lifetime`). */
	missReason?: string;
	/** The provider's own `cache_miss` reason when it reported one (`tools_changed`), verbatim. */
	providerMissReason?: string;
	/** The cache group in force for the request; absent for an agent that recorded none (the coordinator). */
	cacheGroup?: ProfileCacheGroup;
	/** Milliseconds since the agent's previous request finished. */
	idleMs?: number;
	/** True when the layers were inferred from the transcript instead of recorded from the request that was sent. */
	estimated: boolean;
}

/**
 * What happened on an agent's lane of the timeline. `request` is a model request (detail in `ProfileRequest`), `tool` a
 * tool call's execution, `message` a message between agents (the `peer` is the other side), `wait` time spent
 * blocked (on a permission answer, a reply, a retry backoff, the start of a turn, a reserved path or the user), `idle` a
 * gap with nothing running, `stall` a window in which the agent's event loop was blocked.
 */
export const PROFILE_EVENT_KINDS = [
	"request",
	"tool",
	"message",
	"wait",
	"idle",
	"interrupt",
	"steer",
	"notice",
	"compaction",
	"spawn",
	"exit",
	"permission",
	"stall",
] as const;
export type ProfileEventKind = (typeof PROFILE_EVENT_KINDS)[number];

/**
 * Where a request's or tool call's time went, in milliseconds. A request: `firstToken` (until its first content
 * arrived) and `stream` (the rest). A tool call: `prepare` (argument checks, hooks and the permission decision), `queued`
 * (waiting for the batch schedule), `execute`, `finalize` (result hooks and processing) and `held` (until its result went
 * back with its batch). A phase under a millisecond is absent.
 */
export const PROFILE_PHASES = ["firstToken", "stream", "prepare", "queued", "execute", "finalize", "held"] as const;
export type ProfilePhase = (typeof PROFILE_PHASES)[number];

export interface ProfileEvent {
	/** Stable across polls: `<agentId>:<kind>:<source id>`. */
	id: string;
	agentId: string;
	kind: ProfileEventKind;
	/** Start (epoch ms); `durationMs` absent for an instant. */
	at: number;
	durationMs?: number;
	/** Short label: the tool name, `message to tidal-coral`, the notice type, the wait reason. Never message text. */
	label: string;
	/** The other agent of a message, spawn or reply wait; `user` for the person. */
	peer?: string;
	/** Message direction from this lane's agent. */
	direction?: "sent" | "received";
	outcome?: "ok" | "error" | "aborted";
	/** Tokens involved: a request's input total, a tool result's size estimate. */
	tokens?: number;
	/** A request's or tool call's time by phase, when it was recorded. */
	phases?: Partial<Record<ProfilePhase, number>>;
	/** A tool call that started while the model was still streaming: its `prepare` overlapped the stream. */
	early?: boolean;
	/** Where the detail lives: the agent's request index, transcript entry index, or team message id. */
	ref?: { request?: number; entry?: number; message?: number };
}

/** A message between agents (or the user and an agent), with its delivery lifecycle. */
export interface ProfileMessage {
	id: number;
	from: string;
	to: string[];
	at: number;
	replyTo?: number;
	state: "queued" | "delivered" | "awaiting reply" | "answered" | "dead-lettered";
	/** First line, at most 120 characters. */
	preview: string;
	/** The whole message, as the workspace snapshot's traffic already carries it; the page shows it on selection. */
	text?: string;
	/** Milliseconds from sending to delivery, and to the answer when one came. */
	deliveredMs?: number;
	answeredMs?: number;
	/** The recipients that left without reading it, or without answering it (`Traffic.dropped`). */
	dropped?: TrafficDrop[];
	/** Who sent and received it, with role, worktree and tmux pane (`Traffic`'s fields of the same names). */
	fromEndpoint?: Endpoint;
	toEndpoints?: Endpoint[];
	deliveries?: TrafficDelivery[];
	/** An internal notice, not a team message: `from` is `team` or the external caller and `label` the notice type. Its id is negative. */
	internal?: true;
	label?: string;
	/** The sender's transcript entry nearest the send, where its thinking and output are. */
	transcript?: TranscriptRef;
}

/** What the analysis found worth changing, like a Lighthouse audit: each finding names its cost and evidence. */
export const PROFILE_FINDING_KINDS = [
	"cache-rewrite",
	"cache-cold-start",
	"cache-idle-expiry",
	"cache-too-short",
	"tool-errors",
	"slow-tool",
	"reply-wait",
	"dead-letter",
	"permission-wait",
	"interrupt",
	"cost",
	"slow-phase",
	"slow-first-token",
	"slow-turn-start",
	"retry-wait",
	"main-thread-stall",
	"silence",
] as const;
export type ProfileFindingKind = (typeof PROFILE_FINDING_KINDS)[number];

export interface ProfileFinding {
	id: string;
	kind: ProfileFindingKind;
	severity: "high" | "medium" | "low";
	/** One line: `Section update rewrote 81k cached tokens`. */
	title: string;
	/** Cause and the change that would remove it. */
	detail: string;
	agentId?: string;
	/** What it cost: tokens written or sent again, milliseconds waited, dollars. */
	tokens?: number;
	waitedMs?: number;
	cost?: number;
	/** Rows to open: requests by agent and index, events by id. */
	evidence: { agentId: string; request?: number; event?: string }[];
}

/** `GET <profiler>/timeline?since=<epoch ms>`: every agent's events and the messages between them, oldest first. */
export interface ProfileTimeline {
	sessionId: string;
	events: ProfileEvent[];
	messages: ProfileMessage[];
	/** The latest `at` returned: ask again with `since` set to it. */
	until: number;
	hasMore: boolean;
}

/** `GET <profiler>/insights`: findings over the whole session, most costly first. */
export interface ProfileInsights {
	sessionId: string;
	findings: ProfileFinding[];
	generatedAt: number;
}

/** `GET <profiler>`: the session's agents. */
export interface ProfileAgents {
	sessionId: string;
	agents: ProfileAgent[];
	generatedAt: number;
	/** When the session's first agent started (epoch ms): the page's running clock. */
	startedAt?: number;
}

/** `GET <profiler>/agents/<agentId>?after=<index>`: that agent's requests after `index` (all when absent), oldest first. */
export interface ProfileRequests {
	agentId: string;
	requests: ProfileRequest[];
	/** True when more requests follow: ask again with `after` set to the last returned index. */
	hasMore: boolean;
}

/**
 * The live frame: sent when an agent finishes a request, a tool call or a message changes state. `agent` is the updated
 * row; `request` the finished request, when one; `events` and `messages` what is new or changed since the last frame.
 */
export interface ProfileUpdate {
	agent: ProfileAgent;
	request?: ProfileRequest;
	events?: ProfileEvent[];
	messages?: ProfileMessage[];
}

/**
 * `GET <profiler>/messages?limit=<n>&beforeAt=<ms>&beforeKey=<key>`: a page of the session's team messages older than the
 * cursor (the newest when absent) whatever their age (the timeline holds only the last 30 of the last ten minutes).
 * The first page also carries the internal notices. `next` is the cursor for the next older page; it is set whenever
 * older messages may remain, even when this page found fewer than `limit` (the team's history is shared by every session).
 */
export interface ProfileMessages {
	messages: ProfileMessage[];
	next?: FeedCursor;
}

/** One transcript entry as the Messages tab shows it; `thinking` and `text` are cut at a size the page can hold (`truncated`). */
export interface ProfileTranscriptEntry {
	/** The line index in the agent's session file (`TranscriptRef.entry`). */
	entry: number;
	role: "assistant" | "user" | "toolResult" | "notice" | "other";
	at: number;
	text?: string;
	thinking?: string;
	/** The names of the tools an assistant entry called. */
	tools?: string[];
	truncated?: true;
}

/** `GET <profiler>/transcript?agent=<id>&entry=<n>&session=<id>`: the entries around `entry` of that agent's transcript (the one of `session` when given), oldest first. */
export interface ProfileTranscript {
	agentId: string;
	entry: number;
	entries: ProfileTranscriptEntry[];
}

/**
 * Sub-routes under `WORKSPACE_ROUTES.profiler`. `trace` downloads the session as Chrome Trace Event JSON (one process
 * per agent), which Perfetto and chrome://tracing open.
 */
export const PROFILER_PATHS = {
	agents: "/agents",
	timeline: "/timeline",
	insights: "/insights",
	messages: "/messages",
	transcript: "/transcript",
	trace: "/trace",
} as const;
