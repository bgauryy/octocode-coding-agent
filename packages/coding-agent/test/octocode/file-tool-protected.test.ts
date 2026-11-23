import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { registerFileTool } from "../../src/octocode/native/tools/file/tool.ts";
import { shellTargetAccess } from "../../src/octocode/permission/file-access.ts";
import { sha256 } from "../../../common/src/atomic-file.ts";
import { fakeCtx, fakeHost, fakePermission } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { headlessFileTool } from "./permission-file-harness.ts";

/** A fresh repository, canonical (macOS puts the temporary folder behind `/var` -> `/private/var`). */
function repo(): string {
	const dir = fs.realpathSync(tmp("file-protected-"));
	execFileSync("git", ["init", "-q", dir]);
	return dir;
}

const S = "\u017f";

describe("the file tool's protected names, however they are spelled", () => {
	// Each pair: the spelling the agent writes, and the file a later session loads (the same one on APFS and NTFS).
	const cases: Array<[string, string]> = [
		[`.octocode/${S}ettings.json`, ".octocode/settings.json"],
		[`.mcp.j${S}on`, ".mcp.json"],
		[`.octocode/hook${S}.json`, ".octocode/hooks.json"],
		[`vendor/lib/.git/hook${S}/pre-commit`, "vendor/lib/.git/hooks/pre-commit"],
	];

	it.each(cases)("asks in workspace mode for %s, as for %s", async (spelled, loaded) => {
		const root = repo();
		expect(await headlessFileTool("workspace", root).write(loaded)).toMatch(/runs in later sessions/);
		expect(await headlessFileTool("workspace", root).write(spelled)).toMatch(/runs in later sessions/);
		expect(fs.existsSync(path.join(root, loaded))).toBe(false);
	});

	it.each([
		`.octocode/agent/${S}essions/a.jsonl`,
		".octocode/agent/se\u00dfions/a.jsonl",
		".OCTOCODE/AGENT/SESSIONS/a.jsonl",
	])("refuses %s in the state folder in full mode", async (spelled) => {
		const root = repo();
		expect(await headlessFileTool("full", root).write(spelled)).toMatch(/state folder/);
		expect(fs.existsSync(path.join(root, ".octocode/agent/sessions/a.jsonl"))).toBe(false);
	});

	it("keeps the plain spelling refused after a folded folder was planted", async () => {
		const root = repo();
		const tool = headlessFileTool("full", root);
		expect(await tool.write(`.octocode/agent/${S}essions/seed.txt`)).toMatch(/state folder/);
		fs.mkdirSync(path.join(root, `.octocode/agent/${S}essions`), { recursive: true });
		expect(await tool.write(".octocode/agent/sessions/b.jsonl")).toMatch(/state folder/);
	});

	it("asks before changing an instruction file at the root or below it, and lets full mode change it", async () => {
		const root = repo();
		const files = ["AGENTS.md", "AGENTS.override.md", "CLAUDE.md", "sub/AGENTS.md", "pkg/deep/CLAUDE.md"];
		for (const file of files)
			expect(await headlessFileTool("workspace", root).write(file), file).toMatch(/runs in later sessions/);
		for (const file of files) expect(fs.existsSync(path.join(root, file)), file).toBe(false);
		for (const file of files) expect(await headlessFileTool("full", root).write(file), file).toBeUndefined();
		expect(await headlessFileTool("workspace", root).write("docs/guide.md")).toBeUndefined();
	});

	it.each([
		".octocode/SYSTEM.md",
		".octocode/system.md",
		".octocode/append_\u017fy\u017ftem.md",
		".octocode/models.json",
	])("asks in workspace mode before changing %s, which a later session loads", async (file) => {
		const root = repo();
		expect(await headlessFileTool("workspace", root).write(file)).toMatch(/runs in later sessions/);
		expect(fs.existsSync(path.join(root, file))).toBe(false);
	});

	it("treats a shell write the same way", () => {
		const root = repo();
		const write = (raw: string) => shellTargetAccess({ kind: "write", raw, path: raw, position: 0 }, root);
		for (const raw of ["AGENTS.md", "sub/CLAUDE.md", `.octocode/${S}ettings.json`, `.mcp.j${S}on`])
			expect(write(raw), raw).toMatchObject({ protected: true, action: "file.outside" });
		expect(write(`.octocode/agent/${S}essions/x.jsonl`).refusal).toMatch(/state folder/);
		expect(write("src/a.ts")).toMatchObject({ protected: false, action: undefined });
	});
});

describe("credential and state stores outside the Octocode home", () => {
	const home = os.homedir();
	const stores = () => [
		path.join(process.env.OCTOCODE_CODING_AGENT_DIR!, "auth.json"),
		path.join(process.env.OCTOCODE_CODING_AGENT_DIR!, "settings.json"),
		path.join(home, ".pi", "agent", "auth.json"),
		path.join(home, ".pi", "agent", "models.json"),
		path.join(home, ".octocode", "auth.json"),
		path.join(home, ".octocode", "mcp-auth.json"),
		path.join(home, ".octocode", "octocodecode", "auth.json"),
		path.join(home, ".octocode", "agents-communication", "communication.sqlite"),
	];

	it.each(["full", "bypass"] as const)("refuses each in %s mode, by path and through `~`", async (mode) => {
		// HOME is a temporary folder here (setup-env.ts): these are the default stores a later session reads.
		const root = repo();
		const tool = headlessFileTool(mode, root);
		for (const file of stores()) {
			expect(await tool.write(file, '{"anthropic":{"key":"x"}}\n'), file).toMatch(/state folder/);
			expect(fs.existsSync(file), file).toBe(false);
		}
		expect(await tool.write("~/.pi/agent/auth.json")).toMatch(/state folder/);
		// Pi's other files are an outside change, which full mode allows.
		const notes = path.join(home, ".pi", "agent", "notes.txt");
		expect(await tool.write(notes)).toBeUndefined();
		fs.rmSync(notes);
	});
});

describe("a change approved for one place lands nowhere else", () => {
	it("refuses an outside write whose folder became a link into the Octocode home while the dialog was open", async () => {
		const root = repo();
		const target = path.join(fs.realpathSync(tmp("file-outside-")), "drop");
		fs.mkdirSync(target);
		const octocodeHome = process.env.OCTOCODE_HOME!;
		const fake = fakeHost();
		registerFileTool(fake.api, new FileGuard(), fakePermission("workspace", { api: fake.api }));
		const ctx = fakeCtx({ cwd: root, ui: { selects: ["Allow once"] } });
		const select = ctx.ui.select.bind(ctx.ui);
		// While the user reads the dialog, another process swaps the approved folder for a link into the Octocode home.
		ctx.ui.select = async (...args: Parameters<typeof select>) => {
			fs.rmSync(target, { recursive: true });
			fs.symlinkSync(octocodeHome, target);
			return select(...args);
		};
		const query = { reason: "r", type: "write", path: path.join(target, "settings.json"), content: '{"hooks":1}\n' };
		await expect(
			fake.tools.get("file")!.execute("c", { reason: "r", queries: [query] }, undefined, undefined, ctx),
		).rejects.toThrow(/File target identity changed after approval/);
		expect(fs.existsSync(path.join(octocodeHome, "settings.json"))).toBe(false);
	});
});

describe("a byte order mark", () => {
	it("survives a patch, which matches the text after it", async () => {
		const cwd = repo();
		const fake = fakeHost();
		const guard = new FileGuard();
		registerFileTool(fake.api, guard, fakePermission("full", { api: fake.api }));
		const file = path.join(cwd, "bom.txt");
		const original = "\ufeffline one\r\nline two\r\nline three\r\n";
		fs.writeFileSync(file, original);
		guard.record(file, { sha256: sha256(original), size: Buffer.byteLength(original) });
		const patch =
			"*** Begin Patch\n*** Update File: bom.txt\n@@\n line one\n-line two\n+line 2\n line three\n*** End Patch\n";
		const result = await fake.tools
			.get("file")!
			.execute("c", { reason: "r", patch }, undefined, undefined, fakeCtx({ cwd, hasUI: false }));
		expect(result.content[0].text).toMatch(/OK/);
		expect(fs.readFileSync(file, "utf8")).toBe("\ufeffline one\r\nline 2\r\nline three\r\n");
	});
});
