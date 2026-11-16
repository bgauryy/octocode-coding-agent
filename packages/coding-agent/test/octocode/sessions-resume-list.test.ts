import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentRuns, closeSharedAgentDb } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { registerSessionsCommand } from "../../src/octocode/sessions/command.ts";
import { SessionIndex } from "../../src/octocode/sessions/store.ts";
import type { Subcommand, Subcommands } from "../../src/octocode/shared/commands.ts";
import { tmp } from "./helpers.ts";

let saved: { home?: string; db?: string };

beforeEach(() => {
	saved = { home: process.env.OCTOCODE_HOME, db: process.env.OCTOCODE_AGENT_DB };
	process.env.OCTOCODE_HOME = fs.realpathSync(tmp());
	delete process.env.OCTOCODE_AGENT_DB;
});

afterEach(() => {
	closeSharedAgentDb();
	for (const [key, value] of [
		["OCTOCODE_HOME", saved.home],
		["OCTOCODE_AGENT_DB", saved.db],
	] as const) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

/** Runs `/resume all` with no UI and returns the text it prints. */
async function listing(sessionDir: string, cwd: string): Promise<string> {
	let handler: Subcommand["handler"] | undefined;
	const commands = {
		add: (_name: string, command: Subcommand) => (handler = command.handler),
	} as unknown as Subcommands;
	const index = new SessionIndex(sharedAgentDb());
	registerSessionsCommand({} as never, commands, { index: () => index, current: () => "current-id" });
	const printed: string[] = [];
	const stderr = process.stderr.write.bind(process.stderr);
	process.stderr.write = () => true;
	try {
		const ctx = {
			hasUI: false,
			cwd,
			ui: { notify: (text: string) => printed.push(text) },
			sessionManager: {
				getSessionDir: () => sessionDir,
				getSessionId: () => "current-id",
				getSessionFile: () => undefined,
				getSessionName: () => undefined,
				getHeader: () => undefined,
				getEntries: () => [],
			},
		};
		await handler?.("all", ctx as never);
	} finally {
		process.stderr.write = stderr;
	}
	return printed.join("\n");
}

describe("/resume text list", () => {
	it("shows child agents, cost, a gone worktree and keeps branch out of the way of nothing", async () => {
		const root = fs.realpathSync(tmp("octocode-list-"));
		const gone = path.join(root, ".octocode", "worktrees", "old");
		const sessionDir = path.join(root, "sessions");
		fs.mkdirSync(sessionDir, { recursive: true });
		fs.writeFileSync(
			path.join(sessionDir, "s1.jsonl"),
			[
				{ type: "session", version: 3, id: "s1", timestamp: new Date().toISOString(), cwd: gone },
				{
					type: "message",
					id: "m1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: { role: "user", content: "do the thing", timestamp: Date.now() },
				},
			]
				.map((line) => JSON.stringify(line))
				.join("\n"),
		);
		const agent = sharedAgentDb();
		const workspace = registeredWorkspace(root, agent);
		agent.db
			.prepare("INSERT INTO sessions (id, workspace_id, cost, branch) VALUES (?, ?, ?, ?)")
			.run("s1", workspace.id, 1.84, "feature-x");
		for (const id of ["general-a", "general-b"])
			agentRuns.begin(agent.db, { workspaceId: workspace.id, agentId: id, parentSessionId: "s1", goal: "g" });

		const text = await listing(sessionDir, root);
		const line = text.split("\n").find((l) => l.includes("do the thing")) ?? "";
		expect(line).toContain("2 agents");
		expect(line).toContain("$1.84");
		expect(line).toContain("worktree old (gone)");
		expect(line).toContain("feature-x");
	});
});
