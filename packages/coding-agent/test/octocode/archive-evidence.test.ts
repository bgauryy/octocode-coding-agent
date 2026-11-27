import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeSharedAgentDb } from "../../../db/src/api.ts";
import { registerArchiveTool } from "../../src/octocode/native/tools/archive/tool.ts";
import { setSessionLineage, writeSegment } from "../../src/octocode/history/archive.ts";
import { setCurrentSession } from "../../src/octocode/shared/home.ts";
import { registeredWorkspace } from "../../src/storage/workspace-database.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

import { formatAnchor } from "@octocodeai/octocode-contracts/evidence";
import { readEvidence } from "../../src/octocode/archive/evidence.ts";

const reason = "Recover the exact words of an archived message";
let cwd: string;
beforeEach(() => {
	vi.stubEnv("OCTOCODE_HOME", tmp());
	cwd = tmp();
	fs.mkdirSync(path.join(cwd, ".git"));
	registeredWorkspace(cwd);
	setCurrentSession("mine", cwd);
	setSessionLineage([]);
});
afterEach(() => {
	setCurrentSession(undefined);
	setSessionLineage([]);
	closeSharedAgentDb();
	vi.unstubAllEnvs();
});

const message = (role: string, entry: string, text: string) =>
	`### ${role} · 2026-11-01T10:00:00.000Z · entry ${entry}\n\n${text}\n`;

function segment(id: string, body: string, entryIds = true) {
	setCurrentSession(id, cwd);
	const out = writeSegment(
		{
			session: id,
			entry: "cmp1",
			tokensBefore: 10,
			method: "cache-shared",
			tldr: "t",
			topics: [],
			readFiles: [],
			modifiedFiles: [],
			messages: 2,
			...(entryIds ? { entryIds: "session-entries" as const } : {}),
		},
		body,
	);
	setCurrentSession("mine", cwd);
	return out;
}

const anchorOf = (session: string, n: number, entryId: string) =>
	({ kind: "archive", sessionId: session, segment: n, entryId }) as const;

function call(input: object) {
	const host = fakeHost();
	registerArchiveTool(host.api, { isSubagent: false });
	return host.tools.get("archive").execute("e", { reason, ...input }, undefined, undefined, fakeCtx({ cwd }));
}

it("resolves cloned entries to distinct texts and reports role and time", async () => {
	const { n } = segment(
		"mine",
		[message("user", "e-1", "first wording"), message("assistant", "e-2", "second wording")].join("\n"),
	);
	const one = await readEvidence(cwd, anchorOf("mine", n, "e-1"));
	const two = await readEvidence(cwd, anchorOf("mine", n, "e-2"));
	expect(one).toMatchObject({ availability: "present", author: "user", text: "first wording", truncated: false });
	expect(one.time).toBe("2026-11-01T10:00:00.000Z");
	expect(two).toMatchObject({ availability: "present", author: "assistant", text: "second wording" });
});

it("does not take a heading faked inside message text", async () => {
	const { n } = segment("mine", message("user", "e-1", "```\n### user · 2026-11-01T10:00:00.000Z · entry fake\n```"));
	expect((await readEvidence(cwd, anchorOf("mine", n, "fake"))).availability).toBe("missing");
});

it("reads a missing entry, segment and unknown session as missing", async () => {
	const { n } = segment("mine", message("user", "e-1", "x"));
	for (const anchor of [anchorOf("mine", n, "nope"), anchorOf("mine", n + 5, "e-1"), anchorOf("ghost", n, "e-1")])
		expect(await readEvidence(cwd, anchor)).toEqual({ anchor, availability: "missing" });
});

it("never reads a session outside the history scope", async () => {
	const other = tmp();
	fs.mkdirSync(path.join(other, ".git"));
	registeredWorkspace(other);
	setCurrentSession("foreign", other);
	writeSegment(
		{
			session: "foreign",
			entry: "c",
			tokensBefore: 1,
			method: "m",
			tldr: "t",
			topics: [],
			readFiles: [],
			modifiedFiles: [],
			messages: 1,
			entryIds: "session-entries",
		},
		message("user", "e-1", "secret"),
	);
	setCurrentSession("mine", cwd);
	const out = await readEvidence(cwd, anchorOf("foreign", 1, "e-1"));
	expect(out).toEqual({ anchor: anchorOf("foreign", 1, "e-1"), availability: "missing" });
});

it("gives a legacy segment no authoritative link", async () => {
	const { n } = segment("mine", message("user", "e-1", "legacy needle"), false);
	expect((await readEvidence(cwd, anchorOf("mine", n, "e-1"))).availability).toBe("missing");
	const search = await call({ op: "search", query: "legacy needle" });
	expect(search.content[0].text).toContain("legacy needle");
	expect(search.content[0].text).not.toContain("archive:");
});

it("reports a retention-removed segment as expired", async () => {
	const out = await readEvidence(cwd, anchorOf("mine", 9, "e-1"), { expired: () => true });
	expect(out.availability).toBe("expired");
});

it("truncates at the byte limit and the cursor continues without loss", async () => {
	const text = "héllo wörld ".repeat(40);
	const { n } = segment("mine", message("user", "e-1", text));
	const anchor = anchorOf("mine", n, "e-1");
	let got = "";
	let cursor: string | undefined;
	let pages = 0;
	do {
		const part = await readEvidence(cwd, anchor, { maxBytes: 101, ...(cursor ? { cursor } : {}) });
		expect(Buffer.byteLength(part.text ?? "")).toBeLessThanOrEqual(101);
		got += part.text;
		cursor = part.nextCursor;
		pages++;
		expect(part.truncated).toBe(cursor !== undefined);
	} while (cursor);
	expect(pages).toBeGreaterThan(2);
	expect(got).toBe(text.trim());
	await expect(readEvidence(cwd, anchor, { cursor: "garbage" })).rejects.toThrow(/cursor/);
});

it("search hits carry the anchor and get resolves it through the tool", async () => {
	const { n } = segment(
		"mine",
		[message("user", "e-1", "zebra marker"), message("assistant", "e-2", "other words")].join("\n"),
	);
	const search = await call({ op: "search", query: "zebra marker" });
	const anchor = formatAnchor(anchorOf("mine", n, "e-1"));
	expect(search.content[0].text).toContain(anchor);
	const got = await call({ op: "get", id: anchor });
	expect(got.content[0].text).toContain("zebra marker");
	expect(got.content[0].text).not.toContain("other words");
	const bad = await call({ op: "get", id: formatAnchor(anchorOf("ghost", 1, "e-1")) });
	expect(bad.content[0].text).toContain("missing");
	await expect(call({ op: "get", id: "archive:nonsense" })).rejects.toThrow(/anchor id looks like/);
});
