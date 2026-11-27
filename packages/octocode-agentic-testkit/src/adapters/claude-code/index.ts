import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxFor, singlePrompt, type AdapterContext, type AgentAdapter } from "../../adapter.ts";
import { runProcess, writeFiles, type ProcessRun } from "../../process.ts";
import type { SandboxOptions } from "../../sandbox.ts";

export interface ClaudeCodeOptions {
	/** Executable name or path (default `claude`). */
	command?: string;
	timeoutMs?: number;
	/** Replaces the default flags between `-p <prompt>` and the trailing mcp flags. */
	args?: string[];
	/** Keep the temp HOME and workspace (default: removed on close). */
	keep?: boolean;
	/**
	 * OS sandbox for the `claude` process (`runProcess`). Default: on when the gateway forwards to a real model,
	 * because the adapter runs with `--permission-mode bypassPermissions`; `false` opts out.
	 */
	sandbox?: false | SandboxOptions;
	/** Skills by name, written to `<CLAUDE_CONFIG_DIR>/skills/<name>/SKILL.md` (frontmatter included). */
	skills?: Record<string, string>;
}

export { CLAUDE_CODE_LIMITS } from "./limits.ts";

/** `{ name: SKILL.md text }` as files `<name>/SKILL.md`, for a harness's skills directory. */
export function skillFiles(skills: Record<string, string> | undefined): Record<string, string> {
	return Object.fromEntries(Object.entries(skills ?? {}).map(([name, body]) => [`${name}/SKILL.md`, body]));
}

/** Result of one external CLI run. */
export type ExternalRun = ProcessRun;

/** Why the CLI cannot run here, or undefined when `<command> --version` succeeds. */
export function cliMissing(command: string): string | undefined {
	const r = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 15_000 });
	return r.error || r.status !== 0 ? `\`${command}\` CLI not found or not runnable` : undefined;
}

export function claudeCodeMissing(command = "claude"): string | undefined {
	return cliMissing(command);
}

/**
 * Claude Code as an agent: `claude -p` with `ANTHROPIC_BASE_URL` at the gateway, a dummy key, an isolated
 * HOME / CLAUDE_CONFIG_DIR and the mock MCP servers through `--strict-mcp-config --mcp-config`.
 */
export function claudeCodeAdapter(opts: ClaudeCodeOptions = {}): AgentAdapter<ExternalRun> {
	return {
		name: "claude-code",
		unavailable: () => cliMissing(opts.command ?? "claude"),
		async start(ctx: AdapterContext) {
			const command = opts.command ?? "claude";
			const root = mkdtempSync(join(tmpdir(), "testkit-claude-"));
			const home = join(root, "home");
			const config = join(root, "claude-config");
			const workspace = ctx.workdir ?? join(root, "workspace");
			for (const d of [home, config, workspace, join(root, "tmp")]) mkdirSync(d, { recursive: true });
			writeFiles(workspace, ctx.files ?? {});
			writeFiles(join(config, "skills"), skillFiles(opts.skills));
			const mcpServers: Record<string, unknown> = {};
			// No identity headers: the mock attributes each call to the agent whose model asked for it (gateway lineage).
			for (const [name, url] of Object.entries(ctx.mcpUrls ?? {})) mcpServers[name] = { type: "http", url };
			const mcpFile = join(root, "mcp.json");
			writeFileSync(mcpFile, JSON.stringify({ mcpServers }));
			const env = {
				PATH: process.env.PATH ?? "",
				HOME: home,
				CLAUDE_CONFIG_DIR: config,
				TMPDIR: join(root, "tmp"),
				// Its Bash tool writes under /tmp/claude-<uid> otherwise, outside the sandbox's writable paths.
				CLAUDE_CODE_TMPDIR: join(root, "tmp"),
				ANTHROPIC_BASE_URL: ctx.gatewayUrl,
				ANTHROPIC_API_KEY: "testkit",
				DISABLE_AUTOUPDATER: "1",
				DISABLE_TELEMETRY: "1",
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				NO_COLOR: "1",
				CI: "1",
				...ctx.env,
			};
			const sandbox = await sandboxFor(opts.sandbox, ctx, root);
			const flags = opts.args ?? [
				"--output-format",
				"stream-json",
				"--verbose",
				"--no-session-persistence",
				"--permission-mode",
				"bypassPermissions",
			];
			return {
				run: async (input) => {
					const i = singlePrompt("claude-code", input);
					return runProcess(command, ["-p", i.prompt, ...flags, "--strict-mcp-config", "--mcp-config", mcpFile], {
						env: { ...env, ...i.env },
						cwd: workspace,
						timeoutMs: i.timeoutMs ?? opts.timeoutMs ?? 120_000,
						home,
						sandbox,
					});
				},
				close: async () => {
					if (!opts.keep) rmSync(root, { recursive: true, force: true });
				},
			};
		},
	};
}
