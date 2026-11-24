// Pins the package's public surface: the runtime names of every entry, the manifest that maps the entries to `dist`,
// `testkitConfig`, and the types users write tests and adapters with (checked by the package typecheck). A change
// here is a contract change: update the list on purpose, never to make the test pass.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, expectTypeOf, it } from "vitest";
import type { claudeCodeAdapter, ClaudeCodeOptions, ExternalRun } from "../src/adapters/claude-code/index.ts";
import type { codexAdapter, CodexOptions } from "../src/adapters/codex/index.ts";
import type {
	octocodeAgentAdapter,
	OctocodeAgentAdapterOptions,
	OctocodeAgentRun,
} from "../src/adapters/octocode-agent/index.ts";
import { testkitConfig } from "../src/config.ts";
import * as root from "../src/index.ts";
import {
	defineAdapter,
	runInput,
	type Trace,
	type AgentAdapter,
	type AgentSuiteOptions,
	type CapturedRequest,
	type ChatMessage,
	type ComparisonSummary,
	type Conversation,
	type ConverseStop,
	type EventKind,
	type Forward,
	type Gateway,
	type GatewayOptions,
	type Guard,
	type InprocResult,
	type JudgeOptions,
	type Judgement,
	type LiveOptions,
	type LiveSummary,
	type MockMcp,
	type MockMcpOptions,
	type NamePattern,
	type Panel,
	type PassPolicy,
	type PendingCall,
	type ReferenceOptions,
	type Responder,
	type ResponderContext,
	type RoutingReport,
	type RunInput,
	type ScriptedCall,
	type Step,
	type SuiteTestContext,
	type SurfaceLimits,
	type SurfaceReport,
	type Tier as RootTier,
	type ToolDef,
	type TraceEvent,
	type Trial,
	type Turn,
	type Usage,
	type VerifierResult,
	type WorkspaceDiff,
	type WorkspaceSnapshot,
} from "../src/index.ts";
import AgentReporter from "../src/reporter.ts";
import type { resolveTier, Tier, TierResolution } from "../src/tiers.ts";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = join(pkgDir, "src");
const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as {
	main: string;
	types: string;
	private?: boolean;
	publishConfig?: { access: string };
	scripts: Record<string, string>;
	peerDependencies: Record<string, string>;
	files: string[];
	sideEffects: string[];
	exports: Record<string, Record<"source" | "types" | "import" | "default", string>>;
};

const ROOT = [
	"AGENT_REPORT_FILE",
	"DEFAULT_DENY_READ",
	"DEFAULT_IGNORE",
	"DEFAULT_LIMITS",
	"DEFAULT_STOP_TOKEN",
	"Lineage",
	"MemoryStore",
	"NoAnswer",
	"NoJsonError",
	"SUSPICIOUS_RULES",
	"StepFailure",
	"Trace",
	"agentSuite",
	"analyzeSurface",
	"assertVerdict",
	"cacheBreaks",
	"cacheEvents",
	"cacheForm",
	"cacheReadRatio",
	"callMatches",
	"canonicalize",
	"checkGuards",
	"compareRates",
	"connectMcp",
	"converse",
	"costOf",
	"dataText",
	"decide",
	"defineAdapter",
	"diffWorkspace",
	"duplicateBlocks",
	"escapeHtml",
	"explainJudgement",
	"extractJson",
	"fileHash",
	"findSuspicious",
	"firstCallOnly",
	"firstChoice",
	"firstToolCallDifference",
	"formatComparison",
	"formatSummary",
	"forwardRequest",
	"fromResponsesResponse",
	"gatewayForwards",
	"globRegExp",
	"growth",
	"guardReason",
	"harnessToolErrors",
	"hashOf",
	"judge",
	"judgePanel",
	"live",
	"liveCompare",
	"liveEnabled",
	"loadResults",
	"matchName",
	"matchers",
	"maxToolCalls",
	"mcpToolName",
	"mockMcp",
	"modelCalls",
	"modelUser",
	"neededPasses",
	"never",
	"passAtK",
	"passHatK",
	"posteriorAbove",
	"prefixBreaks",
	"probeRouting",
	"promptShape",
	"recordMcp",
	"redTeamAttacks",
	"redact",
	"referenceAdapter",
	"renderResult",
	"renderResultsHtml",
	"repeatedSentences",
	"resetCacheEvents",
	"runAttack",
	"runComparison",
	"runInproc",
	"runInput",
	"runProcess",
	"runTrials",
	"runVerifier",
	"sandboxAvailable",
	"sandboxFor",
	"saveResult",
	"schemaProse",
	"script",
	"scriptedUser",
	"scripts",
	"sections",
	"serverCalls",
	"singlePrompt",
	"skillLoads",
	"skillOf",
	"snapshotWorkspace",
	"spentUsd",
	"startGateway",
	"summarize",
	"summarizeResults",
	"surfaceOfRequest",
	"textOf",
	"toolEnvelopes",
	"toolParts",
	"toolsFromSnapshot",
	"wilson",
	"writeFiles",
];

const SUBPATHS: Record<string, string[]> = {
	"./setup": [],
	"./config": ["testkitConfig"],
	"./cache-report": [
		"cacheDir",
		"cacheEvents",
		"default",
		"formatSummary",
		"recordCacheEvent",
		"resetCacheEvents",
		"runId",
		"summarize",
	],
	"./reporter": ["agentReport", "default", "formatAgentReport"],
	"./tiers": ["forwardOf", "resolveTier"],
	"./adapters/reference": ["referenceAdapter"],
	"./adapters/claude-code": [
		"CLAUDE_CODE_LIMITS",
		"claudeCodeAdapter",
		"claudeCodeMissing",
		"cliMissing",
		"skillFiles",
	],
	"./adapters/codex": ["codexAdapter", "codexMissing"],
	"./adapters/octocode-agent": [
		"octocodeAgentAdapter",
		"octocodeAgentAvailable",
		"parseSkillListing",
		"runOctocodeAgent",
		"skillToolDescription",
	],
};

describe("runtime exports", () => {
	it("the root entry exports exactly the pinned names", () => {
		expect(Object.keys(root).sort()).toEqual(ROOT);
	});

	it("the manifest has exactly the root and the pinned subpaths", () => {
		expect(Object.keys(manifest.exports).sort()).toEqual([".", ...Object.keys(SUBPATHS)].sort());
	});

	it.each(Object.entries(SUBPATHS))("%s exports exactly the pinned names", async (subpath, names) => {
		const mod = (await import(join(pkgDir, manifest.exports[subpath].source))) as object;
		expect(Object.keys(mod).sort()).toEqual(names);
	});
});

describe("package manifest", () => {
	it("maps every entry's source to its dist output", () => {
		for (const [subpath, conditions] of Object.entries(manifest.exports)) {
			expect(existsSync(join(pkgDir, conditions.source)), `${subpath} source`).toBe(true);
			const out = conditions.source.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, "");
			expect(conditions, subpath).toEqual({
				source: conditions.source,
				types: `${out}.d.ts`,
				import: `${out}.js`,
				default: `${out}.js`,
			});
		}
		expect([manifest.main, manifest.types]).toEqual([manifest.exports["."].import, manifest.exports["."].types]);
	});

	it("lists every module that registers matchers, and every module importing one for that effect", () => {
		const sources = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
		const text = (rel: string): string => readFileSync(join(srcDir, rel), "utf8");
		const registering = new Set(sources.filter((rel) => /\bexpect\.extend\(/.test(text(rel))));
		const importing = sources.filter((rel) =>
			[...text(rel).matchAll(/^import "(\.[^"]+)";$/gm)].some((m) =>
				registering.has(join(dirname(rel), m[1]).replace(/^\.\//, "")),
			),
		);
		expect([...registering]).toEqual(["matchers.ts"]);
		const expected = [...registering, ...importing].flatMap((rel) => [
			`./src/${rel}`,
			`./dist/${rel.replace(/\.ts$/, ".js")}`,
		]);
		expect([...manifest.sideEffects].sort()).toEqual(expected.sort());
	});

	it("publishes publicly with the build, its sources, the examples and the docs, which exist", () => {
		expect(manifest.private).toBeUndefined();
		expect(manifest.publishConfig).toEqual({ access: "public" });
		// The `source` export condition points into `src`, so `src` ships; `prepack` builds and runs check:consumer.
		expect(manifest.scripts.prepack).toBe("yarn build && yarn check:consumer");
		expect(manifest.peerDependencies).toMatchObject({ vitest: expect.any(String), "@types/node": expect.any(String) });
		expect(manifest.files).toEqual([
			"dist",
			"src",
			"examples",
			"README.md",
			"GUIDE.md",
			"REFERENCE.md",
			"MCP-AND-SKILLS.md",
			"CHANGELOG.md",
			"LICENSE",
		]);
		for (const entry of manifest.files.filter((f) => f !== "dist"))
			expect(existsSync(join(pkgDir, entry)), entry).toBe(true);
	});
});

describe("testkitConfig", () => {
	it("gives the kit's setup, global setup, pool, timeouts and reporter", () => {
		const config = testkitConfig();
		expect(config).toEqual({
			pool: "forks",
			testTimeout: 60_000,
			hookTimeout: 60_000,
			setupFiles: [join(srcDir, "setup.ts")],
			globalSetup: [join(srcDir, "cache-report.ts")],
			reporters: ["default", expect.any(AgentReporter)],
		});
		for (const file of [...(config.setupFiles as string[]), ...(config.globalSetup as string[])])
			expect(existsSync(file), file).toBe(true);
	});

	it("appends the caller's setup files, global setups and reporters; other options replace the kit's", () => {
		const config = testkitConfig({
			setupFiles: "./mine.ts",
			globalSetup: ["./global.ts"],
			reporters: "verbose",
			testTimeout: 120_000,
			include: ["agents/**/*.test.ts"],
		});
		expect(config).toEqual({
			pool: "forks",
			testTimeout: 120_000,
			hookTimeout: 60_000,
			include: ["agents/**/*.test.ts"],
			setupFiles: [join(srcDir, "setup.ts"), "./mine.ts"],
			globalSetup: [join(srcDir, "cache-report.ts"), "./global.ts"],
			reporters: ["verbose", expect.any(AgentReporter)],
		});
		expect(testkitConfig({ reporters: [["junit", { outputFile: "j.xml" }]] }).reporters).toEqual([
			["junit", { outputFile: "j.xml" }],
			expect.any(AgentReporter),
		]);
	});
});

describe("public types", () => {
	it("names the types of the gateway, scripts, trace and guards", () => {
		expectTypeOf<typeof root.startGateway>().parameter(0).toEqualTypeOf<GatewayOptions | undefined>();
		expectTypeOf<typeof root.startGateway>().returns.resolves.toEqualTypeOf<Gateway>();
		expectTypeOf<Gateway["trace"]>().toEqualTypeOf<Trace>();
		expectTypeOf<typeof root.script>().returns.toEqualTypeOf<Responder>();
		expectTypeOf<Responder>().parameter(0).toEqualTypeOf<ResponderContext>();
		expectTypeOf<{ toolCalls: ScriptedCall[] }>().toExtend<Step>();
		expectTypeOf<Trace["events"]>().toEqualTypeOf<TraceEvent[]>();
		expectTypeOf<TraceEvent["kind"]>().toEqualTypeOf<EventKind>();
		expectTypeOf<Trace["requests"]>().toEqualTypeOf<CapturedRequest[]>();
		expectTypeOf<CapturedRequest["messages"]>().toEqualTypeOf<ChatMessage[]>();
		expectTypeOf<CapturedRequest["usage"]>().toEqualTypeOf<Usage | undefined>();
		expectTypeOf<Guard>().parameters.toEqualTypeOf<[PendingCall, readonly PendingCall[]]>();
		expectTypeOf<typeof root.mockMcp>().parameters.toEqualTypeOf<[MockMcpOptions]>();
		expectTypeOf<typeof root.mockMcp>().returns.toEqualTypeOf<MockMcp>();
		expectTypeOf<MockMcpOptions["tools"]>().toEqualTypeOf<ToolDef[]>();
	});

	it("names the types of suites, live trials, judges, comparisons and simulated users", () => {
		expectTypeOf<typeof root.agentSuite<string>>().parameter(1).toEqualTypeOf<AgentSuiteOptions<string>>();
		expectTypeOf<SuiteTestContext<string>["run"]>().returns.resolves.toEqualTypeOf<Turn<string>>();
		expectTypeOf<NonNullable<AgentSuiteOptions<string>["pass"]>>().toEqualTypeOf<PassPolicy>();
		expectTypeOf<typeof root.runTrials>().parameters.toEqualTypeOf<[LiveOptions, Trial]>();
		expectTypeOf<typeof root.runTrials>().returns.resolves.toEqualTypeOf<LiveSummary>();
		expectTypeOf<typeof root.judge>().parameters.toEqualTypeOf<[JudgeOptions]>();
		expectTypeOf<typeof root.judge>().returns.resolves.toEqualTypeOf<Judgement>();
		expectTypeOf<typeof root.judgePanel>().returns.resolves.toEqualTypeOf<Panel>();
		expectTypeOf<JudgeOptions["model"]>().toEqualTypeOf<Tier | Forward>();
		expectTypeOf<RootTier>().toEqualTypeOf<Tier>();
		expectTypeOf<typeof resolveTier>().returns.toEqualTypeOf<TierResolution>();
		expectTypeOf<typeof root.runComparison>().returns.resolves.toEqualTypeOf<ComparisonSummary>();
		expectTypeOf<typeof root.converse<string>>().returns.resolves.toEqualTypeOf<Conversation<string>>();
		expectTypeOf<Conversation<string>["stopped"]>().toEqualTypeOf<ConverseStop>();
	});

	it("names the types of workspace grading, surface review and routing", () => {
		expectTypeOf<typeof root.snapshotWorkspace>().returns.toEqualTypeOf<WorkspaceSnapshot>();
		expectTypeOf<typeof root.diffWorkspace>().returns.toEqualTypeOf<WorkspaceDiff>();
		expectTypeOf<typeof root.runVerifier>().returns.resolves.toEqualTypeOf<VerifierResult>();
		expectTypeOf<typeof root.analyzeSurface>().parameter(1).toEqualTypeOf<Partial<SurfaceLimits> | undefined>();
		expectTypeOf<typeof root.analyzeSurface>().returns.toEqualTypeOf<SurfaceReport>();
		expectTypeOf<typeof root.probeRouting>().returns.resolves.toEqualTypeOf<RoutingReport>();
	});

	it("types each bundled adapter by its options and run result", () => {
		expectTypeOf<typeof root.referenceAdapter>().parameter(0).toEqualTypeOf<ReferenceOptions & { trace: Trace }>();
		expectTypeOf<typeof root.referenceAdapter>().returns.toEqualTypeOf<AgentAdapter<InprocResult>>();
		expectTypeOf<typeof claudeCodeAdapter>().parameters.toEqualTypeOf<[opts?: ClaudeCodeOptions]>();
		expectTypeOf<typeof claudeCodeAdapter>().returns.toEqualTypeOf<AgentAdapter<ExternalRun>>();
		expectTypeOf<typeof codexAdapter>().parameters.toEqualTypeOf<[opts?: CodexOptions]>();
		expectTypeOf<typeof codexAdapter>().returns.toEqualTypeOf<AgentAdapter<ExternalRun>>();
		expectTypeOf<typeof octocodeAgentAdapter>().parameters.toEqualTypeOf<[opts?: OctocodeAgentAdapterOptions]>();
		expectTypeOf<typeof octocodeAgentAdapter>().returns.toEqualTypeOf<AgentAdapter<OctocodeAgentRun>>();
	});

	it("defineAdapter returns the adapter and infers an inline adapter's run result", async () => {
		const session = {
			run: async (input: string | RunInput) => ({ prompts: runInput(input).prompts.length }),
			close: async () => {},
		};
		const adapter = defineAdapter({ name: "inline", start: async () => session });
		expectTypeOf(adapter).toEqualTypeOf<AgentAdapter<{ prompts: number }>>();
		expectTypeOf(
			defineAdapter({ name: "x", start: async () => ({ run: async () => "text", close: async () => {} }) }),
		).toEqualTypeOf<AgentAdapter<string>>();
		expect(adapter.name).toBe("inline");
		await expect((await adapter.start({ gatewayUrl: "http://127.0.0.1:1" })).run("hi")).resolves.toEqual({
			prompts: 1,
		});
	});

	it("types the kit's matchers on expect", () => {
		// Type-checked, never called: the matchers need a recorded trace to run.
		const typed = (trace: Trace, later: Promise<Trace>): void => {
			expect(trace).toHaveCalledTool("search", { args: { query: "cache" }, before: "answer" });
			expect(trace).not.toHaveCalledMcp("docs", /^delete_/);
			expectTypeOf(expect(trace).toHaveCalledTool).parameter(0).toEqualTypeOf<NamePattern>();
			expectTypeOf(expect(trace).toHaveCalledTool("search")).toEqualTypeOf<void>();
			expectTypeOf(expect(later).resolves.toHaveCalledTool("search")).toEqualTypeOf<Promise<void>>();
			// @ts-expect-error -- a misspelled matcher is not on `expect`
			expect(trace).toHaveCaledTool("search");
			// @ts-expect-error -- a tool name is a string, glob or RegExp, not a number
			expect(trace).toHaveCalledTool(1);
		};
		expectTypeOf(typed).toBeFunction();
		expect(root.matchers.toHaveCalledTool).toBeTypeOf("function");
	});
});
