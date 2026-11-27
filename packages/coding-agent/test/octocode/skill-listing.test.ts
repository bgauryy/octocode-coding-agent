import "../mcp-host.ts";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { captureSkillResourceSnapshot } from "../../src/core/skill-resource-snapshot.ts";
import { loadSkillsFromDir } from "../../src/core/skills.ts";
import { withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import { SkillCatalog } from "../../src/octocode/skill/catalog.ts";
import { SkillListing } from "../../src/core/skills/listing.ts";
import { registerSkillTool } from "../../src/octocode/native/tools/skill/tool.ts";
import { fakeCtx, fakeHost, rendered, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

function fixtures() {
	const root = fs.realpathSync(tmp("skill-listing-"));
	const skill = (folder: string, name: string, extra = "") => {
		const dir = path.join(root, folder);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "SKILL.md"),
			`---\nname: ${name}\ndescription: Use for ${name} work.\n${extra}---\n# ${name}\n\nBODY_${name}\n`,
		);
		return path.join(dir, "SKILL.md");
	};
	const files = {
		alpha: skill("alpha", "alpha"),
		beta: skill("beta", "beta"),
		hidden: skill("hidden", "hidden", "disable-model-invocation: true\n"),
	};
	const loaded = loadSkillsFromDir({ dir: root, source: "test" });
	return { root, files, loaded, snapshot: () => captureSkillResourceSnapshot(loaded) };
}

function setup(snapshot: () => unknown) {
	const fp = fakeHost();
	(fp.api.resources as { getSkillResourceSnapshot: () => unknown }).getSkillResourceSnapshot = snapshot;
	registerSkillTool(withNativePermissionOwners(fp.api), new SkillCatalog(() => snapshot() as never));
	const tool = fp.tools.get("skill");
	const ctx = fakeCtx({ cwd: tmp("skill-listing-cwd-") });
	type Result = { content: Array<{ text: string }>; details: Record<string, unknown> };
	const call = (params: Record<string, unknown>) =>
		tool.execute("call-1", { reason: "the task matches", ...params }, undefined, undefined, ctx) as Promise<Result>;
	return { tool, call };
}

const context = (overrides: Record<string, unknown> = {}) => ({
	state: {},
	invalidate: vi.fn(),
	executionStarted: true,
	isPartial: false,
	isError: false,
	expanded: false,
	cwd: "/",
	args: {},
	...overrides,
});

describe("the skill tool's description", () => {
	it("explains what a skill is, how to use it and where outputs go, then lists the enabled skills with their paths", () => {
		const f = fixtures();
		const { tool } = setup(f.snapshot);
		const text: string = tool.prepareLoadout({}).descriptions.skill;
		for (const part of ["SKILL.md", "scripts/", "references/", "assets/", "several", ".octocode/agent/"])
			expect(text).toContain(part);
		expect(text).toContain(`${f.files.alpha}: Use for alpha work.`);
		expect(text).toContain(`${f.files.beta}: Use for beta work.`);
		expect(text).toContain("<global_skills>");
		expect(text).not.toContain("BODY_alpha");
	});

	it("leaves out the skills only the user may run", () => {
		const f = fixtures();
		const text: string = setup(f.snapshot).tool.prepareLoadout({}).descriptions.skill;
		expect(text).not.toContain("hidden");
	});

	it("follows the skills the session has now", () => {
		const f = fixtures();
		let snapshot: () => unknown = () => ({ version: 1, resources: [], explicitSkills: [] });
		const { tool } = setup(() => snapshot());
		expect(tool.prepareLoadout({})).toEqual({ hiddenDeclarations: ["skill"] });
		snapshot = f.snapshot;
		expect(tool.prepareLoadout({}).descriptions.skill).toContain(f.files.alpha);
	});

	it("groups entries by category as a typed list", () => {
		const f = fixtures();
		const entries = new SkillCatalog(f.snapshot).invocable();
		const listing = SkillListing.of(entries);
		expect(listing.groups.map((group) => group.category)).toEqual(["global"]);
		expect(listing.groups[0].entries.map((entry) => entry.name)).toEqual(["alpha", "beta"]);
		expect(listing.find(f.files.beta)?.name).toBe("beta");
		expect(listing.find("alpha")?.path).toBe(f.files.alpha);
		expect(listing.find("hidden")).toBeUndefined();
		expect(listing.render()).toContain(`${f.files.alpha}: Use for alpha work.`);
	});
});

describe("loading several skills", () => {
	it("returns one block per skill, by name or by listed path", async () => {
		const f = fixtures();
		const { call } = setup(f.snapshot);
		const result = await call({ names: ["alpha", f.files.beta] });
		const text = result.content[0].text;
		expect(text.match(/<skill name=/g)).toHaveLength(2);
		expect(text).toContain("BODY_alpha");
		expect(text).toContain("BODY_beta");
		expect((result.details.skills as Array<{ name: string }>).map((skill) => skill.name)).toEqual(["alpha", "beta"]);
		expect(result.details.loadedSkills).toEqual([
			{ name: "alpha", location: f.files.alpha },
			{ name: "beta", location: f.files.beta },
		]);
	});

	it("keeps `name` working for one skill", async () => {
		const { call } = setup(fixtures().snapshot);
		const result = await call({ name: "alpha" });
		expect(result.content[0].text).toContain("BODY_alpha");
	});

	it("refuses each entry that is not listed and still returns the others", async () => {
		const f = fixtures();
		const { call } = setup(f.snapshot);
		const result = await call({ names: ["alpha", "alph", "hidden", path.join(f.root, "secret.txt")] });
		const text = result.content[0].text;
		expect(text).toContain("BODY_alpha");
		expect(text).toMatch(/Unknown skill "alph"\. Close matches: alpha\./);
		expect(text).toMatch(/reserved for the user/);
		expect(text).toMatch(/Unknown skill ".*secret\.txt"/);
		const refused = result.details.refused as Array<{ request: string; reason: string }>;
		expect(refused.map((entry) => entry.reason)).toEqual(["unknown", "reserved", "unknown"]);
	});

	it("fails the call when no entry loads, naming every refusal", async () => {
		const { call } = setup(fixtures().snapshot);
		await expect(call({ names: ["zzzzzzzz", "hidden"] })).rejects.toThrow(
			/Unknown skill "zzzzzzzz"[\s\S]*reserved for the user/,
		);
		await expect(call({})).rejects.toThrow(/needs/);
	});
});

describe("rendering a batch", () => {
	it("lists the names in the header and keeps the collapsed row to one line", async () => {
		const f = fixtures();
		const { call, tool } = setup(f.snapshot);
		const header = rendered(tool.renderCall({ names: ["alpha", "skill:beta"] }, theme, context()));
		expect(header).toContain("Skill(alpha, beta)");
		const result = await call({ names: ["alpha", "beta", "nope"] });
		const collapsed = rendered(tool.renderResult(result, { expanded: false }, theme, context()));
		expect(collapsed.trim().split("\n")).toHaveLength(1);
		expect(collapsed).toMatch(/2 skills/);
		expect(collapsed).toMatch(/1 not loaded/);
	});

	it("shows each skill's name, description, file and line count, and each failure, when expanded", async () => {
		const f = fixtures();
		const { call, tool } = setup(f.snapshot);
		const result = await call({ names: ["alpha", "beta", "nope"] });
		const text = rendered(tool.renderResult(result, { expanded: true }, theme, context({ expanded: true })));
		for (const part of [
			"alpha",
			"beta",
			"Use for alpha work.",
			"Use for beta work.",
			"alpha/SKILL.md",
			"beta/SKILL.md",
			"lines",
			"nope",
		])
			expect(text).toContain(part);
		expect(text).not.toContain("<skill");
	});

	it("gives other surfaces one block group per skill and the failures", async () => {
		const f = fixtures();
		const { call, tool } = setup(f.snapshot);
		const result = await call({ names: ["alpha", "beta", "nope"] });
		const display = tool.display({ args: { names: ["alpha", "beta", "nope"] }, status: "completed", result });
		expect(display.title).toBe("Skill: alpha, beta, nope");
		expect(display.outcome.text).toMatch(/2 skills/);
		const paths = display.blocks.filter((block: { type: string }) => block.type === "path");
		expect(paths.map((block: { path: string }) => block.path)).toEqual([f.files.alpha, f.files.beta]);
		expect(JSON.stringify(display.blocks)).toContain("nope");
	});
});
