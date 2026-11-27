import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { formatAnchor } from "@octocodeai/octocode-contracts/evidence";
import { WORKSPACE_ROUTES } from "@octocodeai/octocode-contracts/protocol";
import { registerArchiveCommand } from "../../src/octocode/archive/command.ts";
import { evidenceText, readEvidence } from "../../src/octocode/archive/evidence.ts";
import { setSessionLineage, writeSegment } from "../../src/octocode/history/archive.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { handleEvidenceRequest, localEvidence } from "../../src/octocode/workspace/evidence-route.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let cwd: string;
beforeEach(() => {
	vi.stubEnv("OCTOCODE_HOME", tmp());
	cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	registeredWorkspace(cwd);
	setCurrentSession("mine", cwd);
	setSessionLineage([]);
	writeSegment(
		{
			session: "mine",
			entry: "c1",
			tokensBefore: 1,
			method: "m",
			tldr: "t",
			topics: [],
			readFiles: [],
			modifiedFiles: [],
			messages: 1,
			entryIds: "session-entries",
		},
		"### user · 2026-11-01T10:00:00.000Z · entry e-1\n\nthe exact recorded wording\n",
	);
});
afterEach(() => {
	setCurrentSession(undefined);
	setSessionLineage([]);
	closeSharedAgentDb();
	vi.unstubAllEnvs();
});

const anchor = { kind: "archive", sessionId: "mine", segment: 1, entryId: "e-1" } as const;

async function web(query: Record<string, string>, method = "GET") {
	const replies: Array<{ status: number; body: unknown }> = [];
	const url = new URL(`http://localhost${WORKSPACE_ROUTES.evidence}?${new URLSearchParams(query)}`);
	const handled = await handleEvidenceRequest(
		{ method } as IncomingMessage,
		url,
		localEvidence(cwd),
		"s1",
		(status, body) => replies.push({ status, body }),
	);
	return { handled, ...replies[0] };
}

it("the tool path, /archive open and the web route read the same source text", async () => {
	const read = await readEvidence(cwd, anchor);
	expect(read).toMatchObject({ availability: "present", text: "the exact recorded wording" });

	const commands = new Subcommands();
	registerArchiveCommand(commands);
	const ctx = fakeCtx({ cwd, hasUI: true });
	await commands.get("archive")!.handler(`open ${formatAnchor(anchor)}`, ctx);
	expect(ctx.ui.notes.at(-1)?.message).toContain(evidenceText(read));

	const route = await web({ sessionId: "s1", anchor: formatAnchor(anchor) });
	expect(route).toMatchObject({ handled: true, status: 200, body: read });
});

it("rejects a bad anchor with a usage error and refuses other methods and sessions", async () => {
	const commands = new Subcommands();
	registerArchiveCommand(commands);
	const ctx = fakeCtx({ cwd, hasUI: true });
	await commands.get("archive")!.handler("open nonsense", ctx);
	expect(ctx.ui.notes.at(-1)).toMatchObject({ type: "warning" });
	expect(ctx.ui.notes.at(-1)?.message).toContain("Usage:");
	expect((await web({ sessionId: "s1", anchor: "nonsense" })).status).toBe(400);
	expect((await web({ sessionId: "s1", anchor: formatAnchor(anchor) }, "POST")).status).toBe(405);
	expect((await web({ sessionId: "other", anchor: formatAnchor(anchor) })).status).toBe(409);
});

it("reads an unknown anchor as missing, not as an error", async () => {
	const missing = { ...anchor, entryId: "nope" };
	expect(await web({ sessionId: "s1", anchor: formatAnchor(missing) })).toMatchObject({
		status: 200,
		body: { availability: "missing" },
	});
});
