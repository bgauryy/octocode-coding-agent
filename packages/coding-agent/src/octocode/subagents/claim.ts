import { configuredSubagentModels } from "./configured-models.ts";
import type { AgentEnd } from "../team/panel/state.ts";
import { randomUUID } from "node:crypto";
import os from "node:os";
import { getEnvApiKey } from "@octocodeai/octocode-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "../../core/features/index.ts";
import type { ReportStatus } from "../instructions/report.ts";
import { envInt } from "../../../../common/src/env.ts";
import { shortPath } from "../../utils/display-path.ts";
import { sessionFolderNames } from "../shared/home.ts";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { agentScratch, dropEmptyScratch, type ReadReports, scratchNames } from "./handoff/scratch.ts";
import { type CacheChoice, childCachePreferences, defaultTaskCache, type Identity } from "./process/env.ts";
import { childHookMode, type HookMode } from "../shared/hook-mode.ts";
import { routeThinking } from "./thinking.ts";
import { maxRequests } from "./budget.ts";
import type { Team } from "../team/session.ts";
import { currentCatalog } from "./catalog.ts";
import type { Background } from "./command.ts";
import { type ReportQueue } from "./handoff.ts";
import {
	clampNote,
	type ModelRoute,
	registryBilling,
	routedModel,
	routeModel,
	SUBAGENT_DEFAULT_TIER,
	subagentThinking,
	supportedThinking,
} from "./model.ts";
import { providerHealth } from "./provider-health.ts";
import { getPromptCacheTtlMs } from "../../core/cache-warmer/economics.ts";
import { type AgentProfile, GENERAL_PROFILE, profileSelectsBrowser, profileTools } from "./profiles.ts";
import type { RunDetails } from "./run-types.ts";
import type { GraphWake } from "./graph-wake.ts";

/** Starting a subagent: who it is (name, role, goal), its slot under the limit, and the task text it receives. */

export const MAX_SUBAGENTS_ENV = "OCTOCODE_MAX_SUBAGENTS";
const MOST_DEFAULT_SUBAGENTS = 6;
const GIB = 1024 ** 3;

/**
 * The default for a machine: at most 6, one per CPU, and one per GiB of memory (a child and its MCP pair peak near
 * 450 MB, so that stays within about half the machine).
 */
export const machineSubagents = (cores: number, totalMemory: number): number =>
	Math.max(1, Math.min(MOST_DEFAULT_SUBAGENTS, cores, Math.floor(totalMemory / GIB)));

/** Read once: the limit is in a tool description, which must not change during a session. */
let thisMachine: number | undefined;
const thisMachineSubagents = (): number => (thisMachine ??= machineSubagents(os.availableParallelism(), os.totalmem()));

/** How many subagents may run at once: `OCTOCODE_MAX_SUBAGENTS` (a positive integer), else what this machine suits. A call past it waits for a slot. */
export function maxSubagents(env: NodeJS.ProcessEnv = process.env, fallback: number = thisMachineSubagents()): number {
	const value = envInt(env, MAX_SUBAGENTS_ENV, fallback);
	return value >= 1 ? value : fallback;
}

const SUBAGENT_LINGER_ENV = "OCTOCODE_SUBAGENT_LINGER_SECONDS";

/** Seconds a finished background subagent stays reachable (a message resumes its saved conversation); 0 = off. */
function lingerSeconds(env: NodeJS.ProcessEnv = process.env): number {
	return Math.max(0, envInt(env, SUBAGENT_LINGER_ENV, 0));
}

/**
 * Seconds a background run stays resumable even with the linger setting at 0 when it waits for an answer: it reported
 * `blocked`, or it ended with a `replyRequired` message to its parent or a peer still unanswered
 * (`Team.unansweredPeerAsks` counts the peer ones).
 */
export const BLOCKED_LINGER_SECONDS = 600;

/**
 * The window a finished background run stays reachable: the profile's `linger` when it sets one, else the setting; at
 * least `BLOCKED_LINGER_SECONDS` after a `blocked` report or while it has an unanswered ask to its parent or a peer
 * (`awaitsReply`), whatever outcome it reported.
 */
export function reachableSeconds(
	outcome: ReportStatus | undefined,
	env: NodeJS.ProcessEnv = process.env,
	profileLinger?: number,
	awaitsReply = false,
): number {
	const seconds = profileLinger ?? lingerSeconds(env);
	return outcome === "blocked" || awaitsReply ? Math.max(seconds, BLOCKED_LINGER_SECONDS) : seconds;
}

/** The refusal for a resume while every slot is taken (a message is answered now; it does not wait for a slot). */
export function subagentLimitError(active: Iterable<string>, limit: number): string {
	const ids = [...active];
	return `${ids.length} subagents are already running${ids.length ? ` (${ids.join(", ")})` : ""}; the limit is ${limit}. Wait for one to finish (background answers arrive as messages), pass the work to a running subagent with \`agent\` type \`message\`, or do it yourself. The limit is set by ${MAX_SUBAGENTS_ENV}.`;
}

/**
 * Subagent slots under `maxSubagents()`. A call past the limit waits, first come first served, until a run gives its
 * slot back; its signal (Esc, a turn abort) gives up the wait. A slot given back passes straight to the next waiter.
 */
export class Slots {
	private taken = 0;
	private readonly waiting: Array<() => void> = [];

	private readonly limit: () => number;
	constructor(limit: () => number = maxSubagents) {
		this.limit = limit;
	}

	/** Takes a free slot without waiting; false when all are in use or someone already waits. */
	tryTake(): boolean {
		if (this.waiting.length > 0 || this.taken >= this.limit()) return false;
		this.taken += 1;
		return true;
	}

	/** Takes a slot, waiting while all are in use; `onWait` hears how many run when the wait begins. */
	async take(signal: AbortSignal | undefined, onWait?: (running: number) => void): Promise<void> {
		signal?.throwIfAborted();
		if (this.tryTake()) return;
		onWait?.(this.taken);
		await new Promise<void>((resolve, reject) => {
			const grant = () => {
				signal?.removeEventListener("abort", cancel);
				resolve();
			};
			const cancel = () => {
				const index = this.waiting.indexOf(grant);
				if (index >= 0) this.waiting.splice(index, 1);
				reject(new Error("Cancelled while waiting for a subagent slot."));
			};
			this.waiting.push(grant);
			signal?.addEventListener("abort", cancel, { once: true });
			// onWait may abort synchronously before the listener is installed.
			if (signal?.aborted) cancel();
		});
	}

	give(): void {
		const next = this.waiting.shift();
		if (next) next();
		else this.taken = Math.max(0, this.taken - 1);
	}
}

/** State of one agent tool registration; a replaced session starts clean. */
export interface AgentRuns {
	api: ExtensionAPI;
	team: Team;
	background: Background;
	/** Foreground runs, so `/agents kill` can stop one without aborting the whole turn. */
	foreground: Background;
	/** What each task running now has spent so far (`spawn-limits.ts`). */
	live: Map<string, Pick<RunDetails, "cost">>;
	reports: ReportQueue;
	read: ReadReports;
	/** Subagents running now (foreground and background), by name. */
	running: Map<string, undefined>; // The ids of the running subagents (a map because the team session reads it as one).
	/** The backlog item each child was started for (`agent` `item`), by name; an entry of an ended child is dropped when read (`idle-items.ts`). */
	items: Map<string, string>;
	/** Their slots under the limit, taken before the spawn ask and given back by `Run.release`. */
	slots: Slots;
	/** Called when a background run starts or ends: the footer counts them while the agents panel cannot show them. */
	changed: () => void;
	/** Called when a background run ended, with how it ended: the agents panel shows the outcome on the finished row. */
	ended?: (id: string, end: AgentEnd) => void;
	/** Bumped when a session ends: a background run started under an earlier session drops its late report. */
	session: number;
	/** Wakes the parent for a report that says what became ready or what is stuck (`graph-wake.ts`). */
	graph?: GraphWake;
}

/** What a call asks for: its goal (already checked by `checkGoal`), a profile and model to plan with. */
interface AgentParams {
	goal: string;
	/** The name of the child a continued run is (`resume`): it keeps it, and with it its saved conversation. */
	name?: string;
	sessionId?: string;
	profile?: string;
	model?: string;
	headless?: boolean;
	background?: boolean;
	isolate?: boolean;
	/** The task's hook mode, or the one an earlier run of a resumed child was started with. */
	hooks?: HookMode;
	/** The task's cache tier; absent: `defaultTaskCache`. */
	cache?: CacheChoice;
}

/** A claimed subagent run: who it is, who started it, where it hands files back, and how it gives its slot back. */
export interface Run {
	identity: Identity & { role: string; goal: string };
	profile: AgentProfile | undefined;
	/** The model it runs on (the parent's when nothing else routes); `fallback` is the profile's unavailable preference. */
	route: RunRoute;
	/** Why the run starts without the team (its database is unusable), for the result. */
	teamNote: string;
	release: () => void;
}

/**
 * A run's model route, with what chose it for its failure report: `via` names the request that picked the model (the
 * `model` argument or the profile's preference; absent when it is this session's model), `parent` this session's model.
 */
export type RunRoute = Extract<ModelRoute, { model?: string }> & { via?: string; parent?: string };

/**
 * Whether `provider` authenticates only through this session's runtime override (`--api-key`): that key lives in this
 * process's memory and never reaches a child, which inherits the environment and the shared credential store instead.
 * An environment key the child inherits keeps the provider usable.
 */
function sessionOnlyProvider(registry: ExtensionContext["modelRegistry"] | undefined, provider: string): boolean {
	return registry?.getProviderAuthStatus?.(provider).source === "runtime" && !getEnvApiKey(provider);
}

function sessionOnlyError(provider: string): Error {
	return new Error(
		`${provider} is authenticated by this session's --api-key, which subagents do not receive. Connect it with /providers or choose a model from another provider.`,
	);
}

/** The models a child process can authenticate for; naming a session-only provider explicitly is refused with the reason. */
function childAvailable(registry: ExtensionContext["modelRegistry"] | undefined, explicit: string | undefined) {
	if (!registry) return [];
	const provider = explicit?.includes("/") ? explicit.slice(0, explicit.indexOf("/")) : undefined;
	if (provider && sessionOnlyProvider(registry, provider)) throw sessionOnlyError(provider);
	return registry.getAvailable().filter((model) => !sessionOnlyProvider(registry, model.provider));
}

/** What a call asks for, checked before anything waits, asks or starts: its profile and the model it routes to. */
export type RunPlan = Pick<Run, "profile" | "route">;

/**
 * Checks the profile and routes the model; throws the refusal (unknown profile, unavailable model). `refused` holds why
 * each profile file was refused when the profiles loaded, by file name: an unknown name that is one of them says why.
 */
export function planRun(
	profiles: Map<string, AgentProfile>,
	params: Pick<AgentParams, "profile" | "model" | "headless" | "background">,
	ctx: Pick<ExtensionContext, "modelRegistry" | "model">,
	refused: ReadonlyMap<string, string> = new Map(),
): RunPlan {
	let profile = params.profile ? profiles.get(params.profile) : undefined;
	if (params.profile && !profile) {
		const why = refused.get(params.profile);
		throw new Error(
			`Unknown profile "${params.profile}". Available: ${[...profiles.keys()].join(", ")}${why ? `\n"${params.profile}" was refused when profiles loaded: ${why}` : ""}`,
		);
	}
	profileTools(profile);
	if (params.headless !== undefined) {
		if (!profile || !profileSelectsBrowser(profile))
			throw new Error("headless requires a browser-enabled profile; use profile: browser.");
		profile = { ...profile, headless: params.headless };
	}
	// An explicit model is strict; a profile's is a preference that falls back to this session's model; a task with
	// neither a model nor a profile takes the default purpose.
	const available = childAvailable(ctx.modelRegistry, params.model);
	const routed = routeModel({
		explicit: params.model,
		preferred: profile ? profile.model : SUBAGENT_DEFAULT_TIER,
		available,
		parent: ctx.model,
		catalog: currentCatalog(),
		refused: (provider, id, proven, cost) => providerHealth.refused(provider, id, proven, cost),
		thinking: subagentThinking(),
		configured: configuredSubagentModels(),
		// A purpose prefers a model the user's subscription pays for; a background child skips a plan that forbids unattended use.
		billing: registryBilling(ctx.modelRegistry, params.background === true),
	});
	if ("error" in routed) throw new Error(routed.error);
	const route = routed.model ? { ...routed, model: supportedThinking(routed.model, available) } : routed;
	// A preference that fell back, or a default purpose with no candidate, runs the child on this session's model.
	const routedProvider = route.model ? route.model.slice(0, route.model.indexOf("/")) : ctx.model?.provider;
	if (routedProvider && sessionOnlyProvider(ctx.modelRegistry, routedProvider)) throw sessionOnlyError(routedProvider);
	const parent = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	// The default purpose names its route only when it chose a model other than this session's.
	const onParent = !route.model || route.model === parent || route.model.startsWith(`${parent}:`);
	const defaulted = !params.model && !profile && !onParent;
	// A model that cannot run at the asked level (glm-5.3-flash has no `off`) runs at the nearest one it supports.
	const clamped = route.model ? clampNote(routed.model, route.model) : "";
	const asked = params.model
		? `model argument: ${params.model}`
		: profile?.model && !route.fallback
			? `profile ${profile.name}: ${profile.model}`
			: defaulted
				? `default: ${SUBAGENT_DEFAULT_TIER}`
				: undefined;
	// A purpose says whether the user's setting chose its model or the automatic choice did, and why a set one was skipped.
	const source = route.setting ? `setting ${route.setting}` : route.skipped ? `automatic; ${route.skipped}` : "";
	const via = [asked, source, clamped].filter(Boolean).join("; ") || undefined;
	return { profile, route: { ...route, ...(via ? { via } : {}), ...(parent ? { parent } : {}) } };
}

/**
 * Names the run and claims it, in the slot the caller already took (`runs.slots`); `release` gives the slot back. A
 * queued background run is claimed before it has one: `slot.held` says whether there is one to give.
 * `avoid`: names to skip besides the team's, those of existing scratch folders and those of existing session folders
 *, e.g. existing refs of isolated runs. A
 * resumed run keeps its own name, and with it its saved conversation; a new one never gets a name with a saved one.
 */
export function claimRun(
	runs: AgentRuns,
	plan: RunPlan,
	params: Pick<AgentParams, "goal" | "name" | "sessionId" | "background" | "isolate" | "hooks" | "cache">,
	ctx: Pick<ExtensionContext, "cwd" | "sessionManager"> & Partial<Pick<ExtensionContext, "model" | "modelRegistry">>,
	avoid: Iterable<string> = [],
	resumed?: Run["identity"],
	slot: { held: boolean } = { held: true },
): Run {
	const { cwd } = ctx;
	const { profile, route } = plan;
	// Joining gives the child its parent's address for sendMessage; without a usable team database it still runs, alone.
	let parentId: string | undefined;
	let teamNote = "";
	try {
		parentId = runs.team.join().id;
	} catch (error) {
		teamNote = `\n\n(Started without the team: ${errorMessage(error)}. It cannot message you or its teammates.)`;
	}
	if (params.name && runs.running.has(params.name)) throw new Error(`${params.name} is running.`);
	// A resumed run continues as the same agent: name, role, goal, scratch folder and permission.
	const identity: Run["identity"] = resumed ?? {
		id:
			params.name ??
			runs.team.newName([...runs.running.keys(), ...scratchNames(cwd), ...sessionFolderNames(), ...avoid]),
		role: profile?.name ?? GENERAL_PROFILE,
		sessionId: params.sessionId ?? randomUUID(),
		goal: params.goal,
		parentSession: ctx.sessionManager.getSessionId(),
		parentTranscript: ctx.sessionManager.getSessionFile(),
		...(parentId ? { parentId } : {}),
	};
	// A profile's `hooks: false` forbids them; else the task's choice, the mode this child started with, the profile's.
	identity.hooks = childHookMode(profile?.hooks, params.hooks, resumed?.hooks);
	// Resolved for the model the child runs on: its provider and model cache settings apply, not the parent's.
	const childModel = ctx.modelRegistry
		? (routedModel(route.model, ctx.modelRegistry.getAvailable()) ?? ctx.model)
		: undefined;
	if (childModel && ctx.modelRegistry) {
		const policy = ctx.modelRegistry.getCachePolicy(childModel, [
			{ source: "parent settings", values: runs.api.getSettings() },
		]);
		// The task's tier for its history, else the default for its shape; a retention the user configured wins over both.
		const choice =
			params.cache ??
			defaultTaskCache({
				lingers:
					params.background === true &&
					params.isolate !== true &&
					reachableSeconds(undefined, process.env, profile?.linger) > 0,
				resumed: resumed !== undefined || params.name !== undefined,
				thinking: routeThinking(route.model) ?? route.thinking,
				requests: maxRequests(profile),
			});
		identity.cachePreferences = childCachePreferences(policy, choice);
		// How long the entry the child writes lives: the stagger keeps its prefix warm for that long.
		identity.cacheTtlMs = getPromptCacheTtlMs(childModel, identity.cachePreferences);
	}
	const scratch = agentScratch(cwd, identity.id);
	if (scratch) identity.scratch = scratch;
	// Taken last: a throw above leaves no name behind (the caller gives the slot back when nothing is claimed).
	runs.running.set(identity.id, undefined);
	const release = () => {
		if (!runs.running.delete(identity.id)) return;
		if (slot.held) runs.slots.give();
		const kept = scratch && !dropEmptyScratch(scratch);
		runs.team.rememberFinished(
			identity.id,
			`its report (or failure) reached you or arrives when your turn ends${kept ? ` (files it handed back, and its full report when cut, are in ${shortPath(scratch)})` : ""}.`,
		);
	};
	return { identity, profile, route, teamNote, release };
}
