import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { registerMemory } from "../../src/octocode/memory/register.ts";
import { memoryStore } from "../../src/octocode/memory/store.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";

let root: string;
let cwd: string;

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octo-start-recall-"));
	cwd = path.join(root, "repo");
	fs.mkdirSync(cwd);
	vi.stubEnv("OCTOCODE_HOME", path.join(root, "home"));
	vi.stubEnv("OCTOCODE_AGENT_DB", "");
	vi.stubEnv("OCTOCODE_MEMORY_AUTO", "");
});

afterEach(() => {
	closeSharedAgentDb();
	vi.unstubAllEnvs();
	fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
	const fake = fakeHost();
	registerMemory(fake.api, { commands: new Subcommands(), isSubagent: false, permission: fakePermission() });
	const ctx = fakeCtx({ cwd, hasUI: true, mode: "rpc" });
	Object.assign(ctx, { isProjectTrusted: () => true });
	Object.assign(ctx.sessionManager, { getBranch: () => [] });
	return {
		ctx,
		start: (prompt: string) =>
			fake.fire(
				"before_agent_start",
				{ systemPromptOptions: { sections: {}, contextFiles: [] }, prompt },
				ctx,
			) as Promise<any>,
	};
}

describe("start recall by the active item's goal", () => {
	it("recalls a memory that only the goal matches; with no active item nothing changes", async () => {
		memoryStore(cwd).set({ title: "Parquet exporter quirks", body: "flush before close", author: "agent" });
		const none = setup();
		expect(await none.start("continue please")).toBeUndefined();

		const { ctx, start } = setup();
		const { store } = openBacklog(ctx, { isSubagent: false });
		const item = store.add({ title: "Exports", goal: "Fix the parquet exporter", createdBy: "t" });
		expect(await start("continue please")).toBeUndefined();
		store.update(
			item.ref,
			{ state: "ongoing", why: "Exports lose rows" },
			{ id: ctx.sessionManager.getSessionId(), surface: "tool" },
		);
		const result = await start("continue please");
		expect(result.message.details.ids).toEqual([1]);
	});
});
