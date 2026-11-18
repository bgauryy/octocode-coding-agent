import { textOf, type Trace } from "../trace.ts";
import { cannot, fail, needTrace, type Result } from "./shared.ts";

export interface StandardSchemaIssue {
	readonly message: string;
	readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

export type StandardSchemaResult<Output> =
	| { readonly value: Output; readonly issues?: undefined }
	| { readonly issues: ReadonlyArray<StandardSchemaIssue> };

/**
 * The part of the Standard Schema v1 interface (standardschema.dev) the testkit calls. Zod, Valibot and ArkType
 * schemas satisfy it as they are, so the testkit depends on none of them.
 */
export interface StandardSchemaV1<Output = unknown> {
	readonly "~standard": {
		readonly version: 1;
		readonly vendor: string;
		readonly validate: (value: unknown) => StandardSchemaResult<Output> | Promise<StandardSchemaResult<Output>>;
	};
}

/** Thrown by `extractJson` when no candidate parses. */
export class NoJsonError extends Error {
	override name = "NoJsonError";
}

/** The JSON value in a model answer: a fenced ```json (or bare ```) block, else the whole text, else the first {...} or [...] span. */
export function extractJson(text: string): unknown {
	const fenced = /```(?:json)?[ \t]*\r?\n([\s\S]*?)```/.exec(text)?.[1];
	const span = /[[{][\s\S]*[\]}]/.exec(text)?.[0];
	for (const candidate of [fenced, text, span]) {
		if (candidate === undefined) continue;
		try {
			return JSON.parse(candidate) as unknown;
		} catch {
			// not JSON: try the next candidate
		}
	}
	throw new NoJsonError("no JSON value found in the answer");
}

const issuePath = (i: StandardSchemaIssue): string =>
	(i.path ?? []).map((p) => (typeof p === "object" ? String(p.key) : String(p))).join(".") || "(root)";

/** The final answer of a trace (of `agent` when given), or the string itself. */
function answerText(received: unknown, agent: string | undefined): string {
	if (typeof received === "string") return received;
	const t: Trace = needTrace(received);
	const last = t.events.findLast((e) => e.kind === "answer" && (agent === undefined || e.agent === agent));
	if (!last) return cannot(`no answer in the trace${agent ? ` from ${agent}` : ""}`);
	return typeof last.data === "string" ? last.data : textOf(last.data);
}

export const answerMatchers = {
	/** The answer's JSON (see `extractJson`) validates against a Standard Schema. */
	toMatchSchema(received: unknown, schema: StandardSchemaV1, o: { agent?: string } = {}): Result {
		const text = answerText(received, o.agent);
		let value: unknown;
		try {
			value = extractJson(text);
		} catch (e) {
			if (!(e instanceof NoJsonError)) throw e;
			return fail(`${e.message}\n  answer: ${JSON.stringify(text.slice(0, 300))}`);
		}
		const result = schema["~standard"].validate(value);
		if (result instanceof Promise)
			throw new Error("toMatchSchema needs a synchronous schema; this one validates async");
		const issues = result.issues ?? [];
		return {
			pass: issues.length === 0,
			message: () =>
				issues.length
					? `the answer's JSON does not match the schema:\n  ${issues.map((i) => `${issuePath(i)}: ${i.message}`).join("\n  ")}`
					: `expected the answer's JSON not to match the schema, but it did: ${JSON.stringify(value).slice(0, 300)}`,
		};
	},
};
