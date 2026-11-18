import { afterAll, describe, test, type ExpectStatic, type TestContext } from "vitest";
import type { AdapterContext, AgentAdapter, AgentSession, RunInput } from "./adapter.ts";
import { startGateway, type Gateway, type GatewayOptions } from "./gateway.ts";
import type { Guard } from "./guards.ts";
import { mockMcp, type MockMcp, type ToolDef } from "./mcp.ts";
import { spentUsd, type Pricing } from "./policy.ts";
import { suiteMeta } from "./suite-meta.ts";
import { dataText, guardReason, type Trace, type TraceMark } from "./trace.ts";

/** Share of runs that must pass (0 < share <= 1), every run ("all", pass^k) or at least one ("any", pass@k). */
export type PassPolicy = number | "all" | "any";

/** One fresh agent of a suite: its own gateway, trace and mock servers. */
export interface ReplicaContext {
	replica: number;
	gateway: Gateway;
	trace: Trace;
	mcp: Record<string, MockMcp>;
}

type SuiteGateway = Omit<GatewayOptions, "guards">;

export interface AgentSuiteOptions<R> {
	/** The harness under test; a factory is called once per fresh agent with that agent's gateway, trace and mocks. */
	adapter: AgentAdapter<R> | ((ctx: ReplicaContext) => AgentAdapter<R>);
	/** Gateway of each agent: a `responder` (script) or a `forward`; a function gets the run index. */
	gateway?: SuiteGateway | ((replica: number) => SuiteGateway);
	/** Mock MCP servers by name; every agent gets its own mocks, spies and URLs (`AdapterContext.mcpUrls`). */
	mcp?: Record<string, ToolDef[]>;
	/** Judged at the gateway (before the harness sees a call) and at every mock MCP server. */
	guards?: readonly Guard[];
	/** Hard USD cap for the whole describe, split evenly across runs; needs `pricing`. */
	budgetUsd?: number;
	/** USD per million tokens; prices every request (scripted runs on estimated usage). */
	pricing?: Pricing;
	/** Fresh agents that each run every test (default 1). */
	runs?: number;
	/** Default "all". */
	pass?: PassPolicy;
	/** Runs executed at once (default: all). Use 1 for local models. */
	concurrency?: number;
	/** "describe" (default): one agent per run for the whole describe, each test its next turn. "test": fresh per test. */
	isolation?: "describe" | "test";
	/** Passed to `adapter.start` besides the gateway and MCP URLs. */
	start?: Omit<AdapterContext, "gatewayUrl" | "mcpUrls">;
	/** Skip every test with this reason, such as an unresolved tier; `adapter.unavailable()` is checked too. */
	skip?: string;
	timeoutMs?: number;
}

/** One `run()`: the adapter's result plus what this turn alone recorded. */
export interface Turn<R> {
	result: R;
	/** This turn's requests and events (`Trace.since`); the context's `trace` holds every turn. */
	trace: Trace;
	/** The last answer recorded in this turn. */
	answer?: string;
	/** Why a cap or a guard stopped part of this turn. */
	stopped?: string;
}

export interface SuiteTestContext<R> extends ReplicaContext {
	/** Sends the next turn to this run's agent. */
	run(input: string | RunInput): Promise<Turn<R>>;
	expect: ExpectStatic;
}

export interface SuiteTestOptions {
	/** Accept a turn that a cap or guard stopped (to test the stop itself). */
	allowStop?: boolean;
	/** The aggregated verdict is expected to fail (`test.fails`). */
	fails?: boolean;
	timeoutMs?: number;
}

export interface SuiteApi<R> {
	test(name: string, fn: (ctx: SuiteTestContext<R>) => Promise<void> | void, opts?: SuiteTestOptions): void;
}

interface Replica<R> {
	index: number;
	ctx?: ReplicaContext;
	adapter?: AgentAdapter<R>;
	session?: AgentSession<R>;
	dead?: string;
}

export function neededPasses(policy: PassPolicy, runs: number): number {
	if (policy === "all") return runs;
	if (policy === "any") return 1;
	if (!(policy > 0 && policy <= 1)) throw new RangeError(`agentSuite: pass=${policy} must be in (0, 1]`);
	return Math.ceil(policy * runs - 1e-9);
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
	const queue = [...items];
	const worker = async (): Promise<void> => {
		// oxlint-disable-next-line no-await-in-loop -- pool worker: it takes the next item only when its last one is done, which bounds concurrency
		for (let item = queue.shift(); item !== undefined; item = queue.shift()) await fn(item);
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

function stopOf(view: Trace): string | undefined {
	const reasons = view.events.flatMap((e) =>
		e.kind === "guard" ? [`guard: ${guardReason(e)}`] : e.kind === "cut" ? [`cut: ${dataText(e.data)}`] : [],
	);
	return reasons.length ? reasons.join("; ") : undefined;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Each test is its agent's next turn, so a rerun would grade a different turn: no retry, no repeats, no
 * concurrency, no shuffle. Set on the describe and on every test, so config, parent and tag options lose.
 */
const ONE_TURN_EACH = { retry: 0, repeats: 0, concurrent: false } as const;

/** Why Vitest is running this test again (a retry or a repeat), or undefined on its first run. */
function rerunOf(tc: TestContext): string | undefined {
	const r = tc.task.result;
	if (r?.retryCount) return `retry ${r.retryCount}`;
	if (r?.repeatCount) return `repeat ${r.repeatCount}`;
	return undefined;
}

/**
 * A `describe` that owns real agents. Each run gets a fresh agent (gateway, trace, mocks, session); each `t.test`
 * runs its body once per run, as that agent's next turn, and passes when the pass policy holds. A turn that a cap
 * or guard stopped fails its run unless the test sets `allowStop`. A test filtered alone (`-t`) starts on a fresh
 * agent without the earlier turns. Whether the agent remembers earlier turns is the adapter's: the reference
 * adapter does with `conversation: true`. Tests run in order, one at a time, without Vitest `retry` or `repeats`
 * (a rerun would grade a different turn); a test that runs again anyway fails.
 */
export function agentSuite<R>(name: string, opts: AgentSuiteOptions<R>, body: (t: SuiteApi<R>) => void): void {
	const runs = opts.runs ?? 1;
	if (!Number.isInteger(runs) || runs < 1) throw new RangeError(`agentSuite: runs=${runs} must be a positive integer`);
	const needed = neededPasses(opts.pass ?? "all", runs);
	if (opts.budgetUsd !== undefined && !opts.pricing) throw new Error("agentSuite: budgetUsd needs pricing");

	describe(name, { ...ONE_TURN_EACH, shuffle: false }, () => {
		let replicas: Replica<R>[] = [];
		/** USD each run spent on agents already closed (`isolation: "test"`), so the describe-wide cap holds. */
		const spentByRun = new Map<number, number>();
		const fresh = (): void => {
			replicas = Array.from({ length: runs }, (_, index) => ({ index }));
		};
		fresh();

		const ensure = async (r: Replica<R>): Promise<ReplicaContext> => {
			if (r.ctx) return r.ctx;
			const g = typeof opts.gateway === "function" ? opts.gateway(r.index) : (opts.gateway ?? {});
			const share = opts.budgetUsd === undefined ? undefined : opts.budgetUsd / runs;
			const left = share === undefined ? undefined : share - (spentByRun.get(r.index) ?? 0);
			if (share !== undefined && left !== undefined && left <= 0) r.dead = `budget share $${share.toFixed(4)} spent`;
			const gateway = await startGateway({
				...g,
				guards: opts.guards,
				caps: {
					...g.caps,
					...(opts.pricing ? { pricing: opts.pricing } : {}),
					...(left !== undefined ? { maxUsd: Math.max(0, left) } : {}),
				},
			});
			const mcp: Record<string, MockMcp> = {};
			for (const [server, tools] of Object.entries(opts.mcp ?? {}))
				mcp[server] = mockMcp({ name: server, tools, trace: gateway.trace, guards: opts.guards });
			r.ctx = { replica: r.index, gateway, trace: gateway.trace, mcp };
			r.adapter = typeof opts.adapter === "function" ? opts.adapter(r.ctx) : opts.adapter;
			return r.ctx;
		};

		const close = async (r: Replica<R>): Promise<void> => {
			if (r.ctx) spentByRun.set(r.index, (spentByRun.get(r.index) ?? 0) + spentUsd(r.ctx.trace));
			await r.session?.close();
			await Promise.all(Object.values(r.ctx?.mcp ?? {}).map((m) => m.close()));
			await r.ctx?.gateway.close();
		};

		const turn = async (r: Replica<R>, ctx: ReplicaContext, input: string | RunInput, stops: string[]) => {
			if (r.dead) throw new Error(`run ${r.index} stopped earlier: ${r.dead}`);
			if (!r.session) {
				// A mock's listen only binds a port: it sends no request and records nothing, so the mocks listen at once.
				const urls = await Promise.all(
					Object.entries(ctx.mcp).map(async ([server, m]): Promise<[string, string]> => [server, await m.listen()]),
				);
				const mcpUrls = Object.fromEntries(urls);
				r.session = await r.adapter!.start({ ...opts.start, gatewayUrl: ctx.gateway.url, mcpUrls });
			}
			const mark: TraceMark = ctx.trace.mark();
			const result = await r.session.run(input);
			const view = ctx.trace.since(mark);
			const stopped = stopOf(view);
			if (stopped) stops.push(stopped);
			if (view.events.some((e) => e.kind === "cut" && dataText(e.data).startsWith("budget cap"))) r.dead = stopped;
			const answer = view.of("answer").at(-1)?.data;
			return { result, trace: view, stopped, ...(typeof answer === "string" ? { answer } : {}) };
		};

		afterAll(async () => {
			await Promise.all(replicas.map(close));
		});

		body({
			test(testName, fn, testOpts = {}) {
				const timeout = testOpts.timeoutMs ?? opts.timeoutMs;
				const options = { ...ONE_TURN_EACH, ...(timeout ? { timeout } : {}) };
				(testOpts.fails ? test.fails : test)(testName, options, async (tc: TestContext): Promise<void> => {
					const rerun = rerunOf(tc);
					if (rerun) {
						const why = `agentSuite: "${testName}" ran again (${rerun}); each test is its agent's next turn, so a rerun would grade another turn`;
						if (!testOpts.fails) throw new Error(why);
						// Under test.fails a throw would read as the expected failure; returning fails the test instead.
						return void (await tc.annotate(why, "agent"));
					}
					if (opts.isolation === "test") {
						await Promise.all(replicas.map(close));
						fresh();
					}
					if (opts.skip) return tc.skip(opts.skip);
					await ensure(replicas[0]);
					const missing = replicas[0].adapter?.unavailable?.();
					if (missing) return tc.skip(`${replicas[0].adapter?.name ?? "adapter"}: ${missing}`);
					const marks = new Map<number, TraceMark>();
					const failures: { replica: number; message: string; error: unknown }[] = [];
					let passes = 0;
					await pool(replicas, opts.concurrency ?? runs, async (r) => {
						const ctx = await ensure(r);
						marks.set(r.index, ctx.trace.mark());
						const stops: string[] = [];
						try {
							await fn({ ...ctx, run: (input) => turn(r, ctx, input, stops), expect: tc.expect });
							if (stops.length && !testOpts.allowStop) throw new Error(`turn stopped early: ${stops.join("; ")}`);
							passes++;
						} catch (error) {
							failures.push({ replica: r.index, message: message(error), error });
						}
					});
					const meta = suiteMeta({
						adapter: replicas[0].adapter?.name ?? "?",
						needed,
						passes,
						failures: failures.map(({ replica, message: m }) => ({ replica, message: m })),
						turns: replicas.map((r) => r.ctx!.trace.since(marks.get(r.index)!)),
						mcp: replicas.map((r) => r.ctx!.mcp),
					});
					tc.task.meta.agentSuite = meta;
					await tc.annotate(
						`${passes}/${runs} runs passed (need ${needed}) · ${meta.requests} requests · $${meta.costUsd.toFixed(4)}`,
						"agent",
					);
					if (passes >= needed) return;
					if (runs === 1) throw failures[0].error;
					const detail = failures
						.toSorted((a, b) => a.replica - b.replica)
						.map((f) => `  run ${f.replica}: ${f.message.split("\n")[0]}`)
						.join("\n");
					throw new Error(`${passes}/${runs} runs passed, ${needed} needed\n${detail}`);
				});
			},
		});
	});
}
