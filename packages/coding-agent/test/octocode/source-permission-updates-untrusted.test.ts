import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerSourcePolicy } from "../../src/octocode/permission/source-policy-loader.ts";
import { grantsAccess, parsePermissionUpdates } from "../../src/octocode/shared/permission-updates.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";

/**
 * A hook's `updatedPermissions` aimed at `projectSettings` or `localSettings`: the loader ignores an untrusted project's
 * grants, so a granting update there is refused before anything is written (it would be saved and never apply).
 * Restricting updates are still saved, and a trusted project or the user/session destinations are unaffected.
 */
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

async function fixture(trusted: boolean) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "permission-updates-untrusted-"));
	roots.push(root);
	const home = path.join(root, "home");
	const cwd = path.join(root, "work");
	fs.mkdirSync(home, { recursive: true });
	fs.mkdirSync(cwd);
	vi.stubEnv("CLAUDE_CONFIG_DIR", home);
	const owner = registerSourcePolicy(fakeHost().api, { home });
	const ctx = { ...fakeCtx({ cwd, hasUI: false }), isProjectTrusted: () => trusted };
	await owner.refresh(ctx);
	const decision = () =>
		owner.evaluate({ active: true, toolCallId: "x", toolName: "bash", input: { command: "node -p 42" } }, cwd).decision;
	const file = (name: string) => path.join(cwd, ".claude", name);
	return { owner, ctx, decision, file, home };
}

const update = (destination: string, behavior: "allow" | "deny") =>
	parsePermissionUpdates([
		{ type: "addRules", rules: [{ toolName: "Bash", ruleContent: "node -p 42" }], behavior, destination },
	]);
const publish = (f: Awaited<ReturnType<typeof fixture>>, updates: ReturnType<typeof update>) =>
	f.owner.prepareUpdates(f.ctx, updates)(new AbortController().signal, (change) => change());

for (const [destination, name] of [
	["projectSettings", "settings.json"],
	["localSettings", "settings.local.json"],
] as const) {
	it(`refuses an allow rule to ${destination} in an untrusted project and writes nothing`, async () => {
		const f = await fixture(false);
		expect(() => f.owner.prepareUpdates(f.ctx, update(destination, "allow"))).toThrow(
			/not saved: this project is not trusted.*\/trust.*userSettings or session/,
		);
		expect(fs.existsSync(f.file(name))).toBe(false);
		expect(f.decision()).toBe("none");
	});

	it(`still saves a deny rule to ${destination} in an untrusted project, and it restricts`, async () => {
		const f = await fixture(false);
		await publish(f, update(destination, "deny"));
		expect(JSON.parse(fs.readFileSync(f.file(name), "utf8")).permissions.deny).toEqual(["Bash(node -p 42)"]);
		expect(f.decision()).toBe("deny");
	});

	it(`saves an allow rule to ${destination} in a trusted project and it grants`, async () => {
		const f = await fixture(true);
		await publish(f, update(destination, "allow"));
		expect(JSON.parse(fs.readFileSync(f.file(name), "utf8")).permissions.allow).toEqual(["Bash(node -p 42)"]);
		expect(f.decision()).toBe("allow");
	});

	it(`saves a deny rule to ${destination} in a trusted project`, async () => {
		const f = await fixture(true);
		await publish(f, update(destination, "deny"));
		expect(f.decision()).toBe("deny");
	});
}

it("refuses the whole batch when one update grants, before any file is written", async () => {
	const f = await fixture(false);
	const updates = [...update("projectSettings", "deny"), ...update("localSettings", "allow")];
	expect(() => f.owner.prepareUpdates(f.ctx, updates)).toThrow(/localSettings not saved/);
	expect(fs.existsSync(f.file("settings.json"))).toBe(false);
});

it("refuses acceptEdits and extra directories to project files in an untrusted project", async () => {
	const f = await fixture(false);
	for (const raw of [
		{ type: "setMode", mode: "acceptEdits", destination: "localSettings" },
		{ type: "addDirectories", directories: ["/tmp/x"], destination: "projectSettings" },
	]) {
		expect(() => f.owner.prepareUpdates(f.ctx, parsePermissionUpdates([raw]))).toThrow(/not trusted/);
	}
	expect(fs.existsSync(f.file("settings.json"))).toBe(false);
	expect(fs.existsSync(f.file("settings.local.json"))).toBe(false);
});

it("leaves the user and session destinations granting in an untrusted project", async () => {
	const f = await fixture(false);
	await publish(f, update("userSettings", "allow"));
	expect(f.decision()).toBe("allow");
	const g = await fixture(false);
	await publish(g, update("session", "allow"));
	expect(g.decision()).toBe("allow");
});

it("classifies which updates grant", () => {
	const one = (raw: object) => grantsAccess(parsePermissionUpdates([{ destination: "localSettings", ...raw }])[0]);
	const rules = [{ toolName: "Bash" }];
	expect(one({ type: "addRules", behavior: "allow", rules })).toBe(true);
	expect(one({ type: "replaceRules", behavior: "allow", rules })).toBe(true);
	expect(one({ type: "removeRules", behavior: "allow", rules })).toBe(false);
	expect(one({ type: "addRules", behavior: "ask", rules })).toBe(false);
	expect(one({ type: "addRules", behavior: "deny", rules })).toBe(false);
	expect(one({ type: "setMode", mode: "acceptEdits" })).toBe(true);
	expect(one({ type: "setMode", mode: "dontAsk" })).toBe(false);
	expect(one({ type: "addDirectories", directories: ["/x"] })).toBe(true);
	expect(one({ type: "removeDirectories", directories: ["/x"] })).toBe(false);
});
