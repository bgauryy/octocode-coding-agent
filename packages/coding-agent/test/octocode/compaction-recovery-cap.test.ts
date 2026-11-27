import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RECOVERY_HEADING } from "../../src/core/compaction/summary-view.ts";
import { ArchiveCapture, summaryLabel } from "../../src/octocode/compaction/archive.ts";
import { addLedgerEdits } from "../../src/octocode/compaction/edit-ledger.ts";
import { writeSummary } from "../../src/octocode/compaction/summary.ts";
import { RECOVERY_CHARS } from "../../src/octocode/compaction/summary-text.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { renderPrompt } from "../../src/core/prompt-template.ts";
import { asSetup } from "./fake-host.ts";

const model = { provider: "p", id: "m", api: "anthropic-messages", maxTokens: 10_000, contextWindow: 200_000 };
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 };
const T0 = Date.UTC(2026, 10, 1, 10, 0, 0);

const skillResult = (name: string) => ({
	role: "toolResult",
	toolCallId: `call-${name}`,
	toolName: "skill",
	isError: false,
	content: [{ type: "text", text: `<skill name="${name}" location="/skills/${name}/SKILL.md">\nbody\n</skill>` }],
	details: { name, location: `/skills/${name}/SKILL.md`, baseDir: `/skills/${name}`, lines: 1 },
});
const agentResult = (id: string) => ({
	role: "toolResult",
	toolCallId: `call-${id}`,
	toolName: "agent",
	isError: false,
	content: [],
	timestamp: T0,
	details: { id, profile: "worker", startedAt: T0 },
});

let savedHome: string | undefined;
let home: string;
/** A long session path in a folder that exists: the paid summary is kept beside it. */
let sessionFile: string;
beforeEach(() => {
	savedHome = process.env.OCTOCODE_HOME;
	// The archive line names this folder and always stays whole, so its length sets what the cap leaves: a fixed base
	// keeps the budget the same under any $TMPDIR (an isolated run's is about 30 characters longer).
	home = fs.mkdtempSync("/tmp/octocode-");
	process.env.OCTOCODE_HOME = home;
	sessionFile = path.join(process.env.OCTOCODE_HOME, "octocodecode/agent/sessions/long-session-with-a-long-name.jsonl");
	fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
	setCurrentSession("long-session-with-a-long-name");
});
afterEach(() => {
	setCurrentSession(undefined);
	fs.rmSync(home, { recursive: true, force: true });
	if (savedHome === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = savedHome;
});

/** One compaction of a session: new skills, `agents` subagents' changes, `jobs` running jobs, and the TL;DR it files. */
async function compactOnce(round: number, branch: unknown[], { jobs = 0, agents = 12 } = {}) {
	const tldr = `Round ${round}: rewrote the compaction pointer, then searched the archive for every fact a summary dropped.`;
	const messages = [
		{ role: "user", content: `keep going, round ${round}`, timestamp: T0 + round },
		...["review", "research", `extra-${round}`].map(skillResult),
		...Array.from({ length: agents }, (_, i) => agentResult(`worker-${round}-${i}`)),
	];
	const fileOps = { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() };
	const preparation = {
		firstKeptEntryId: `keep${round}`,
		tokensBefore: 150_000,
		messagesToSummarize: messages,
		turnPrefixMessages: [],
		isSplitTurn: false,
		fileOps,
		settings: { reserveTokens: 16_384, keepRecentTokens: 20_000 },
	};
	const ledger = await addLedgerEdits(
		preparation as never,
		"/repo",
		(agent) => Array.from({ length: 30 }, (_, i) => `/repo/src/${agent}/module-${i}.ts`),
		() => "~/.octocode/octocodecode/agent/sessions/x/output/subagent-edits-0123456789abcdef.md",
	);
	const work = Array.from({ length: jobs }, (_, i) => `job ${i} running the full suite for package ${i}`);
	const live = [
		renderPrompt("notices/recovery/live-items.md"),
		...(jobs > 0 ? [renderPrompt("notices/recovery/live-work.md", { work: work.join("; ") })] : []),
	];
	const api = asSetup({
		getThinkingLevel: () => "off",
		getActiveTools: () => ["backlogPlan"],
		getSettings: () => ({}),
		createUsageRecorder: () => () => {},
		appendEntry: () => {},
	}) as never;
	const ctx = {
		model,
		modelRegistry: {
			getCachePolicy: () => ({ options: {} }),
			streamSimple: () => ({
				result: async () => ({
					role: "assistant",
					content: [{ type: "text", text: `## Goal\nwork\n\n## TL;DR\n${tldr}\nTopics: compaction, archive` }],
					stopReason: "stop",
					usage,
					timestamp: T0 + round,
				}),
			}),
		},
		sessionManager: {
			getSessionId: () => "long-session-with-a-long-name",
			getSessionFile: () => sessionFile,
			getBranch: () => branch,
			buildSessionProjection: () => ({ entries: [], messages: [] }),
		},
		hasUI: false,
	} as never;
	const event = { preparation, branchEntries: branch, signal: { aborted: false } } as never;
	const out = await writeSummary(api, event, ctx, undefined, undefined, undefined, undefined, () => [
		...ledger,
		...live,
	]);
	const compaction = out!.compaction!;
	// The segment is filed once the compaction succeeded, as `register.ts` does.
	const archive = new ArchiveCapture();
	archive.capture({ preparation, branchEntries: [] } as never);
	const id = `compaction-${round}`;
	archive.write(
		{ ...compaction, type: "compaction", id } as never,
		"long-session-with-a-long-name",
		summaryLabel(`## TL;DR\n${tldr}`),
		"cache-shared",
	);
	branch.push({ ...compaction, type: "compaction", id });
	return compaction.summary;
}

const recoveryOf = (summary: string) =>
	summary.slice(summary.indexOf(`${RECOVERY_HEADING}\n`) + RECOVERY_HEADING.length + 1);

describe("the Recovery section across repeated compactions", () => {
	it("stays within the cap through 10 compactions, keeping the archive line, the counts and live state", async () => {
		const branch: unknown[] = [];
		for (let round = 1; round <= 10; round++) {
			const recovery = recoveryOf(await compactOnce(round, branch));
			const bullets = recovery.split("\n");
			expect(bullets.every((line) => line.startsWith("- "))).toBe(true);
			expect(recovery.length).toBeLessThanOrEqual(RECOVERY_CHARS);
			expect(bullets[0]).toMatch(/^- For anything from before this summary, search the archive /);
			expect(recovery).toContain(`This compaction is segment ${round} `);
			expect(recovery).toContain("or 12 subagents (360 files; by subagent: ~/");
			expect(recovery).toContain("this session holds no items.");
			expect(recovery).not.toContain("worker-");
			// Skills not loaded again across two compactions leave the pointer list.
			expect(recovery).toContain("review, research");
			if (round >= 3) expect(recovery).not.toContain(`extra-${round - 2}`);
			// Earlier segments fill what is left, never more than two.
			expect(bullets.filter((line) => line.includes(" · Round ")).length).toBeLessThanOrEqual(2);
		}
	});

	it("names the two newest earlier segments when the tools report little", async () => {
		const branch: unknown[] = [];
		for (let round = 1; round <= 3; round++) await compactOnce(round, branch, { agents: 0 });
		const recovery = recoveryOf(await compactOnce(4, branch, { agents: 0 }));
		expect(recovery.length).toBeLessThanOrEqual(RECOVERY_CHARS);
		expect(recovery.split("\n").filter((line) => line.includes(" · Round "))).toEqual([
			expect.stringContaining("Round 3:"),
			expect.stringContaining("Round 2:"),
		]);
	});

	it("keeps live state whole when the tools report more than fits, and drops the optional lines instead", async () => {
		const branch: unknown[] = [];
		const recovery = recoveryOf(await compactOnce(1, branch, { jobs: 8 }));
		expect(recovery).toContain("job 7 running the full suite for package 7.");
		expect(recovery).not.toContain("full transcript");
		expect(recovery).not.toContain("`backlogPlan` `add`");
	});
});
