import {
	PROFILE_ACTIVITY_KINDS,
	PROFILE_CACHE_STATES,
	PROFILE_EVENT_KINDS,
	PROFILE_FINDING_KINDS,
	PROFILE_LAYER_KINDS,
	type ProfileAgent,
	type ProfileEvent,
	type ProfileFinding,
	type ProfileMessage,
	type ProfileRequest,
	type ProfileUpdate,
} from "@octocodeai/octocode-contracts";
import { isRecord } from "@octocodeai/octocode-contracts/guards";

function finite(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}
function optional(value: unknown, test: (value: unknown) => boolean): boolean {
	return value === undefined || test(value);
}
const isString = (value: unknown) => typeof value === "string";

function isUsage(value: unknown): boolean {
	return (
		isRecord(value) &&
		finite(value.input) &&
		finite(value.output) &&
		finite(value.cacheRead) &&
		finite(value.cacheWrite) &&
		optional(value.cost, finite)
	);
}

function isCacheGroup(value: unknown): boolean {
	return isRecord(value) && typeof value.prefix === "string" && optional(value.key, isString);
}

function isLayer(value: unknown): boolean {
	return (
		isRecord(value) &&
		(PROFILE_LAYER_KINDS as readonly unknown[]).includes(value.kind) &&
		typeof value.label === "string" &&
		finite(value.tokens) &&
		(PROFILE_CACHE_STATES as readonly unknown[]).includes(value.state) &&
		typeof value.changed === "boolean" &&
		optional(value.breakpoint, (flag) => typeof flag === "boolean") &&
		optional(value.entry, finite)
	);
}

const isBoolean = (value: unknown) => typeof value === "boolean";
const isKind = (value: unknown) => (PROFILE_LAYER_KINDS as readonly unknown[]).includes(value);

function isContextLayers(value: unknown): boolean {
	return Array.isArray(value) && value.every((row) => isRecord(row) && isKind(row.kind) && finite(row.tokens));
}

function isContextTop(value: unknown): boolean {
	return (
		Array.isArray(value) &&
		value.every((row) => isRecord(row) && isKind(row.kind) && typeof row.label === "string" && finite(row.tokens))
	);
}

function isActivity(value: unknown): boolean {
	return (
		isRecord(value) &&
		(PROFILE_ACTIVITY_KINDS as readonly unknown[]).includes(value.kind) &&
		typeof value.label === "string" &&
		finite(value.since) &&
		optional(value.peer, isString) &&
		optional(value.count, finite)
	);
}

/** Shape checks for what the host sends; the page renders these fields without further trust in them. */
export function isProfileAgent(value: unknown): value is ProfileAgent {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		optional(value.parentId, isString) &&
		typeof value.role === "string" &&
		optional(value.model, isString) &&
		optional(value.provider, isString) &&
		(value.status === "idle" || value.status === "working") &&
		optional(value.goal, isString) &&
		optional(value.outcome, isString) &&
		finite(value.requests) &&
		isUsage(value.totals) &&
		optional(value.hitRate, finite) &&
		optional(value.lastRequestAt, finite) &&
		typeof value.profiled === "boolean" &&
		optional(value.contextWindow, finite) &&
		optional(value.compactAt, finite) &&
		optional(value.contextTokens, finite) &&
		optional(value.contextLayers, isContextLayers) &&
		optional(value.contextTop, isContextTop) &&
		optional(value.contextEstimated, isBoolean) &&
		optional(value.startedAt, finite) &&
		optional(value.endedAt, finite) &&
		optional(value.activity, isActivity) &&
		optional(value.cacheTtlMs, finite) &&
		optional(value.cacheGroup, isCacheGroup)
	);
}

export function isProfileRequest(value: unknown): value is ProfileRequest {
	return (
		isRecord(value) &&
		typeof value.agentId === "string" &&
		finite(value.index) &&
		finite(value.at) &&
		optional(value.durationMs, finite) &&
		typeof value.model === "string" &&
		optional(value.provider, isString) &&
		isUsage(value.usage) &&
		Array.isArray(value.layers) &&
		value.layers.every(isLayer) &&
		optional(value.firstBreak, finite) &&
		optional(value.missReason, isString) &&
		optional(value.providerMissReason, isString) &&
		optional(value.cacheGroup, isCacheGroup) &&
		optional(value.idleMs, finite) &&
		typeof value.estimated === "boolean"
	);
}

const MESSAGE_STATES = ["queued", "delivered", "awaiting reply", "answered", "dead-lettered"];

export function isProfileEvent(value: unknown): value is ProfileEvent {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		typeof value.agentId === "string" &&
		(PROFILE_EVENT_KINDS as readonly unknown[]).includes(value.kind) &&
		finite(value.at) &&
		optional(value.durationMs, finite) &&
		typeof value.label === "string" &&
		optional(value.peer, isString) &&
		optional(value.tokens, finite) &&
		optional(value.ref, isRecord)
	);
}

export function isProfileMessage(value: unknown): value is ProfileMessage {
	return (
		isRecord(value) &&
		finite(value.id) &&
		typeof value.from === "string" &&
		Array.isArray(value.to) &&
		value.to.every(isString) &&
		finite(value.at) &&
		optional(value.replyTo, finite) &&
		MESSAGE_STATES.includes(value.state as string) &&
		typeof value.preview === "string" &&
		optional(value.text, isString) &&
		optional(value.deliveredMs, finite) &&
		optional(value.answeredMs, finite)
	);
}

export function isProfileFinding(value: unknown): value is ProfileFinding {
	return (
		isRecord(value) &&
		typeof value.id === "string" &&
		(PROFILE_FINDING_KINDS as readonly unknown[]).includes(value.kind) &&
		["high", "medium", "low"].includes(value.severity as string) &&
		typeof value.title === "string" &&
		typeof value.detail === "string" &&
		optional(value.agentId, isString) &&
		optional(value.tokens, finite) &&
		optional(value.waitedMs, finite) &&
		optional(value.cost, finite) &&
		Array.isArray(value.evidence) &&
		value.evidence.every((item) => isRecord(item) && typeof item.agentId === "string")
	);
}

/** A live frame carries the agent row and any of: the finished request, new events, new or changed messages. */
export function isProfileUpdate(value: unknown): value is ProfileUpdate {
	return (
		isRecord(value) &&
		isProfileAgent(value.agent) &&
		optional(value.request, isProfileRequest) &&
		optional(value.events, (list) => Array.isArray(list) && list.every(isProfileEvent)) &&
		optional(value.messages, (list) => Array.isArray(list) && list.every(isProfileMessage))
	);
}
