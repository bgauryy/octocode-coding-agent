import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerSourcePolicy } from "../../src/octocode/permission/source-policy-loader.ts";
import { applySessionRuleUpdates, parsePermissionUpdates } from "../../src/octocode/shared/permission-updates.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

const empty = () => ({ allow: [], deny: [], ask: [] });
const add = (ruleContent: string, type = "addRules", behavior = "allow") => ({
	type,
	rules: [{ toolName: "Bash", ruleContent }],
	behavior,
	destination: "session",
});
it("applies ordered rules only within their destination behavior", () => {
	const initial = { allow: ["Bash(old)"], deny: ["Bash(protected)"], ask: [] };
	expect(
		applySessionRuleUpdates(
			initial,
			parsePermissionUpdates([add("new", "replaceRules"), add("new", "removeRules"), add("final")]),
		),
	).toEqual({ allow: ["Bash(final)"], deny: ["Bash(protected)"], ask: [] });
	expect(initial.allow).toEqual(["Bash(old)"]);
});
it("rejects unsupported effects without changing prior session rules", () => {
	const initial = empty();
	expect(() =>
		applySessionRuleUpdates(
			initial,
			parsePermissionUpdates([add("new"), { type: "setMode", mode: "auto", destination: "session" }]),
		),
	).toThrow(/Unsupported/);
	expect(initial).toEqual(empty());
});
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
});
async function fixture() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-updates-"));
	roots.push(root);
	const home = path.join(root, "home"),
		cwd = path.join(root, "work");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(cwd);
	vi.stubEnv("CLAUDE_CONFIG_DIR", home);
	const fake = fakeHost();
	const changed = vi.fn();
	const owner = registerSourcePolicy(fake.api, home, changed);
	const ctx = fakeCtx({ cwd, hasUI: false });
	await owner.refresh(ctx);
	const decision = () =>
		owner.evaluate(
			{
				active: true,
				toolCallId: "x",
				toolName: "bash",
				input: { command: "node -p 42" },
			},
			cwd,
		).decision;
	return { owner, ctx, changed, decision };
}
it("stages session updates without mutation and preserves them across refresh", async () => {
	const f = await fixture();
	const publish = f.owner.prepareUpdates(f.ctx, parsePermissionUpdates([add("node -p 42")]));
	expect(f.decision()).toBe("none");
	await publish(new AbortController().signal, (change) => change());
	expect(f.decision()).toBe("allow");
	await f.owner.refresh(f.ctx);
	expect(f.decision()).toBe("allow");
});
it("rejects a stale staged update after another publication", async () => {
	const f = await fixture();
	const stale = f.owner.prepareUpdates(f.ctx, parsePermissionUpdates([add("node -p 42")]));
	await f.owner.prepareUpdates(f.ctx, parsePermissionUpdates([add("node -p 42", "addRules", "deny")]))(
		new AbortController().signal,
		(change) => change(),
	);
	await expect(stale(new AbortController().signal, (change) => change())).rejects.toThrow(/changed/);
	expect(f.decision()).toBe("deny");
});

it("clears session updates for a different actual session", async () => {
	const f = await fixture();
	await f.owner.prepareUpdates(f.ctx, parsePermissionUpdates([add("node -p 42")]))(
		new AbortController().signal,
		(change) => change(),
	);
	const other = {
		...f.ctx,
		sessionManager: {
			...f.ctx.sessionManager,
			getSessionId: () => "another-session",
		},
	};
	await f.owner.refresh(other);
	expect(f.decision()).toBe("none");
});

it("rejects an actual session switch even without a policy refresh", async () => {
	const f = await fixture();
	let id = f.ctx.sessionManager.getSessionId();
	const ctx = {
		...f.ctx,
		sessionManager: { ...f.ctx.sessionManager, getSessionId: () => id },
	};
	const staged = f.owner.prepareUpdates(ctx, parsePermissionUpdates([add("node -p 42")]));
	id = "switched-without-refresh";
	await expect(staged(new AbortController().signal, (change) => change())).rejects.toThrow(/changed/);
	expect(f.decision()).toBe("none");
});
