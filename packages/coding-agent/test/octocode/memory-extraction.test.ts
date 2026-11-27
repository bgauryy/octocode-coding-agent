import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import {
	checkpointCandidates,
	listCandidates,
	noticedLines,
	queueCandidates,
} from "../../src/octocode/memory/file/candidates.ts";
import { memoryStore } from "../../src/octocode/memory/store.ts";
import { batchEntries } from "../../src/octocode/shared/batch.ts";
import { tmp } from "./helpers.ts";

// A checkpoint as the summarizer wrote it in session 01a1ff01: fragments, resolved items and per-run status among the lessons.
const SUMMARY = `## Goal
Build the audit fixes.

## Constraints & Preferences
- User vision for the RFC, all already in it:
- Never run a full suite beside another one; the machine is under swap pressure.
- [x] Lint clean on packages/db
- Known lint and type issues to resolve in \`check\`:
  - none
- (none)

## Key Decisions
- Fixed the flaky db test by closing the shared handle in afterEach.
- Children report through the agent tool, never by writing files in the coordinator's tree.
- Resolved: the lockfile conflict.
- Next: run the e2e suite.
- Keep the release notes in CHANGELOG.md, one line per change.

## Errors & Fixes
- oxlint rejects a cycle that only imports types, so move the shared type to a leaf module.
- Typecheck passes now.
`;

const REPORT = `done. Merged the item.

Noticed:
- I did not touch files/bash-jobs/
- none
- The fixture loader caches files across tests, so edits need a restart of the runner.
- Everything else is unchanged:
For coordinator: merge`;

describe("extraction keeps only durable whole sentences", () => {
	it("saves the lessons of a checkpoint and drops fragments, resolved items and status", () => {
		expect(checkpointCandidates(SUMMARY).map((c) => c.text)).toEqual([
			"Never run a full suite beside another one; the machine is under swap pressure.",
			"Children report through the agent tool, never by writing files in the coordinator's tree.",
			"Keep the release notes in CHANGELOG.md, one line per change.",
			"oxlint rejects a cycle that only imports types, so move the shared type to a leaf module.",
		]);
	});

	it("saves only the durable Noticed line of a report", () => {
		expect(noticedLines(REPORT)).toEqual([
			"The fixture loader caches files across tests, so edits need a restart of the runner.",
		]);
	});
});

describe("queueing", () => {
	let root: string;
	beforeEach(() => {
		root = tmp("memextract-");
		fs.mkdirSync(path.join(root, "repo"), { recursive: true });
		vi.stubEnv("OCTOCODE_AGENT_DB", path.join(root, "agent.db"));
	});
	afterEach(() => {
		closeSharedAgentDb();
		vi.unstubAllEnvs();
	});

	it("updates a near-duplicate candidate instead of adding another", () => {
		const store = memoryStore(path.join(root, "repo"));
		const item = (text: string, evidence: string) => ({
			text,
			kind: "decision" as const,
			origin: "checkpoint" as const,
			evidence,
		});
		queueCandidates(
			store,
			[item("Use yarn for every install; npm rewrites the lockfile.", "session s1, entry a")],
			"s1",
		);
		queueCandidates(
			store,
			[item("Use yarn for every install, since npm rewrites the lockfile.", "session s1, entry b")],
			"s1",
		);
		const queued = listCandidates(store);
		expect(queued).toHaveLength(1);
		expect(queued[0]?.title).toBe("Use yarn for every install, since npm rewrites the lockfile.");
		expect(queued[0]?.body).toContain("entry b");
	});
});

describe("a batch delete reply", () => {
	it("is a count and the ids, not every body", async () => {
		const bodies = ["M1", "M2", "M3"].map((id) => `Deleted ${id} (workspace, fact) Title — ${"x".repeat(300)}`);
		const reply = await batchEntries(
			bodies,
			(_, i) => `M${i + 1}`,
			(text) => ({ content: [{ type: "text", text }] }),
			{
				operation: "delete",
				verb: "Deleted",
				condense: (rows) => rows.map((row) => /^Deleted (\S+)/.exec(row)?.[1]).join(", "),
			},
		);
		expect(reply.content[0]).toMatchObject({ text: "Deleted 3 of 3: M1, M2, M3." });
	});
});
