import fs from "node:fs/promises";
import type { ExtensionToolContext } from "../../../core/extensions/index.ts";
import { sha256 } from "../../../utils/atomic-file.ts";
import { isRecord } from "../../../utils/guards.ts";
import type { MutationReceipt } from "../render.ts";
import { matchesResponsePath } from "./path.ts";

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
const WAIT_MS = 2000;
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
	const data = isRecord(row.data) ? row.data : {};
	const partial = data.isPartial === true || row.isPartial === true;
	const reasons = Array.isArray(data.partialReasons) ? data.partialReasons : [];
	if (reasons.includes("diagnosticsNotPublished")) return { path, state: "unpublished" };
	if (data.kind !== "diagnostics" && !(row.status === "empty" && data.category === "noDiagnostics"))
		return { path, state: "unavailable" };
	if (row.status === "error") return { path, state: "unavailable" };
	if (partial) return { path, state: "unavailable" };
	if (row.status === "empty" && data.category === "noDiagnostics") return { path, state: "observed-empty" };
	const matches = Array.isArray(data.matches) ? data.matches : undefined;
	if (!matches) return { path, state: "unsupported" };
	const issues = matches.slice(0, MAX_ISSUES).map((item) => {
		if (!isRecord(item)) return "Unknown diagnostic";
		const range = isRecord(item.displayRange) ? item.displayRange : {};
		const location = typeof range.startLine === "number" ? `:${range.startLine}` : "";
		const code = typeof item.code === "string" || typeof item.code === "number" ? `${item.code} ` : "";
		return `${code}${location} ${typeof item.message === "string" ? item.message : "Unknown diagnostic"}`.slice(0, 240);
	});
	const pagination = isRecord(data.pagination) ? data.pagination : {};
	const truncated = data.isTruncated === true || pagination.hasMore === true || matches.length > MAX_ISSUES;
	return matches.length ? { path, state: "issues", issues, truncated } : { path, state: "observed-empty" };
}

/** Coalesce repeated writes, then inspect a bounded number of final surviving targets outside file locks. */
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
		const controller = new AbortController();
		const abort = () => controller.abort();
		signal?.addEventListener("abort", abort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<"pending">((resolve) => {
				timer = setTimeout(() => {
					controller.abort();
					resolve("pending");
				}, WAIT_MS);
			});
			// Only schema-declared fields: the tool's query schema rejects unknown fields, and the row carries the
			// diagnostics (matches, category) by itself.
			const call = ctx.executeTool(
				TOOL,
				{ queries: [{ operation: "diagnostic", path }] },
				{
					signal: controller.signal,
				},
			);
			const outcome = await Promise.race([call, timeout]);
			if (outcome === "pending") {
				results.push({ path, state: signal?.aborted ? "cancelled" : "pending" });
				continue;
			}
			const after = await stale(receipt);
			if (after) {
				results.push({ path, state: after });
				continue;
			}
			if (outcome.isError) {
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
			results.push(
				row && matchesResponsePath(parsed, row, path, ctx.cwd) ? describe(row, path) : { path, state: "unavailable" },
			);
		} catch {
			results.push({ path, state: signal?.aborted ? "cancelled" : "unavailable" });
		} finally {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
		}
	}
	return results;
}

export function formatFeedback(feedback: readonly DiagnosticFeedback[]): string {
	return feedback
		.map(({ path, state, issues, truncated }) => {
			const detail =
				state === "issues"
					? `diagnostics observed after edit (source version unverified): ${issues?.join("; ")}${truncated ? "; more results omitted" : ""}`
					: state === "observed-empty"
						? "no diagnostics observed after edit (source version unverified)"
						: `diagnostics ${state}; no clean result available`;
			return `${path}: ${detail}.`;
		})
		.join("\n");
}
