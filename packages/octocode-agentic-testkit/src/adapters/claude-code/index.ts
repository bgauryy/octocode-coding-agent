import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AdapterContext, AgentAdapter } from "../../adapter.ts";

export interface ClaudeCodeOptions {
	/** Executable name or path (default `claude`). */
	command?: string;
	timeoutMs?: number;
	/** Replaces the default flags between `-p <prompt>` and the trailing mcp flags. */
	args?: string[];
	/** Keep the temp HOME and workspace (default: removed on close). */
	keep?: boolean;
}

export interface ExternalRun {
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	durationMs: number;
	stdout: string;
	stderr: string;
	/** Parsed JSON lines of stdout; non-JSON lines are skipped. */
	events: Record<string, unknown>[];
	home: string;
	workspace: string;
}

/** Why the CLI cannot run here, or undefined when `<command> --version` succeeds. */
export function cliMissing(command: string): string | undefined {
	const r = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 15_000 });
	return r.error || r.status !== 0 ? `\`${command}\` CLI not found or not runnable` : undefined;
}

export function claudeCodeMissing(command = "claude"): string | undefined {
	return cliMissing(command);
}

/** Runs a prepared command in its own process group; resolves with the captured output and parsed JSON lines. */
export function runProcess(
	command: string,
	args: string[],
	o: { env: Record<string, string>; cwd: string; timeoutMs: number; home: string },
): Promise<ExternalRun> {
	const started = Date.now();
	return new Promise((done, fail) => {
		const child = spawn(command, args, { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"], detached: true, env: o.env });
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
		child.stderr.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
		const killGroup = (): void => {
			try {
				process.kill(-child.pid!, "SIGKILL");
			} catch {
				// already gone
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			killGroup();
		}, o.timeoutMs);
		child.on("error", (e) => {
			clearTimeout(timer);
			fail(e);
		});
		child.on("close", (exitCode, signal) => {
			clearTimeout(timer);
			killGroup();
			const events: Record<string, unknown>[] = [];
			for (const line of stdout.split("\n")) {
				try {
					const v = JSON.parse(line) as unknown;
					if (v && typeof v === "object") events.push(v as Record<string, unknown>);
				} catch {
					// not a JSON line
				}
			}
			done({
				exitCode,
				signal,
				timedOut,
				durationMs: Date.now() - started,
				stdout,
				stderr,
				events,
				home: o.home,
				workspace: o.cwd,
			});
		});
	});
}

/**
 * Claude Code as an agent: `claude -p` with `ANTHROPIC_BASE_URL` at the gateway, a dummy key, an isolated
 * HOME / CLAUDE_CONFIG_DIR and the mock MCP servers through `--strict-mcp-config --mcp-config`.
 */
export function claudeCodeAdapter(opts: ClaudeCodeOptions = {}): AgentAdapter<ExternalRun> {
	return {
		name: "claude-code",
		async start(ctx: AdapterContext) {
			const command = opts.command ?? "claude";
			const root = mkdtempSync(join(tmpdir(), "testkit-claude-"));
			const home = join(root, "home");
			const config = join(root, "claude-config");
			const workspace = ctx.workdir ?? join(root, "workspace");
			for (const d of [home, config, workspace, join(root, "tmp")]) mkdirSync(d, { recursive: true });
			const mcpServers: Record<string, unknown> = {};
			for (const [name, url] of Object.entries(ctx.mcpUrls ?? {}))
				mcpServers[name] = { type: "http", url, headers: { "x-testkit-agent": "main", "x-testkit-span": "main" } };
			const mcpFile = join(root, "mcp.json");
			writeFileSync(mcpFile, JSON.stringify({ mcpServers }));
			const env = {
				PATH: process.env.PATH ?? "",
				HOME: home,
				CLAUDE_CONFIG_DIR: config,
				TMPDIR: join(root, "tmp"),
				ANTHROPIC_BASE_URL: ctx.gatewayUrl,
				ANTHROPIC_API_KEY: "testkit",
				DISABLE_AUTOUPDATER: "1",
				DISABLE_TELEMETRY: "1",
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
				NO_COLOR: "1",
				CI: "1",
				...ctx.env,
			};
			const flags = opts.args ?? [
				"--output-format",
				"stream-json",
				"--verbose",
				"--no-session-persistence",
				"--permission-mode",
				"bypassPermissions",
			];
			return {
				run: (prompt) =>
					runProcess(command, ["-p", prompt, ...flags, "--strict-mcp-config", "--mcp-config", mcpFile], {
						env,
						cwd: workspace,
						timeoutMs: opts.timeoutMs ?? 120_000,
						home,
					}),
				close: async () => {
					if (!opts.keep) rmSync(root, { recursive: true, force: true });
				},
			};
		},
	};
}
