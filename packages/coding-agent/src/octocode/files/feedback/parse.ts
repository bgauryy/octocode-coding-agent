import fs from "node:fs/promises";
import type { ExtensionToolContext } from "../../../core/extensions/index.ts";
import { sha256 } from "../../../utils/atomic-file.ts";
import { isRecord } from "../../../utils/guards.ts";
import type { MutationReceipt } from "../render.ts";
import { matchesResponsePath } from "./path.ts";
import { knownUnsupported, noteUnsupported, saysUnsupported } from "./support.ts";

const TOOL = "mcp__octocode__astSearch";
const MAX_FILES = 3;

type ParseState = "parsed" | "recovered" | "unsupported";
interface ParseObservation {
	digest: string;
	state: ParseState;
}
type ParseFeedback = {
	path: string;
	state: "possible-regression" | "already-invalid" | "observed-parsed" | "unsupported" | "superseded";
};

/**
 * The parser's view of `path` now, or undefined when nothing can be claimed. The call is bounded by the caller's
 * signal and the research server's own request timeout, never by a deadline of this tool: an answer that arrives late
 * is still the parser's answer. A file type the server already refused in this session is not asked again.
 */
async function observe(
	path: string,
	ctx: ExtensionToolContext,
	signal?: AbortSignal,
): Promise<ParseObservation | undefined> {
	const sessionId = ctx.sessionManager.getSessionId();
	const before = await fs.readFile(path).catch(() => undefined);
	if (
		!before ||
		!ctx.tools.some((tool) => tool.name === TOOL) ||
		signal?.aborted ||
		ctx.sessionManager.getSessionId() !== sessionId
	)
		return undefined;
	const digest = sha256(before);
	if (knownUnsupported(sessionId, TOOL, path)) return { digest, state: "unsupported" };
	try {
		// Only schema-declared fields: the tool's query schema rejects unknown fields, and the row carries the
		// parse evidence (diagnostics, partialReasons) by itself.
		const outcome = await ctx.executeTool(TOOL, { queries: [{ operation: "syntaxTree", path }] }, { signal });
		if (ctx.sessionManager.getSessionId() !== sessionId) return undefined;
		if (outcome.isError || signal?.aborted) {
			if (outcome.isError && saysUnsupported(outcome)) noteUnsupported(sessionId, TOOL, path);
			return { digest, state: "unsupported" };
		}
		const after = await fs.readFile(path).catch(() => undefined);
		if (!after || sha256(after) !== digest || ctx.sessionManager.getSessionId() !== sessionId) return undefined;
		let value: unknown = outcome.result.structuredContent;
		const content = outcome.result.content.find((part) => part.type === "text")?.text;
		if (!value && content && content.length < 60_000) {
			try {
				value = JSON.parse(content) as unknown;
			} catch {
				/* Human-readable text is not a parser contract. */
			}
		}
		const results = isRecord(value) && Array.isArray(value.results) ? value.results : [];
		const row = results[0];
		const data = isRecord(row) && isRecord(row.data) ? row.data : undefined;
		if (
			!data ||
			row.status === "error" ||
			!matchesResponsePath(value, row, path, ctx.cwd) ||
			data.operation !== "syntaxTree" ||
			!Array.isArray(data.nodes)
		) {
			if (row && row.status === "error" && saysUnsupported(outcome)) noteUnsupported(sessionId, TOOL, path);
			return { digest, state: "unsupported" };
		}
		const reasons = Array.isArray(data.partialReasons) ? data.partialReasons : [];
		const diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics : [];
		const recovered =
			diagnostics.some((diagnostic) => isRecord(diagnostic) && diagnostic.code === "syntaxTree.parse.recovered") ||
			reasons.includes("parseRecovered");
		// Parser recovery is itself a partial tree whose walk also ends at a terminal limit; that abbreviation does
		// not change what the parser proved, while any other incomplete result cannot prove parse status.
		if (
			reasons.some((reason) => reason !== "parseRecovered") ||
			((data.terminalLimit === true || data.isPartial === true || row.isPartial === true) && !recovered)
		)
			return { digest, state: "unsupported" };
		return { digest, state: recovered ? "recovered" : "parsed" };
	} catch {
		return { digest, state: "unsupported" };
	}
}

/** Capture pre-edit parser observations only before the batch starts writing. */
export async function captureParseBefore(
	paths: readonly string[],
	ctx: ExtensionToolContext,
	signal?: AbortSignal,
): Promise<Map<string, ParseObservation>> {
	const observations = new Map<string, ParseObservation>();
	for (const path of new Set(paths.slice(0, MAX_FILES))) {
		const observed = await observe(path, ctx, signal);
		if (observed) observations.set(path, observed);
	}
	return observations;
}

/** A parser observation is advisory: its sanitized-source snapshot is not a digest of committed bytes. */
export async function inspectParseAfter(
	receipts: readonly MutationReceipt[],
	before: ReadonlyMap<string, ParseObservation>,
	ctx: ExtensionToolContext,
	signal?: AbortSignal,
): Promise<ParseFeedback[]> {
	const final = new Map<string, MutationReceipt>();
	for (const receipt of receipts) final.set(receipt.canonicalPath, receipt);
	const first = new Map<string, MutationReceipt>();
	for (const receipt of receipts) if (!first.has(receipt.canonicalPath)) first.set(receipt.canonicalPath, receipt);
	const feedback: ParseFeedback[] = [];
	for (const [path, receipt] of final) {
		const baseline = before.get(path);
		if (
			!baseline ||
			baseline.digest !== first.get(path)?.beforeDigest ||
			baseline.state === "unsupported" ||
			receipt.digest === null
		) {
			feedback.push({ path, state: "unsupported" });
			continue;
		}
		const observed = await observe(path, ctx, signal);
		if (!observed || observed.digest !== receipt.digest) {
			feedback.push({ path, state: "superseded" });
			continue;
		}
		feedback.push({
			path,
			state:
				observed.state === "unsupported"
					? "unsupported"
					: baseline.state === "recovered"
						? "already-invalid"
						: observed.state === "recovered"
							? "possible-regression"
							: "observed-parsed",
		});
	}
	return feedback;
}

/** The rows that carry a claim; a file type the parser does not serve says nothing worth a line to the model. */
export function formatParseFeedback(feedback: readonly ParseFeedback[]): string {
	return feedback
		.filter(({ state }) => state !== "unsupported")
		.map(
			({ path, state }) =>
				`${path}: ${state === "possible-regression" ? "possible parse regression observed after edit (source version unverified)" : state === "already-invalid" ? "parse errors already observed before this batch" : state === "observed-parsed" ? "parse completed after edit (source version unverified)" : `parse feedback ${state}; no parse claim available`}.`,
		)
		.join("\n");
}
