import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { expandPromptTemplate } from "../src/core/prompt-templates.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { inspectPluginHooks } from "../src/core/plugin-hooks.ts";
import { loadHooks, commandsFor } from "../src/octocode/hooks/config.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
const dirs: string[] = [];
function fixture(protocol: "claude" | "codex") {
	const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "plugin-runtime-")));
	dirs.push(root);
	const agentDir = path.join(root, "user");
	const cwd = path.join(root, "project");
	const plugin = path.join(root, "plugin");
	for (const dir of [agentDir, cwd, path.join(plugin, `.${protocol}-plugin`), path.join(plugin, "skills/review")])
		fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(path.join(plugin, `.${protocol}-plugin/plugin.json`), JSON.stringify({ name: "review-kit" }));
	fs.writeFileSync(
		path.join(plugin, "skills/review/SKILL.md"),
		"---\nname: review\ndescription: Review a change.\n---\nRead the diff.",
	);
	const settings = { plugins: [{ path: plugin, protocol }] };
	fs.writeFileSync(path.join(agentDir, "settings.json"), JSON.stringify(settings));
	return { root, agentDir, cwd, plugin, settings };
}
afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
describe("configured plugin skill activation", () => {
	it.each(["claude", "codex"] as const)(
		"loads %s plugin skills through the native resource loader without executing its index",
		async (protocol) => {
			const f = fixture(protocol);
			fs.writeFileSync(path.join(f.plugin, "index.ts"), 'throw new Error("plugin index must not execute")');
			const loader = new DefaultResourceLoader({ ...f, nativeFeatures: false });
			await loader.reload();
			expect(loader.getSkills().skills.map((s) => s.name)).toContain("review-kit:review");
			expect(loader.getExtensions().extensions).toEqual([]);
			expect(loader.getExtensions().errors).toEqual([]);
			fs.writeFileSync(
				path.join(f.agentDir, "settings.json"),
				JSON.stringify({ plugins: [{ ...f.settings.plugins[0], enabled: false }] }),
			);
			await loader.reload();
			expect(loader.getSkills().skills).toEqual([]);
		},
	);
	it("uses Claude description fallback and boolean spellings without changing Codex validation", async () => {
		for (const protocol of ["claude", "codex"] as const) {
			const f = fixture(protocol);
			fs.writeFileSync(
				path.join(f.plugin, "skills/review/SKILL.md"),
				"---\nuser-invocable: OFF\ndisable-model-invocation: YES\n---\nReview the staged changes.\nMore detail.",
			);
			const loader = new DefaultResourceLoader({ ...f, nativeFeatures: false });
			await loader.reload();
			if (protocol === "claude")
				expect(loader.getSkills().skills).toContainEqual(
					expect.objectContaining({
						name: "review-kit:review",
						description: "Review the staged changes.",
						userInvocable: false,
						disableModelInvocation: true,
					}),
				);
			else expect(loader.getSkills().skills).toEqual([]);
		}
	});

	it("does not load project plugin settings before project trust", async () => {
		const f = fixture("claude");
		fs.writeFileSync(path.join(f.agentDir, "settings.json"), "{}");
		fs.mkdirSync(path.join(f.cwd, ".octocode"));
		fs.writeFileSync(path.join(f.cwd, ".octocode/settings.json"), JSON.stringify(f.settings));
		const settingsManager = SettingsManager.create(f.cwd, f.agentDir);
		settingsManager.setProjectTrusted(false);
		const loader = new DefaultResourceLoader({ ...f, settingsManager, nativeFeatures: false });
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
	});
	it("rejects a nested skill symlink outside its plugin", async () => {
		const f = fixture("claude");
		const outside = path.join(f.root, "outside");
		fs.mkdirSync(outside);
		fs.writeFileSync(path.join(outside, "SKILL.md"), "---\nname: escaped\ndescription: Outside.\n---\noutside");
		fs.symlinkSync(outside, path.join(f.plugin, "skills/escape"));
		const loader = new DefaultResourceLoader({ ...f, nativeFeatures: false });
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getSkills().diagnostics).toContainEqual(
			expect.objectContaining({ type: "error", message: expect.stringContaining("escapes") }),
		);
	});
	it.each(
		[
			{},
			[null],
			[{}],
			[{ path: "/tmp", protocol: "unknown" }],
			[{ path: "/tmp", protocol: "claude", enabled: "yes" }],
		].map((plugins) => ({ plugins })),
	)("reports malformed plugin settings without rejecting reload: %j", async ({ plugins }) => {
		const f = fixture("claude");
		fs.writeFileSync(path.join(f.agentDir, "settings.json"), JSON.stringify({ plugins }));
		const loader = new DefaultResourceLoader({ ...f, nativeFeatures: false });
		await expect(loader.reload()).resolves.toBeUndefined();
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getSkills().diagnostics).toContainEqual(
			expect.objectContaining({ type: "error", message: expect.stringContaining("plugins") }),
		);
	});
	it("rejects contained directory cycles before recursive skill loading", async () => {
		const f = fixture("claude");
		fs.symlinkSync(path.join(f.plugin, "skills"), path.join(f.plugin, "skills/loop"));
		const loader = new DefaultResourceLoader({ ...f, nativeFeatures: false });
		await loader.reload();
		expect(loader.getSkills().skills).toEqual([]);
		expect(loader.getSkills().diagnostics).toContainEqual(
			expect.objectContaining({ type: "error", message: expect.stringContaining("cycle") }),
		);
	});

	it("activates namespaced Claude prompt commands and refuses unsupported execution metadata", async () => {
		const f = fixture("claude");
		fs.writeFileSync(
			path.join(f.plugin, ".claude-plugin/plugin.json"),
			JSON.stringify({
				name: "review-kit",
				commands: {
					about: { content: "Review $ARGUMENTS", description: "Review", argumentHint: "[path]" },
					restricted: { content: "Run a check", allowedTools: ["Bash"] },
				},
			}),
		);
		const loader = new DefaultResourceLoader({ ...f, nativeFeatures: false });
		await loader.reload();
		const loaded = loader.getPrompts();
		expect(loaded.prompts.map((p) => p.name)).toEqual(["review-kit:about"]);
		expect(expandPromptTemplate("/review-kit:about src/main.ts", loaded.prompts)).toBe("Review src/main.ts");
		expect(loaded.diagnostics).toContainEqual(
			expect.objectContaining({ message: expect.stringContaining("allowedTools") }),
		);
		fs.writeFileSync(
			path.join(f.agentDir, "settings.json"),
			JSON.stringify({ plugins: [{ ...f.settings.plugins[0], enabled: false }] }),
		);
		await loader.reload();
		expect(loader.getPrompts().prompts).toEqual([]);
	});
	it("uses Claude zero-based arguments for loaded plugin commands", async () => {
		const f = fixture("claude");
		fs.mkdirSync(path.join(f.plugin, "commands"));
		fs.writeFileSync(
			path.join(f.plugin, "commands/review.md"),
			"---\ndescription: Review\narguments: [file, branch]\n---\n$0 | $1 | $file | $branch | $ARGUMENTS",
		);
		const loader = new DefaultResourceLoader({ ...f, nativeFeatures: false });
		await loader.reload();
		expect(expandPromptTemplate('/review-kit:review "a file"  main', loader.getPrompts().prompts)).toBe(
			'a file | main | a file | main | "a file"  main',
		);
	});
	it("contains command file paths and honors the prompt disable switch", async () => {
		const f = fixture("claude");
		fs.mkdirSync(path.join(f.plugin, "commands"));
		fs.writeFileSync(path.join(f.plugin, "commands/about.md"), "---\ndescription: About\n---\nAbout $ARGUMENTS");
		const loader = new DefaultResourceLoader({ ...f, nativeFeatures: false });
		await loader.reload();
		expect(loader.getPrompts().prompts.map((p) => p.name)).toEqual(["review-kit:about"]);
		const disabled = new DefaultResourceLoader({ ...f, nativeFeatures: false, noPromptTemplates: true });
		await disabled.reload();
		expect(disabled.getPrompts().prompts).toEqual([]);
		fs.symlinkSync(path.join(f.plugin, ".claude-plugin/plugin.json"), path.join(f.plugin, "commands/metadata.md"));
		const outside = path.join(f.root, "outside.md");
		fs.writeFileSync(outside, "external");
		fs.symlinkSync(outside, path.join(f.plugin, "commands/escape.md"));
		await loader.reload();
		expect(loader.getPrompts().prompts.map((p) => p.name)).not.toContain("review-kit:escape");
		expect(loader.getPrompts().diagnostics).toContainEqual(
			expect.objectContaining({ message: expect.stringContaining("escapes") }),
		);
	});
});

it("uses one plugin data identity for skills, commands and reviewed hooks", async () => {
	const f = fixture("claude");
	fs.mkdirSync(path.join(f.plugin, "hooks"));
	fs.mkdirSync(path.join(f.plugin, "commands"));
	fs.writeFileSync(
		path.join(f.plugin, "hooks/hooks.json"),
		JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "true" }] }] } }),
	);
	fs.writeFileSync(path.join(f.plugin, "commands/data.md"), "${CLAUDE_PLUGIN_DATA} | $0");
	const entry = { ...f.settings.plugins[0], hooksFingerprint: inspectPluginHooks(f.settings.plugins[0]).fingerprint };
	fs.writeFileSync(path.join(f.agentDir, "settings.json"), JSON.stringify({ plugins: [entry] }));
	const loader = new DefaultResourceLoader({ ...f, nativeFeatures: false });
	await loader.reload();
	const hooks = loadHooks(f.cwd, false, undefined, { sourceProfiles: true, plugins: [entry] });
	const data = commandsFor(hooks.config, "PreToolUse", ["Bash"])[0]?.plugin?.data;
	expect(typeof data).toBe("string");
	expect(loader.getSkills().skills.find((s) => s.name === "review-kit:review")?.claudePluginData).toBe(data);
	expect(expandPromptTemplate('/review-kit:data "${CLAUDE_PLUGIN_DATA}"', loader.getPrompts().prompts)).toBe(
		`${data} | ${data}`,
	);
});
