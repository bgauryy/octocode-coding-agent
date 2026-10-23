import { describe, expect, it } from "vitest";
import { completeCli, shellCompletion } from "../src/cli/completion.ts";

describe("CLI value completion", () => {
	it("offers valid enum values and preserves comma-separated tool selections", () => {
		expect(completeCli(["--mode", ""])).toEqual(["text", "json", "rpc", "acp"]);
		expect(completeCli(["--thinking", "hi"])).toEqual(["high"]);
		expect(completeCli(["--tui-mode", ""])).toEqual(["fullscreen", "regular"]);
		expect(completeCli(["--tools", "read,ba"])).toContain("read,bash");
	});
	it("follows nested commands and does not suggest flags in free text or after --", () => {
		expect(completeCli(["mcp", "exposure", "server", ""])).toEqual(["auto", "deferred", "direct", "hidden"]);
		expect(completeCli(["auth", ""])).toContain("check");
		expect(completeCli(["--api-key", ""])).toEqual([]);
		expect(completeCli(["--", "--"])).toEqual([]);
		expect(completeCli(["--mode", "text", "--th"])).toEqual(["--thinking", "--theme"]);
	});
	it.each(["bash", "zsh", "fish"] as const)("generates %s completion without installing it", (shell) => {
		expect(shellCompletion(shell)).toContain("completion --values");
	});
});

it("keeps completion flags aligned with the argument parser", async () => {
	const { readFileSync } = await import("node:fs");
	const { CLI_FLAGS } = await import("../src/cli/completion.ts");
	const source = readFileSync(new URL("../src/cli/args.ts", import.meta.url), "utf8");
	const flags = [...source.matchAll(/arg === "(-[^" ]+)"/g)].map((match) => match[1]);
	expect(new Set(CLI_FLAGS)).toEqual(new Set(flags));
});

it("completes catalog providers and models without resolving credentials", () => {
	expect(completeCli(["--provider", "openai"])).toContain("openai");
	expect(completeCli(["--provider", "openai", "--model", ""])).not.toHaveLength(0);
});

it.each(["bash", "zsh"] as const)("preserves an empty value through the %s shell adapter", async (shell) => {
	const { spawnSync } = await import("node:child_process");
	const available = spawnSync(shell, ["--version"]);
	if (available.error) return;
	const stub = 'octocode() { printf "%s\\n" "$#:$*"; }\n';
	const script =
		shell === "bash"
			? `${stub}${shellCompletion(shell)}\nCOMP_WORDS=(octocode --mode ''); COMP_CWORD=2; _octocode_complete; printf '%s\\n' "\${COMPREPLY[@]}"`
			: `compdef() { :; }; compadd() { print -rl -- "\${candidates[@]}"; };\n${stub}${shellCompletion(shell)}\nwords=(octocode --mode ''); CURRENT=3; PREFIX=''; _octocode_complete`;
	const result = spawnSync(shell, ["-c", script], { encoding: "utf8" });
	expect(result.status, result.stderr).toBe(0);
	expect(result.stdout.trim()).toBe("4:completion --values --mode");
});
