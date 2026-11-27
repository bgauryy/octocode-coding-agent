import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getNativeSkillsDir } from "../../src/config.ts";

const script = path.join(getNativeSkillsDir(), "resume-external-harness", "scripts", "sessions.mjs");
const hasSqlite = spawnSync("sqlite3", ["-version"]).status === 0;
const slug = (dir: string) => dir.replace(/[^A-Za-z0-9]/g, "-");
const jsonl = (rows: unknown[]) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
const write = (file: string, text: string | Buffer) => {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, text);
};

const CLAUDE_ID = "11111111-1111-4111-8111-111111111111";
const CLAUDE_WT_ID = "22222222-2222-4222-8222-222222222222";
const CODEX_ID = "01a1ba84-cc23-7af0-aa1d-44efce643218";
const CODEX_ZST_ID = "01a1ba84-dddd-7af0-aa1d-44efce643218";
const CODEX_GONE_ID = "01a1ba84-eeee-7af0-aa1d-44efce643218";
const CODEX_OTHER_ID = "01a1ba84-ffff-7af0-aa1d-44efce643218";
const OCTO_ID = "01a21320-0000-7000-8000-000000000001";

describe("resume-external-harness sessions script", () => {
	let home: string;
	let repo: string;
	const git = (cwd: string, ...args: string[]) => {
		const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-C", cwd, ...args], {
			encoding: "utf8",
		});
		if (result.status !== 0) throw new Error(result.stderr);
		return result.stdout.trim();
	};
	const run = (...args: string[]) => {
		const result = spawnSync(process.execPath, [script, ...args, "--cwd", repo], {
			encoding: "utf8",
			env: {
				...process.env,
				HOME: home,
				CLAUDE_CONFIG_DIR: "",
				CODEX_HOME: "",
				XDG_CONFIG_HOME: "",
				OCTOCODE_SESSION_ID: OCTO_ID,
			},
		});
		return { ...result, json: () => JSON.parse(result.stdout) };
	};

	beforeAll(() => {
		home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "resume-harness-")));
		repo = path.join(home, "code", "repo");
		fs.mkdirSync(path.join(repo, "sub"), { recursive: true });
		git(repo, "init", "-q", "-b", "main");
		write(path.join(repo, "a.txt"), "a\n");
		git(repo, "add", ".");
		git(repo, "commit", "-qm", "init");
		const feature = path.join(home, "code", "repo-feature");
		git(repo, "worktree", "add", "-q", "-b", "feature", feature);
		write(path.join(feature, "b.txt"), "b\n");
		git(feature, "add", ".");
		git(feature, "commit", "-qm", "feature work");
		git(repo, "worktree", "add", "-q", "-b", "done", path.join(home, "code", "repo-done"));
		const gone = path.join(home, "code", "repo-gone");
		git(repo, "worktree", "add", "-q", "-b", "gone", gone);
		fs.rmSync(gone, { recursive: true, force: true });
		// A folder a harness made for this repository that git no longer lists.
		write(
			path.join(home, ".cursor", "worktrees", "repo", "stray", ".git"),
			`gitdir: ${path.join(repo, ".git", "worktrees", "stray")}\n`,
		);

		const at = (minute: number) => `2026-01-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
		write(
			path.join(home, ".claude", "projects", slug(repo), `${CLAUDE_ID}.jsonl`),
			jsonl([
				{
					type: "user",
					cwd: repo,
					gitBranch: "main",
					timestamp: at(0),
					message: { content: "<task-notification>noise</task-notification>" },
				},
				{
					type: "user",
					cwd: repo,
					isMeta: true,
					timestamp: at(0),
					message: { content: "Base directory for this skill" },
				},
				{
					type: "user",
					cwd: repo,
					timestamp: at(1),
					message: { content: "Fix the parser; token sk-abcdefghijklmnopqrstuvwxyz123456" },
				},
				{
					type: "assistant",
					cwd: repo,
					timestamp: at(5),
					message: {
						content: [
							{ type: "text", text: "Editing the parser now." },
							{ type: "tool_use", name: "Edit", input: { file_path: path.join(repo, "parser.ts") } },
						],
					},
				},
				{ type: "ai-title", aiTitle: "Parser fix" },
				{ type: "user", cwd: repo, isSidechain: true, timestamp: at(6), message: { content: "subagent prompt" } },
			]),
		);
		write(
			path.join(home, ".claude", "projects", slug(feature), `${CLAUDE_WT_ID}.jsonl`),
			jsonl([{ type: "user", cwd: feature, timestamp: at(10), message: { content: "Build the feature" } }]),
		);

		const rollout = (id: string, cwd: string, extra: unknown[] = []) =>
			jsonl([
				{
					type: "session_meta",
					payload: {
						id,
						cwd,
						timestamp: at(20),
						git: { branch: "main" },
						base_instructions: { text: "x".repeat(30000) },
					},
				},
				{
					type: "response_item",
					timestamp: at(20),
					payload: {
						type: "message",
						role: "user",
						content: [{ type: "input_text", text: "<environment_context>cwd</environment_context>" }],
					},
				},
				{
					type: "response_item",
					timestamp: at(21),
					payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Add the export command" }] },
				},
				...extra,
			]);
		const day = path.join(home, ".codex", "sessions", "2026", "01", "01");
		write(
			path.join(day, `rollout-2026-01-01T10-20-00-${CODEX_ID}.jsonl`),
			rollout(CODEX_ID, path.join(repo, "sub"), [
				{
					type: "response_item",
					timestamp: at(25),
					payload: {
						type: "custom_tool_call",
						name: "apply_patch",
						input: "*** Begin Patch\n*** Add File: src/export.ts\n+x\n*** End Patch",
					},
				},
				{
					type: "response_item",
					timestamp: at(26),
					payload: { type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "yarn test" }) },
				},
				{ type: "compacted", timestamp: at(27), payload: { message: "Summary: export command half done" } },
				{
					type: "response_item",
					timestamp: at(30),
					payload: {
						type: "message",
						role: "assistant",
						content: [{ type: "output_text", text: "Tests still fail in export.ts" }],
					},
				},
			]),
		);
		write(
			path.join(day, `rollout-2026-01-01T10-20-00-${CODEX_GONE_ID}.jsonl`),
			rollout(CODEX_GONE_ID, path.join(home, "code", "repo-gone")),
		);
		write(
			path.join(day, `rollout-2026-01-01T10-20-00-${CODEX_OTHER_ID}.jsonl`),
			rollout(CODEX_OTHER_ID, path.join(home, "elsewhere")),
		);
		// A compressed rollout, as Codex writes many of them.
		write(
			path.join(day, `rollout-2026-01-01T10-20-00-${CODEX_ZST_ID}.jsonl.zst`),
			zlib.zstdCompressSync(Buffer.from(rollout(CODEX_ZST_ID, repo))),
		);
		write(path.join(home, ".codex", "session_index.jsonl"), jsonl([{ id: CODEX_ID, thread_name: "Export command" }]));
		write(
			path.join(home, ".codex", "external_agent_session_imports.json"),
			JSON.stringify({ records: [{ imported_thread_id: CODEX_ZST_ID, source_path: "/claude/original.jsonl" }] }),
		);

		write(
			path.join(home, ".cursor", "projects", slug(repo).replace(/^-+/, ""), "agent-transcripts", "cur-1.jsonl"),
			jsonl([
				{
					role: "user",
					message: { content: [{ type: "text", text: "<user_query>\nTidy the README\n</user_query>" }] },
				},
				{ role: "assistant", message: { content: [{ type: "text", text: "Done." }] } },
			]),
		);
		// Sessions of a sibling project whose name starts with the repository's.
		write(
			path.join(
				home,
				".cursor",
				"projects",
				`${slug(repo).replace(/^-+/, "")}-old`,
				"agent-transcripts",
				"cur-old.jsonl",
			),
			jsonl([{ role: "user", message: { content: "old project" } }]),
		);
	});

	afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

	it("lists the repository's and its worktrees' sessions with timing and location, and nothing else", () => {
		const result = run("list", "--json", "--limit", "50");
		expect(result.status, result.stderr).toBe(0);
		const sessions = result.json().sessions as Array<Record<string, any>>;
		const refs = sessions.map((s) => `${s.harness}:${s.id}`).sort();
		const expected = [
			`claude:${CLAUDE_ID}`,
			`claude:${CLAUDE_WT_ID}`,
			`codex:${CODEX_ID}`,
			`codex:${CODEX_GONE_ID}`,
			"cursor:cur-1",
			`codex:${CODEX_ZST_ID}`,
		];
		expect(refs).toEqual(expected.sort());
		const byId = new Map(sessions.map((s) => [s.id, s]));
		expect(byId.get(CLAUDE_ID)).toMatchObject({
			title: "Parser fix",
			userTurns: 1,
			resume: { command: `claude --resume ${CLAUDE_ID}`, cwd: repo },
		});
		expect(byId.get(CLAUDE_ID)?.timing).toMatchObject({ ran: "5m", live: false });
		expect(byId.get(CLAUDE_WT_ID)?.scope).toMatchObject({ kind: "worktree", branch: "feature" });
		expect(byId.get(CODEX_ID)).toMatchObject({
			title: "Export command",
			userTurns: 1,
			resume: { command: `codex resume ${CODEX_ID}` },
		});
		expect(byId.get(CODEX_GONE_ID)?.scope).toMatchObject({ kind: "worktree", missing: true });
		expect(byId.get(CODEX_ZST_ID)).toMatchObject({
			importedFrom: "/claude/original.jsonl",
			timing: { ran: "unknown (imported copy)" },
		});
		// The transcript file was just written: the other tool may still be running it.
		expect(byId.get("cur-1")?.timing.live).toBe(true);

		const text = run("list").stdout;
		expect(text).toContain("LIVE?");
		expect(text).toContain("folder deleted");
		expect(text).toContain(
			`restore the worktree first (\`git worktree add ${path.join(home, "code", "repo-gone")} gone\`)`,
		);
		expect(
			run("list", "--json", "--root-only")
				.json()
				.sessions.map((s: { id: string }) => s.id),
		).not.toContain(CLAUDE_WT_ID);
	});

	it("shows a digest without injected records or credentials", () => {
		const text = run("show", `claude:${CLAUDE_ID}`).stdout;
		expect(text).toContain("# claude:" + CLAUDE_ID + " - Parser fix");
		expect(text).toContain(`- ${path.join(repo, "parser.ts")}`);
		expect(text).toContain("User: Fix the parser; token [redacted]");
		expect(text).toContain("Edit " + path.join(repo, "parser.ts"));
		expect(text).not.toMatch(/sk-abcdef|task-notification|Base directory|subagent prompt/);

		const codex = run("show", CODEX_ID, "--json").json();
		expect(codex.latestSummary).toBe("Summary: export command half done");
		expect(codex.filesEdited).toEqual(["src/export.ts"]);
		expect(codex.turns).toEqual([
			{
				turn: 1,
				user: "Add the export command",
				assistant: "Tests still fail in export.ts",
				tools: ["apply_patch src/export.ts", "exec_command yarn test"],
			},
		]);
		expect(run("show", "latest", "--harness", "cursor", "--json").json().turns[0]).toMatchObject({
			user: "Tidy the README",
			assistant: "Done.",
		});
		expect(run("show", `codex:${CODEX_OTHER_ID}`).status).toBe(1);
	});

	it("reports each worktree's state, its sessions and a suggested action", () => {
		const result = run("worktrees", "--json");
		expect(result.status, result.stderr).toBe(0);
		const { base, worktrees } = result.json();
		expect(base).toBe("main");
		const byName = new Map((worktrees as Array<Record<string, any>>).map((tree) => [path.basename(tree.path), tree]));
		expect(byName.get("repo")?.kind).toBe("root");
		expect(byName.get("repo-feature")).toMatchObject({ ahead: 1, changedFiles: 0, advice: { state: "unmerged" } });
		expect(byName.get("repo-feature")?.sessions.map((s: { id: string }) => s.id)).toEqual([CLAUDE_WT_ID]);
		expect(byName.get("repo-done")?.advice).toMatchObject({ state: "merged" });
		expect(byName.get("repo-done")?.advice.action).toContain("git worktree remove");
		expect(byName.get("repo-gone")).toMatchObject({ missing: true, advice: { state: "dangling" } });
		expect(byName.get("repo-gone")?.advice.action).toContain("git worktree prune");
		expect(byName.get("repo-gone")?.sessions.map((s: { id: string }) => s.id)).toEqual([CODEX_GONE_ID]);
		expect(byName.get("stray")).toMatchObject({
			kind: "unregistered",
			gitdirExists: false,
			advice: { state: "dangling" },
		});
		expect(byName.get("stray")?.advice.action).toContain("git worktree repair");
	});

	it("names every place it searched", () => {
		const text = run("locations").stdout;
		expect(text).toContain(`found   Claude Code projects: ${path.join(home, ".claude", "projects")}`);
		expect(text).toContain("Codex sessions");
		expect(text).toContain("Cursor CLI chats");
		expect(text).toContain(`worktree: ${path.join(home, "code", "repo-feature")}`);
	});

	it.skipIf(!hasSqlite)("reads Cursor CLI chat databases and gives their resume command", () => {
		const db = path.join(home, ".cursor", "chats", createHash("md5").update(repo).digest("hex"), "chat-9", "store.db");
		fs.mkdirSync(path.dirname(db), { recursive: true });
		const hex = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("hex");
		const sql = [
			"create table meta (key text, value text);",
			"create table blobs (id text, data blob);",
			`insert into meta values ('0', '${hex({ name: "CLI chat", createdAt: 1767261600000 })}');`,
			`insert into blobs values ('a', X'${hex({ role: "user", content: [{ type: "text", text: "<user_query>Ship it</user_query>" }] })}');`,
			"insert into blobs values ('b', X'0a0b0c');",
			`insert into blobs values ('c', X'${hex({ role: "assistant", content: "Shipped." })}');`,
		].join("\n");
		expect(spawnSync("sqlite3", [db], { input: sql }).status).toBe(0);
		const listed = run("list", "--json", "--harness", "cursor")
			.json()
			.sessions.find((s: { id: string }) => s.id === "chat-9");
		expect(listed).toMatchObject({
			title: "CLI chat",
			source: "cli",
			resume: { command: "cursor-agent --resume chat-9" },
		});
		expect(run("show", "cursor:chat-9", "--json").json().turns).toEqual([
			{ turn: 1, user: "Ship it", assistant: "Shipped.", tools: [] },
		]);
	});

	it("reads Octocode sessions of the workspace and marks the one running the script", () => {
		const at = (second: number) => `2026-01-01T10:00:${String(second).padStart(2, "0")}.000Z`;
		const message = (second: number, role: string, content: unknown) => ({
			type: "message",
			timestamp: at(second),
			message: { role, content },
		});
		write(
			path.join(repo, ".octocode", "agent", "sessions", `2026-01-01T10-00-00-000Z_${OCTO_ID}.jsonl`),
			jsonl([
				{ type: "session", version: 3, id: OCTO_ID, timestamp: at(0), cwd: repo },
				{ type: "custom_message", timestamp: at(1), customType: "backlog-digest", content: "Backlog: 3 open" },
				message(2, "user", [{ type: "text", text: "[src terminal:terminal ✓proven via terminal] t4\nAdd a flag" }]),
				message(3, "assistant", [
					{ type: "text", text: "Adding it." },
					{ type: "toolCall", name: "file", arguments: { queries: [{ type: "edit", path: "src/cli.ts" }] } },
				]),
				{ type: "compaction", timestamp: at(4), summary: "## Goal\nAdd a flag" },
				{ type: "session_info", timestamp: at(5), name: "CLI flag" },
			]),
		);
		const [listed] = run("list", "--json", "--harness", "octocode").json().sessions;
		expect(listed).toMatchObject({
			id: OCTO_ID,
			title: "CLI flag",
			userTurns: 1,
			source: "this session",
			startedAt: at(0),
			updatedAt: at(5),
			resume: { command: `octocode --resume ${OCTO_ID}`, cwd: repo },
		});
		const shown = run("show", `octocode:${OCTO_ID}`, "--json").json();
		expect(shown).toMatchObject({ filesEdited: ["src/cli.ts"], latestSummary: "## Goal\nAdd a flag" });
		expect(shown.turns).toEqual([{ turn: 1, user: "Add a flag", assistant: "Adding it.", tools: ["file src/cli.ts"] }]);
	});

	it.skipIf(!hasSqlite)("reads Antigravity conversations, skips subagents and appends prompts not yet indexed", () => {
		const agy = path.join(home, ".gemini", "antigravity-cli");
		fs.mkdirSync(agy, { recursive: true });
		const first = "Fix ✓ bug";
		const at = "2026-01-01 10:00:00+00:00";
		const sql = [
			"create table conversation_summaries (conversation_id text, title text, preview text, workspace_uris text, last_modified_time text, last_user_input_time text, parent_conversation_id text);",
			"create table conversations_fts (conversation_id text, chunk_index integer, user_body text, agent_body text, user_step_byte_offsets text, agent_step_byte_offsets text);",
			`insert into conversation_summaries values ('agy-1', 'Bug fix', '', '["file://${repo}"]', '${at}', '${at}', '');`,
			`insert into conversation_summaries values ('agy-child', '', '', '["file://${repo}"]', '${at}', '', 'agy-1');`,
			`insert into conversation_summaries values ('agy-away', 'Away', '', '["file://${path.join(home, "elsewhere")}"]', '${at}', '${at}', '');`,
			`insert into conversations_fts values ('agy-1', -1, '', '', '', '');`,
			`insert into conversations_fts values ('agy-1', 0, '${first}Then docs', 'Looking.Fixed.', '[[0,0],[2,${Buffer.byteLength(first)}]]', '[[1,0],[3,8]]');`,
		].join("\n");
		expect(spawnSync("sqlite3", [path.join(agy, "conversation_summaries.db")], { input: sql }).status).toBe(0);
		const prompt = (display: string, minute: number) => ({
			display,
			timestamp: Date.parse(`2026-01-01T09:${minute}:00Z`),
			workspace: repo,
			conversationId: "agy-1",
		});
		write(
			path.join(agy, "history.jsonl"),
			jsonl([prompt(first, 10), prompt("/model", 20), prompt("Then docs", 30), prompt("Add tests", 40)]),
		);
		const listed = run("list", "--json", "--harness", "agy").json().sessions;
		expect(listed).toHaveLength(1);
		expect(listed[0]).toMatchObject({
			id: "agy-1",
			title: "Bug fix",
			userTurns: 3,
			startedAt: "2026-01-01T09:10:00.000Z",
			updatedAt: "2026-01-01T10:00:00.000Z",
			resume: { command: "agy --conversation agy-1", cwd: repo },
		});
		expect(run("show", "agy:agy-1", "--json").json().turns).toEqual([
			{ turn: 1, user: first, assistant: "Looking.", tools: [] },
			{ turn: 2, user: "Then docs", assistant: "Fixed.", tools: [] },
			{ turn: 3, user: "Add tests", assistant: "", tools: [] },
		]);
	});

	it.skipIf(!hasSqlite)(
		"shows an Antigravity conversation by id from outside the repository, with tools and the error it stopped on",
		() => {
			const agy = path.join(home, ".gemini", "antigravity-cli");
			const id = "agy-away";
			const away = path.join(home, "elsewhere");
			const hex = (text: string) => Buffer.from(`\u0004\u0008${text}\u0001HTTP 429 Too Many Requests`).toString("hex");
			const sql = [
				"create table steps (idx integer primary key, step_type integer, status integer, error_details blob, step_payload blob);",
				"insert into steps values (0, 14, 3, null, x'00');",
				`insert into steps values (1, 17, 3, null, x'${hex("RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 5m.")}');`,
			].join("\n");
			write(path.join(agy, "conversations", `${id}.db`), "");
			expect(spawnSync("sqlite3", [path.join(agy, "conversations", `${id}.db`)], { input: sql }).status).toBe(0);
			write(
				path.join(agy, "brain", id, ".system_generated", "logs", "transcript.jsonl"),
				jsonl([
					{
						step_index: 0,
						type: "USER_INPUT",
						source: "USER_EXPLICIT",
						content: "<USER_REQUEST>\nAudit caching\n</USER_REQUEST>\n<ADDITIONAL_METADATA>x</ADDITIONAL_METADATA>",
					},
					{
						step_index: 1,
						type: "PLANNER_RESPONSE",
						source: "MODEL",
						content: null,
						tool_calls: [{ name: "read_file", args: { Path: JSON.stringify("/x/a.rs") } }],
					},
					{ step_index: 2, type: "GENERIC", source: "MODEL", content: "Created At: result text" },
					{ step_index: 3, type: "PLANNER_RESPONSE", source: "MODEL", content: "Found two leaks." },
					{ step_index: 4, type: "SYSTEM_MESSAGE", source: "SYSTEM", content: "notice" },
				]),
			);
			const shown = run("show", `agy:${id}`, "--json").json();
			expect(shown.session).toMatchObject({ id, cwd: away, outside: true });
			expect(shown.totalTurns).toBe(1);
			expect(shown.turns).toEqual([
				{ turn: 1, user: "Audit caching", assistant: "Found two leaks.", tools: ["read_file /x/a.rs"] },
			]);
			expect(shown.lastAssistantMessage).toBe("Found two leaks.");
			expect(shown.lastError).toBe("RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 5m.");
			const text = run("show", `agy:${id}`).stdout;
			expect(text).toContain(`workspace ${away} (outside this repository)`);
			expect(text).toContain("## Run ended with an error");
			expect(
				run("list", "--json", "--harness", "agy")
					.json()
					.sessions.map((s: { id: string }) => s.id),
			).not.toContain(id);
		},
	);
});
