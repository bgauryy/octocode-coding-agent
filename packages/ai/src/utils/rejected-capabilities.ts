/**
 * Request fields a provider endpoint rejected with a 400. A gateway that fronts another provider's models often does not
 * take every field its upstream does (`cache_control` markers, strict tool schemas, an effort setting). The first
 * rejection is remembered for the process, per endpoint and model, and the field is left out of every later request
 * to it, so a gateway costs one failed request, not one per turn.
 */

import type { Api, Model } from "../types.ts";

export type RejectableCapability = "cache_control" | "strict_tools" | "effort" | "thinking";

/** Endpoint and model pairs remembered; the oldest is forgotten first. */
const MAX_REMEMBERED_ENDPOINTS = 128;

// Insertion-ordered, so the oldest entry is evicted first.
const rejected = new Map<string, Set<RejectableCapability>>();

type Entry = Record<string, unknown>;
const isEntry = (value: unknown): value is Entry =>
	typeof value === "object" && value !== null && !Array.isArray(value);

function endpointKey(model: Pick<Model<Api>, "baseUrl" | "id">): string {
	return `${model.baseUrl.replace(/\/+$/, "")}\n${model.id}`;
}

/** Whether the endpoint already rejected `capability`. */
export function isCapabilityRejected(
	model: Pick<Model<Api>, "baseUrl" | "id">,
	capability: RejectableCapability,
): boolean {
	return rejected.get(endpointKey(model))?.has(capability) ?? false;
}

function rememberRejectedCapability(model: Pick<Model<Api>, "baseUrl" | "id">, capability: RejectableCapability): void {
	const key = endpointKey(model);
	const known = rejected.get(key) ?? new Set<RejectableCapability>();
	known.add(capability);
	// Re-insert so a recently used endpoint is the last to go.
	rejected.delete(key);
	rejected.set(key, known);
	if (rejected.size > MAX_REMEMBERED_ENDPOINTS) {
		const oldest = rejected.keys().next().value;
		if (oldest !== undefined) rejected.delete(oldest);
	}
}

export function clearRejectedCapabilities(): void {
	rejected.clear();
}

const REFUSAL =
	"extra inputs|unknown|unrecognized|unsupported|not (?:permitted|supported|allowed)|invalid|unexpected|extraneous";

/**
 * A field as providers write it in a rejection: a path (`tools.0.strict`, `output_config.effort`), a quoted name
 * (`'strict'`) or `parameter strict`. A bare common word (`strict mode`, `effort`) is not a field reference, so an
 * unrelated 400 never matches. Identifiers that are not English words need no anchor.
 */
const EFFORT_IDENTIFIERS = "reasoning_effort|reasoning\\.effort|output_config";
const anchored = (name: string) =>
	`(?:(?:[.'"\`\\[]|\\b(?:parameter|param|field|property)\\s+)${name}(?![\\w-])|^${name}(?=\\s*:))`;

/** A refusal wording within 80 characters of the field reference, either order. */
function refusalOf(field: string): RegExp {
	return new RegExp(`(?:${field})[\\s\\S]{0,80}(?:${REFUSAL})|(?:${REFUSAL})[\\s\\S]{0,80}(?:${field})`, "i");
}

const FIELD_PATTERNS: ReadonlyArray<readonly [RejectableCapability, RegExp]> = [
	["cache_control", refusalOf("cache_control|cachepoint")],
	["strict_tools", refusalOf(anchored("strict"))],
	["effort", refusalOf(`${EFFORT_IDENTIFIERS}|${anchored("effort")}`)],
	["thinking", refusalOf(`${anchored("thinking")}|reasoningconfig`)],
];

/** The capability a 400 response names as refused, or undefined for any other error. */
export function rejectedCapabilityFromError(
	status: number | undefined,
	body: string,
): RejectableCapability | undefined {
	if (status !== 400) return undefined;
	return FIELD_PATTERNS.find(([, pattern]) => pattern.test(body))?.[0];
}

function withoutKey(value: unknown, key: string): boolean {
	let changed = false;
	if (Array.isArray(value)) {
		for (const item of value) changed = withoutKey(item, key) || changed;
		return changed;
	}
	if (!isEntry(value)) return false;
	if (key in value) {
		delete value[key];
		changed = true;
	}
	for (const child of Object.values(value)) changed = withoutKey(child, key) || changed;
	return changed;
}

function withoutCachePoints(value: unknown): boolean {
	let changed = false;
	if (Array.isArray(value)) {
		for (let index = value.length - 1; index >= 0; index--) {
			const item: unknown = value[index];
			if (isEntry(item) && Object.keys(item).length === 1 && "cachePoint" in item) {
				value.splice(index, 1);
				changed = true;
			} else changed = withoutCachePoints(item) || changed;
		}
		return changed;
	}
	if (!isEntry(value)) return false;
	for (const child of Object.values(value)) changed = withoutCachePoints(child) || changed;
	return changed;
}

/** Tool definitions live under `tools` (Anthropic, OpenAI) or `toolConfig` (Bedrock Converse). */
function withoutStrictTools(body: Entry): boolean {
	let changed = false;
	for (const holder of [body.tools, body.toolConfig]) changed = withoutKey(holder, "strict") || changed;
	return changed;
}

/** Wire holders of request options: the body, and Bedrock's `additionalModelRequestFields`. */
function optionHolders(body: Entry): Entry[] {
	return isEntry(body.additionalModelRequestFields) ? [body, body.additionalModelRequestFields] : [body];
}

/** Only the effort setting of each wire shape (`reasoning_effort`, `reasoning.effort`, `output_config.effort`). */
function withoutEffort(body: Entry): boolean {
	let changed = false;
	for (const holder of optionHolders(body)) {
		if ("reasoning_effort" in holder) {
			delete holder.reasoning_effort;
			changed = true;
		}
		for (const field of ["reasoning", "output_config"] as const) {
			const nested = holder[field];
			if (!isEntry(nested) || !("effort" in nested)) continue;
			delete nested.effort;
			if (Object.keys(nested).length === 0) delete holder[field];
			changed = true;
		}
	}
	return changed;
}

/** The thinking switch itself (`thinking`, Bedrock's `reasoningConfig`), only when the error names it. */
function withoutThinking(body: Entry): boolean {
	let changed = false;
	for (const holder of optionHolders(body))
		for (const field of ["thinking", "reasoningConfig"]) {
			if (!(field in holder)) continue;
			delete holder[field];
			changed = true;
		}
	return changed;
}

/** Removes the capability's fields from a parsed request body in place; false when the body carried none of them. */
function stripCapability(body: Entry, capability: RejectableCapability): boolean {
	switch (capability) {
		case "cache_control":
			return withoutKey(body, "cache_control") || withoutCachePoints(body);
		case "strict_tools":
			return withoutStrictTools(body);
		case "effort":
			return withoutEffort(body);
		case "thinking":
			return withoutThinking(body);
	}
}

const CAPABILITIES: readonly RejectableCapability[] = ["cache_control", "strict_tools", "effort", "thinking"];

/**
 * The request body with every capability this endpoint rejected before left out; the body itself when none applies. Only
 * an endpoint with a remembered rejection pays for a parse.
 */
export function withoutRejectedCapabilities(model: Pick<Model<Api>, "baseUrl" | "id">, body: string): string {
	const known = rejected.get(endpointKey(model));
	if (!known) return body;
	const parsed: unknown = JSON.parse(body);
	if (!isEntry(parsed)) return body;
	let changed = false;
	for (const capability of CAPABILITIES)
		if (known.has(capability)) changed = stripCapability(parsed, capability) || changed;
	return changed ? JSON.stringify(parsed) : body;
}

/**
 * The body to resend after a 400, with the capability the error names left out, or undefined when the error names none,
 * the endpoint already dropped it (the field was not the cause) or the body carries none of its fields. The failure
 * arrived before any reply content, so the resend cannot duplicate visible output. Remembers the rejection.
 */
export function bodyAfterRejection(
	model: Pick<Model<Api>, "baseUrl" | "id">,
	body: string,
	status: number | undefined,
	responseBody: string,
): string | undefined {
	const capability = rejectedCapabilityFromError(status, responseBody);
	if (!capability || isCapabilityRejected(model, capability)) return undefined;
	const parsed: unknown = JSON.parse(body);
	if (!isEntry(parsed) || !stripCapability(parsed, capability)) return undefined;
	rememberRejectedCapability(model, capability);
	return JSON.stringify(parsed);
}
