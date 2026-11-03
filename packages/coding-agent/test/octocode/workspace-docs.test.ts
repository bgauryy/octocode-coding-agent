import { fixtureBacklog } from "./backlog-fixture.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Value } from "typebox/value";
import { afterEach, expect, it } from "vitest";
import { DocsIndexSchema } from "@octocodeai/octocode-contracts/docs";
import { openAgentDb } from "../../src/config/database.ts";
import { docKind, readDocFile, readDocsIndex } from "../../src/octocode/workspace/docs.ts";
import { startWorkspaceWeb } from "../../src/octocode/workspace/server.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.reverse()) await close();
	cleanup.length = 0;
});

function docsWorkspace(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-docs-"));
	cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const write = (relative: string, content: string) => {
		const file = path.join(root, ".octocode", relative);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, content);
	};
	write("octocode-rfc-generator/demo/RFC.md", "---\nstatus: Proposed\nquestion: How?\n---\n\n# Voice\n\nSee B12.\n");
	write("audit-2026-10-27/deep/findings.md", "# Findings\n");
	write("plans/step.md", "no heading here");
	write("agent-system-prompts.md", "# Prompts\n");
	write("skills/octocode-research/skill.md", "# Skill output\n");
	write("tmp/scratch.md", "# Scratch\n");
	write("notes.txt", "not markdown");
	write(".hidden/secret.md", "# Hidden\n");
	return root;
}

it("exposes runtime Markdown exports and opted-in agent scratch while keeping private session data out", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-docs-runtime-"));
	cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const state = path.join(root, ".octa", "code");
	fs.mkdirSync(path.join(state, "temp", "agents"), { recursive: true });
	fs.mkdirSync(path.join(state, "session-data"), { recursive: true });
	fs.writeFileSync(path.join(state, "backlog.md"), "# Board");
	fs.writeFileSync(path.join(state, "temp", "agents", "report.md"), "# Handoff");
	fs.writeFileSync(path.join(state, "session-data", "private.md"), "# Private");
	expect(readDocsIndex(root).docs.map((doc) => doc.path)).toEqual([".octa/code/backlog.md"]);
	const handoff = ".octa/code/temp/agents/report.md";
	expect(readDocsIndex(root, true).docs.map((doc) => doc.path)).toContain(handoff);
	expect(readDocFile(root, handoff)).toBeUndefined();
	expect(readDocFile(root, handoff, true)?.markdown).toBe("# Handoff");
	expect(readDocFile(root, ".octa/code/session-data/private.md", true)).toBeUndefined();
});

it("lists every Markdown document with kind, title, status and date, except skills/ and tmp/", () => {
	const root = docsWorkspace();
	const index = readDocsIndex(root);
	expect(Value.Check(DocsIndexSchema, index)).toBe(true);
	expect(index.docs.map((doc) => doc.path).sort()).toEqual([
		"agent-system-prompts.md",
		"audit-2026-10-27/deep/findings.md",
		"octocode-rfc-generator/demo/RFC.md",
		"plans/step.md",
	]);
	const rfc = index.docs.find((doc) => doc.kind === "rfc")!;
	expect(rfc).toMatchObject({ title: "Voice", status: "Proposed", question: "How?", topic: "octocode-rfc-generator" });
	expect(rfc.updated).toMatch(/^\d{4}-\d{2}-\d{2}T/);
	expect(index.docs.find((doc) => doc.path === "plans/step.md")).toMatchObject({ kind: "plan", title: "step" });
	expect(index.docs.find((doc) => doc.path === "agent-system-prompts.md")).toMatchObject({ kind: "report", topic: "" });
	expect(index.truncated).toBe(false);
	expect(readDocsIndex(root, true).docs.map((doc) => doc.path)).toContain("tmp/scratch.md");
	expect(docKind("audit-2026-10-27/x.md")).toBe("audit");
	expect(docKind("misc/contract.md")).toBe("contract");
});

it("serves only regular files inside .octocode, never through a symlink or an escaping path", () => {
	const root = docsWorkspace();
	const outside = fs.mkdtempSync(path.join(os.tmpdir(), "docs-outside-"));
	cleanup.push(() => fs.rmSync(outside, { recursive: true, force: true }));
	fs.writeFileSync(path.join(outside, "secret.md"), "# Secret\n");
	const base = path.join(root, ".octocode");
	fs.symlinkSync(path.join(outside, "secret.md"), path.join(base, "plans", "link.md"));
	fs.symlinkSync(outside, path.join(base, "linked-dir"));
	expect(readDocFile(root, "plans/step.md")?.markdown).toBe("no heading here");
	for (const attempt of [
		"plans/link.md",
		"linked-dir/secret.md",
		"../secret.md",
		"plans/../../secret.md",
		"/etc/passwd.md",
		"plans/step.md\0.txt",
		"notes.txt",
		".hidden/secret.md",
		"skills/octocode-research/skill.md",
		"tmp/scratch.md",
		"plans\\step.md",
		"plans",
	])
		expect(readDocFile(root, attempt), attempt).toBeUndefined();
	expect(readDocFile(root, "tmp/scratch.md", true)?.markdown).toBe("# Scratch\n");
	expect(readDocsIndex(root).docs.some((doc) => doc.path.includes("link"))).toBe(false);
});

it("serves the library and the Mermaid script only through the authenticated board routes", async () => {
	const repoRoot = docsWorkspace();
	const db = openAgentDb(path.join(repoRoot, "db"));
	cleanup.push(() => db.close());
	const web = await startWorkspaceWeb({
		store: fixtureBacklog(() => db, "repo"),
		actor: { id: "parent" },
		session: "session",
		repoName: "repo",
		repoRoot,
	});
	cleanup.push(() => web.close());
	const url = new URL(web.url);
	const headers = { Authorization: `Bearer ${url.hash.slice(8)}` };
	for (const route of ["/api/docs", "/api/docs/file?path=plans/step.md", "/api/docs/mermaid"])
		expect((await fetch(`${url.origin}${route}`)).status, route).toBe(401);
	const index = (await (await fetch(`${url.origin}/api/docs`, { headers })).json()) as { docs: { path: string }[] };
	expect(index.docs).toHaveLength(4);
	const file = await fetch(`${url.origin}/api/docs/file?path=octocode-rfc-generator/demo/RFC.md`, { headers });
	expect(((await file.json()) as { markdown: string }).markdown).toContain("# Voice");
	for (const bad of ["../x.md", "skills/octocode-research/skill.md", "tmp/scratch.md"])
		expect((await fetch(`${url.origin}/api/docs/file?path=${encodeURIComponent(bad)}`, { headers })).status, bad).toBe(
			404,
		);
	expect((await fetch(`${url.origin}/api/docs/file?path=tmp/scratch.md&tmp=1`, { headers })).status).toBe(200);
	expect((await fetch(`${url.origin}/api/docs`, { method: "POST", headers, body: "{}" })).status).toBe(405);
	const mermaid = (await (await fetch(`${url.origin}/api/docs/mermaid`, { headers })).json()) as { script: string };
	expect(mermaid.script.length).toBeGreaterThan(1_000_000);
	expect(mermaid.script).toContain("mermaid");
});
