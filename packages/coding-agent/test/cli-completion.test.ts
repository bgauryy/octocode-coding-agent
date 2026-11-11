import octocode from "../src/octocode/index.ts";
import { fakeHost } from "./octocode/fake-host.ts";
import { describe, expect, it, vi } from "vitest";
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
		expect(completeCli(["--exclude-tools", "file,arc"])).toEqual(["file,archive"]);
		// The former `debug` tool is removed (docs/native-features.md), so nothing completes it.
		expect(completeCli(["--exclude-tools", "file,deb"])).toEqual([]);
		// The native `browser` tool is retired: browsing is the built-in browser MCP server, so nothing completes it.
		expect(completeCli(["--exclude-tools", "file,bro"])).toEqual([]);
	});
	it("follows nested commands and does not suggest flags in free text or after --", () => {
		// docs/mcp-reference.md: `/mcp exposure <server> <direct|deferred|hidden>`.
		expect(completeCli(["mcp", "exposure", "server", ""])).toEqual(["direct", "deferred", "hidden"]);
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
		expect(parsed.unknownFlags, spec.name).toEqual([]);
		expect(
			parsed.diagnostics.filter((d) => d.message.startsWith("Unknown option")),
			spec.name,
		).toEqual([]);
	}
});

it("lists --plan in help and has no feature flag section", async () => {
	const { printHelp } = await import("../src/cli/args.ts");
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		printHelp();
		const text = log.mock.calls.map((call) => String(call[0])).join("\n");
		expect(text).toContain("--plan");
		expect(text).not.toContain("Feature CLI Flags");
		expect(text).not.toContain("register additional flags");
	} finally {
		log.mockRestore();
	}
});

it("shows unattended delegation and persistent RPC examples in help", async () => {
	const { parseArgs, printHelp } = await import("../src/cli/args.ts");
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	try {
		printHelp();
		const text = log.mock.calls.map((call) => String(call[0])).join("\n");
		const invocations = [
			["-p", "--no-stdin", "--no-session", "--permission-mode", "workspace"],
			["--mode", "json", "--no-stdin", "--permission-mode", "workspace"],
			["--mode", "rpc", "--no-dialogs", "--permission-mode", "workspace"],
		];
		for (const args of invocations) {
			expect(text).toContain(args.join(" "));
			const parsed = parseArgs([...args, ...(args.includes("rpc") ? [] : ["Review this repository"])]);
			expect(parsed.unknownFlags).toEqual([]);
			expect(parsed.diagnostics).toEqual([]);
		}
		expect(text).toContain("Keep stdin open until completion");
		expect(text).toContain("--trust records folder trust");
	} finally {
		log.mockRestore();
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
