import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { FeatureContext } from "../../core/features/index.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import { snapshotTree } from "../backlog/qa-baseline.ts";
import { QA_VERDICTS, type QaRequest, type QaReview, type QaReviewer, type QaVerdictWord } from "../backlog/qa-gate.ts";
import { smallModelLabel } from "./small-call.ts";
import { spawnAgent } from "./spawn.ts";
import type { SpawnEnv } from "./spawn-env.ts";

const run = promisify(execFile);

/** The most diff text the reviewer is given; a longer one is cut and says so, and the reviewer reads the rest itself. */
const DIFF_BYTES = 24 * 1024;
/** The skill the reviewer loads: it reviews finished work against its request. */
export const QA_SKILL = "octocode-code-review";
/** The skill for an item that links a pull request: it checks the changed contracts and their consumers. */
export const QA_PR_SKILL = "octocode-pr-review";
/** The thinking level of the small reviewer: a bounded read of a bounded diff. */
const QA_THINKING = "low";
/**
 * The wall-clock limit of one review, both attempts together. Measured reviews take 23-100 s (median about 45 s, two
 * attempts at most about 200 s); 5 min leaves headroom for a slow provider and cuts the 550-1174 s stalls.
 */
const QA_TIMEOUT_MS = 5 * 60_000;

/** Why an answer was rejected, in words the reviewer can act on when it is asked again. */
const REJECTIONS: Record<string, string> = {
	missing: 'no line "Structured result:" was found',
	duplicate: 'the line "Structured result:" appeared more than once',
	framing: '"Structured result:" must be followed by one ```json block with its closing fence',
	json: "the block was not valid JSON",
	schema: "the block did not match the schema",
	oversize: "the block was too large",
	shape: "verdict, summary and findings must be present",
};

/** Longest rejection text kept in the owed note. */
const MAX_REJECTION_CHARS = 300;

/** The verdict the reviewer returns, validated by the host (`result-schema.ts`). */
export const QA_RESULT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["verdict", "summary", "findings"],
	properties: {
		verdict: { type: "string", enum: [...QA_VERDICTS], description: "The review's outcome." },
		summary: { type: "string", minLength: 1, maxLength: 600, description: "One or two sentences: why." },
		findings: {
			type: "array",
			maxItems: 20,
			items: { type: "string", maxLength: 600 },
			description: "Each: file:line and what is wrong or unchecked in the item's own changes. Empty only for Ready.",
		},
		context: {
			type: "array",
			maxItems: 20,
			items: { type: "string", maxLength: 600 },
			description:
				"Not the item's doing and never a reason for the verdict: edits by others in the diff, failures their work caused or that predate the item.",
		},
	},
};

/**
 * What changed in the reported files since the item was claimed (`baseline`, a tree id), or against HEAD when none was
 * recorded or the tree cannot be read now; cut at `DIFF_BYTES`. `sinceClaim` says which range ran. The note says what the
 * text is when it is not the whole diff, and names files that changed since the claim but are not reported (other work in
 * the tree).
 */
export async function diffOf(
	cwd: string,
	files: readonly string[],
	baseline: string | undefined,
): Promise<{ diff: string; note: string; unreported: string; sinceClaim: boolean }> {
	const none = { note: "", unreported: "", sinceClaim: false };
	if (!files.length) return { diff: "(the completion names no files)", ...none };
	try {
		const now = baseline ? await snapshotTree(cwd) : undefined;
		const sinceClaim = Boolean(baseline && now);
		const range = baseline && now ? [baseline, now] : ["HEAD"];
		const { stdout } = await run("git", ["-C", cwd, "diff", ...range, "--", ...files], {
			maxBuffer: 16 * 1024 * 1024,
		});
		let unreported = "";
		if (baseline && now) {
			const all = await run("git", ["-C", cwd, "diff", "--name-only", baseline, now], { maxBuffer: 16 * 1024 * 1024 });
			const others = all.stdout
				.split("\n")
				.filter(
					(name) => name && !files.some((file) => name === file || name.startsWith(`${file.replace(/\/$/, "")}/`)),
				);
			if (others.length) unreported = `${others.slice(0, 30).join(", ")}${others.length > 30 ? ", ..." : ""}`;
		}
		if (!stdout.trim())
			return {
				diff: `(no change in those files ${sinceClaim ? "since the item was claimed" : "against HEAD"})`,
				note: "",
				unreported,
				sinceClaim,
			};
		if (Buffer.byteLength(stdout) <= DIFF_BYTES) return { diff: stdout.trimEnd(), note: "", unreported, sinceClaim };
		return {
			diff: Buffer.from(stdout).subarray(0, DIFF_BYTES).toString("utf8"),
			note: ` (cut at ${DIFF_BYTES / 1024} KB: read the rest with git diff)`,
			unreported,
			sinceClaim,
		};
	} catch (error) {
		return { diff: `(git diff failed: ${errorMessage(error)})`, ...none };
	}
}

/** The review's cost in dollars: `usage.cost` is a number or a per-kind breakdown with its total. */
const spentOf = (cost: number | { total: number } | undefined): number =>
	typeof cost === "number" ? cost : (cost?.total ?? 0);

const isVerdict = (value: unknown): value is (typeof QA_VERDICTS)[number] =>
	typeof value === "string" && (QA_VERDICTS as readonly string[]).includes(value);

/**
 * The QA reviewer: a read-only `reviewer` child on the small tier with the code-review skill, started through the
 * ordinary `agent` path (permissions, slots, cost counted in the session). The caller waits for its verdict. Whatever stops
 * a review from completing is a reason, never a refusal of `done`: `skipped` when QA is not configured (no priced small
 * model); `unavailable` (the review is owed) when the reviewer could not start, timed out, or answered off the schema twice.
 */
export function qaReviewer(env: SpawnEnv, options: { timeoutMs?: number } = {}): QaReviewer {
	const limit = options.timeoutMs ?? QA_TIMEOUT_MS;
	return async (request: QaRequest, ctx: FeatureContext, outer?: AbortSignal): Promise<QaReview> => {
		const small = smallModelLabel(ctx);
		if (!small) return { skipped: "no priced small model is connected" };
		const { diff, note, unreported, sinceClaim } = await diffOf(ctx.cwd, request.files, request.baseline);
		const skill = request.pullRequest ? QA_PR_SKILL : QA_SKILL;
		const task = renderPrompt("subagent/qa-review.md", {
			ref: request.ref,
			title: request.title,
			goal: request.goal,
			summary: request.summary,
			verification: request.verification,
			files: request.files.join(", ") || "none",
			diff,
			diffNote: note,
			scope: sinceClaim
				? "since the item was claimed"
				: "against HEAD (no claim baseline: other agents' edits may be included)",
			unreported,
			skill,
			pullRequest: request.pullRequest ? ` and its pull request ${request.pullRequest}` : "",
		});
		const model = `${small}:${QA_THINKING}`;
		// The limit stops the child (the signal reaches `spawnAgent`) and ends the review without a retry.
		const timer = new AbortController();
		let timedOut = false;
		const clock = setTimeout(() => {
			timedOut = true;
			timer.abort();
		}, limit);
		const signal = outer ? AbortSignal.any([outer, timer.signal]) : timer.signal;
		const timeout = { unavailable: `the review timed out after ${Math.round(limit / 1000)} s` };
		// An answer off the schema is retried once, told why it was rejected; a second one leaves the review owed.
		let result: Awaited<ReturnType<typeof spawnAgent>> | undefined;
		let data: Record<string, unknown> | undefined;
		let notes: string | undefined;
		let rejected: string | undefined;
		let spent = 0;
		try {
			for (let attempt = 0; attempt < 2 && !data; attempt++) {
				try {
					result = await spawnAgent(
						env,
						`qa-${request.ref}${attempt ? "-retry" : ""}`,
						{
							profile: "reviewer",
							model,
							skills: [skill],
							goal: `QA review of ${request.ref}: ${request.goal}`,
							task: rejected ? `${task}\n\nYour last answer was rejected: ${rejected}. Answer again.` : task,
							resultSchema: QA_RESULT_SCHEMA,
							background: false,
						},
						signal,
						undefined,
						ctx,
						false,
						true,
					);
				} catch (error) {
					if (outer?.aborted) throw error;
					if (timedOut) return timeout;
					return { unavailable: `the reviewer could not start: ${errorMessage(error)}` };
				}
				if (timedOut) return timeout;
				spent += spentOf(result.usage?.cost);
				const structured = result.details?.structured;
				const candidate =
					structured?.status === "valid" ? (structured.data as Record<string, unknown> | undefined) : undefined;
				if (
					candidate &&
					isVerdict(candidate.verdict) &&
					typeof candidate.summary === "string" &&
					Array.isArray(candidate.findings)
				) {
					data = candidate;
					notes = structured?.notes;
				} else {
					const code = structured?.error?.code ?? (candidate ? "shape" : (structured?.status ?? "no result"));
					const where = structured?.error?.path ? ` at ${structured.error.path}` : "";
					rejected = `${code}${where}${REJECTIONS[code] ? `: ${REJECTIONS[code]}` : ""}`;
				}
			}
		} finally {
			clearTimeout(clock);
		}
		// The reviewer ran but its answers were unusable: the review is owed, so a later start retries it instead of leaving the item on the holder's word.
		if (!data)
			return {
				unavailable: `the reviewer gave no valid verdict twice (${(rejected ?? "no result").slice(0, MAX_REJECTION_CHARS)})`,
			};
		const context = Array.isArray(data.context)
			? data.context.filter((line): line is string => typeof line === "string")
			: [];
		const findings = (data.findings as unknown[]).filter((finding): finding is string => typeof finding === "string");
		if (data.verdict !== "Ready" && !findings.length) findings.push("The reviewer named no finding: read its report.");
		return {
			verdict: {
				verdict: data.verdict as QaVerdictWord,
				summary: data.summary as string,
				findings,
				...(context.length ? { context } : {}),
				...(notes ? { notes } : {}),
			},
			model: small,
			cost: spent,
		};
	};
}
