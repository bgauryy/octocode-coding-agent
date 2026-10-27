import { octocodeToolDefinition } from "../../../mcp/test/mcp-preset-tool-fixture.ts";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxToolCall, getCurrentSystemMessage } from "@octocodeai/octocode-ai";
import { NATIVE_FEATURE_PATH } from "../../src/core/native-tools.ts";
import { captureSkillResourceSnapshot } from "../../src/core/skill-resource-snapshot.ts";
import { loadSkillsFromDir } from "../../src/core/skills.ts";
import { octocodePrompt } from "../../src/octocode/instructions/policy.ts";
import { withNativePermissionOwners } from "../../src/octocode/permission/native-tools.ts";
import { SkillCatalog, closeNames, setActiveSkillCatalog } from "../../src/octocode/skill/catalog.ts";
import { registerSkillTool } from "../../src/octocode/skill/tool.ts";
import { createHarness, getToolResult, type Harness } from "../suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../utilities.ts";
import { fakeCtx, fakePi, rendered, theme } from "./fake-pi.ts";
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
	const fp = fakePi();
	(fp.pi as unknown as { getSkillResourceSnapshot: () => unknown }).getSkillResourceSnapshot = snapshot;
	registerSkillTool(withNativePermissionOwners(fp.pi));
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

afterEach(() => setActiveSkillCatalog(undefined));

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
		expect(tool.description).toMatch(/matches the description of a skill/);
		expect(tool.description).toMatch(/directory/);
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

	it("sees skills the session loads later, and survives a failing snapshot", async () => {
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
		expect((await call("alpha")).details).toMatchObject({ name: "alpha" });
	});

	it("expands a Claude skill's host variables like the /skill command, and cuts an oversized file", async () => {
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
		expect(text).toContain("[Cut at 256 KB.");
		expect(text.length).toBeLessThan(270 * 1024);
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
			expect(collapsed).toContain("Loaded 4 lines");
			expect(collapsed).toContain("to expand");
			expect(collapsed).not.toContain("BODY_alpha");
			expect(rendered(tool.renderResult(result, { expanded: true }, theme, context({ expanded: true })))).toContain(
				"BODY_alpha",
			);
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

describe("localFetch of a loaded skill's SKILL.md", () => {
	const definition = () =>
		octocodeToolDefinition(
			{ name: "localFetch", description: "Read files", inputSchema: { type: "object" } },
			{ namespace: { name: "mcp__octocode" }, call: async () => ({ content: [{ type: "text", text: "ok" }] }) },
		);
	const call = (args: unknown, cwd = "/") => rendered(definition().renderCall!(args, theme, context({ cwd }) as never));

	it("renders the call as `Skill: <name>` only when the path is a loaded skill's file", () => {
		const f = fixtures();
		setActiveSkillCatalog(new SkillCatalog(f.snapshot));
		const file = path.join(f.alpha, "SKILL.md");
		expect(call({ queries: [{ path: file, fullContent: true }] })).toBe("✓ Skill: alpha");
		// A relative path resolves against the session's directory.
		expect(call({ queries: [{ path: "alpha/SKILL.md" }] }, f.root)).toBe("✓ Skill: alpha");
		// A disabled-for-models skill read by a model is still a skill load.
		expect(call({ queries: [{ path: path.join(f.root, "hidden", "SKILL.md") }] })).toBe("✓ Skill: hidden");
		// Anything else keeps the generic row: another file, a reference of the skill, a batch, no path.
		expect(call({ queries: [{ path: f.secret }] })).toContain("localFetch(");
		expect(call({ queries: [{ path: path.join(f.alpha, "reference.md") }] })).toContain("localFetch(");
		expect(call({ queries: [{ path: file }, { path: f.secret }] })).toContain("2 queries");
		expect(call({ queries: [{ matchString: "x" }] })).toBe("✓ localFetch");
		expect(call({})).toBe("✓ localFetch");
	});

	it("keeps the generic row when no skill is loaded, and for other Octocode tools", () => {
		const f = fixtures();
		const file = path.join(f.alpha, "SKILL.md");
		expect(call({ queries: [{ path: file }] })).toContain("localFetch(");
		setActiveSkillCatalog(new SkillCatalog(f.snapshot));
		const search = octocodeToolDefinition(
			{ name: "localSearch", description: "Search", inputSchema: { type: "object" } },
			{ namespace: { name: "mcp__octocode" }, call: async () => ({ content: [] }) },
		);
		expect(rendered(search.renderCall!({ queries: [{ path: file }] }, theme, context() as never))).toContain(
			"localSearch(",
		);
	});

	it("shows the loaded skill's result as one expandable line", () => {
		const f = fixtures();
		setActiveSkillCatalog(new SkillCatalog(f.snapshot));
		const args = { queries: [{ path: path.join(f.alpha, "SKILL.md") }] };
		const result = {
			content: [{ type: "text" as const, text: "line1\nline2\nline3" }],
			details: { server: "octocode", tool: "localFetch" },
		};
		const draw = (a: unknown, error = false) =>
			rendered(
				definition().renderResult!(
					result,
					{ expanded: false } as never,
					theme,
					context({ args: a, isError: error }) as never,
				),
			);
		expect(draw(args)).toContain("Loaded skill");
		expect(draw(args)).not.toContain("line1");
		expect(draw({ queries: [{ path: f.secret }] })).toContain("line1");
		expect(draw(args, true)).not.toContain("Loaded skill");
	});

	it("re-reads the session's skills once when an unknown SKILL.md is read, then keeps the answer cached", () => {
		const f = fixtures();
		const snapshot = vi.fn(f.snapshot);
		const catalog = new SkillCatalog(snapshot);
		const file = path.join(f.alpha, "SKILL.md");
		expect(catalog.byFile(file, "/")?.skill.name).toBe("alpha");
		expect(snapshot).toHaveBeenCalledTimes(1);
		expect(catalog.byFile(path.join(f.root, "missing", "SKILL.md"), "/")).toBeUndefined();
		expect(catalog.byFile(path.join(f.root, "missing", "SKILL.md"), "/")).toBeUndefined();
		expect(snapshot).toHaveBeenCalledTimes(1);
		// Not a SKILL.md: never a reason to refresh.
		expect(catalog.byFile(f.secret, "/")).toBeUndefined();
		expect(snapshot).toHaveBeenCalledTimes(1);
	});
});

describe("close names", () => {
	it("matches containing, contained and near names, closest first, at most five", () => {
		const names = ["octocode-research", "research", "octocode-roast", "zzz", "r1", "r2", "r3", "r4", "r5", "r6"];
		expect(closeNames("research", names)).toEqual(["octocode-research", "research"]);
		expect(closeNames("roas", names)).toEqual(["octocode-roast"]);
		expect(closeNames("r", names)).toHaveLength(5);
		expect(closeNames("qqqqqq", names)).toEqual([]);
	});
});

describe("skill policy", () => {
	const base = { octocode: true, profiles: [], canDelegate: true };
	const rule =
		"Before starting a task, when a listed skill's description matches it or the task names one, load that skill first and follow it.";

	it("tells the main session and a subagent once, in the common work section", () => {
		for (const canDelegate of [true, false]) {
			const prompt = octocodePrompt({ ...base, canDelegate });
			expect(prompt.split(rule)).toHaveLength(2);
			expect(prompt).not.toContain("load any named skill first");
		}
		const work = octocodePrompt({ ...base, canDelegate: false }).split("# Context and research")[0];
		expect(work).toContain(rule);
		expect(octocodePrompt({ ...base, canDelegate: false })).toContain("Finish it yourself.");
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
					path: NATIVE_FEATURE_PATH,
					factory: (pi) => {
						const wrapped = withNativePermissionOwners(pi);
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
		expect(sections?.skills).toContain("Use the skill tool with a skill's name to load it");
		expect(sections?.skills).toContain("<name>alpha</name>");
		expect(sections?.skills).not.toContain("<name>hidden</name>");
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
		expect(h.session.systemPrompt).not.toContain("skill tool");
	});
});
