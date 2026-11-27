import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getFileStamp } from "@octocodeai/octocode-common/paths";
import { PARENT_SESSION_ENV, TEAM_WORKSPACE_ENV } from "@octocodeai/octocode-common/env";
import { agentEvents, closeSharedAgentDb, sessions, transcripts } from "../../../db/src/api.ts";
import { validateToolArguments } from "../../../ai/src/utils/validation.ts";
import { registerArchiveTool } from "../../src/octocode/native/tools/archive/tool.ts";
import { archiveFolder, setSessionLineage, writeSegment } from "../../src/octocode/history/archive.ts";
import { writeSessionRecord } from "../../src/octocode/history/archive/record.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace, workspaceDb } from "../../src/storage/workspace-database.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

const reason = "Recover the selected session's decisions and tool failures";
let cwd: string;
let counter = 0;
beforeEach(() => {
	vi.stubEnv("OCTOCODE_HOME", tmp());
	cwd = workspace();
	setCurrentSession("parent", cwd);
	setSessionLineage([]);
});
afterEach(() => {
	setCurrentSession(undefined);
	setSessionLineage([]);
	closeSharedAgentDb();
	vi.unstubAllEnvs();
});

function workspace(): string {
	const dir = tmp();
	fs.mkdirSync(path.join(dir, ".git"));
	return dir;
}

function tool(subagent = false) {
	const host = fakeHost();
	registerArchiveTool(host.api, { isSubagent: subagent });
	return host.tools.get("archive");
}

function call(input: object, subagent = false, signal?: AbortSignal) {
	return tool(subagent).execute(`scope-${counter++}`, { reason, ...input }, signal, undefined, fakeCtx({ cwd }));
}

function result(text: string, isError: boolean) {
	const id = `entry-${counter++}`;
	return {
		type: "message",
		id,
		timestamp: "2026-11-01T10:00:00.000Z",
		message: {
			role: "toolResult",
			toolName: "file",
			toolCallId: `call-${id}`,
			content: [{ type: "text", text }],
			isError,
		},
	};
}

function session(
	id: string,
	body: string,
	options: { parent?: string; root?: string; results?: ReturnType<typeof result>[] } = {},
) {
	const root = options.root ?? cwd;
	const workspaceId = registeredWorkspace(root).id;
	setCurrentSession(id, root);
	writeSegment(
		{
			session: id,
			entry: `segment-${id}`,
			tokensBefore: 1000,
			method: "cache-shared",
			tldr: body,
			topics: [],
			readFiles: [],
			modifiedFiles: [],
			messages: 1,
		},
		body,
	);
	const entries = options.results ?? [];
	const transcript = path.join(process.env.OCTOCODE_HOME!, `${id}.jsonl`);
	fs.writeFileSync(transcript, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
	const db = sharedAgentDb();
	sessions.bind(db.db, id, workspaceId);
	db.mirror.transaction(() =>
		transcripts.save(
			db.mirror.db,
			id,
			transcript,
			JSON.stringify({ type: "session", id, cwd: root }),
			getFileStamp(transcript),
			entries.map((entry) => ({ id: entry.id, parentId: null, type: entry.type, json: JSON.stringify(entry) })),
			0,
		),
	);
	writeSessionRecord({
		session: id,
		repository: workspaceId,
		workspace: root,
		transcript,
		goal: { role: "user", text: `goal of ${id}` },
		ending: [],
		toolCalls: entries.length,
		...(options.parent ? { parent: options.parent } : {}),
	});
	setCurrentSession("parent", cwd);
}

function family() {
	session("parent", "cobalt parent_marker", {
		results: [result("parent refusal", true), result("parent success", false)],
	});
	session("child", "cobalt child_marker", {
		parent: "parent",
		results: [result("child refusal", true), result("child success", false)],
	});
	session("unrelated", "cobalt unrelated_marker", { results: [result("unrelated refusal", true)] });
}

it("refuses a schema-valid child event get while preserving the coordinator getter", async () => {
	const { agent, workspace } = workspaceDb(cwd);
	agentEvents.append(agent.db, workspace.id, {
		id: "event-guard",
		time: new Date(0).toISOString(),
		name: "coordinator",
		parentId: null,
		sessionId: "parent",
		type: "init",
		data: { marker: "coordinator event" },
		version: 1,
	});
	const child = tool(true);
	const input = { reason, op: "get", id: "event:event-guard" };
	validateToolArguments(child, { type: "toolCall", id: "child-get", name: "archive", arguments: input } as never);
	await expect(child.execute("child-get", input, undefined, undefined, fakeCtx({ cwd }))).rejects.toThrow(
		/main session only/,
	);
	expect((await call(input)).content[0].text).toContain("coordinator event");
});

it.each(["parent", "current"])(
	"keeps parent and child regex hits and excludes unrelated sessions for %s",
	async (sessionId) => {
		family();
		const out = await call({ op: "search", source: "sessions", sessionId, query: "cobalt" });
		expect(out.content[0].text).toContain("parent_marker");
		expect(out.content[0].text).toContain("child_marker");
		expect(out.content[0].text).not.toContain("unrelated_marker");
	},
);

it.each(["parent", "current"])(
	"keeps parent and child ranked hits and excludes unrelated sessions for %s",
	async (sessionId) => {
		family();
		const out = await call({ op: "search", source: "sessions", sessionId, keywords: "cobalt" });
		expect(out.content[0].text).toContain("parent_marker");
		expect(out.content[0].text).toContain("child_marker");
		expect(out.content[0].text).not.toContain("unrelated_marker");
	},
);

it.each(["parent", "current"])(
	"scopes error samples and rate denominators to the selected family for %s",
	async (sessionId) => {
		family();
		const out = await call({ op: "search", source: "sessions", sessionId, errors: true });
		expect(out.content[0].text).toContain("2 tool errors in 4 tool results (50.0%)");
		expect(out.content[0].text).toContain("parent refusal");
		expect(out.content[0].text).toContain("child refusal");
		expect(out.content[0].text).not.toContain("unrelated refusal");
		expect(out.details).toMatchObject({ hits: 2, files: 2 });
	},
);

it("intersects an error file target with the selected family", async () => {
	family();
	const out = await call({
		op: "search",
		source: "sessions",
		sessionId: "parent",
		errors: true,
		file: archiveFolder("unrelated"),
	});
	expect(out.details).toMatchObject({ hits: 0, files: 0 });
	expect(out.content[0].text).not.toContain("unrelated refusal");
});

it("does not bypass the session filter when a search file target belongs to another session", async () => {
	family();
	const folder = archiveFolder("unrelated");
	const file = path.join(
		folder,
		fs.readdirSync(folder).find((name) => name.startsWith("1-"))!,
	);
	const out = await call({ op: "search", source: "sessions", sessionId: "parent", query: "cobalt", file });
	expect(out.content[0].text).not.toContain("unrelated_marker");
	expect(out.content[0].text).toContain("No line matches");
});

it("preserves explicit inherited parent access from a separate child workspace", async () => {
	const parentRoot = cwd;
	session("parent", "cobalt parent_marker");
	session("parent-neighbor", "cobalt unrelated_marker");
	cwd = workspace();
	session("worktree-child", "cobalt own_marker", { parent: "parent" });
	setCurrentSession("worktree-child", cwd);
	vi.stubEnv(PARENT_SESSION_ENV, "parent");
	vi.stubEnv(TEAM_WORKSPACE_ENV, parentRoot);
	const out = await call({ op: "search", source: "sessions", sessionId: "parent", query: "cobalt" }, true);
	expect(out.content[0].text).toContain("parent_marker");
	expect(out.content[0].text).not.toContain("unrelated_marker");
	const own = await call({ op: "search", source: "sessions", sessionId: "current", query: "cobalt" }, true);
	expect(own.content[0].text).toContain("own_marker");
	expect(own.content[0].text).not.toContain("parent_marker");
});

it("preserves readable extra archive files without a session filter or session record", async () => {
	const folder = archiveFolder();
	fs.mkdirSync(folder, { recursive: true });
	const file = path.join(folder, "LIBRARY.md");
	fs.writeFileSync(file, "cobalt extra_marker\n");
	const out = await call({ op: "search", source: "sessions", query: "cobalt", file });
	expect(out.content[0].text).toContain("extra_marker");
});

it("preserves cancellation before a scoped archive read", async () => {
	const controller = new AbortController();
	controller.abort(new Error("cancelled scope read"));
	await expect(
		call({ op: "search", source: "sessions", sessionId: "current", query: "cobalt" }, false, controller.signal),
	).rejects.toThrow("cancelled scope read");
});
