import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentEvents } from "../../../db/src/api.ts";
import { createProfiler } from "../../src/octocode/profiler/service.ts";
import { silenceTool, storedSilences } from "../../src/octocode/profiler/silences.ts";
import { openAgentDb } from "../../src/storage/database.ts";
import { registerFixtureWorkspace } from "./backlog-fixture.ts";
import { tmp } from "./helpers.ts";

const cleanup: Array<() => void> = [];
afterEach(() => {
	for (const step of cleanup.splice(0)) step();
});

function database() {
	const db = openAgentDb(path.join(tmp(), "agent.db"));
	cleanup.push(() => db.close());
	return { db, workspace: registerFixtureWorkspace(db, "repo") };
}

let next = 0;
function silent(
	db: ReturnType<typeof openAgentDb>["db"],
	workspace: string,
	name: string,
	data: Record<string, unknown>,
	time = "2026-11-20T10:00:00.000Z",
) {
	agentEvents.append(db, workspace, {
		id: `event-${++next}`,
		time,
		name,
		parentId: null,
		sessionId: null,
		type: "update",
		version: 1,
		data: { agentId: name, state: "stalled", ...data },
	});
}

describe("profiler silence episodes", () => {
	it("names what an agent waited on from its working line", () => {
		expect(silenceTool("Running bash: yarn test")).toBe("bash");
		expect(silenceTool("⚠ Checking file: src/a.ts")).toBe("file");
		expect(silenceTool("Running 3 tools: bash, file")).toBe("several tools");
		expect(silenceTool("Thinking: plan")).toBe("model");
		expect(silenceTool(undefined)).toBe("unknown");
	});

	it("groups the session's silent episodes by tool and provider in insights", () => {
		const { db, workspace } = database();
		const bash = { detail: "silent", activity: "Running bash: yarn test", model: "anthropic/claude" };
		silent(db.db, workspace, "kid-one", { ...bash, minutes: 4 });
		silent(db.db, workspace, "kid-two", { ...bash, minutes: 6 });
		silent(db.db, workspace, "kid-one", { detail: "silent", activity: "Thinking", model: "openai/gpt", minutes: 2 });
		// Not a silence episode, an agent outside the session, an episode before the session began.
		silent(db.db, workspace, "kid-one", { activity: "Running bash: x", model: "anthropic/claude", minutes: 9 });
		silent(db.db, workspace, "stranger", { ...bash, minutes: 9 });
		silent(db.db, workspace, "kid-two", { ...bash, minutes: 9 }, "2026-11-19T10:00:00.000Z");
		// A namesake of a session agent in another workspace.
		silent(db.db, registerFixtureWorkspace(db, "other"), "kid-one", { ...bash, minutes: 30 });

		const since = Date.parse("2026-11-20T00:00:00.000Z");
		const profiler = createProfiler({
			sessionId: "s1",
			self: () => ({ id: "main", role: "main", status: "idle" }),
			coordinatorFile: () => undefined,
			members: () => [
				{ id: "kid-one", role: "general", status: "working" },
				{ id: "kid-two", role: "general", status: "working" },
			],
			traffic: () => [],
			transcript: () => undefined,
			silences: (ids) => storedSilences(db.db, ids, { workspaces: [workspace] }, since),
		});
		cleanup.push(() => profiler.close());
		const found = profiler.insights().findings.filter((finding) => finding.kind === "silence");
		expect(found).toMatchObject([
			{
				id: "silence:bash:anthropic",
				waitedMs: 10 * 60_000,
				evidence: [{ agentId: "kid-two" }, { agentId: "kid-one" }],
			},
			{ id: "silence:model:openai", agentId: "kid-one", waitedMs: 2 * 60_000 },
		]);
	});
});
