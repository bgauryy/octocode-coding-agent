import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createEventBus } from "../../src/core/event-bus.ts";
import { registerMcpHookCaller } from "../../../mcp/src/hook-caller.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
afterEach(() => vi.unstubAllEnvs());
it.each(["claude", "codex", "octocode"] as const)("preserves %s fork source semantics", async (protocol) => {
	const home = tmp();
	const native = tmp();
	vi.stubEnv("OCTOCODE_HOME", native);
	const file =
		protocol === "octocode"
			? path.join(native, "hooks.json")
			: path.join(home, `.${protocol}`, protocol === "claude" ? "settings.json" : "hooks.json");
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const source = protocol === "octocode" ? "resume" : "fork";
	fs.writeFileSync(
		file,
		JSON.stringify({
			hooks: { SessionStart: [{ matcher: source, hooks: [{ type: "command", command: "echo source-matched" }] }] },
		}),
	);
	const fake = fakeHost();
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	registerHooks(fake.api, {}, home);
	await fake.fire("session_start", { reason: "fork" }, ctx);
	const results = await fake.emit("before_agent_start", {}, ctx);
	expect(JSON.stringify(results)).toContain("source-matched");
});

it("delivers compact and clear MCP context once through the registered owner", async () => {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".claude"));
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "mcp_tool", server: "policy", tool: "context" }] }] } }),
	);
	const fake = fakeHost();
	fake.api.events = createEventBus();
	const call = vi.fn(async () => ({ content: [{ type: "text" as const, text: "MCP session guidance" }] }));
	const unregister = registerMcpHookCaller(fake.api.events, call);
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	registerHooks(fake.api, {}, home);
	await fake.fire("session_start", { reason: "startup" }, ctx);
	expect(JSON.stringify(await fake.emit("before_agent_start", {}, ctx))).not.toContain("MCP session guidance");
	expect(call).not.toHaveBeenCalled();
	for (const event of ["session_compact", "session_start"] as const) {
		await fake.fire(event, { reason: "new" }, ctx);
		expect(JSON.stringify(await fake.emit("before_agent_start", {}, ctx))).toContain("MCP session guidance");
		expect(JSON.stringify(await fake.emit("before_agent_start", {}, ctx))).not.toContain("MCP session guidance");
	}
	expect(call).toHaveBeenCalledTimes(2);
	unregister();
	await fake.fire("session_shutdown", {}, ctx);
});

it.each(["claude", "codex"] as const)(
	"delivers the active model through the %s SessionStart owner",
	async (protocol) => {
		const home = tmp();
		vi.stubEnv("OCTOCODE_HOME", tmp());
		const file = path.join(home, `.${protocol}`, protocol === "claude" ? "settings.json" : "hooks.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify({
				hooks: {
					SessionStart: [
						{ hooks: [{ type: "mcp_tool", server: "policy", tool: "context", input: { model: "${model}" } }] },
					],
				},
			}),
		);
		const fake = fakeHost();
		fake.api.events = createEventBus();
		const call = vi.fn(async () => ({ content: [] }));
		const unregister = registerMcpHookCaller(fake.api.events, call);
		const ctx = fakeCtx({ cwd: tmp(), hasUI: false, model: { id: "fixture-model" } });
		registerHooks(fake.api, {}, home);
		try {
			await fake.fire("session_start", { reason: protocol === "claude" ? "new" : "startup" }, ctx);
			await fake.emit("before_agent_start", {}, ctx);
			expect(call).toHaveBeenCalledWith(expect.objectContaining({ input: { model: "fixture-model" } }));
		} finally {
			unregister();
			await fake.fire("session_shutdown", {}, ctx);
		}
	},
);
