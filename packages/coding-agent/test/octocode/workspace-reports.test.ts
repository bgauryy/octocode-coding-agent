import { fixtureBacklog } from "./backlog-fixture.ts";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AGENT_DIR } from "../../src/storage/agent-layout.ts";
import { Value } from "typebox/value";
import { afterEach, expect, it } from "vitest";
import { ReportFileSchema, ReportsIndexSchema } from "@octocodeai/octocode-contracts/protocol";
import { openAgentDb } from "../../src/storage/database.ts";
import { readReportFile, readReportsIndex } from "../../src/octocode/workspace/reports.ts";
import { startWorkspaceWeb } from "../../src/octocode/workspace/server.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const close of cleanup.reverse()) await close();
	cleanup.length = 0;
});

function reportWorkspace(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-reports-"));
	cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const write = (folder: string, name: string, content: string) => {
		fs.mkdirSync(path.join(root, AGENT_DIR, folder, "demo"), { recursive: true });
		fs.writeFileSync(path.join(root, AGENT_DIR, folder, "demo", name), content);
	};
	write(
		"octocode-rfc-generator",
		"RFC.md",
		"---\nstatus: Proposed\nconfidence: medium\nquestion: How should voice work?\n---\n\n# Spoken agent conversations\n\nBody.\n",
	);
	write("octocode-rfc-generator", "appendix-engine.md", "# Appendix\nDetail.");
	write("octocode-research", "brief.md", "---\nquestion: Who calls buildSystemPrompt?\n---\n\n# Prompt callers\n");
	fs.mkdirSync(path.join(root, AGENT_DIR, "octocode-brainstorming", "tmp"), { recursive: true });
	fs.writeFileSync(path.join(root, AGENT_DIR, "octocode-brainstorming", "tmp", "scratch.md"), "# Scratch");
	return root;
}

it("indexes report folders with their kind, frontmatter and documents, skipping scratch", () => {
	const root = reportWorkspace();
	const index = readReportsIndex(root);
	expect(index.reports).toHaveLength(2);
	expect(Value.Check(ReportsIndexSchema, index)).toBe(true);
	const rfc = index.reports.find((report) => report.kind === "rfc");
	expect(rfc).toMatchObject({
		id: "demo",
		kind: "rfc",
		title: "Spoken agent conversations",
		status: "Proposed",
		confidence: "medium",
		question: "How should voice work?",
		files: [{ name: "RFC.md" }, { name: "appendix-engine.md" }],
	});
	expect(index.reports.find((report) => report.kind === "research")).toMatchObject({
		id: "demo",
		title: "Prompt callers",
		question: "Who calls buildSystemPrompt?",
	});
	// The brainstorm source dir exists but only contains scratch, so it lists nothing.
	expect(index.reports.some((report) => report.kind === "brainstorm")).toBe(false);
});

it("serves only files a report's own index lists, never arbitrary paths", () => {
	const root = reportWorkspace();
	expect(readReportFile(root, "demo", "rfc", "RFC.md")).toMatchObject({
		id: "demo",
		kind: "rfc",
		file: "RFC.md",
		markdown: expect.stringContaining("# Spoken agent conversations"),
	});
	expect(readReportFile(root, "demo", "rfc", "appendix-engine.md")?.markdown).toContain("# Appendix");
	// Ids repeat across kinds: the research brief must be found even though the RFC scanned first.
	expect(readReportFile(root, "demo", "research", "brief.md")).toMatchObject({
		id: "demo",
		kind: "research",
		file: "brief.md",
	});
	expect(readReportFile(root, "demo", "rfc", "brief.md")).toBeUndefined();
	expect(readReportFile(root, "demo", "rfc", "package.json")).toBeUndefined();
	expect(readReportFile(root, "demo", "rfc", "../other/RFC.md")).toBeUndefined();
	expect(readReportFile(root, "missing", "rfc", "RFC.md")).toBeUndefined();
	expect(readReportFile(root, "..", "rfc", "db")).toBeUndefined();
});

it("opens the selected document when id and filename are duplicated across kinds", () => {
	const root = reportWorkspace();
	// The demo folder exists for both rfc and research; RFC.md only exists under rfc, brief.md only under research.
	// Create an RFC.md in the research folder too so id+filename is duplicated.
	fs.writeFileSync(
		path.join(root, AGENT_DIR, "octocode-research", "demo", "RFC.md"),
		"---\nquestion: Overlapping\n---\n\n# Research RFC\n",
	);
	const rfcFile = readReportFile(root, "demo", "rfc", "RFC.md");
	const researchFile = readReportFile(root, "demo", "research", "RFC.md");
	expect(rfcFile?.markdown).toContain("# Spoken agent conversations");
	expect(researchFile?.markdown).toContain("# Research RFC");
	expect(rfcFile?.kind).toBe("rfc");
	expect(researchFile?.kind).toBe("research");
	expect(Value.Check(ReportFileSchema, rfcFile)).toBe(true);
	expect(Value.Check(ReportFileSchema, researchFile)).toBe(true);
});

it("rejects .md symlinks and keeps reads inside report folders", () => {
	const root = reportWorkspace();
	const outside = path.join(root, "outside-secret.md");
	fs.writeFileSync(outside, "# secret");
	const link = path.join(root, AGENT_DIR, "octocode-rfc-generator", "demo", "escape.md");
	fs.symlinkSync(outside, link);
	const index = readReportsIndex(root);
	expect(index.reports.find((report) => report.kind === "rfc")?.files.some((file) => file.name === "escape.md")).toBe(
		false,
	);
	expect(readReportFile(root, "demo", "rfc", "escape.md")).toBeUndefined();
	expect(fs.readFileSync(outside, "utf8")).toBe("# secret");
});

it("parses CRLF frontmatter", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-reports-crlf-"));
	cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, AGENT_DIR, "octocode-rfc-generator", "demo"), { recursive: true });
	fs.writeFileSync(
		path.join(root, AGENT_DIR, "octocode-rfc-generator", "demo", "RFC.md"),
		"---\r\nstatus: Accepted\r\nconfidence: high\r\nquestion: Will it work?\r\n---\r\n\r\n# CRLF report\r\n",
	);
	const index = readReportsIndex(root);
	expect(index.reports[0]).toMatchObject({
		status: "Accepted",
		confidence: "high",
		question: "Will it work?",
		title: "CRLF report",
	});
});

it("skips fenced code and frontmatter when finding the first heading", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-reports-heading-"));
	cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
	fs.mkdirSync(path.join(root, AGENT_DIR, "octocode-research", "demo"), { recursive: true });
	fs.writeFileSync(
		path.join(root, AGENT_DIR, "octocode-research", "demo", "brief.md"),
		"---\nquestion: heading parsing\n---\n\n```\n# code sample\n```\n\nbody\n---\n# Actual title\n",
	);
	const index = readReportsIndex(root);
	expect(index.reports[0].title).toBe("Actual title");
});

it("truncates generated payloads to schema bounds", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-reports-bounds-"));
	cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
	const longTitle = "T".repeat(500);
	const longStatus = "S".repeat(100);
	fs.mkdirSync(path.join(root, AGENT_DIR, "octocode-rfc-generator", "demo"), { recursive: true });
	fs.writeFileSync(
		path.join(root, AGENT_DIR, "octocode-rfc-generator", "demo", "RFC.md"),
		`---\nstatus: ${longStatus}\n---\n\n# ${longTitle}\n`,
	);
	for (let i = 0; i < 40; i++) {
		fs.writeFileSync(path.join(root, AGENT_DIR, "octocode-rfc-generator", "demo", `extra-${i}.md`), `# Extra ${i}`);
	}
	const index = readReportsIndex(root);
	expect(Value.Check(ReportsIndexSchema, index)).toBe(true);
	expect(index.reports[0].title).toHaveLength(300);
	expect(index.reports[0].status).toHaveLength(40);
	expect(index.reports[0].files).toHaveLength(32);
});

it("skips identifiers that cannot be represented losslessly in the contracts schema", () => {
	const root = reportWorkspace();
	const longFile = `${"f".repeat(129)}.md`;
	fs.writeFileSync(path.join(root, AGENT_DIR, "octocode-rfc-generator", "demo", longFile), "# Too long");
	const longId = "i".repeat(129);
	fs.mkdirSync(path.join(root, AGENT_DIR, "octocode-research", longId), { recursive: true });
	fs.writeFileSync(path.join(root, AGENT_DIR, "octocode-research", longId, "brief.md"), "# Too long");
	const index = readReportsIndex(root);
	expect(Value.Check(ReportsIndexSchema, index)).toBe(true);
	expect(index.reports.find((report) => report.kind === "rfc")?.files.some((file) => file.name === longFile)).toBe(
		false,
	);
	expect(index.reports.some((report) => report.id === longId || report.id === longId.slice(0, 128))).toBe(false);
	expect(readReportFile(root, "demo", "rfc", longFile)).toBeUndefined();
});

it("serves reports only through the authenticated board routes", async () => {
	const repoRoot = reportWorkspace();
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
	expect((await fetch(`${url.origin}/api/reports`)).status).toBe(401);
	const index = await fetch(`${url.origin}/api/reports`, { headers });
	expect(index.status).toBe(200);
	const body = (await index.json()) as { reports: { id: string; kind: string; files: { name: string }[] }[] };
	expect(body.reports).toHaveLength(2);
	const file = await fetch(`${url.origin}/api/reports/file?id=demo&kind=rfc&name=RFC.md`, { headers });
	expect(file.status).toBe(200);
	expect(await file.json()).toMatchObject({ id: "demo", kind: "rfc", file: "RFC.md" });
	expect((await fetch(`${url.origin}/api/reports/file?id=demo&kind=research&name=RFC.md`, { headers })).status).toBe(
		404,
	);
	expect((await fetch(`${url.origin}/api/reports/file?id=demo&kind=rfc&name=secrets.md`, { headers })).status).toBe(
		404,
	);
	expect((await fetch(`${url.origin}/api/reports/file?id=..&kind=rfc&name=db`, { headers })).status).toBe(404);
	expect((await fetch(`${url.origin}/api/reports`, { method: "POST", headers, body: "{}" })).status).toBe(405);
});
