import { envFlag, LEAN_ENV } from "@octocodeai/octocode-common/env";
import { errorMessage, isRecord } from "@octocodeai/octocode-contracts/guards";
import type { FeatureContext, FeatureSetup } from "../../../core/features/index.ts";
import { CHILD_EXPOSURE_EVENT, type ChildExposure } from "../../permission/provenance/exposure.ts";
import { notify } from "../../shared/commands.ts";
import { interactive } from "../../shared/interactive.ts";
import { AGENT_RESULT_TYPE } from "../../shared/messages.ts";
import { contentText } from "../../shared/util.ts";
import { storeUnavailable } from "../errors.ts";
import type { MemoryStore } from "../store.ts";
import { type CandidateInput, checkpointCandidates, noticedLines, queueCandidates } from "./candidates.ts";
import { consolidateDue } from "./consolidation.ts";
import { fixChecker } from "./defects.ts";
import { toolFieldMap } from "./stale.ts";
import type { SmallModel } from "./passes.ts";
import { globalMemoryFile, workspaceMemoryFile } from "../../permission/memory-files.ts";
import { NO_TAINT, quarantineReason, sessionTaint, type Taint } from "./quarantine.ts";
import { reflectOnSession } from "./reflection.ts";
import { memorySettings, writesAutomatically } from "./settings.ts";
import { reviewSession } from "./signals.ts";
import type { MemoryFileSync } from "./sync.ts";

/**
 * How a main session turns what it learned into MEMORY.md lines, with `memory.autoUpdate` at `auto`:
 *
 * - After each compaction, the checkpoint's standing rules, decisions and failures are queued as candidates (no model
 *   call); so are the `Noticed:` lines of a child's report. A checkpoint holds task-scoped detail, so a candidate never
 *   reaches a file by itself.
 * - When the session ends (quit, a new or resumed session), a session of 5 user turns or more that had an outside signal
 *   (a correction, a check that failed then passed, a refused or reverted call, a repeated error) gets one reflection:
 *   a `small` model call that proposes at most 3 ops (`reflection.ts`).
 * - When the session's first run starts and when it ends, a file due for its daily consolidation (`consolidation.ts`) gets it
 *   when candidates are pending.
 *
 * Only sessions with a screen (terminal, RPC) spend on a model, and `memory.reflection: false` turns both model passes
 * off. Children and lean sessions do none of this. Other sessions see a changed file at their next compaction or start.
 */

const MIN_USER_TURNS = 5;
/** A session's end waits for its passes, so their calls are short. The first run's pass runs beside the turn. */
const REFLECT_TIMEOUT_MS = 10_000;
const START_PASS_TIMEOUT_MS = 60_000;
const END_PASS_TIMEOUT_MS = 15_000;

interface MemoryReflectionOptions {
	isSubagent: boolean;
	env: NodeJS.ProcessEnv;
	store: (ctx: Pick<FeatureContext, "cwd">) => MemoryStore;
	files: MemoryFileSync;
	/** The `small` purpose's caller; without one only the code's part of consolidation runs, and no reflection. */
	small?: SmallModel;
}

export function registerMemoryReflection(api: FeatureSetup, options: MemoryReflectionOptions): void {
	// A child never harvests or writes: its coordinator queues the child's `Noticed:` lines.
	if (options.isSubagent || envFlag(options.env, LEAN_ENV)) return;
	const { env, files } = options;
	const { small } = options;
	const settings = () => memorySettings(api.settings.get());
	const automatic = () => writesAutomatically(settings());
	/** The model of a pass: `memory.reflection` on and a `small` model cheaper than this session's to call. */
	const modelFor = (ctx: FeatureContext): SmallModel | undefined =>
		small && settings().reflection && small.label(ctx) ? small : undefined;
	/** Children whose harness said they read nothing from outside the workspace (`permission/provenance/exposure.ts`). */
	const cleanChildren = new Set<string>();
	/**
	 * The pass each session's first run started, with what stops it. Its failure is shown when it happens and thrown
	 * when the session ends, which awaits it.
	 */
	const started = new Map<string, { done: Promise<Error | undefined>; stop: AbortController }>();

	const queue = (ctx: FeatureContext, items: readonly CandidateInput[]) => {
		if (items.length === 0) return;
		try {
			queueCandidates(options.store(ctx), items, ctx.sessionManager.getSessionId());
		} catch (error) {
			// A busy or missing database: the next compaction carries the same bullets again.
			if (!storeUnavailable(error)) throw error;
		}
	};
	const tagged = (text: string, why: string | undefined, rest: Omit<CandidateInput, "text" | "quarantine">) => ({
		text,
		...rest,
		...(why ? { quarantine: why } : {}),
	});

	api.bus.on("session_compact", async (event, ctx) => {
		if (!automatic()) return;
		const found = checkpointCandidates(event.compactionEntry.summary);
		if (found.length === 0) return;
		const taint = sessionTaint(ctx.sessionManager.getBranch());
		const evidence = `session ${ctx.sessionManager.getSessionId()}, entry ${event.compactionEntry.id}`;
		queue(
			ctx,
			found.map(({ text, kind }) =>
				tagged(text, quarantineReason(text, taint), { kind, origin: "checkpoint", evidence }),
			),
		);
	});

	api.channels.on(CHILD_EXPOSURE_EVENT, (data) => {
		const { child, exposed } = data as Partial<ChildExposure>;
		if (typeof child !== "string") return;
		if (exposed === false) cleanChildren.add(child);
		else cleanChildren.delete(child);
	});
	/** A child's report, from its `agent` result or the message that delivered it in the background. */
	const harvestReport = (ctx: FeatureContext, text: string, details: unknown) => {
		if (!automatic()) return;
		const lines = noticedLines(text);
		if (lines.length === 0) return;
		const child = isRecord(details) && typeof details.id === "string" ? details.id : undefined;
		// A child that did not say it read only the workspace may relay a page's text, as provenance treats its report.
		const taint =
			child !== undefined && cleanChildren.has(child) ? sessionTaint(ctx.sessionManager.getBranch()) : undefined;
		const evidence = `session ${ctx.sessionManager.getSessionId()}, report of ${child ?? "a child"}`;
		queue(
			ctx,
			lines.map((line) =>
				tagged(
					line,
					taint ? quarantineReason(line, taint) : "comes from a child that read sources outside the workspace",
					{ kind: "gotcha", origin: "child", evidence },
				),
			),
		);
	};
	api.bus.on("tool_result", async (event, ctx) => {
		if (event.toolName === "agent" && !event.isError) harvestReport(ctx, contentText(event.content), event.details);
		return undefined;
	});
	api.bus.on("message_end", async (event, ctx) => {
		const { message } = event;
		if (message.role === "custom" && message.customType === AGENT_RESULT_TYPE)
			harvestReport(ctx, contentText(message.content), message.details);
	});

	const consolidate = async (
		ctx: FeatureContext,
		trigger: "start" | "end",
		timeoutMs: number,
		taint: Taint,
		signal?: AbortSignal,
	) => {
		try {
			await consolidateDue(
				ctx,
				{
					api,
					store: options.store(ctx),
					repeats: files.repeats(),
					env,
					small: modelFor(ctx),
					fixed: fixChecker(options.store(ctx), env),
					toolFields: () => toolFieldMap(api.tools.getAll()),
					taint,
					timeoutMs,
					...(signal ? { signal } : {}),
				},
				trigger,
			);
		} catch (error) {
			if (!storeUnavailable(error)) throw error;
		}
	};

	// The first run's start: `register.ts` has taken the request's AGENTS.md files, so the pass checks lines against them.
	api.bus.on("agent_start", async (_event, ctx) => {
		const session = ctx.sessionManager.getSessionId();
		if (started.has(session) || !automatic() || !interactive(ctx, false)) return;
		const stop = new AbortController();
		const done = consolidate(ctx, "start", START_PASS_TIMEOUT_MS, NO_TAINT, stop.signal).then(
			() => undefined,
			(error: unknown) => {
				notify(ctx.ui, `Memory consolidation failed: ${errorMessage(error)}`, "error");
				return error instanceof Error ? error : new Error(errorMessage(error));
			},
		);
		started.set(session, { done, stop });
	});

	api.bus.on("session_shutdown", async (event, ctx) => {
		const session = ctx.sessionManager.getSessionId();
		const first = started.get(session);
		started.delete(session);
		// The end's own pass takes over from a pass still running: it waits less.
		first?.stop.abort();
		const failure = await first?.done;
		if (failure) throw failure;
		// A reload keeps the session, and a fork goes on in its copy: neither ends what it learned.
		if (event.reason === "reload" || event.reason === "fork" || !automatic() || !interactive(ctx, false)) return;
		const entries = ctx.sessionManager.getBranch();
		const taint = sessionTaint(entries);
		const model = modelFor(ctx);
		const review = reviewSession(entries);
		if (model && review.userTurns >= MIN_USER_TURNS && review.signals.length > 0) {
			try {
				await reflectOnSession(
					ctx,
					{
						api,
						store: options.store(ctx),
						repeats: files.repeats(),
						env,
						small: model,
						taint,
						timeoutMs: REFLECT_TIMEOUT_MS,
					},
					{
						session,
						entries,
						signals: review.signals,
						files: [globalMemoryFile(env), workspaceMemoryFile(ctx.cwd)],
					},
				);
			} catch (error) {
				if (!storeUnavailable(error)) throw error;
			}
		}
		await consolidate(ctx, "end", END_PASS_TIMEOUT_MS, taint);
	});
}
