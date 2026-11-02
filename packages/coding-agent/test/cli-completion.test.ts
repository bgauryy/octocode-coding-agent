import octocode from "../src/octocode/index.ts";
import { fakeHost } from "./octocode/fake-host.ts";
import { describe, expect, it } from "vitest";
import { completeCli, shellCompletion } from "../src/cli/completion.ts";

describe("CLI value completion", () => {
	it("offers valid enum values and preserves comma-separated tool selections", () => {
		expect(completeCli(["--mode", ""])).toEqual(["text", "json", "rpc", "acp"]);
		expect(completeCli(["--thinking", "hi"])).toEqual(["high"]);
		expect(completeCli(["--tui-mode", ""])).toEqual(["fullscreen", "regular"]);
		expect(completeCli(["--tools", "read,ba"])).toContain("read,bash");
	});
	it("completes every reviewed native tool and the built-in MCP tools", async () => {
		const fake = fakeHost();
		await octocode(fake.api);
		expect(new Set(completeCli(["--tools", ""]))).toEqual(new Set([...fake.tools.keys(), "mcp"]));
		expect(completeCli(["--exclude-tools", "file,deb"])).toEqual(["file,debug"]);
		// The native `browser` tool is retired: browsing is the built-in browser MCP server, so nothing completes it.
		expect(completeCli(["--exclude-tools", "file,bro"])).toEqual([]);
	});
	it("follows nested commands and does not suggest flags in free text or after --", () => {
		expect(completeCli(["mcp", "exposure", "server", ""])).toEqual(["direct", "hidden"]);
		expect(completeCli(["auth", ""])).toContain("check");
		expect(completeCli(["models", ""])).toContain("discover");
		expect(completeCli(["--api-key", ""])).toEqual([]);
		expect(completeCli(["--", "--"])).toEqual([]);
		expect(completeCli(["--mode", "text", "--th"])).toEqual(["--thinking", "--theme"]);
	});
	it.each(["bash", "zsh", "fish"] as const)("generates %s completion without installing it", (shell) => {
		expect(shellCompletion(shell)).toContain("completion --values");
	});
});

it("parses, documents and completes every flag from one table", async () => {
	const { CLI_FLAGS } = await import("../src/cli/completion.ts");
	const { FLAG_SPECS } = await import("../src/cli/args/flags.ts");
	const { parseArgs } = await import("../src/cli/args.ts");
	const { flagHelpRows } = await import("../src/cli/args/flags.ts");
	const help = flagHelpRows().join("\n");
	for (const spec of FLAG_SPECS) {
		// A hidden flag (kept so an older parent's command line still parses) is neither listed nor completed.
		const listed = !spec.hidden;
		expect(CLI_FLAGS.includes(spec.name), spec.name).toBe(listed);
		if (spec.short) expect(CLI_FLAGS.includes(spec.short), spec.short).toBe(listed);
		expect(help.includes(spec.name), spec.name).toBe(listed);
		// Every flag is recognized: none falls through to the unknown-flag path.
		const value = spec.values?.[0] ?? "x";
		const parsed = parseArgs(spec.kind === "boolean" || spec.kind === "optional" ? [spec.name] : [spec.name, value]);
		expect(parsed.unknownFlags.size, spec.name).toBe(0);
		expect(
			parsed.diagnostics.filter((d) => d.message.startsWith("Unknown option")),
			spec.name,
		).toEqual([]);
	}
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
