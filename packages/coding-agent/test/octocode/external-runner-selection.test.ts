import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../../src/core/features/index.ts";
import { externalAgentsEnabled } from "../../src/octocode/external/enabled.ts";
import { connectedRunners } from "../../src/octocode/external/connected.ts";

const turn = vi.hoisted(() => vi.fn(async () => ({ text: "done" })));
vi.mock("../../src/octocode/external/runner-status.ts", () => ({
	listRunners: () => [
		{ id: "claude-code", name: "Claude Code", cli: true, adapter: true },
		{ id: "codex", name: "Codex", cli: true, adapter: true },
	],
}));
vi.mock("../../src/octocode/external/runner-session.ts", () => ({ runnerTurn: turn, runnerTurnDeps: () => ({}) }));

const roots: string[] = [];
afterEach(() => {
	vi.clearAllMocks();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const permission = () => async () => ({ outcome: { outcome: "cancelled" as const } });

it("requires an explicit global choice before offering installed external agents", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-runner-selection-"));
	roots.push(root);
	expect(externalAgentsEnabled(root)).toBe(false);
	fs.writeFileSync(path.join(root, "settings.json"), JSON.stringify({ externalAgents: true }));
	expect(externalAgentsEnabled(root)).toBe(true);
});

it("offers only selected installed runners, including an explicitly empty selection", () => {
	expect(connectedRunners(true, permission, ["claude-code"]).ids).toEqual(["claude-code"]);
	expect(connectedRunners(true, permission, []).ids).toEqual([]);
	expect(connectedRunners(false, permission, ["claude-code"]).ids).toEqual([]);
	expect(connectedRunners(true, permission).ids).toEqual(["claude-code", "codex"]);
});

it("refuses a direct turn for a runner absent from the captured selection before launching it", async () => {
	const runners = connectedRunners(true, permission, ["claude-code"]);
	await expect(
		runners.turn({
			runner: "codex",
			cwd: "/fixture",
			text: "inspect",
			signal: new AbortController().signal,
			onActivity: () => undefined,
			ctx: { cwd: "/fixture" } as ExtensionContext,
		}),
	).rejects.toThrow(/not enabled/);
	expect(turn).not.toHaveBeenCalled();
});
