import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerBacklog } from "../../src/octocode/backlog/index.ts";
import { BacklogStore } from "../../src/octocode/backlog/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { sharedAgentDb } from "../../src/storage/database.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { backlogToolName } from "./backlog-fixture.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

let tmp: string;
let savedDb: string | undefined;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "octo-merge-gate-")));
	savedDb = process.env.OCTOCODE_AGENT_DB;
	process.env.OCTOCODE_AGENT_DB = path.join(tmp, "home", "octocode.db");
});

afterEach(() => {
	closeSharedAgentDb();
	if (savedDb === undefined) delete process.env.OCTOCODE_AGENT_DB;
	else process.env.OCTOCODE_AGENT_DB = savedDb;
	fs.rmSync(tmp, { recursive: true, force: true });
});

async function setup() {
	const fake = fakeHost();
	registerBacklog(fake.api, { commands: new Subcommands(), isSubagent: false });
	const cwd = path.join(tmp, "repo");
	fs.mkdirSync(cwd, { recursive: true });
	const git = (command: string) => execSync(command, { cwd, stdio: "ignore" });
	git("git init -q && git -c user.email=t@t -c user.name=t commit -q --allow-empty -m base");
	git("git update-ref refs/octocode/kid-1 HEAD");
	const text = async (params: Record<string, unknown>) =>
		(
			(await fake.tools
				.get(backlogToolName(params.op))
				.execute("id", params, undefined, undefined, fakeCtx({ cwd }))) as { content: Array<{ text: string }> }
		).content[0].text;
	await text({ op: "add", items: [{ title: "work", goal: "work done", why: "needed", state: "todo" }] });
	await text({ op: "claim", id: "B1" });
	const agent = sharedAgentDb();
	const store = new BacklogStore(() => agent, registeredWorkspace(cwd, agent).id);
	const item = store.get("B1")!;
	store.update(
		"B1",
		{
			links: [
				...item.links,
				{ relation: "output", target: { resource: "files", repositoryKey: store.repo, path: "refs/octocode/kid-1" } },
			],
		},
		{ id: "test" },
	);
	return { text, git };
}

const completion = { summary: "did it", verification: "passed: unit test" };

describe("completing an item with an isolated change", () => {
	it("refuses done while the linked ref is unmerged, and allows it once the ref is gone", async () => {
		const { text, git } = await setup();
		await expect(text({ op: "done", id: "B1", completion })).rejects.toThrow(/unmerged \(refs\/octocode\/kid-1\)/);
		git("git update-ref -d refs/octocode/kid-1");
		expect(await text({ op: "done", id: "B1", completion })).toMatch(/^Updated B1 \[done/);
	});

	it("still allows closing abandoned work", async () => {
		const { text } = await setup();
		expect(await text({ op: "close", id: "B1", close: { kind: "wont_do", text: "dropped" } })).toMatch(/^Updated B1/);
	});
});
