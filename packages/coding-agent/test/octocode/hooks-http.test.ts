import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commandsFor, loadHooks } from "../../src/octocode/hooks/config.ts";
import { failureOf, interpret, runHook } from "../../src/octocode/hooks/runner.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";

const servers: http.Server[] = [];
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(
		servers.splice(0).map(
			(server) =>
				new Promise<void>((resolve) => {
					server.closeAllConnections();
					server.close(() => resolve());
				}),
		),
	);
});
async function endpoint(handler: http.RequestListener) {
	const server = http.createServer(handler);
	servers.push(server);
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}/hook`;
}
function configured(url: string, fields: Record<string, unknown> = {}, policy: Record<string, unknown> = {}) {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	fs.mkdirSync(path.join(home, ".claude"));
	fs.writeFileSync(
		path.join(home, ".claude/settings.json"),
		JSON.stringify({ ...policy, hooks: { PreToolUse: [{ hooks: [{ type: "http", url, ...fields }] }] } }),
	);
	const result = loadHooks(tmp(), false, home, { sourceProfiles: true });
	return { ...result, home, hook: commandsFor(result.config, "PreToolUse", ["Bash"])[0]! };
}
describe("Claude HTTP hook transport", () => {
	it("posts the payload and restricts header interpolation with both allowlists", async () => {
		let received: unknown;
		const url = await endpoint(async (req, res) => {
			const chunks = [];
			for await (const chunk of req) chunks.push(chunk);
			received = {
				method: req.method,
				contentType: req.headers["content-type"],
				auth: req.headers.authorization,
				secret: req.headers["x-secret"],
				payload: JSON.parse(Buffer.concat(chunks).toString()),
			};
			res.end(
				JSON.stringify({
					hookSpecificOutput: {
						hookEventName: "PreToolUse",
						permissionDecision: "deny",
						permissionDecisionReason: "policy",
					},
				}),
			);
		});
		const { hook, errors } = configured(
			url,
			{
				headers: { Authorization: "Bearer $TOKEN", "X-Secret": "${SECRET}.$OTHER" },
				allowedEnvVars: ["TOKEN", "SECRET"],
			},
			{ allowedHttpHookUrls: ["http://127.0.0.1:*"], httpHookAllowedEnvVars: ["TOKEN"] },
		);
		expect(errors).toEqual([]);
		const input = { hook_event_name: "PreToolUse", tool_name: "Bash" };
		const result = await runHook(hook, input, tmp(), { TOKEN: "yes", SECRET: "no", OTHER: "no" });
		expect(received).toEqual({
			method: "POST",
			contentType: "application/json",
			auth: "Bearer yes",
			secret: ".",
			payload: input,
		});
		expect(interpret("PreToolUse", result, "claude")).toMatchObject({ block: "policy" });
	});
	it("expands plugin header variables with the same identity as command hooks", async () => {
		let root: string | undefined;
		const url = await endpoint((req, res) => {
			root = req.headers["x-plugin"] as string;
			res.end();
		});
		const { hook } = configured(url, {
			headers: { "X-Plugin": "${CLAUDE_PLUGIN_ROOT}" },
			allowedEnvVars: ["CLAUDE_PLUGIN_ROOT"],
		});
		hook.plugin = { id: "fixture", root: tmp(), data: tmp() };
		await runHook(hook, {}, tmp(), { CLAUDE_PLUGIN_ROOT: "incorrect" });
		expect(root).toBe(hook.plugin.root);
	});

	it.each([
		{ status: 503, body: "{}" },
		{ status: 200, body: "plain" },
		{ status: 200, body: "[]" },
		{ status: 200, body: "x".repeat(70000) },
	])("reports invalid response $status", async ({ status, body }) => {
		const url = await endpoint((_req, res) => {
			res.statusCode = status;
			res.end(body);
		});
		const { hook } = configured(url);
		expect(hook).toBeDefined();
		const result = await runHook(hook, {}, tmp());
		expect(failureOf(hook, result, false)).toBeTruthy();
		expect(interpret("PreToolUse", result, "claude")).toEqual({});
	});
	it("accepts an empty successful response", async () => {
		const { hook } = configured(await endpoint((_req, res) => res.end()));
		const result = await runHook(hook, {}, tmp());
		expect(failureOf(hook, result, false)).toBeUndefined();
	});
	it("blocks disallowed destinations before sending and never follows redirects", async () => {
		let requests = 0;
		const url = await endpoint((_req, res) => {
			requests++;
			res.writeHead(302, { Location: "/elsewhere" });
			res.end();
		});
		const denied = configured(url, {}, { allowedHttpHookUrls: [] });
		expect(denied.hook.configurationError).toContain("allowedHttpHookUrls");
		expect(failureOf(denied.hook, await runHook(denied.hook, {}, tmp()), false)).toBeTruthy();
		expect(requests).toBe(0);
		const allowed = configured(url).hook;
		expect(failureOf(allowed, await runHook(allowed, {}, tmp()), false)).toBeTruthy();
		expect(requests).toBe(1);
	});
	it("bounds a stalled response and honors cancellation", async () => {
		const { hook } = configured(await endpoint(() => {}), { timeout: 0.03 });
		expect((await runHook(hook, {}, tmp())).timedOut).toBe(true);
		const abort = new AbortController();
		abort.abort();
		expect(failureOf(hook, await runHook(hook, {}, tmp(), {}, abort.signal), true)).toBeUndefined();
	});
	it("enforces onFailure through the actual pre-tool dispatcher", async () => {
		const url = await endpoint((_req, res) => {
			res.statusCode = 500;
			res.end();
		});
		const { home } = configured(url, { onFailure: "block" });
		const fake = fakePi();
		const hooks = registerHooks(fake.pi, { OCTOCODE_HOOKS: "1", OCTOCODE_HOOKS_COMPAT: "1" }, home);
		const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
		await fake.fire("session_start", { reason: "startup" }, ctx);
		expect(
			await hooks.preToolUse({ toolName: "bash", toolCallId: "http", input: { command: "true" } } as never, ctx),
		).toMatchObject({ block: true, reason: expect.stringContaining("onFailure") });
	});
	it.each(["not a URL", "https://name:secret@example.com/", "file:///tmp/policy"])(
		"retains a required HTTP gate with invalid URL %s",
		async (url) => {
			const { home } = configured(url, { onFailure: "block" });
			const fake = fakePi();
			const hooks = registerHooks(fake.pi, { OCTOCODE_HOOKS: "1", OCTOCODE_HOOKS_COMPAT: "1" }, home);
			const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
			await fake.fire("session_start", { reason: "startup" }, ctx);
			expect(
				await hooks.preToolUse(
					{ toolName: "bash", toolCallId: "invalid-http", input: { command: "true" } } as never,
					ctx,
				),
			).toMatchObject({ block: true });
			expect(() => hooks.report(ctx.cwd)).not.toThrow();
			expect(hooks.report(ctx.cwd)).not.toContain("secret");
		},
	);

	it("merges trusted settings policies and keeps URL paths case-sensitive", () => {
		const { home } = configured("http://EXAMPLE.COM./Allowed", {}, { allowedHttpHookUrls: ["http://unrelated/*"] });
		const cwd = tmp();
		fs.mkdirSync(path.join(cwd, ".claude"));
		fs.writeFileSync(
			path.join(cwd, ".claude/settings.json"),
			JSON.stringify({ allowedHttpHookUrls: ["http://example.com/Allowed"] }),
		);
		const trusted = commandsFor(loadHooks(cwd, true, home, { sourceProfiles: true }).config, "PreToolUse", [
			"Bash",
		])[0]!;
		expect(trusted.configurationError).toBeUndefined();
		const untrusted = commandsFor(loadHooks(cwd, false, home, { sourceProfiles: true }).config, "PreToolUse", [
			"Bash",
		])[0]!;
		expect(untrusted.configurationError).toBeTruthy();
		fs.writeFileSync(
			path.join(cwd, ".claude/settings.json"),
			JSON.stringify({ allowedHttpHookUrls: ["http://example.com/allowed"] }),
		);
		expect(
			commandsFor(loadHooks(cwd, true, home, { sourceProfiles: true }).config, "PreToolUse", ["Bash"])[0]!
				.configurationError,
		).toBeTruthy();
	});
});
