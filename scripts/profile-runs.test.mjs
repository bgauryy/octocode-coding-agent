import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createBenchmarkEnv } from "./profile-runs.mjs";

test("an isolated run keeps its agent dir, Octocode home and agent database under the temporary root", () => {
	const root = join("/tmp", "octocode-startup-benchmark-x");
	const env = createBenchmarkEnv({ mode: "rpc" }, root);
	assert.equal(env.OCTOCODE_CODING_AGENT_DIR, join(root, "agent"));
	assert.equal(env.OCTOCODE_HOME, join(root, "home"));
	assert.equal(env.OCTOCODE_AGENT_DB, join(root, "home", "agent", "workspaces.db"));
});

test("a run with a named agent dir does not move the home or the database", () => {
	const previous = { home: process.env.OCTOCODE_HOME, db: process.env.OCTOCODE_AGENT_DB };
	delete process.env.OCTOCODE_HOME;
	delete process.env.OCTOCODE_AGENT_DB;
	try {
		const env = createBenchmarkEnv({ mode: "rpc", agentDir: "/somewhere" }, undefined);
		assert.equal(env.OCTOCODE_CODING_AGENT_DIR, "/somewhere");
		assert.equal(env.OCTOCODE_HOME, undefined);
		assert.equal(env.OCTOCODE_AGENT_DB, undefined);
	} finally {
		if (previous.home !== undefined) process.env.OCTOCODE_HOME = previous.home;
		if (previous.db !== undefined) process.env.OCTOCODE_AGENT_DB = previous.db;
	}
});
