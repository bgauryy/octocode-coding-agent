import "../mcp-host.ts";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage } from "@octocodeai/octocode-ai";
import { captureSkillResourceSnapshot } from "../../src/core/skill-resource-snapshot.ts";
import { loadSkillsFromDir } from "../../src/core/skills.ts";
import { withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import { closeNames, editDistance } from "../../src/octocode/skill/catalog.ts";
import { skillLoadSummary } from "../../src/octocode/skill/render.ts";
import { registerSkillTool } from "../../src/octocode/skill/tool.ts";
import { createHarness, getToolResult, type Harness } from "../suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { fakeCtx, fakeHost, rendered, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** Skill folders under `root`: alpha (with a reference file), a similarly named one, and one only the user may run. */
function fixtures() {
	const root = fs.realpathSync(tmp("skill-tool-"));
	const skill = (folder: string, name: string, extra = "", body = `BODY_${name}`) => {
		const dir = path.join(root, folder);
		fs.mkdirSync(dir, { recursive: true });
		fs.writeFileSync(
			path.join(dir, "SKILL.md"),
			`---\nname: ${name}\ndescription: Use for ${name} work.\n${extra}---\n# ${name}\n\n${body}\nSee reference.md\n`,
		);
		return dir;
	};
	const alpha = skill("alpha", "alpha");
	fs.writeFileSync(path.join(alpha, "reference.md"), "REFERENCE_ALPHA\n");
	skill("alpine", "alpine");
	skill("hidden", "hidden", "disable-model-invocation: true\n");
	const secret = path.join(root, "secret.txt");
	fs.writeFileSync(secret, "SECRET_TEXT\n");
	const loaded = loadSkillsFromDir({ dir: root, source: "test" });
	return { root, alpha, secret, loaded, snapshot: () => captureSkillResourceSnapshot(loaded) };
}

function setup(snapshot: () => unknown) {
	const fp = fakeHost();
	(fp.api as unknown as { getSkillResourceSnapshot: () => unknown }).getSkillResourceSnapshot = snapshot;
	registerSkillTool(withNativePermissionOwners(fp.api));
	const tool = fp.tools.get("skill");
	const cwd = tmp("skill-cwd-");
	const ctx = fakeCtx({ cwd });
	const call = (name: string) =>
		tool.execute("call-1", { name, reason: "the task matches" }, undefined, undefined, ctx) as Promise<{
			content: Array<{ text: string }>;
			details: Record<string, unknown>;
		}>;
	return { fp, tool, ctx, cwd, call };
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

describe("skill tool", () => {
	it("returns a loaded skill's instructions and directory, without its front matter", async () => {
		const f = fixtures();
		const { call, tool } = setup(f.snapshot);
		const result = await call("alpha");
		const text = result.content[0].text;
		expect(text).toContain(`<skill name="alpha" location="${path.join(f.alpha, "SKILL.md")}">`);
		expect(text).toContain(`References are relative to ${f.alpha}.`);
		expect(text).toContain("BODY_alpha");
		expect(text).not.toContain("description: Use for alpha");
		expect(result.details).toMatchObject({ name: "alpha", baseDir: f.alpha, lines: 4 });
		expect(tool.defaultActive).not.toBe(false);
	});

	it("accepts the forms a user types: /skill:name, skill:name and another case", async () => {
		const { call } = setup(fixtures().snapshot);
		for (const name of ["/skill:alpha", "skill:alpha", "ALPHA", " alpha "])
			expect((await call(name)).details).toMatchObject({ name: "alpha" });
	});

	it("refuses an unknown name and names the close matches", async () => {
		const { call } = setup(fixtures().snapshot);
		await expect(call("alp")).rejects.toThrow(/Unknown skill "alp"\. Close matches: alpha, alpine\./);
		await expect(call("zzzzzzzz")).rejects.toThrow(/Unknown skill "zzzzzzzz"\. Available: alpha, alpine\./);
	});

	it("never reads another path: a path is not a skill name, whatever file it points at", async () => {
		const f = fixtures();
		const { call } = setup(f.snapshot);
		for (const name of [f.secret, path.join(f.alpha, "SKILL.md"), "../secret.txt", path.join(f.alpha, "reference.md")])
			await expect(call(name)).rejects.toThrow(/Unknown skill/);
		const reads: string[] = [];
		const original = fs.readFileSync;
		const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((
			file: fs.PathOrFileDescriptor,
			...rest: unknown[]
		) => {
			reads.push(String(file));
			return (original as (...args: unknown[]) => unknown)(file, ...rest);
		}) as typeof fs.readFileSync);
		try {
			await call("alpha");
		} finally {
			spy.mockRestore();
		}
		expect(reads).toEqual([path.join(f.alpha, "SKILL.md")]);
	});

	it("refuses a skill the user reserved with disable-model-invocation, and does not list it", async () => {
		const { call } = setup(fixtures().snapshot);
		await expect(call("hidden")).rejects.toThrow(/reserved for the user.*\/skill:hidden/);
		await expect(call("zzzzzzzz")).rejects.not.toThrow(/hidden/);
	});

	it("sees skills loaded later but refuses execution with a failing snapshot", async () => {
		const f = fixtures();
		let snapshot: () => unknown = () => ({ version: 1, resources: [], explicitSkills: [] });
		const { call, tool } = setup(() => snapshot());
		await expect(call("alpha")).rejects.toThrow(/no skill a model can load/);
		expect(tool.prepareLoadout({})).toEqual({ hiddenDeclarations: ["skill"] });
		snapshot = f.snapshot;
		expect((await call("alpha")).details).toMatchObject({ name: "alpha" });
		expect(tool.prepareLoadout({})).toBeUndefined();
		snapshot = () => {
			throw new Error("moved");
		};
		await expect(call("alpha")).rejects.toThrow("moved");
		expect(tool.prepareLoadout({})).toBeUndefined();
	});

	it("expands a Claude skill's host variables like the /skill command, and returns an oversized file whole", async () => {
		const f = fixtures();
		const dir = path.join(f.root, "claude");
		fs.mkdirSync(dir);
		fs.writeFileSync(
			path.join(dir, "SKILL.md"),
			"---\nname: claude-skill\ndescription: Claude style.\n---\nDir is ${CLAUDE_SKILL_DIR}\n" + "x".repeat(300 * 1024),
		);
		const loaded = loadSkillsFromDir({ dir, source: "test", protocol: "claude" });
		const { call } = setup(() => captureSkillResourceSnapshot(loaded));
		const text = (await call("claude-skill")).content[0].text;
		expect(text).toContain(`Dir is ${dir}`);
		expect(text).not.toContain("[Cut at");
		expect(text.length).toBeGreaterThan(300 * 1024);
	});

	it("pins instructions and references to the captured file and refuses a replaced canonical link", async () => {
		const f = fixtures();
		const alias = path.join(f.root, "alias");
		fs.symlinkSync(f.alpha, alias, "dir");
		const loaded = loadSkillsFromDir({ dir: alias, source: "test" });
		const { call } = setup(() => captureSkillResourceSnapshot(loaded));
		expect((await call("alpha")).details.baseDir).toBe(f.alpha);
		fs.unlinkSync(alias);
		fs.symlinkSync(path.join(f.root, "alpine"), alias, "dir");
		const result = await call("alpha");
		expect(result.content[0].text).toContain("BODY_alpha");
		expect(result.content[0].text).not.toContain("BODY_alpine");
		expect(result.details).toMatchObject({ location: path.join(f.alpha, "SKILL.md"), baseDir: f.alpha });
		fs.unlinkSync(path.join(f.alpha, "SKILL.md"));
		fs.symlinkSync(f.secret, path.join(f.alpha, "SKILL.md"));
		// The catalog's snapshot is validated once per loaded skill list; the file the tool reads is checked when read.
		await expect(call("alpha")).rejects.toThrow(
			'Skill "alpha" could not be read: its file now resolves to another path',
		);
		// A reload (a new skill list) validates every file again.
		expect(() => captureSkillResourceSnapshot({ ...loaded, skills: [...loaded.skills] })).toThrow(
			"Child skill canonical identity changed",
		);
	});

	describe("rendering", () => {
		it("draws the call as `Skill: <name>` and the result as one compact, expandable line", async () => {
			const { call, tool } = setup(fixtures().snapshot);
			expect(rendered(tool.renderCall({ name: "alpha" }, theme, context({ isPartial: true })))).toMatch(
				/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Skill: alpha/,
			);
			expect(rendered(tool.renderCall({ name: "skill:alpha" }, theme, context()))).toContain("Skill: alpha");
			const result = await call("alpha");
			const collapsed = rendered(tool.renderResult(result, { expanded: false }, theme, context()));
			expect(collapsed).toContain("Global skill · 4 lines");
			expect(collapsed).toContain("to expand");
			expect(collapsed).not.toContain("BODY_alpha");
			expect(rendered(tool.renderResult(result, { expanded: true }, theme, context({ expanded: true })))).toContain(
				"BODY_alpha",
			);
		});

		it("names the skill's group and origin, and shows its description, file and instructions when expanded", async () => {
			const { call, tool } = setup(fixtures().snapshot);
			const result = await call("alpha");
			expect(result.details).toMatchObject({ category: "global", description: "Use for alpha work." });
			const collapsed = rendered(tool.renderResult(result, { expanded: false }, theme, context()));
			expect(collapsed).toMatch(/Global skill \u00b7 4 lines \u00b7 temporary \u00b7 test/);
			expect(collapsed).not.toContain("Use for alpha work.");
			const expanded = rendered(tool.renderResult(result, { expanded: true }, theme, context({ expanded: true })));
			const order = ["Use for alpha work.", "alpha/SKILL.md", "BODY_alpha"].map((text) => expanded.indexOf(text));
			expect(order.every((index) => index >= 0)).toBe(true);
			expect(order).toEqual([...order].sort((a, b) => a - b));
			expect(expanded).not.toContain("<skill");
			expect(expanded).not.toContain("References are relative");
		});

		it("says where only skills found in a folder came from: core and Octocode skills ship with the build", () => {
			expect(skillLoadSummary({ lines: 10, category: "octocode", origin: "user" })).toBe(
				"Octocode skill \u00b7 10 lines",
			);
			expect(skillLoadSummary({ lines: 1, category: "core", origin: "user" })).toBe("Core skill \u00b7 1 line");
			expect(skillLoadSummary({ lines: 3, category: "workspace", origin: "project" })).toBe(
				"Workspace skill \u00b7 3 lines \u00b7 project",
			);
			// A result recorded before the group existed still reads.
			expect(skillLoadSummary({ lines: 2, origin: "user" })).toBe("Loaded 2 lines \u00b7 user");
		});

		it("gives other surfaces the same summary, then the description, the file and the instructions", async () => {
			const { call, tool } = setup(fixtures().snapshot);
			const result = await call("alpha");
			const display = tool.display({ args: { name: "alpha" }, status: "completed", result });
			expect(display.outcome.text).toBe("Global skill \u00b7 4 lines \u00b7 temporary \u00b7 test");
			expect(display.blocks.map((block: { type: string }) => block.type)).toEqual(["text", "path", "markdown"]);
			expect(display.blocks[0].text).toBe("Use for alpha work.");
		});

		it("keeps every line of a validation failure, not just its heading", () => {
			const { tool } = setup(fixtures().snapshot);
			const error = {
				content: [
					{ type: "text", text: 'Validation failed for tool "skill":\n  - reason: must have required property' },
				],
				details: undefined,
			};
			const row = rendered(tool.renderResult(error, { expanded: false }, theme, context({ isError: true })));
			expect(row).toContain("must have required property");
		});

		it("draws a refusal as the error line", () => {
			const { tool } = setup(fixtures().snapshot);
			const error = {
				content: [{ type: "text", text: 'Unknown skill "x". Close matches: alpha.' }],
				details: undefined,
			};
			expect(rendered(tool.renderResult(error, { expanded: false }, theme, context({ isError: true })))).toContain(
				"Unknown skill",
			);
		});

		it("draws only the glyph and the tokens the other tool rows use, so both themes apply", () => {
			const colors: string[] = [];
			const recording = {
				...(theme as object),
				fg: (color: string, text: string) => (colors.push(color), text),
			} as never;
			const { tool, call } = setup(fixtures().snapshot);
			void call;
			tool.renderCall({ name: "alpha" }, recording, context());
			expect(new Set(colors)).toEqual(new Set(["success", "toolTitle"]));
		});
	});
});

describe("close names", () => {
	it("matches containing, contained and near names, closest first, at most five", () => {
		const names = ["octocode-research", "research", "octocode-roast", "zzz", "r1", "r2", "r3", "r4", "r5", "r6"];
		expect(closeNames("research", names)).toEqual(["octocode-research", "research"]);
		expect(closeNames("roas", names)).toEqual(["octocode-roast"]);
		expect(closeNames("r", names)).toHaveLength(5);
		expect(closeNames("qqqqqq", names)).toEqual([]);
		// Swapped adjacent letters count as one edit.
		expect(closeNames("octocode-raost", names)).toEqual(["octocode-roast"]);
		expect(editDistance("wbe", "web")).toBe(1);
		expect(editDistance("web", "new")).toBe(2);
		expect(editDistance("exit", "quit")).toBe(2);
	});
});

describe("a session with skills", () => {
	let harness: Harness | undefined;
	let env: ReturnType<typeof fixtures>;
	beforeEach(() => {
		env = fixtures();
	});
	afterEach(() => harness?.cleanup());

	async function start(skills = env.loaded.skills) {
		const extensionsResult = await createTestExtensionsResult(
			[
				{
					owner: "native",
					path: "<inline:octocode>",
					factory: (api) => {
						const wrapped = withNativePermissionOwners(api);
						registerSkillTool(wrapped);
					},
				},
			],
			env.root,
		);
		const loader = {
			...createTestResourceLoader({ extensionsResult }),
			getSkills: () => ({ skills, diagnostics: [], explicitSkills: env.loaded.explicitSkills }),
		};
		harness = await createHarness({ resourceLoader: loader, cwd: env.root });
		return harness;
	}

	it("declares the skill tool by default, names it in the skills section, and loads a skill through it", async () => {
		const h = await start();
		expect(h.session.getActiveToolNames()).toContain("skill");
		h.setResponses([
			fauxAssistantMessage([fauxToolCall("skill", { name: "alpha", reason: "task matches alpha" })]),
			fauxAssistantMessage("done"),
		]);
		await h.session.prompt("do alpha work");
		const sections = getCurrentSystemMessage(h.session.messages)?.sections;
		expect(sections?.skills).toContain('<skill name="alpha">');
		expect(sections?.skills).not.toContain('<skill name="hidden"');
		const result = getToolResult(h, "skill");
		expect(result.isError).toBe(false);
		expect(JSON.stringify(result.content)).toContain("BODY_alpha");
		expect(JSON.stringify(result.content)).toContain(`References are relative to ${env.alpha}`);
	});

	it("keeps the tool and its prompt hint out of a session without a model-invocable skill", async () => {
		const none = env.loaded.skills.filter((skill) => skill.disableModelInvocation);
		const h = await start(none);
		h.setResponses([fauxAssistantMessage("hi")]);
		await h.session.prompt("hello");
		const sections = getCurrentSystemMessage(h.session.messages)?.sections;
		expect(sections?.skills).toBeUndefined();
		expect(sections?.tools ?? "").not.toContain("- skill:");
	});
});
