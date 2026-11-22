import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import type { FeatureContext } from "../../core/features/index.ts";
import { renderPrompt } from "../../core/prompt-template.ts";
import { QA_VERDICTS, type QaRequest, type QaReview, type QaReviewer } from "../backlog/qa-gate.ts";
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
			description: "Each: file:line and what is wrong or unchecked. Empty only for Ready.",
		},
	},
};

/** `git diff HEAD` of the reported files, cut at `DIFF_BYTES`; the note says what the text is when it is not the whole diff. */
async function diffOf(cwd: string, files: readonly string[]): Promise<{ diff: string; note: string }> {
	if (!files.length) return { diff: "(the completion names no files)", note: "" };
	try {
		const { stdout } = await run("git", ["-C", cwd, "diff", "HEAD", "--", ...files], {
			maxBuffer: 16 * 1024 * 1024,
		});
		if (!stdout.trim()) return { diff: "(no uncommitted change in those files)", note: "" };
		if (Buffer.byteLength(stdout) <= DIFF_BYTES) return { diff: stdout.trimEnd(), note: "" };
		return {
			diff: Buffer.from(stdout).subarray(0, DIFF_BYTES).toString("utf8"),
			note: ` (cut at ${DIFF_BYTES / 1024} KB: read the rest with git diff)`,
		};
	} catch (error) {
		return { diff: `(git diff failed: ${errorMessage(error)})`, note: "" };
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
 * a review from completing (no priced small model, a refused start, a child that failed or answered off the schema) is a
 * `skipped` reason, never a refusal of `done`.
 */
export function qaReviewer(env: SpawnEnv): QaReviewer {
	return async (request: QaRequest, ctx: FeatureContext, signal?: AbortSignal): Promise<QaReview> => {
		const small = smallModelLabel(ctx);
		if (!small) return { skipped: "no priced small model is connected" };
		const { diff, note } = await diffOf(ctx.cwd, request.files);
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
			skill,
			pullRequest: request.pullRequest ? ` and its pull request ${request.pullRequest}` : "",
		});
		const model = `${small}:${QA_THINKING}`;
		let result: Awaited<ReturnType<typeof spawnAgent>>;
		try {
			result = await spawnAgent(
				env,
				`qa-${request.ref}`,
				{
					profile: "reviewer",
					model,
					skills: [skill],
					goal: `QA review of ${request.ref}: ${request.goal}`,
					task,
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
			if (signal?.aborted) throw error;
			return { skipped: `the reviewer could not start: ${errorMessage(error)}` };
		}
		const structured = result.details?.structured;
		const data = structured?.status === "valid" ? (structured.data as Record<string, unknown> | undefined) : undefined;
		if (!data || !isVerdict(data.verdict) || typeof data.summary !== "string" || !Array.isArray(data.findings))
			return { skipped: `the reviewer gave no valid verdict (${structured?.status ?? "no result"})` };
		const findings = data.findings.filter((finding): finding is string => typeof finding === "string");
		if (data.verdict !== "Ready" && !findings.length) findings.push("The reviewer named no finding: read its report.");
		return {
			verdict: { verdict: data.verdict, summary: data.summary, findings },
			model: small,
			cost: spentOf(result.usage?.cost),
		};
	};
}
