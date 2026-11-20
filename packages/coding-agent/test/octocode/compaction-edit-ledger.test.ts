import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { EditLog } from "../../src/octocode/team/edits.ts";
import { teamWorkspace } from "../../src/octocode/team/store/workspace.ts";
import { tmp } from "./helpers.ts";
import { addLedgerEdits } from "../../src/octocode/compaction/edit-ledger.ts";
import { addFileToolOps } from "../../src/octocode/compaction/register.ts";

const bash = (id: string, command: string, extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	timestamp: 1_000,
	content: [{ type: "toolCall", id, name: "bash", arguments: { command, ...extra } }],
});
const result = (toolCallId: string, toolName: string, isError = false, details?: unknown) => ({
	role: "toolResult",
	toolCallId,
	toolName,
	isError,
	content: [],
	timestamp: 2_000,
	...(details ? { details } : {}),
});
const prepare = (messages: unknown[]) =>
	({
		fileOps: { read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() },
		messagesToSummarize: messages,
		turnPrefixMessages: [],
	}) as never as Parameters<typeof addLedgerEdits>[0];

describe("the compaction's modified-file ledger", () => {
	it("adds what this session's bash calls wrote, and only calls that did not fail", async () => {
		const preparation = prepare([
			bash("1", "printf x > notes.txt && sed -n 1p src/a.ts"),
			result("1", "bash"),
			bash("2", "echo y >> failed.txt"),
			result("2", "bash", true),
			bash("3", "mkdir -p out && cp src/a.ts out/b.ts"),
			result("3", "bash"),
			bash("4", "Set-Content x.txt 1", { type: "powershell" }),
			result("4", "bash"),
		]);
		const lines = await addLedgerEdits(preparation, "/repo", () => []);
		expect([...preparation.fileOps.edited].sort()).toEqual(["/repo/notes.txt", "/repo/out/b.ts"]);
		expect(lines).toEqual([
			"Your own changes, with `file` or `bash`, are in `<modified-files>`: not another process's.",
		]);
	});

	it("adds the files its subagents changed, says which subagent changed them, and does not list a file twice", async () => {
		const asked: Array<[string, number]> = [];
		const preparation = prepare([
			{ role: "user", content: "go", timestamp: 500 },
			result("9", "agent", false, { id: "worker-1", profile: "worker", startedAt: 700 }),
			{
				role: "custom",
				customType: "octocode-agent-result",
				timestamp: 5_000,
				details: { id: "scout", durationMs: 1_000 },
			},
			result("10", "agent", false, { id: "idle-one", profile: "scout", startedAt: 800 }),
		]);
		preparation.fileOps.edited.add("src/own.ts");
		const saved: string[] = [];
		const lines = await addLedgerEdits(
			preparation,
			"/repo",
			(agent, since) => {
				asked.push([agent, since]);
				return agent === "worker-1"
					? ["/repo/src/own.ts", "/repo/src/child.ts"]
					: agent === "scout"
						? ["/elsewhere/x.md"]
						: [];
			},
			(text) => {
				saved.push(text);
				return "/out/subagent-edits.md";
			},
		);
		expect(asked).toEqual([
			["worker-1", 700],
			["scout", 4_000],
			["idle-one", 800],
		]);
		// `src/own.ts` was listed by its relative spelling already: the log's absolute one is the same file.
		expect([...preparation.fileOps.edited].sort()).toEqual(["/elsewhere/x.md", "/repo/src/child.ts", "src/own.ts"]);
		// The line counts the subagents and their files and names the file that lists them by subagent.
		expect(lines).toEqual([
			"Your own changes, with `file`, `bash` or 2 subagents (3 files; by subagent: /out/subagent-edits.md), are in `<modified-files>`: not another process's.",
		]);
		expect(saved).toHaveLength(1);
		expect(saved[0]).toContain("## worker-1 (2)\n- src/own.ts\n- src/child.ts");
		expect(saved[0]).toContain("## scout (1)\n- /elsewhere/x.md");
	});

	it("keeps the line short however many subagents changed files, and still points at them when the list cannot be saved", async () => {
		const preparation = prepare([
			{ role: "user", content: "go", timestamp: 500 },
			...Array.from({ length: 12 }, (_, i) =>
				result(String(i), "agent", false, { id: `worker-${i}`, profile: "worker", startedAt: 600 + i }),
			),
		]);
		const many = (agent: string) => Array.from({ length: 40 }, (_, i) => `/repo/src/${agent}/file-${i}.ts`);
		const lines = await addLedgerEdits(preparation, "/repo", many, () => undefined);
		expect(preparation.fileOps.edited.size).toBe(480);
		expect(lines).toEqual([
			"Your own changes, with `file`, `bash` or 12 subagents (480 files), are in `<modified-files>`: not another process's.",
		]);
	});

	it("says nothing when no file changed, and the file tool part still works alone", async () => {
		const preparation = prepare([bash("1", "ls src"), result("1", "bash")]);
		expect(await addLedgerEdits(preparation, "/repo", () => [])).toEqual([]);
		addFileToolOps(preparation, "/repo");
		expect(preparation.fileOps.edited.size).toBe(0);
	});
});

describe("the ledger's edit log", () => {
	it("reads a subagent's changes from this checkout's edit log", async () => {
		const cwd = tmp();
		const db = sharedAgentDb();
		const log = new EditLog(db.db, registeredWorkspace(teamWorkspace(cwd), db).id);
		const root = log.workspace;
		log.record("worker-1", "bash", [path.join(root, "src", "child.ts")], 1_500);
		log.record("someone-else", "file", [path.join(root, "src", "other.ts")], 1_500);
		const preparation = prepare([result("9", "agent", false, { id: "worker-1", profile: "worker", startedAt: 1_000 })]);
		const lines = await addLedgerEdits(preparation, cwd);
		expect([...preparation.fileOps.edited]).toEqual([path.join(root, "src", "child.ts")]);
		expect(lines[0]).toContain("or 1 subagent (1 file; by subagent: ");
		const listed = /by subagent: (\S+)\)/.exec(lines[0])?.[1];
		const text = fs.readFileSync(listed!.replace(/^~/, os.homedir()), "utf8");
		expect(text).toContain("## worker-1 (1)\n- ");
		expect(text).toContain(path.join("src", "child.ts"));
	});
});
