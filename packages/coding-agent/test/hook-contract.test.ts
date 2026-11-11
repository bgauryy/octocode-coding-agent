import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { matchesHook } from "../src/octocode/hooks/profiles.ts";
import { parseHooks } from "../src/octocode/hooks/config/parse.ts";
import {
	createSandbox,
	QUIET_ARGS,
	runCli,
	SCRIPTED_MODEL_ARGS,
	type ModelServer,
	type Sandbox,
	startModelServer,
	writeScriptedProvider,
	writeSettings,
} from "./helpers/feature-host-cli.ts";
import { HOOK_SETTINGS } from "./octocode/helpers.ts";

/**
 * The hook contract of Claude Code, driven through the real CLI (`octocode -p`) with a scripted model: what a command
 * hook receives on stdin, what its exit code and JSON output do, and that SessionEnd hooks of every dialect run.
 */
const CAPTURE = join(dirname(fileURLToPath(import.meta.url)), "octocode", "fixtures", "capture-hook.mjs");
let sandbox: Sandbox;
let server: ModelServer | undefined;

afterEach(async () => {
	await server?.close();
	sandbox?.cleanup();
	server = undefined;
});

const command = (out: string, mode: string) => `node "${CAPTURE}" "${out}" ${mode}`;
const hookFile = (file: string, hooks: unknown) => {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({ hooks }));
};
const group = (cmd: string, matcher?: string) => [
	{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: cmd }] },
];
const nativeHooks = () => join(sandbox.env.OCTOCODE_HOME, "hooks.json");
const claudeHooks = () => join(sandbox.directory, ".claude", "settings.json");
const captured = (out: string, event: string): Record<string, unknown>[] =>
	(existsSync(out) ? readdirSync(out) : [])
		.filter((name) => name.startsWith(`${event}-`))
		.sort()
		.map((name) => JSON.parse(readFileSync(join(out, name), "utf8")));

/** A run in which the model asks for one bash call (`touch <marker>`), then answers. */
async function run(prompt = "go") {
	const marker = join(sandbox.directory, "bash-ran.txt");
	server = await startModelServer([{ tool: "bash", args: { command: `touch "${marker}"` } }, { text: "finished" }]);
	writeScriptedProvider(sandbox, server);
	const result = await runCli(sandbox, [...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS, "-p", prompt]);
	return { result, marker, secondRequest: JSON.stringify(server.requests[1] ?? null) };
}

const setup = () => {
	sandbox = createSandbox({ OCTOCODE_PERMISSION: "full" });
	writeSettings(sandbox, { ...HOOK_SETTINGS });
	return join(sandbox.directory, "captured");
};

describe("command hook contract through octocode -p", () => {
	it("sends the common stdin fields, and exit 0 lets the call proceed", async () => {
		const out = setup();
		hookFile(claudeHooks(), { PreToolUse: group(command(out, "allow"), "Bash") });
		const { result, marker } = await run();
		expect(result.code).toBe(0);
		expect(existsSync(marker)).toBe(true);
		const [input] = captured(out, "PreToolUse");
		expect(input).toMatchObject({
			hook_event_name: "PreToolUse",
			tool_name: "Bash",
			cwd: sandbox.project,
			tool_input: { command: `touch "${marker}"` },
		});
		expect(typeof input?.session_id).toBe("string");
		expect(input).toHaveProperty("transcript_path");
		expect(input).toHaveProperty("permission_mode");
	});

	it.each([
		["native", () => nativeHooks()],
		["Claude", () => claudeHooks()],
	])("%s hooks: exit 2 blocks the call and its stderr reaches the model", async (_dialect, file) => {
		const out = setup();
		hookFile(file(), { PreToolUse: group(command(out, "block")) });
		const { result, marker, secondRequest } = await run();
		expect(result.code).toBe(0);
		expect(existsSync(marker)).toBe(false);
		expect(captured(out, "PreToolUse")).toHaveLength(1);
		expect(secondRequest).toContain("blocked-by-fixture-stderr");
	});

	it("honors a JSON permissionDecision deny on exit 0", async () => {
		const out = setup();
		hookFile(claudeHooks(), { PreToolUse: group(command(out, "deny")) });
		const { marker, secondRequest } = await run();
		expect(existsSync(marker)).toBe(false);
		expect(secondRequest).toContain("denied-by-fixture-json");
	});

	it("reads a Claude hook's JSON deny on an exit code other than 2", async () => {
		const out = setup();
		hookFile(claudeHooks(), { PreToolUse: group(command(out, "exit1-deny")) });
		const { marker, secondRequest } = await run();
		expect(existsSync(marker)).toBe(false);
		expect(secondRequest).toContain("denied-by-exit1-json");
	});

	it("uses the reason of a JSON blocking decision over stderr when the hook exits 2", async () => {
		const out = setup();
		hookFile(claudeHooks(), { PreToolUse: group(command(out, "json-block")) });
		const { marker, secondRequest } = await run();
		expect(existsSync(marker)).toBe(false);
		expect(secondRequest).toContain("blocked-by-fixture-json-reason");
		expect(secondRequest).not.toContain("stderr-that-loses");
	});

	it.each([
		["native", () => nativeHooks()],
		["Claude", () => claudeHooks()],
	])("%s SessionEnd hooks run when the session ends, with the reason", async (_dialect, file) => {
		const out = setup();
		hookFile(file(), { SessionEnd: group(command(out, "allow")) });
		server = await startModelServer([{ text: "hello" }]);
		writeScriptedProvider(sandbox, server);
		const result = await runCli(sandbox, [...QUIET_ARGS, ...SCRIPTED_MODEL_ARGS, "-p", "hi"]);
		expect(result.code).toBe(0);
		const [input] = captured(out, "SessionEnd");
		expect(input).toMatchObject({ hook_event_name: "SessionEnd", reason: "other", cwd: sandbox.project });
		expect(typeof input?.session_id).toBe("string");
	});
});

describe("plugins with a stale approval key in settings", () => {
	it("still run their hooks: a leftover fingerprint is ignored, never a reason to skip the plugin", async () => {
		const out = setup();
		const plugin = join(sandbox.directory, "plugin");
		mkdirSync(join(plugin, ".claude-plugin"), { recursive: true });
		writeFileSync(join(plugin, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "held-kit" }));
		hookFile(join(plugin, "hooks", "hooks.json"), { PreToolUse: group(command(out, "allow")) });
		writeSettings(sandbox, { plugins: [{ path: plugin, protocol: "claude", hooksFingerprint: "a".repeat(64) }] });
		const { result, marker } = await run();
		expect(result.code).toBe(0);
		expect(existsSync(marker)).toBe(true);
		expect(captured(out, "PreToolUse")).toHaveLength(1);
	});
});

describe("hook handler fields and matchers", () => {
	const parse = (hook: Record<string, unknown>, protocol: "claude" | "octocode" = "claude") => {
		const errors: string[] = [];
		const config = parseHooks(
			{ hooks: { PostToolUse: [{ hooks: [{ type: "command", command: "true", ...hook }] }] } },
			"hooks.json",
			undefined,
			errors,
			undefined,
			protocol,
		);
		return { hooks: config.PostToolUse.flatMap((g) => g.hooks), errors };
	};

	it("preserves a valid Claude permission rule as the hook filter", () => {
		const { hooks, errors } = parse({ if: "Bash(git *)" });
		expect(hooks).toMatchObject([{ command: "true", if: "Bash(git *)" }]);
		expect(errors).toEqual([]);
	});

	it("skips an invalid Claude permission rule rather than running the hook unfiltered", () => {
		const { hooks, errors } = parse({ if: "Bash(" });
		expect(hooks).toEqual([]);
		expect(errors).toContainEqual(expect.stringContaining('"if" must be one permission rule'));
	});

	it("accepts a Claude `shell` of bash or powershell and rejects anything else", () => {
		expect(parse({ shell: "powershell" }).hooks).toMatchObject([{ shell: "powershell" }]);
		expect(parse({ shell: "bash" }).hooks).toMatchObject([{ shell: "bash" }]);
		expect(parse({ shell: "zsh" }).errors).toContainEqual(expect.stringContaining("shell must be"));
		expect(parse({ shell: "bash" }, "octocode").errors).toContainEqual(expect.stringContaining("shell"));
	});

	it.each([
		["", ["Bash"], true],
		["*", ["Bash"], true],
		["Bash", ["Bash"], true],
		["Bash", ["Edit"], false],
		["Edit|Write", ["Write"], true],
		["Edit,Write", ["Write"], true],
		["Edit|Write", ["MultiEdit"], false],
		["^Bas", ["Bash"], true],
		["mcp__.*__write", ["mcp__fs__write"], true],
		["Notebook.*", ["Bash"], false],
	])("Claude matcher %j against %j gives %s", (matcher, names, expected) => {
		expect(matchesHook("claude", "PreToolUse", matcher, names)).toBe(expected);
	});
});
