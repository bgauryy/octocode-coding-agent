import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectPluginHooks } from "../../src/core/plugin-hooks.ts";
import { loadHooks } from "../../src/octocode/hooks/config.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { commandsFor } from "../../src/octocode/hooks/config/calls.ts";

describe("plugin hooks through session registration", () => {
	afterEach(() => vi.unstubAllEnvs());
	it.each(["claude", "codex"] as const)(
		"runs %s hooks of an enabled plugin and follows later changes",
		async (protocol) => {
			const home = tmp();
			const plugin = tmp();
			vi.stubEnv("OCTOCODE_HOME", tmp());
			fs.mkdirSync(path.join(plugin, `.${protocol}-plugin`));
			fs.mkdirSync(path.join(plugin, "hooks"));
			fs.writeFileSync(path.join(plugin, `.${protocol}-plugin/plugin.json`), JSON.stringify({ name: "policy" }));
			const hookFile = path.join(plugin, "hooks/hooks.json");
			fs.writeFileSync(
				hookFile,
				JSON.stringify({
					hooks: { PreToolUse: [{ hooks: [{ type: "command", command: `echo "$CLAUDE_PLUGIN_ROOT" >&2; exit 2` }] }] },
				}),
			);
			const entry = { path: plugin, protocol };
			const f = fakeHost();
			f.api.getSettings = () => ({ plugins: [entry] });
			const hooks = registerHooks(f.api, { env: {}, home });
			const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
			const event = { toolName: "bash", toolCallId: "plugin-call", input: { command: "true" } };
			await f.fire("session_start", { reason: "startup" }, ctx);
			expect(await hooks.preToolUse(event as never, ctx)).toMatchObject({
				block: true,
				reason: expect.stringContaining(plugin),
			});
			fs.writeFileSync(
				hookFile,
				JSON.stringify({
					hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "echo changed >&2; exit 2" }] }] },
				}),
			);
			await f.fire("session_start", { reason: "reload" }, ctx);
			// Enabling approves the declarations as they stand, so the changed hook loads as written.
			expect(await hooks.preToolUse(event as never, ctx)).toMatchObject({
				block: true,
				reason: expect.stringContaining("changed"),
			});
		},
	);
	it("keeps identical commands from different plugin identities and honors the global disable switch", () => {
		const home = tmp();
		const native = tmp();
		vi.stubEnv("OCTOCODE_HOME", native);
		const entries = ["one", "two"].map((name) => {
			const root = tmp();
			fs.mkdirSync(path.join(root, ".claude-plugin"));
			fs.mkdirSync(path.join(root, "hooks"));
			fs.writeFileSync(path.join(root, ".claude-plugin/plugin.json"), JSON.stringify({ name }));
			fs.writeFileSync(
				path.join(root, "hooks/hooks.json"),
				JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "true" }] }] } }),
			);
			return { path: root, protocol: "claude" as const };
		});
		expect(
			commandsFor(loadHooks(tmp(), false, home, { plugins: entries }).config, "PreToolUse", ["Bash"]),
		).toHaveLength(2);
		fs.writeFileSync(path.join(native, "hooks.json"), '{"disableAllHooks":true}');
		expect(
			commandsFor(loadHooks(tmp(), false, home, { plugins: entries }).config, "PreToolUse", ["Bash"]),
		).toHaveLength(0);
	});

	it("loads no hooks from malformed hook files", () => {
		const plugin = tmp();
		fs.mkdirSync(path.join(plugin, ".claude-plugin"));
		fs.mkdirSync(path.join(plugin, "hooks"));
		fs.writeFileSync(path.join(plugin, ".claude-plugin/plugin.json"), '{"name":"bad-hooks"}');
		fs.writeFileSync(path.join(plugin, "hooks/hooks.json"), "{}");
		const result = inspectPluginHooks({ path: plugin, protocol: "claude" });
		expect(result.errors).toContainEqual(expect.stringContaining("hooks"));
		expect(
			commandsFor(
				loadHooks(tmp(), false, tmp(), { plugins: [{ path: plugin, protocol: "claude" }] }).config,
				"PreToolUse",
				["Bash"],
			),
		).toEqual([]);
	});
	it.each([{}, [null], [{}]].map((plugins) => ({ plugins })))(
		"reports malformed plugin settings in hook loading: %j",
		({ plugins }) => {
			const result = loadHooks(tmp(), false, tmp(), { plugins: plugins as never });
			expect(result.errors).toContainEqual(expect.stringContaining("plugins"));
			expect(commandsFor(result.config, "PreToolUse", ["Bash"])).toEqual([]);
		},
	);

	it("reports modules in mixed hook files instead of loading an incomplete plugin", () => {
		const plugin = tmp();
		fs.mkdirSync(path.join(plugin, ".claude-plugin"));
		fs.mkdirSync(path.join(plugin, "hooks"));
		fs.writeFileSync(path.join(plugin, ".claude-plugin/plugin.json"), '{"name":"mixed"}');
		fs.writeFileSync(path.join(plugin, "hooks/hooks.json"), JSON.stringify({ hooks: {}, modules: ["./policy.mjs"] }));
		const result = inspectPluginHooks({ path: plugin, protocol: "claude" });
		expect(result.errors).toContainEqual(expect.stringContaining("modules"));
	});
});
