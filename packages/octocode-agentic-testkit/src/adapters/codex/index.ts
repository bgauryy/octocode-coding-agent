import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sandboxFor, singlePrompt, type AdapterContext, type AgentAdapter } from "../../adapter.ts";
import { runProcess, writeFiles } from "../../process.ts";
import type { SandboxOptions } from "../../sandbox.ts";
import { cliMissing, skillFiles, type ExternalRun } from "../claude-code/index.ts";

export interface CodexOptions {
	command?: string;
	timeoutMs?: number;
	/** Model id sent to the mock provider. */
	model?: string;
	keep?: boolean;
	/**
	 * OS sandbox for the `codex` process. Default: on when the gateway forwards to a real model; `false` opts out.
	 * Sandboxed, Codex runs with `--sandbox danger-full-access`: macOS refuses a nested Seatbelt sandbox, and the
	 * outer one already confines it.
	 */
	sandbox?: false | SandboxOptions;
	/** Skills by name, written to `<CODEX_HOME>/skills/<name>/SKILL.md` (frontmatter included). */
	skills?: Record<string, string>;
}

export function codexMissing(command = "codex"): string | undefined {
	return cliMissing(command);
}

const toml = (s: string): string => JSON.stringify(s);

/**
 * Codex as an agent. It ignores OPENAI_BASE_URL, so an isolated HOME + CODEX_HOME holds a `config.toml` with a
 * `mock` provider (`base_url` = gateway `/v1`, `wire_api = "responses"`, websockets off); a dead HTTPS proxy keeps
 * any stray call off the network. The gateway origin must serve `POST /v1/responses`.
 */
export function codexAdapter(opts: CodexOptions = {}): AgentAdapter<ExternalRun> {
	return {
		name: "codex",
		unavailable: () => cliMissing(opts.command ?? "codex"),
		async start(ctx: AdapterContext) {
			const command = opts.command ?? "codex";
			const root = mkdtempSync(join(tmpdir(), "testkit-codex-"));
			const home = join(root, "home");
			const codexHome = join(home, ".codex");
			const workspace = ctx.workdir ?? join(root, "workspace");
			for (const d of [codexHome, workspace, join(root, "tmp")]) mkdirSync(d, { recursive: true });
			writeFiles(workspace, ctx.files ?? {});
			writeFiles(join(codexHome, "skills"), skillFiles(opts.skills));
			const lines = [
				`model_provider = "mock"`,
				`model = ${toml(opts.model ?? "scripted")}`,
				``,
				`[model_providers.mock]`,
				`name = "mock"`,
				`base_url = ${toml(`${ctx.gatewayUrl}/v1`)}`,
				`wire_api = "responses"`,
				`env_key = "OPENAI_API_KEY"`,
				`supports_websockets = false`,
				``,
				`[projects.${toml(workspace)}]`,
				`trust_level = "trusted"`,
			];
			for (const [name, url] of Object.entries(ctx.mcpUrls ?? {}))
				lines.push(``, `[mcp_servers.${name}]`, `default_tools_approval_mode = "approve"`, `url = ${toml(url)}`);
			writeFileSync(join(codexHome, "config.toml"), `${lines.join("\n")}\n`);
			const env = {
				PATH: process.env.PATH ?? "",
				HOME: home,
				CODEX_HOME: codexHome,
				TMPDIR: join(root, "tmp"),
				OPENAI_API_KEY: "testkit",
				HTTPS_PROXY: "http://127.0.0.1:9",
				HTTP_PROXY: "http://127.0.0.1:9",
				ALL_PROXY: "http://127.0.0.1:9",
				NO_PROXY: "127.0.0.1,localhost",
				NO_COLOR: "1",
				CI: "1",
				...ctx.env,
			};
			const sandbox = await sandboxFor(opts.sandbox, ctx, root);
			const own = sandbox ? "danger-full-access" : "read-only";
			return {
				run: async (input) => {
					const i = singlePrompt("codex", input);
					return runProcess(
						command,
						["exec", "--json", "--skip-git-repo-check", "--sandbox", own, "--ephemeral", i.prompt],
						{
							env: { ...env, ...i.env },
							cwd: workspace,
							timeoutMs: i.timeoutMs ?? opts.timeoutMs ?? 120_000,
							home,
							sandbox,
						},
					);
				},
				close: async () => {
					if (!opts.keep) rmSync(root, { recursive: true, force: true });
				},
			};
		},
	};
}
