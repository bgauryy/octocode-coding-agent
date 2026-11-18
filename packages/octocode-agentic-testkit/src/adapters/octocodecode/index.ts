import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInput, sandboxFor, type AdapterContext, type AgentAdapter } from "../../adapter.ts";
import { runProcess, writeFiles, type ProcessRun } from "../../process.ts";
import type { SandboxOptions } from "../../sandbox.ts";

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

export interface OctocodecodeProvider {
	id: string;
	api: string;
	/** The model entry written to `models.json`: `id` plus any `compat`, `promptCache`, limits. */
	model: Record<string, unknown> & { id: string };
	/** Default: the gateway (`/v1` for OpenAI wires). */
	baseUrl?: string;
	/** Reaches the agent only as `TESTKIT_PROVIDER_KEY` in its environment; redacted from the returned stderr. */
	key?: string;
}

export interface OctocodecodeAdapterOptions {
	/** Path of the built CLI bundle; default: `$TESTKIT_OCTOCODECODE_BUNDLE`. */
	bundle?: string;
	/** Files written into the workspace before the first run (relative path -> content). */
	files?: Record<string, string>;
	timeoutMs?: number;
	/** Replaces the default flags between the bundle path and the prompts. */
	args?: string[];
	/** Keep the temp HOME and workspace (default: removed on close). */
	keep?: boolean;
	/**
	 * Wire the agent speaks to the gateway (default `openai-completions`). `anthropic-messages` sends system blocks
	 * and tools with the agent's own prompt-cache markers.
	 */
	api?: "openai-completions" | "anthropic-messages";
	/** Skills written to `<agentHome>/skills/<name>/SKILL.md`. */
	skills?: Record<string, string>;
	/** Written to `<agentHome>/settings.json`. */
	settings?: Record<string, unknown>;
	/** Replaces the default `testkit/scripted` provider; `--model` defaults to `<id>/<model.id>`. */
	provider?: OctocodecodeProvider;
	/** Merged into each MCP server entry (by server name) from `AdapterContext.mcpUrls`. */
	mcp?: Record<string, { toolExposure?: Record<string, string>; description?: string }>;
	/** Adds `--thinking <value>`. */
	thinking?: string;
	/** Save the session under the temp HOME (default false: `--no-session`), e.g. for runs that read past sessions. */
	persistSession?: boolean;
	/** OS sandbox for the CLI process. Default: on when the gateway forwards to a real model; `false` opts out. */
	sandbox?: false | SandboxOptions;
}

/** Result of one octocodecode run. */
export type OctocodecodeRun = ProcessRun;

const sessionFlags = (persist: boolean | undefined): string[] => [
	"--mode",
	"json",
	...(persist ? [] : ["--no-session"]),
	"--offline",
	"--trust",
];
const PROVIDER_KEY_ENV = "TESTKIT_PROVIDER_KEY";

/**
 * The octocodecode CLI as an agent: an isolated HOME whose `models.json` points a provider at the gateway and whose
 * `mcp.json` lists the mock MCP servers (HTTP; the mock attributes each call through the gateway lineage).
 */
export function octocodecodeAdapter(opts: OctocodecodeAdapterOptions = {}): AgentAdapter<OctocodecodeRun> {
	return {
		name: "octocodecode",
		unavailable: () =>
			octocodecodeAvailable(opts.bundle)
				? undefined
				: `no built bundle: set \`bundle\` or ${BUNDLE_ENV} (build with \`yarn run build:offline\`)`,
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
			const api = opts.provider?.api ?? opts.api ?? "openai-completions";
			// The Anthropic client appends `/v1/messages` itself.
			const defaultBase = api === "anthropic-messages" ? ctx.gatewayUrl : `${ctx.gatewayUrl}/v1`;
			const provider = opts.provider;
			const providerId = provider?.id ?? "testkit";
			const model = provider?.model ?? { id: "scripted" };
			const files: Record<string, string> = {
				"models.json": JSON.stringify({
					providers: {
						[providerId]: {
							baseUrl: provider?.baseUrl ?? defaultBase,
							api,
							apiKey: provider ? `$${PROVIDER_KEY_ENV}` : "no-key",
							models: [model],
						},
					},
				}),
			};
			const urls = Object.entries(ctx.mcpUrls ?? {});
			if (urls.length) {
				const mcpServers: Record<string, unknown> = {};
				for (const [name, url] of urls) mcpServers[name] = { url, ...opts.mcp?.[name] };
				files["mcp.json"] = JSON.stringify({ mcpServers });
			}
			if (opts.settings) files["settings.json"] = JSON.stringify(opts.settings);
			for (const [name, text] of Object.entries(opts.skills ?? {})) files[join("skills", name, "SKILL.md")] = text;
			writeFiles(agentHome, files);
			writeFiles(workspace, { ...opts.files, ...ctx.files });
			const key = provider?.key;
			const env = {
				PATH: process.env.PATH ?? "",
				HOME: home,
				USERPROFILE: home,
				OCTOCODE_HOME: agentHome,
				TMPDIR: join(root, "tmp"),
				NO_COLOR: "1",
				CI: "1",
				...(key ? { [PROVIDER_KEY_ENV]: key } : {}),
				...ctx.env,
			};
			const flags = opts.args ?? [
				...sessionFlags(opts.persistSession),
				"--model",
				provider ? `${provider.id}/${provider.model.id}` : "testkit/scripted",
				...(opts.thinking ? ["--thinking", opts.thinking] : []),
			];
			const sandbox = await sandboxFor(opts.sandbox, ctx, root);
			return {
				run: async (input) => {
					const i = runInput(input);
					const r = await runProcess(process.execPath, [bundle, ...flags, ...i.prompts], {
						env: { ...env, ...i.env },
						cwd: workspace,
						timeoutMs: i.timeoutMs ?? opts.timeoutMs ?? 90_000,
						home,
						sandbox,
					});
					return key ? { ...r, stderr: r.stderr.replaceAll(key, "<key>") } : r;
				},
				close: async () => {
					if (!opts.keep) rmSync(root, { recursive: true, force: true });
				},
			};
		},
	};
}

export interface OctocodecodeOptions extends Omit<OctocodecodeAdapterOptions, "mcp"> {
	/** Gateway origin (`Gateway.url`). */
	gatewayUrl: string;
	prompt: string;
	env?: Record<string, string>;
	/** Mock MCP servers to expose to the agent. */
	mcp?: { name: string; listen(): Promise<string> }[];
	/** Per-server config merged into the agent's MCP entries (the adapter's `mcp` option). */
	mcpConfig?: OctocodecodeAdapterOptions["mcp"];
}

/** One-shot convenience: start the adapter, run the prompt once, close. */
export async function runOctocodecode(opts: OctocodecodeOptions): Promise<OctocodecodeRun> {
	const mcpUrls: Record<string, string> = {};
	// oxlint-disable-next-line no-await-in-loop -- one server at a time: a recorder's listen starts its upstream, so MCP requests keep a fixed order
	for (const m of opts.mcp ?? []) mcpUrls[m.name] = await m.listen();
	const session = await octocodecodeAdapter({ ...opts, mcp: opts.mcpConfig }).start({
		gatewayUrl: opts.gatewayUrl,
		mcpUrls,
		env: opts.env,
	});
	try {
		return await session.run(opts.prompt);
	} finally {
		await session.close();
	}
}
