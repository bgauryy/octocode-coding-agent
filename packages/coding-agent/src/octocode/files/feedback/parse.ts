import fs from "node:fs/promises";
import type { ExtensionToolContext } from "../../../core/extensions/index.ts";
import { sha256 } from "../../../utils/atomic-file.ts";
import { isRecord } from "../../../utils/guards.ts";
import type { MutationReceipt } from "../render.ts";
import { matchesResponsePath } from "./path.ts";

const TOOL = "mcp__octocode__astSearch";
const WAIT_MS = 1200;
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
	const controller = new AbortController();
	const abort = () => controller.abort();
	signal?.addEventListener("abort", abort, { once: true });
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => {
				controller.abort();
				resolve(undefined);
			}, WAIT_MS);
		});
		const outcome = await Promise.race([
			ctx.executeTool(
				TOOL,
				{
					queries: [
						{
							operation: "syntaxTree",
							path,
							extras: ["details", "diagnostics", "echo"],
							mainGoal: "Check syntax after editing",
							reasoning: "Observe parser recovery",
						},
					],
				},
				{ signal: controller.signal },
			),
			timeout,
		]);
		if (ctx.sessionManager.getSessionId() !== sessionId) return undefined;
		if (!outcome || outcome.isError || signal?.aborted) return { digest, state: "unsupported" };
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
			!matchesResponsePath(value, row, path) ||
			data.operation !== "syntaxTree" ||
			!Array.isArray(data.nodes)
		)
			return { digest, state: "unsupported" };
		const reasons = Array.isArray(data.partialReasons) ? data.partialReasons : [];
		const diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics : [];
		const recovered =
			diagnostics.some((diagnostic) => isRecord(diagnostic) && diagnostic.code === "syntaxTree.parse.recovered") ||
			reasons.includes("parseRecovered");
		// Parser recovery is itself a partial tree, but any other incomplete result cannot prove parse status.
		if (
			data.terminalLimit === true ||
			reasons.some((reason) => reason !== "parseRecovered") ||
			((data.isPartial === true || row.isPartial === true) && !recovered)
		)
			return { digest, state: "unsupported" };
		return { digest, state: recovered ? "recovered" : "parsed" };
	} catch {
		return { digest, state: "unsupported" };
	} finally {
		if (timer) clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
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

export function formatParseFeedback(feedback: readonly ParseFeedback[]): string {
	return feedback
		.map(
			({ path, state }) =>
				`${path}: ${state === "possible-regression" ? "possible parse regression observed after edit (source version unverified)" : state === "already-invalid" ? "parse errors already observed before this batch" : state === "observed-parsed" ? "parse completed after edit (source version unverified)" : `parse feedback ${state}; no parse claim available`}.`,
		)
		.join("\n");
}
