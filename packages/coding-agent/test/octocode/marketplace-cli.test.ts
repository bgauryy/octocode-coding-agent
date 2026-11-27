import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	createSandbox,
	QUIET_ARGS,
	runCli,
	SCRIPTED_MODEL_ARGS,
	type ModelServer,
	type Sandbox,
	startModelServer,
	writeScriptedProvider,
} from "../helpers/feature-host-cli.ts";

// A case starts the real CLI up to eight times; under a full parallel run that outlasts the 30s default.
vi.setConfig({ testTimeout: 120_000 });

/**
 * `octocode marketplace` and `octocode plugin` through the real CLI against a local bare git repository (no network):
 * the settings record, the cache, what `octocode -p` then sees, that nothing from the repository runs while fetching,
 * and each refusal.
 */
let sandbox: Sandbox;
let server: ModelServer | undefined;
let scratch: string;
let work: string;
let bare: string;

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	}).trim();
const put = (file: string, text: string) => {
	mkdirSync(dirname(join(work, file)), { recursive: true });
	writeFileSync(join(work, file), text);
};
const commit = (message: string) => {
	git(work, "add", "-A");
	git(work, "commit", "-q", "-m", message);
	git(work, "push", "-q", bare, "HEAD:refs/heads/main");
};
const marker = () => join(sandbox.directory, "hook-ran.txt");
const hookFile = (command: string) =>
	JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command }] }] } });
const hookCommand = (suffix = "") => `node "\${CLAUDE_PLUGIN_ROOT}/hooks/mark.mjs" "${marker()}"${suffix}`;
const octocode = (...args: string[]) => runCli(sandbox, args);
const settings = (): Record<string, any> => {
	const file = join(sandbox.agentDir, "settings.json");
	return existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
};
const plugins = (): Record<string, any>[] => settings().plugins ?? [];
const cacheRoot = () => join(sandbox.env.OCTOCODE_HOME, "plugins", "cache");

function buildMarketplace(name = "m") {
	git(work, "init", "-q", "-b", "main");
	put(
		".claude-plugin/marketplace.json",
		JSON.stringify({
			name,
			owner: { name: "tester" },
			plugins: [
				{ name: "fixture", source: "./plugins/fixture", description: "fixture plugin" },
				{ name: "leaky", source: "./plugins/leaky" },
				{ name: "linked", source: "./linked" },
				{ name: "packaged", source: { source: "npm", package: "left-pad" } },
			],
		}),
	);
	put("plugins/fixture/.claude-plugin/plugin.json", JSON.stringify({ name: "fixture", version: "1.0.0" }));
	put("plugins/fixture/commands/greet.md", "MARKETPLACE_GREETING_V1\n");
	put(
		"plugins/fixture/skills/hello/SKILL.md",
		"---\nname: hello\ndescription: Says hello from the marketplace fixture.\n---\nHello.\n",
	);
	put("plugins/fixture/hooks/hooks.json", hookFile(hookCommand()));
	put(
		"plugins/fixture/hooks/mark.mjs",
		'import { writeFileSync } from "node:fs"; writeFileSync(process.argv[2], "ran");\n',
	);
	put("plugins/leaky/.claude-plugin/plugin.json", JSON.stringify({ name: "leaky" }));
	put("plugins/leaky/skills/readme.txt", "x\n");
	symlinkSync("/etc/hosts", join(work, "plugins/leaky/link"));
	symlinkSync(tmpdir(), join(work, "linked"));
	commit("initial");
}

beforeEach(() => {
	sandbox = createSandbox({ OCTOCODE_PERMISSION: "full" });
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "octocode-marketplace-")));
	work = join(scratch, "work");
	bare = join(scratch, "market.git");
	mkdirSync(work);
	git(scratch, "init", "-q", "--bare", "-b", "main", bare);
});

afterEach(async () => {
	await server?.close();
	server = undefined;
	sandbox.cleanup();
	rmSync(scratch, { recursive: true, force: true });
});

describe("octocode marketplace and plugin", () => {
	it("adds a bare git marketplace, installs a plugin, and runs none of its code while fetching", async () => {
		buildMarketplace();
		const added = await octocode("marketplace", "add", bare);
		expect(added.code, added.stderr).toBe(0);
		expect(added.stdout).toContain("Added marketplace m");
		expect(settings().marketplaces.m.source).toMatchObject({ source: "git", url: bare });

		// Without --yes and without a terminal, a plugin that declares hooks is not installed.
		const refused = await octocode("plugin", "install", "fixture@m");
		expect(refused.code).toBe(1);
		expect(refused.stderr).toContain("Approval needed");
		expect(refused.stderr).toContain("UserPromptSubmit");
		expect(plugins()).toEqual([]);

		const installed = await octocode("plugin", "install", "fixture@m", "--yes");
		expect(installed.code, installed.stderr).toBe(0);
		const sha = git(work, "rev-parse", "HEAD");
		expect(plugins()).toEqual([
			{
				path: join(cacheRoot(), "m", "fixture", sha),
				protocol: "claude",
				enabled: true,
				source: { marketplace: "m", plugin: "fixture", sha },
			},
		]);
		// The cached copy is plain files: no .git.
		expect(existsSync(join(cacheRoot(), "m", "fixture", sha, "hooks", "hooks.json"))).toBe(true);
		expect(existsSync(join(cacheRoot(), "m", "fixture", sha, ".git"))).toBe(false);
		// Fetching and installing ran no hook.
		expect(existsSync(marker())).toBe(false);

		// The next session loads the plugin: its command expands, its skill is listed, and the approved hook runs.
		server = await startModelServer([{ text: "finished" }]);
		writeScriptedProvider(sandbox, server);
		const args = QUIET_ARGS.filter((arg) => arg !== "--no-skills");
		const run = await octocode(...args, ...SCRIPTED_MODEL_ARGS, "-p", "/fixture:greet");
		expect(run.code, run.stderr).toBe(0);
		const request = JSON.stringify(server.requests[0]);
		expect(request).toContain("MARKETPLACE_GREETING_V1");
		// The skill tool lists a skill as `path: description`, the plugin's cached file included.
		expect(request).toContain(`fixture/${sha}/skills/hello/SKILL.md: Says hello from the marketplace fixture.`);
		expect(existsSync(marker())).toBe(true);

		const listed = await octocode("plugin", "list");
		expect(listed.stdout).toContain("fixture@m");
	});

	it("asks again when an update changes a hook, and not for other changes", async () => {
		buildMarketplace();
		expect((await octocode("marketplace", "add", bare)).code).toBe(0);
		expect((await octocode("plugin", "install", "fixture@m", "--yes")).code).toBe(0);
		const first = plugins()[0].source.sha as string;
		// The plugin's data folder is keyed by marketplace and plugin, so it survives an update.
		const data = join(
			sandbox.env.OCTOCODE_HOME,
			"plugins",
			"data",
			createHash("sha256").update("claude:fixture:marketplace:m/fixture").digest("hex"),
		);
		mkdirSync(data, { recursive: true });
		writeFileSync(join(data, "state.txt"), "kept");

		// A command-only change updates silently.
		put("plugins/fixture/commands/greet.md", "MARKETPLACE_GREETING_V2\n");
		commit("command change");
		const quiet = await octocode("plugin", "update", "fixture@m");
		expect(quiet.code, quiet.stderr).toBe(0);
		const second = plugins()[0].source.sha as string;
		expect(second).toBe(git(work, "rev-parse", "HEAD"));
		expect(second).not.toBe(first);
		expect(existsSync(join(cacheRoot(), "m", "fixture", first))).toBe(false);
		expect(readFileSync(join(data, "state.txt"), "utf8")).toBe("kept");

		// A changed hook needs approval again.
		put("plugins/fixture/hooks/hooks.json", hookFile(hookCommand(" --extra")));
		commit("hook change");
		const held = await octocode("plugin", "update", "fixture@m");
		expect(held.code).toBe(1);
		expect(held.stderr).toContain("changed what it runs");
		expect(held.stderr).toContain("--yes");
		expect(held.stderr).toContain("--extra");
		expect(plugins()[0].source.sha).toBe(second);
		expect(existsSync(join(cacheRoot(), "m", "fixture", second))).toBe(true);

		const approved = await octocode("plugin", "update", "fixture@m", "--yes");
		expect(approved.code, approved.stderr).toBe(0);
		expect(plugins()[0].source.sha).toBe(git(work, "rev-parse", "HEAD"));
		expect(existsSync(marker())).toBe(false);
	});

	it("removes the cache and data, and uninstalls a marketplace's plugins with it", async () => {
		buildMarketplace();
		expect((await octocode("marketplace", "add", bare)).code).toBe(0);
		expect((await octocode("plugin", "install", "fixture@m", "--yes")).code).toBe(0);
		const data = join(
			sandbox.env.OCTOCODE_HOME,
			"plugins",
			"data",
			createHash("sha256").update("claude:fixture:marketplace:m/fixture").digest("hex"),
		);
		mkdirSync(data, { recursive: true });

		const removed = await octocode("plugin", "remove", "fixture@m");
		expect(removed.code, removed.stderr).toBe(0);
		expect(plugins()).toEqual([]);
		expect(existsSync(join(cacheRoot(), "m", "fixture"))).toBe(false);
		expect(existsSync(data)).toBe(false);

		expect((await octocode("plugin", "install", "fixture@m", "--yes")).code).toBe(0);
		const gone = await octocode("marketplace", "remove", "m");
		expect(gone.code, gone.stderr).toBe(0);
		expect(gone.stdout).toContain("fixture@m");
		expect(plugins()).toEqual([]);
		expect(settings().marketplaces).toEqual({});
		expect(existsSync(join(cacheRoot(), "m"))).toBe(false);
		expect(existsSync(join(sandbox.env.OCTOCODE_HOME, "plugins", "marketplaces", "m"))).toBe(false);
	});

	it("refuses a symlink that leaves the plugin, an unsupported source and a missing plugin", async () => {
		buildMarketplace();
		expect((await octocode("marketplace", "add", bare)).code).toBe(0);
		const inside = await octocode("plugin", "install", "leaky@m", "--yes");
		expect(inside.code).toBe(1);
		expect(inside.stderr).toContain("symlink that leaves the plugin directory");
		const entry = await octocode("plugin", "install", "linked@m", "--yes");
		expect(entry.code).toBe(1);
		expect(entry.stderr).toMatch(/escapes package/);
		const packaged = await octocode("plugin", "install", "packaged@m", "--yes");
		expect(packaged.code).toBe(1);
		expect(packaged.stderr).toContain('"npm" is not supported');
		const missing = await octocode("plugin", "install", "nope@m", "--yes");
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("not found in marketplace");
		expect(plugins()).toEqual([]);
		expect(existsSync(cacheRoot()) ? readdirCount(cacheRoot()) : 0).toBe(0);
	});

	it("refuses credentials in a URL, remote helpers, reserved names and duplicates", async () => {
		const credentials = await octocode("marketplace", "add", "https://user:secret@example.invalid/team/plugins.git");
		expect(credentials.code).toBe(1);
		expect(credentials.stderr).toContain("embedded credentials");
		expect(credentials.stderr).not.toContain("secret");
		const token = await octocode("marketplace", "add", "https://ghp_token@example.invalid/team/plugins.git");
		expect(token.code).toBe(1);

		const touched = join(sandbox.directory, "ext-ran.txt");
		const helper = await octocode("marketplace", "add", `ext::sh -c touch% ${touched}`);
		expect(helper.code).toBe(1);
		expect(helper.stderr).toContain("remote helpers");
		expect(existsSync(touched)).toBe(false);
		const http = await octocode("marketplace", "add", "http://example.invalid/plugins.git");
		expect(http.code).toBe(1);
		expect(http.stderr).toContain("not allowed");

		buildMarketplace("claude-plugins-extra");
		const reserved = await octocode("marketplace", "add", bare);
		expect(reserved.code).toBe(1);
		expect(reserved.stderr).toContain("reserved");

		put(
			".claude-plugin/marketplace.json",
			JSON.stringify({ name: "anthropic-tools", owner: { name: "x" }, plugins: [] }),
		);
		commit("anthropic name");
		expect((await octocode("marketplace", "add", bare)).code).toBe(1);

		put(".claude-plugin/marketplace.json", JSON.stringify({ name: "m", owner: { name: "x" }, plugins: [] }));
		commit("fine");
		expect((await octocode("marketplace", "add", bare)).code).toBe(0);
		const duplicate = await octocode("marketplace", "add", bare);
		expect(duplicate.code).toBe(1);
		expect(duplicate.stderr).toContain("already added");
		expect(Object.keys(settings().marketplaces)).toEqual(["m"]);
	});

	it("reads local directory marketplaces in place and ignores project-declared marketplaces", async () => {
		buildMarketplace();
		const directory = join(scratch, "dir-market");
		mkdirSync(join(directory, ".claude-plugin"), { recursive: true });
		writeFileSync(
			join(directory, ".claude-plugin", "marketplace.json"),
			JSON.stringify({ name: "local", owner: { name: "x" }, plugins: [{ name: "plain", source: "./plain" }] }),
		);
		mkdirSync(join(directory, "plain", "commands"), { recursive: true });
		writeFileSync(join(directory, "plain", "commands", "say.md"), "LOCAL_DIRECTORY_COMMAND\n");
		mkdirSync(join(sandbox.project, ".octocode"), { recursive: true });
		writeFileSync(
			join(sandbox.project, ".octocode", "settings.json"),
			JSON.stringify({ marketplaces: { sneaky: { source: { source: "git", url: "file:///nowhere" }, addedAt: "x" } } }),
		);

		const added = await octocode("marketplace", "add", directory);
		expect(added.code, added.stderr).toBe(0);
		expect(settings().marketplaces.local.source).toEqual({ source: "directory", path: directory });
		const listed = await octocode("marketplace", "list");
		expect(listed.stdout).toContain("local");
		expect(listed.stdout).not.toContain("sneaky");
		// A plugin with no hooks or MCP installs without a question.
		const installed = await octocode("plugin", "install", "plain@local");
		expect(installed.code, installed.stderr).toBe(0);
		expect(plugins()[0].source.sha).toMatch(/^dir-[0-9a-f]{12}$/);
		const update = await octocode("marketplace", "update");
		expect(update.stdout).toContain("read in place");
	});
});

const readdirCount = (dir: string): number =>
	existsSync(dir) ? execFileSync("ls", [dir]).toString().split("\n").filter(Boolean).length : 0;
