import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runMcpCommand } from "../src/cli.ts";
import { projectMcpConfigPath } from "../src/paths.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function options() {
	const cwd = mkdtempSync(join(tmpdir(), "mcp-cli-admission-"));
	dirs.push(cwd);
	return {
		cwd,
		agentDir: cwd,
		presets: [],
		log: vi.fn(),
		error: vi.fn(),
		prepareTrust: vi.fn<() => Promise<void>>(async () => undefined),
	};
}

it("does not admit trust for help, invalid add, global add or remove", async () => {
	const input = options();
	expect(await runMcpCommand(["--help"], input)).toBe(0);
	expect(await runMcpCommand(["add"], input)).toBe(1);
	expect(await runMcpCommand(["add", "fixture", "--", "node", "server.js"], input)).toBe(0);
	expect(await runMcpCommand(["remove", "fixture"], input)).toBe(0);
	expect(input.prepareTrust).not.toHaveBeenCalled();
});

it("awaits host admission before inspecting folder trust", async () => {
	const input = options();
	const admitted = Promise.withResolvers<void>();
	input.prepareTrust.mockImplementation(() => admitted.promise);
	let settled = false;
	const pending = runMcpCommand(["config", "--json"], input).finally(() => {
		settled = true;
	});
	expect(input.prepareTrust).toHaveBeenCalledOnce();
	expect(input.log).not.toHaveBeenCalled();
	expect(settled).toBe(false);
	admitted.resolve();
	expect(await pending).toBe(0);
	expect(input.log).toHaveBeenCalled();
});

it("refuses local add before mutation if host admission fails", async () => {
	const input = options();
	input.prepareTrust.mockRejectedValue(new Error("trust storage unavailable"));
	await expect(runMcpCommand(["add", "fixture", "--local", "--", "node", "server.js"], input)).rejects.toThrow(
		"trust storage unavailable",
	);
	expect(input.prepareTrust).toHaveBeenCalledOnce();
	expect(existsSync(projectMcpConfigPath(input.cwd))).toBe(false);
});
