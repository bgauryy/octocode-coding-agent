import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerArchiveTool } from "../../src/octocode/native/tools/archive/tool.ts";
import { saveCompaction } from "../../src/octocode/archive/summaries.ts";
import { writeSessionRecord } from "../../src/octocode/history/archive/record.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let cwd: string;
beforeEach(() => {
	vi.stubEnv("OCTOCODE_HOME", tmp());
	cwd = workspace();
	setCurrentSession("parent", cwd);
});
afterEach(() => {
	setCurrentSession(undefined);
	closeSharedAgentDb();
	vi.unstubAllEnvs();
});

function workspace(): string {
	const root = tmp();
	fs.mkdirSync(path.join(root, ".git"));
	return root;
}

function seed(id: string, root = cwd, record = true) {
	saveCompaction(sharedAgentDb(), root, id, {
		type: "compaction",
		id: `entry-${id}`,
		parentId: null,
		timestamp: "2026-11-01T00:00:00.000Z",
		summary: `cobalt ${id}_retained_marker`,
		firstKeptEntryId: "kept",
		tokensBefore: 100,
	});
	if (!record) return;
	setCurrentSession(id, root);
	writeSessionRecord({
		session: id,
		repository: registeredWorkspace(root).id,
		workspace: root,
		goal: { role: "user", text: `goal ${id}` },
		ending: [],
		toolCalls: 0,
		...(id === "child" ? { parent: "parent" } : {}),
	});
	setCurrentSession("parent", cwd);
}

function call(input: object) {
	const host = fakeHost();
	registerArchiveTool(host.api);
	return host.tools.get("archive").execute(
		"retained",
		{
			reason: "Recover decisions in the selected session's retained summaries",
			...input,
		},
		undefined,
		undefined,
		fakeCtx({ cwd }),
	);
}

it.each([
	["compactions", "parent"],
	["compactions", "current"],
	["sessions", "parent"],
	["sessions", "current"],
])("filters retained %s to the explicit/current family for %s", async (source, sessionId) => {
	for (const id of ["parent", "child", "unrelated"]) seed(id);
	const out = await call({
		op: "search",
		source,
		sessionId,
		query: source === "compactions" ? "cobalt" : "parent|child|unrelated",
	});
	const prefix = source === "compactions" ? "compaction:" : "session:";
	expect(out.content[0].text).toContain(`${prefix}parent`);
	expect(out.content[0].text).toContain(`${prefix}child`);
	expect(out.content[0].text).not.toContain(`${prefix}unrelated`);
	expect(out.content[0].text).not.toContain("unrelated_retained_marker");
});

it.each(["compactions", "sessions"])(
	"filters retained %s before the page limit and continues with its opaque cursor",
	async (source) => {
		for (const id of ["parent", "child", "unrelated"]) seed(id);
		const input = {
			op: "search",
			source,
			sessionId: "current",
			query: source === "compactions" ? "cobalt" : "parent|child|unrelated",
			limit: 1,
		};
		const first = await call(input);
		expect(first.details.hits).toBe(1);
		expect(first.details.nextCursor).toMatch(/^a2\./);
		const second = await call({ ...input, cursor: first.details.nextCursor });
		expect(second.details.hits).toBe(1);
		expect(second.details.nextCursor).toBeUndefined();
		const text = `${first.content[0].text}\n${second.content[0].text}`;
		const prefix = source === "compactions" ? "compaction:" : "session:";
		expect(text).toContain(`${prefix}parent`);
		expect(text).toContain(`${prefix}child`);
		expect(text).not.toContain(`${prefix}unrelated`);
	},
);

it.each(["parent", "current"])(
	"recovers retained summaries without detail files or records using %s",
	async (sessionId) => {
		for (const id of ["parent", "child", "unrelated"]) seed(id, cwd, false);
		const out = await call({ op: "list", source: "compactions", sessionId });
		expect(out.details.hits).toBe(1);
		expect(out.content[0].text).toContain("compaction:parent:");
		expect(out.content[0].text).not.toContain("compaction:child:");
		expect(out.content[0].text).not.toContain("compaction:unrelated:");
	},
);

it.each(["compactions", "sessions"])(
	"intersects the session filter with workspace visibility for %s",
	async (source) => {
		seed("parent");
		seed("foreign", workspace());
		const out = await call({ op: "search", source, sessionId: "foreign", query: "foreign" });
		expect(out.details.hits).toBe(0);
		expect(out.content[0].text).not.toContain("foreign_retained_marker");
	},
);

it("binds a supplied session ID as data", async () => {
	seed("parent");
	const out = await call({ op: "list", source: "compactions", sessionId: "parent' OR 1=1 --" });
	expect(out.details.hits).toBe(0);
	expect(out.content[0].text).not.toContain("compaction:parent:");
});
