import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ initialize: vi.fn(async () => {}) }));
vi.mock("../../src/octocode/permission/bash-syntax.ts", () => ({
	initializeBashSyntax: state.initialize,
	bashSyntax: () => ({
		commands: [],
		incomplete: true,
		targets: [],
		wholeAllow: true,
	}),
}));
vi.mock("../../src/octocode/shared/trust.ts", () => ({
	projectTrustForContents: async () => true,
}));
import { registerSourcePolicy } from "../../src/octocode/permission/source-policy-loader.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
	state.initialize.mockReset().mockResolvedValue();
	vi.unstubAllEnvs();
});
function fixture(enabled = true) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "bash-policy-init-"));
	roots.push(root);
	const home = path.join(root, "home");
	fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
	vi.stubEnv("CLAUDE_CONFIG_DIR", path.join(home, ".claude"));
	const file = path.join(home, ".claude/settings.json");
	const write = (permissions: unknown) => fs.writeFileSync(file, JSON.stringify({ permissions }));
	const fake = fakePi();
	fake.pi.setToolPolicy = vi.fn();
	const owner = registerSourcePolicy(fake.pi, { OCTOCODE_HOOKS_COMPAT: enabled ? "1" : "0" }, home);
	return { owner, write, ctx: fakeCtx({ cwd: root, hasUI: false }), fake };
}
const call = {
	toolName: "bash",
	toolCallId: "one",
	active: true,
	input: { command: "true" },
};
it("initializes compatibility file effects with no configured rules", async () => {
	const f = fixture();
	f.write({});
	await f.owner.refresh(f.ctx);
	expect(state.initialize).toHaveBeenCalledTimes(1);
});
it("does not initialize when compatibility is disabled", async () => {
	const f = fixture(false);
	f.write({ deny: ["Bash(*)"] });
	await f.owner.refresh(f.ctx);
	expect(state.initialize).not.toHaveBeenCalled();
});
it("holds concurrent refreshes behind initialization and captures changed bytes afterward", async () => {
	const f = fixture();
	f.write({ allow: ["Bash(true)"] });
	let release!: () => void;
	state.initialize.mockImplementationOnce(
		() =>
			new Promise<void>((resolve) => {
				release = resolve;
			}),
	);
	const first = f.owner.refresh(f.ctx);
	await vi.waitFor(() => expect(release).toBeTypeOf("function"));
	let settled = false;
	const second = f.owner.refresh(f.ctx).then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	expect(f.fake.pi.setToolPolicy).not.toHaveBeenCalled();
	f.write({ deny: ["Bash"] });
	release();
	await Promise.all([first, second]);
	expect(f.owner.evaluate(call, f.ctx.cwd).decision).toBe("deny");
});
it("does not poison later refreshes when initialization fails", async () => {
	const f = fixture();
	f.write({ deny: ["Bash(true)"] });
	state.initialize.mockRejectedValueOnce(new Error("missing asset"));
	await f.owner.refresh(f.ctx);
	await f.owner.refresh(f.ctx);
	expect(state.initialize).toHaveBeenCalledTimes(2);
	expect(f.owner.evaluate(call, f.ctx.cwd).decision).toBe("deny");
});
