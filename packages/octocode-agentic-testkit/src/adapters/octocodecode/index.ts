import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AdapterContext, AgentAdapter } from "../../adapter.ts";

export { parseSkillListing } from "./skill-listing.ts";

/** Environment variable holding the path of the built CLI bundle. */
const BUNDLE_ENV = "TESTKIT_OCTOCODECODE_BUNDLE";

/** The configured bundle path, or undefined when neither `bundle` nor the environment names one. */
function resolveBundle(bundle?: string): string | undefined {
	return bundle ?? process.env[BUNDLE_ENV] ?? undefined;
}

export function octocodecodeAvailable(bundle?: string): boolean {
	const path = resolveBundle(bundle);
	return path !== undefined && existsSync(path);
}

export interface OctocodecodeAdapterOptions {
	/** Path of the built CLI bundle; default: `$TESTKIT_OCTOCODECODE_BUNDLE`. */
	bundle?: string;
	/** Files written into the workspace before the first run (relative path -> content). */
	files?: Record<string, string>;
	timeoutMs?: number;
	/** Replaces the default flags between the bundle path and the prompt. */
	args?: string[];
	/** Keep the temp HOME and workspace (default: removed on close). */
	keep?: boolean;
}

export interface OctocodecodeRun {
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

const DEFAULT_ARGS = ["--mode", "json", "--no-session", "--offline", "--trust", "--model", "testkit/scripted"];

/**
 * The octocodecode CLI as an agent: an isolated HOME whose `models.json` points a provider at the gateway and whose
 * `mcp.json` lists the mock MCP servers (HTTP, with the testkit identity headers).
 */
export function octocodecodeAdapter(opts: OctocodecodeAdapterOptions = {}): AgentAdapter<OctocodecodeRun> {
	return {
		name: "octocodecode",
		async start(ctx: AdapterContext) {
			const bundle = resolveBundle(opts.bundle);
			if (!bundle) throw new Error(`octocodecode adapter: set \`bundle\` or ${BUNDLE_ENV} to the built CLI bundle`);
			const root = mkdtempSync(join(tmpdir(), "testkit-octocodecode-"));
			const home = join(root, "home");
			const workspace = ctx.workdir ?? join(root, "workspace");
			// With OCTOCODE_HOME set, the agent dir is OCTOCODE_HOME itself (no `octocodecode` subfolder).
			const agentHome = join(home, ".octocode", "octocodecode");
			mkdirSync(workspace, { recursive: true });
			mkdirSync(join(root, "tmp"), { recursive: true });
			mkdirSync(agentHome, { recursive: true });
			writeFileSync(
				join(agentHome, "models.json"),
				JSON.stringify({
					providers: {
						testkit: {
							baseUrl: `${ctx.gatewayUrl}/v1`,
							api: "openai-completions",
							apiKey: "no-key",
							models: [{ id: "scripted" }],
						},
					},
				}),
			);
			const urls = Object.entries(ctx.mcpUrls ?? {});
			if (urls.length) {
				const mcpServers: Record<string, unknown> = {};
				for (const [name, url] of urls)
					mcpServers[name] = { url, headers: { "x-testkit-agent": "main", "x-testkit-span": "main" } };
				writeFileSync(join(agentHome, "mcp.json"), JSON.stringify({ mcpServers }));
			}
			for (const [rel, content] of Object.entries(opts.files ?? {})) {
				const p = join(workspace, rel);
				mkdirSync(dirname(p), { recursive: true });
				writeFileSync(p, content);
			}
			const env = {
				PATH: process.env.PATH ?? "",
				HOME: home,
				USERPROFILE: home,
				OCTOCODE_HOME: agentHome,
				TMPDIR: join(root, "tmp"),
				NO_COLOR: "1",
				CI: "1",
				...ctx.env,
			};
			return {
				run: (prompt) =>
					runOnce({ bundle, args: opts.args ?? DEFAULT_ARGS, prompt, env, workspace, home, timeoutMs: opts.timeoutMs }),
				close: async () => {
					if (!opts.keep) rmSync(root, { recursive: true, force: true });
				},
			};
		},
	};
}

interface RunInput {
	bundle: string;
	args: string[];
	prompt: string;
	env: Record<string, string>;
	workspace: string;
	home: string;
	timeoutMs?: number;
}

function runOnce(i: RunInput): Promise<OctocodecodeRun> {
	const started = Date.now();
	return new Promise<OctocodecodeRun>((done, fail) => {
		const child = spawn(process.execPath, [i.bundle, ...i.args, i.prompt], {
			cwd: i.workspace,
			stdio: ["ignore", "pipe", "pipe"],
			detached: true,
			env: i.env,
		});
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
		}, i.timeoutMs ?? 90_000);
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
				home: i.home,
				workspace: i.workspace,
			});
		});
	});
}

export interface OctocodecodeOptions extends OctocodecodeAdapterOptions {
	/** Gateway origin (`Gateway.url`). */
	gatewayUrl: string;
	prompt: string;
	env?: Record<string, string>;
	/** Mock MCP servers to expose to the agent. */
	mcp?: { name: string; listen(): Promise<string> }[];
}

/** One-shot convenience: start the adapter, run the prompt once, close. */
export async function runOctocodecode(opts: OctocodecodeOptions): Promise<OctocodecodeRun> {
	const mcpUrls: Record<string, string> = {};
	for (const m of opts.mcp ?? []) mcpUrls[m.name] = await m.listen();
	const session = await octocodecodeAdapter(opts).start({ gatewayUrl: opts.gatewayUrl, mcpUrls, env: opts.env });
	try {
		return await session.run(opts.prompt);
	} finally {
		await session.close();
	}
}
