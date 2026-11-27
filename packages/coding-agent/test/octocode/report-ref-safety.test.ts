import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveReferences } from "../../src/octocode/child-sessions/references.ts";
import { childFiles, type SessionChild } from "../../src/octocode/child-sessions/session-children.ts";
import { tmp } from "./helpers.ts";

const SECRET = "aws_secret_access_key = do-not-leak";

/** A child's scratch folder with its session folder, and a secret file the child may link but the parent must not read. */
function scratch(): { dir: string; session: string; secret: string } {
	const root = tmp();
	const dir = path.join(root, "agents", "kid");
	const session = path.join(dir, "session");
	fs.mkdirSync(session, { recursive: true });
	const secret = path.join(root, "credentials");
	fs.writeFileSync(secret, SECRET);
	return { dir, session, secret };
}

const child = (report: string): SessionChild => ({
	id: "kid",
	profile: "general",
	goal: "g",
	status: "done",
	report,
	reportText: "the report this session received",
});

const resolve = (report: string) =>
	resolveReferences(["report:kid", "report:kid"], { requester: "lead", children: () => [child(report)] });

describe("report:<id> reads only the child's own regular report.md", () => {
	it("reads a regular report.md once", async () => {
		const { dir, session } = scratch();
		fs.writeFileSync(path.join(dir, "report.md"), "full report");
		expect(childFiles({ dir: session }).report).toBe(path.join(dir, "report.md"));
		const { resolved, errors } = await resolve(path.join(dir, "report.md"));
		expect(errors).toEqual([]);
		expect(resolved).toHaveLength(1);
		expect(resolved[0].text).toContain("full report");
	});

	it("refuses a symbolic link, and never records it as the report", async () => {
		const { dir, session, secret } = scratch();
		fs.symlinkSync(secret, path.join(dir, "report.md"));
		expect(childFiles({ dir: session }).report).toBeUndefined();
		const { resolved, errors } = await resolve(path.join(dir, "report.md"));
		expect(JSON.stringify(resolved)).not.toContain("do-not-leak");
		expect(errors).toEqual([expect.stringMatching(/^report:kid: refused .*report\.md/)]);
	});

	it("refuses a hard link to a file kept elsewhere, and a folder named report.md", async () => {
		const linked = scratch();
		fs.linkSync(linked.secret, path.join(linked.dir, "report.md"));
		expect(childFiles({ dir: linked.session }).report).toBeUndefined();
		const hard = await resolve(path.join(linked.dir, "report.md"));
		expect(JSON.stringify(hard.resolved)).not.toContain("do-not-leak");
		expect(hard.errors).toEqual([expect.stringContaining("refused")]);
		const folder = scratch();
		fs.mkdirSync(path.join(folder.dir, "report.md"));
		expect(childFiles({ dir: folder.session }).report).toBeUndefined();
		expect((await resolve(path.join(folder.dir, "report.md"))).errors).toEqual([expect.stringContaining("refused")]);
	});

	it("refuses a report whose real path is outside the child's scratch folder", async () => {
		const { dir, secret } = scratch();
		const elsewhere = path.dirname(secret);
		fs.writeFileSync(path.join(elsewhere, "report.md"), SECRET);
		const linkedScratch = path.join(path.dirname(dir), "linked");
		fs.symlinkSync(elsewhere, linkedScratch);
		const { resolved, errors } = await resolve(path.join(linkedScratch, "report.md"));
		expect(JSON.stringify(resolved)).not.toContain("do-not-leak");
		expect(errors).toEqual([expect.stringContaining("refused")]);
	});

	it("falls back to the received report when the file is gone", async () => {
		const { dir } = scratch();
		const { resolved, errors } = await resolve(path.join(dir, "report.md"));
		expect(errors).toEqual([]);
		expect(resolved[0].text).toContain("the report this session received");
	});
});
