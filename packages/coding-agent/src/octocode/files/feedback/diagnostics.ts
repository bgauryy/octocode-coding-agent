import fs from "node:fs/promises";
import type { ExtensionToolContext } from "../../../core/features/index.ts";
import { sha256 } from "../../../../../common/src/atomic-file.ts";
import { asRecord, isRecord } from "@octocodeai/octocode-contracts/guards";
import type { MutationReceipt } from "../render.ts";
import { matchesResponsePath } from "./path.ts";
import { knownUnsupported, noteUnsupported, saysUnsupported } from "./support.ts";

type DiagnosticState =
	| "issues"
	| "observed-empty"
	| "unpublished"
	| "unsupported"
	| "unavailable"
	| "cancelled"
	| "pending"
	| "superseded";

interface DiagnosticFeedback {
	path: string;
	state: DiagnosticState;
	/** Short, bounded observations; the complete nested tool result stays with its own execution record. */
	issues?: string[];
	truncated?: boolean;
}

const TOOL = "mcp__octocode__lspSearch";
const MAX_FILES = 3;
const MAX_ISSUES = 5;

async function stillCurrent(receipt: MutationReceipt): Promise<boolean> {
	const bytes = await fs.readFile(receipt.canonicalPath).catch(() => undefined);
	return receipt.digest === null ? bytes === undefined : bytes !== undefined && sha256(bytes) === receipt.digest;
}

function rowOf(value: unknown): Record<string, unknown> | undefined {
	if (!isRecord(value) || !Array.isArray(value.results) || !isRecord(value.results[0])) return undefined;
	return value.results[0];
}

function describe(row: Record<string, unknown>, path: string): DiagnosticFeedback {
	const data = asRecord(row.data);
	const partial = data.isPartial === true || row.isPartial === true;
	const reasons = Array.isArray(data.partialReasons) ? data.partialReasons : [];
	if (reasons.includes("diagnosticsNotPublished")) return { path, state: "unpublished" };
	// The research server names the row's operation in `operation`; rows shaped with `kind` are still accepted.
	const diagnostics = data.operation === "diagnostics" || data.kind === "diagnostics";
	if (!diagnostics && !(row.status === "empty" && data.category === "noDiagnostics"))
		return { path, state: "unavailable" };
	if (row.status === "error") return { path, state: "unavailable" };
	if (partial) return { path, state: "unavailable" };
	if (row.status === "empty" && data.category === "noDiagnostics") return { path, state: "observed-empty" };
	const matches = Array.isArray(data.matches) ? data.matches : undefined;
	if (!matches) return { path, state: "unsupported" };
	const issues = matches.slice(0, MAX_ISSUES).map((item) => {
		if (!isRecord(item)) return "Unknown diagnostic";
		const range = asRecord(item.displayRange);
		const location = typeof range.startLine === "number" ? `:${range.startLine}` : "";
		const code = typeof item.code === "string" || typeof item.code === "number" ? `${item.code} ` : "";
		return `${code}${location} ${typeof item.message === "string" ? item.message : "Unknown diagnostic"}`.slice(0, 240);
	});
	const pagination = asRecord(data.pagination);
	const truncated = data.isTruncated === true || pagination.hasMore === true || matches.length > MAX_ISSUES;
	return matches.length ? { path, state: "issues", issues, truncated } : { path, state: "observed-empty" };
}

/**
 * Coalesce repeated writes, then inspect a bounded number of final surviving targets outside file locks. Each call is
 * bounded by the caller's signal and the research server's own request and language-server timeouts, never by a
 * deadline of this tool, so a server still warming up answers the next edit instead of being cut off on every one.
 * A file type the server already said it has no language server for is not asked again in this process (`support.ts`).
 */
export async function inspectMutations(
	receipts: readonly MutationReceipt[],
	ctx: ExtensionToolContext,
	signal?: AbortSignal,
): Promise<DiagnosticFeedback[]> {
	const latest = new Map<string, MutationReceipt>();
	for (const receipt of receipts) latest.set(receipt.canonicalPath, receipt);
	const results: DiagnosticFeedback[] = [];
	const sessionId = ctx.sessionManager.getSessionId();
	const callable = ctx.tools.some((tool) => tool.name === TOOL);
	/** Why `receipt` is no longer worth inspecting: the call was cancelled or the session changed, or the file changed again. */
	const stale = async (receipt: MutationReceipt): Promise<"cancelled" | "superseded" | undefined> => {
		if (signal?.aborted || ctx.sessionManager.getSessionId() !== sessionId) return "cancelled";
		return (await stillCurrent(receipt)) ? undefined : "superseded";
	};
	for (const [index, receipt] of [...latest.values()].entries()) {
		const path = receipt.canonicalPath;
		if (index >= MAX_FILES) {
			results.push({ path, state: "pending" });
			continue;
		}
		const before = await stale(receipt);
		if (before) {
			results.push({ path, state: before });
			continue;
		}
		if (receipt.digest === null) {
			results.push({ path, state: "unsupported" });
			continue;
		}
		if (!callable) {
			results.push({ path, state: "unavailable" });
			continue;
		}
		if (knownUnsupported(TOOL, path)) {
			results.push({ path, state: "unsupported" });
			continue;
		}
		try {
			// Only schema-declared fields: the tool's query schema rejects unknown fields, and the row carries the
			// diagnostics (matches, category) by itself.
			const outcome = await ctx.executeTool(TOOL, { queries: [{ operation: "diagnostic", path }] }, { signal });
			const after = await stale(receipt);
			if (after) {
				results.push({ path, state: after });
				continue;
			}
			if (outcome.isError) {
				if (saysUnsupported(outcome)) noteUnsupported(TOOL, path);
				results.push({ path, state: "unavailable" });
				continue;
			}
			const structured = outcome.result.structuredContent;
			const text = outcome.result.content.find((part) => part.type === "text")?.text;
			let parsed: unknown = structured;
			if (!parsed && text && text.length <= 60_000) {
				try {
					parsed = JSON.parse(text) as unknown;
				} catch {
					// A display-only result cannot prove an empty publication.
				}
			}
			const row = rowOf(parsed);
			if (row && saysUnsupported(outcome)) noteUnsupported(TOOL, path);
			results.push(
				row && matchesResponsePath(parsed, row, path, ctx.cwd) ? describe(row, path) : { path, state: "unavailable" },
			);
		} catch {
			results.push({ path, state: signal?.aborted ? "cancelled" : "unavailable" });
		}
	}
	return results;
}

/** Only the rows that report issues: an empty, unpublished, unsupported or superseded answer proves nothing about the edit, so it earns no line. */
export function formatFeedback(feedback: readonly DiagnosticFeedback[]): string {
	return feedback
		.filter(({ state }) => state === "issues")
		.map(
			({ path, issues, truncated }) =>
				`${path}: diagnostics observed after edit (source version unverified): ${issues?.join("; ")}${truncated ? "; more results omitted" : ""}.`,
		)
		.join("\n");
}
