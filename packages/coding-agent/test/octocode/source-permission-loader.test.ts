import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const trust = vi.hoisted(() => ({ check: vi.fn(async () => true) }));
vi.mock("../../src/octocode/shared/trust.ts", () => ({
	projectTrustForContents: trust.check,
}));
import { registerSourcePolicy } from "../../src/octocode/permission/source-policy-loader.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0))
		fs.rmSync(root, { recursive: true, force: true });
	trust.check.mockReset().mockResolvedValue(true);
	vi.unstubAllEnvs();
});
function setup() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "source-policy-"));
	roots.push(root);
	const cwd = path.join(root, "workspace"),
		home = path.join(root, "home");
	fs.mkdirSync(path.join(cwd, ".claude"), { recursive: true });
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, ".claude"));
	const fake = fakePi();
	fake.pi.setToolPolicy = vi.fn();
	const owner = registerSourcePolicy(
		fake.pi,
		{ OCTOCODE_HOOKS_COMPAT: "1" },
		home,
	);
	const ctx = fakeCtx({ cwd, hasUI: false });
	return {
		root,
		cwd,
		home,
		fake,
		owner,
		ctx,
		project: path.join(cwd, ".claude", "settings.json"),
		user: path.join(home, ".claude", "settings.json"),
	};
}
const invocation = {
	active: true,
	toolCallId: "one",
	toolName: "bash",
	input: { command: "true" },
};
it("never publishes project allowances changed across the trust snapshot", async () => {
	const f = setup();
	fs.writeFileSync(f.project, JSON.stringify({ permissions: { allow: [] } }));
	trust.check.mockImplementationOnce(async () => {
		fs.writeFileSync(
			f.project,
			JSON.stringify({ permissions: { allow: ["Bash"] } }),
		);
		return true;
	});
	await f.owner.refresh(f.ctx);
	expect(f.owner.evaluate(invocation, f.cwd).decision).toBe("unsupported");
});
it("loads restrictive project rules without trust but excludes allowances", async () => {
	const f = setup();
	trust.check.mockResolvedValue(false);
	fs.writeFileSync(
		f.project,
		JSON.stringify({ permissions: { allow: ["Bash"], deny: ["Read"] } }),
	);
	await f.owner.refresh(f.ctx);
	expect(f.owner.evaluate(invocation, f.cwd).decision).toBe("none");
	expect(
		f.owner.evaluate(
			{ ...invocation, toolName: "read", input: { path: "a" } },
			f.cwd,
		).decision,
	).toBe("deny");
});
it.each(["oversized", "directory", "invalid-utf8"])(
	"diagnoses %s source without accepting its policy",
	async (kind) => {
		const f = setup();
		if (kind === "directory") fs.mkdirSync(f.user);
		else
			fs.writeFileSync(
				f.user,
				kind === "oversized"
					? Buffer.alloc(1024 * 1024 + 1, 32)
					: Buffer.from([0xff]),
			);
		await f.owner.refresh(f.ctx);
		expect(f.owner.evaluate(invocation, f.cwd).decision).toBe("unsupported");
	},
);
it("refreshes same-sized settings changes and reinstates tool visibility", async () => {
	const f = setup();
	fs.writeFileSync(f.user, JSON.stringify({ permissions: { deny: ["Bash"] } }));
	await f.owner.refresh(f.ctx);
	const setter = vi.mocked(f.fake.pi.setToolPolicy!);
	expect(setter.mock.calls.at(-1)![0]("bash")).toBe(false);
	fs.writeFileSync(f.user, JSON.stringify({ permissions: { deny: ["Read"] } }));
	await f.owner.refresh(f.ctx);
	expect(setter.mock.calls.at(-1)![0]("bash")).toBe(true);
	expect(f.owner.evaluate(invocation, f.cwd).decision).toBe("none");
});
