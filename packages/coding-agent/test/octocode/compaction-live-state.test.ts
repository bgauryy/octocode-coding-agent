import { renderPrompt } from "../../src/core/prompt-template.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { splitSummary } from "../../src/core/compaction/summary-view.ts";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { liveStateLines } from "../../src/octocode/compaction/live-state.ts";
import { writeSummary } from "../../src/octocode/compaction/summary.ts";
import { JOB_TYPE } from "../../src/octocode/shared/messages.ts";
import { asSetup } from "./fake-host.ts";

const SESSION = "session-live";
let dir: string;
let savedDb: string | undefined;
let savedHome: string | undefined;

beforeEach(() => {
	dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-live-state-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	savedHome = process.env.OCTOCODE_HOME;
	process.env.OCTOCODE_AGENT_DB = path.join(dir, "home", "octocode.db");
	process.env.OCTOCODE_HOME = path.join(dir, "octo-home");
	fs.mkdirSync(path.join(dir, "repo"), { recursive: true });
});
afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	if (savedHome === undefined) delete process.env.OCTOCODE_HOME;
	else process.env.OCTOCODE_HOME = savedHome;
	fs.rmSync(dir, { recursive: true, force: true });
});

const cwd = () => path.join(dir, "repo");
const ctx = () =>
	({ cwd: cwd(), sessionManager: { getSessionId: () => SESSION, getSessionFile: () => undefined } }) as never;

/** Items B1 (held by this session), B2 (held by another) and B3 (todo). */
function seed(): void {
	const agent = sharedAgentDb();
	const store = new BacklogStore(() => agent, registeredWorkspace(cwd(), agent).id);
	for (const title of ["Held by this session", "Held by a peer", "Not claimed yet"])
		store.add({ title, goal: "g", why: "Required work", state: "todo", createdBy: "agent" });
	store.update("B1", { state: "ongoing" }, { id: SESSION });
	store.update("B2", { state: "ongoing" }, { id: "session-peer" });
}

const backgroundJob = (id: string, command: string, log: string) => [
	{
		type: "message",
		timestamp: new Date(2_000).toISOString(),
		message: { role: "assistant", content: [{ type: "toolCall", id, name: "bash", arguments: { command } }] },
	},
	{
		type: "message",
		timestamp: new Date(2_000).toISOString(),
		message: { role: "toolResult", toolCallId: id, toolName: "bash", isError: false, details: { job: "bash-1", log } },
	},
];

describe("the live state a compaction summary carries", () => {
	it("leaves the items this session holds to the session-state brief, so no item is listed twice", () => {
		seed();
		expect(liveStateLines(ctx(), [], 0)).toEqual([]);
	});

	it("says no job or subagent runs once every earlier one reported, and stays quiet in a session that started none", () => {
		seed();
		const reported = [{ type: "custom_message", customType: "octocode-agent-result", details: { id: "kind-fox" } }];
		expect(liveStateLines(ctx(), reported, 0).join("\n")).toContain(
			"no background job or subagent you started is running",
		);
		expect(liveStateLines(ctx(), [], 0).join("\n")).not.toContain("is running");
	});

	it("says none when the session holds nothing, so an id the summary invented is not confirmed", () => {
		const [line] = liveStateLines(ctx(), [], 0);
		expect(line).toContain(renderPrompt("notices/recovery/live-items.md"));
	});

	it("names background work started in this process that has not reported, not earlier or reported work", () => {
		const entries = [
			...backgroundJob("c1", "yarn test", "/logs/a.log"),
			...backgroundJob("c2", "yarn build", "/logs/b.log"),
			{ type: "custom_message", customType: JOB_TYPE, details: { id: "bash-1", log: "/logs/b.log" } },
		];
		const lines = liveStateLines(ctx(), entries, 1_000);
		expect(lines).toHaveLength(2);
		expect(lines[1]).toMatch(/started in this process with no report yet.*yarn test/);
		expect(lines[1]).not.toContain("yarn build");
		expect(liveStateLines(ctx(), entries, 3_000)).toHaveLength(1);
	});

	it("bounds long background commands instead of refilling the compacted context", () => {
		const command = `run-tests ${"argument ".repeat(10_000)} --final-check`;
		const entries = Array.from({ length: 12 }, (_, index) =>
			backgroundJob(`c${index}`, command, `/logs/${index}.log`),
		).flat();
		const lines = liveStateLines(ctx(), entries, 1_000);
		expect(lines.join("\n").length).toBeLessThan(5_000);
		expect(lines[1]).toContain("bash-1");
		expect(lines[1]).toContain("characters omitted");
		expect(lines[1]).toContain("4 more background starts");
		expect(JSON.stringify(entries)).toContain(command);
	});

	it("is appended to the summary as Recovery bullets that splitSummary removes again", async () => {
		const model = { provider: "p", id: "m", api: "anthropic-messages", maxTokens: 10_000, contextWindow: 200_000 };
		const api = asSetup({
			getThinkingLevel: () => "off",
			getActiveTools: () => [],
			getSettings: () => ({}),
			createUsageRecorder: () => () => {},
			appendEntry: () => {},
		}) as never;
		const sessionCtx = {
			model,
			modelRegistry: {
				getCachePolicy: () => ({ options: {} }),
				streamSimple: () => ({
					result: async () => ({
						role: "assistant",
						content: [{ type: "text", text: "## Goal\nAdded B7 and B6" }],
						stopReason: "stop",
						usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2 },
						timestamp: 1,
					}),
				}),
			},
			sessionManager: {
				getSessionId: () => SESSION,
				// A writable session file: the paid summary is saved beside it.
				getSessionFile: () => path.join(dir, "s.jsonl"),
				getBranch: () => [],
				buildSessionProjection: () => ({ entries: [], messages: [] }),
			},
			hasUI: false,
		} as never;
		const event = {
			preparation: {
				firstKeptEntryId: "k",
				tokensBefore: 1,
				messagesToSummarize: [{ role: "user", content: "go" }],
				turnPrefixMessages: [],
				isSplitTurn: false,
				fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
				settings: { reserveTokens: 10_000 },
			},
			branchEntries: [],
			signal: { aborted: false },
		} as never;
		const out = await writeSummary(api, event, sessionCtx, undefined, undefined, undefined, undefined, () =>
			liveStateLines(ctx(), [], 0),
		);
		const { summary } = out!.compaction!;
		const recovery = summary.slice(summary.indexOf("## Recovery"));
		expect(recovery).toContain(renderPrompt("notices/recovery/live-items.md"));
		const split = splitSummary(summary);
		expect(split.body).toBe("## Goal\nAdded B7 and B6");
		expect(split.messages).toEqual(["go"]);
	});
});
