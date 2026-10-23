import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectPluginHooks } from "../../src/core/plugin-hooks.ts";
import { commandsFor, loadHooks } from "../../src/octocode/hooks/config.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

describe("plugin hooks through session registration", () => {
	afterEach(() => vi.unstubAllEnvs());
	it.each(["claude", "codex"] as const)(
		"runs reviewed %s hooks and revokes approval when the definition changes",
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
			const entry = { path: plugin, protocol, hooksFingerprint: undefined as string | undefined };
			const f = fakePi();
			f.pi.getSettings = () => ({ plugins: [entry] });
			const hooks = registerHooks(f.pi, { OCTOCODE_HOOKS: "1", OCTOCODE_HOOKS_COMPAT: "1" }, home);
			const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
			const event = { toolName: "bash", toolCallId: "plugin-call", input: { command: "true" } };
			await f.fire("session_start", { reason: "startup" }, ctx);
			expect(await hooks.preToolUse(event as never, ctx)).toBeUndefined();
			expect(hooks.report(ctx.cwd)).toContain("review");
			entry.hooksFingerprint = inspectPluginHooks(entry).fingerprint!;
			await f.fire("session_start", { reason: "reload" }, ctx);
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
			expect(await hooks.preToolUse(event as never, ctx)).toBeUndefined();
			expect(hooks.report(ctx.cwd)).toContain("review");
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
			const entry = { path: root, protocol: "claude" as const };
			return { ...entry, hooksFingerprint: inspectPluginHooks(entry).fingerprint! };
		});
		expect(
			commandsFor(loadHooks(tmp(), false, home, { sourceProfiles: true, plugins: entries }).config, "PreToolUse", [
				"Bash",
			]),
		).toHaveLength(2);
		expect(
			commandsFor(loadHooks(tmp(), false, home, { plugins: entries }).config, "PreToolUse", ["Bash"]),
		).toHaveLength(0);
		fs.writeFileSync(path.join(native, "hooks.json"), '{"disableAllHooks":true}');
		expect(
			commandsFor(loadHooks(tmp(), false, home, { sourceProfiles: true, plugins: entries }).config, "PreToolUse", [
				"Bash",
			]),
		).toHaveLength(0);
	});

	it("does not issue an approvable fingerprint for malformed hook files", () => {
		const plugin = tmp();
		fs.mkdirSync(path.join(plugin, ".claude-plugin"));
		fs.mkdirSync(path.join(plugin, "hooks"));
		fs.writeFileSync(path.join(plugin, ".claude-plugin/plugin.json"), '{"name":"bad-hooks"}');
		fs.writeFileSync(path.join(plugin, "hooks/hooks.json"), "{}");
		const result = inspectPluginHooks({ path: plugin, protocol: "claude" });
		expect(result.fingerprint).toBeUndefined();
		expect(result.errors).toContainEqual(expect.stringContaining("hooks"));
	});
	it.each([{}, [null], [{}]].map((plugins) => ({ plugins })))(
		"reports malformed plugin settings in hook loading: %j",
		({ plugins }) => {
			const result = loadHooks(tmp(), false, tmp(), { sourceProfiles: true, plugins: plugins as never });
			expect(result.errors).toContainEqual(expect.stringContaining("plugins"));
			expect(commandsFor(result.config, "PreToolUse", ["Bash"])).toEqual([]);
		},
	);

	it("reports modules in mixed hook files instead of approving an incomplete plugin", () => {
		const plugin = tmp();
		fs.mkdirSync(path.join(plugin, ".claude-plugin"));
		fs.mkdirSync(path.join(plugin, "hooks"));
		fs.writeFileSync(path.join(plugin, ".claude-plugin/plugin.json"), '{"name":"mixed"}');
		fs.writeFileSync(path.join(plugin, "hooks/hooks.json"), JSON.stringify({ hooks: {}, modules: ["./policy.mjs"] }));
		const result = inspectPluginHooks({ path: plugin, protocol: "claude" });
		expect(result.fingerprint).toBeUndefined();
		expect(result.errors).toContainEqual(expect.stringContaining("modules"));
	});
});
