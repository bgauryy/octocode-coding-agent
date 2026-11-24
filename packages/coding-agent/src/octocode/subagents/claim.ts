import { resolveLimits } from "../../core/limits.ts";
import { configuredSubagentModels } from "./configured-models.ts";
import type { AgentEnd } from "../team/panel/state.ts";
import { randomUUID } from "node:crypto";
import type { Api, Model } from "@octocodeai/octocode-ai";
import { MAX_SUBAGENTS_ENV } from "./concurrency.ts";
export { machineSubagents, maxSubagents, MAX_SUBAGENTS_ENV } from "./concurrency.ts";
import type { Slots } from "./slots.ts";
export { Slots } from "./slots.ts";
import { modelAvailableToChild, modelEnabled, sessionOnlyProvider } from "./task-model-visibility.ts";
import type { FeatureSetup, FeatureContext } from "../../core/features/index.ts";
import type { ReportStatus } from "../native/prompts/report.ts";
import { envInt } from "@octocodeai/octocode-common/env";
import { shortPath } from "../../utils/display-path.ts";
import { sessionFolderNames } from "../shared/home.ts";
import { deriveAgentRoute, type AgentRoute } from "@octocodeai/octocode-contracts/config";
import { agentScratch, dropEmptyScratch, type ReadReports, scratchNames } from "./handoff/scratch.ts";
import { type CacheChoice, childCachePreferences, defaultTaskCache, type Identity } from "./process/env.ts";
import { childHookMode, type HookMode } from "../shared/hook-mode.ts";
import { routeThinking } from "../render/route-thinking.ts";
import { maxRequests, taskRequestLimit } from "./budget.ts";
import type { Team } from "../team/session.ts";
import { sessionHeap } from "../shared/session-heap.ts";
import { joinTeamNow, type RunTeamJoin } from "./team-join.ts";
import { currentCatalog } from "../../core/model-catalog/index-store.ts";
import type { Background } from "./command.ts";
import { type ReportQueue } from "./handoff.ts";
import {
	clampNote,
	type ModelRoute,
	registryBilling,
	routedModel,
	routeModel,
	routeSource,
	SUBAGENT_DEFAULT_TIER,
	subagentThinking,
	supportedThinking,
} from "./model.ts";
import { providerHealth } from "./provider-health.ts";
import { getPromptCacheTtlMs } from "../../core/cache-warmer/economics.ts";
import { staggerPays } from "./stagger.ts";
import type { ReportGroups } from "./report-groups.ts";
import { type AgentProfile, GENERAL_PROFILE, profileSelectsBrowser, profileTools } from "./profiles.ts";
import type { RunDetails } from "./run-types.ts";
import type { ChainQueue } from "./chain.ts";
import type { GraphWake } from "./graph-wake.ts";
import type { HandedItems } from "./handed-items.ts";

/** Starting a subagent: who it is (name, role, goal), its slot under the limit, and the task text it receives. */

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

/** State of one agent tool registration; a replaced session starts clean. */
export interface AgentRuns {
	api: FeatureSetup;
	team: Team;
	background: Background;
	/** Foreground runs, so `/agents kill` can stop one without aborting the whole turn. */
	foreground: Background;
	/** What each task running now has spent so far (`spawn-limits.ts`). */
	live: Map<string, Pick<RunDetails, "cost" | "contextTokens" | "contextWindow">>;
	reports: ReportQueue;
	/** The children each parent step started, whose reports wait for each other (`report-groups.ts`). */
	groups: ReportGroups;
	read: ReadReports;
	/** Subagents running now (foreground and background), by name. */
	running: Map<string, undefined>; // The ids of the running subagents (a map because the team session reads it as one).
	/** The backlog item each child was started for (`agent` `item`), by name; an entry of an ended child is dropped when read (`idle-items.ts`). */
	items: Map<string, string>;
	/** The items calls are starting children for, by item, with the call id: held from the first check to the claim (`second-child.ts`). */
	starting?: Map<string, string>;
	/** The items handed to each running child after its start (`hand-item.ts`); taken back when its run ends. */
	handed?: HandedItems;
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
	/** The children waiting for prerequisites (`subagents.queuedStarts`), and the gate that releases them. */
	chain?: ChainQueue;
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
	/** Desktop apps the task may control (`DESKTOP_APPS_ENV`). */
	apps?: readonly string[];
	background?: boolean;
	isolate?: boolean;
	/** The task's hook mode, or the one an earlier run of a resumed child was started with. */
	hooks?: HookMode;
	/** The task's cache tier; absent: `defaultTaskCache`. */
	cache?: CacheChoice;
	/** The task's soft request limit, or the one an earlier run of a resumed child was started with. */
	maxRequests?: number;
}

/** A claimed subagent run: who it is, who started it, where it hands files back, and how it gives its slot back. */
export interface Run {
	identity: Identity & { role: string; goal: string };
	profile: AgentProfile | undefined;
	/** The model it runs on (the parent's when nothing else routes); `fallback` is the profile's unavailable preference. */
	route: RunRoute;
	/** The model the run resolves to among the available ones (the parent's when nothing else routes); absent without a registry. */
	model?: Model<Api>;
	/** How the model's provider is billed (`deriveAgentRoute`); absent when the registry could not say. */
	agentRoute?: AgentRoute;
	/** Why the run starts without the team (its database is unusable), for the result. */
	teamNote: string;
	release: () => void;
}

/**
 * A run's model route, with what chose it for its failure report: `via` names the request that picked the model (the
 * `model` argument or the profile's preference; absent when it is this session's model), `parent` this session's model.
 */
export type RunRoute = Extract<ModelRoute, { model?: string }> & { via?: string; parent?: string };

function sessionOnlyError(provider: string): Error {
	return new Error(
		`${provider} is authenticated by this session's --api-key, which subagents do not receive. Connect it with /providers or choose a model from another provider.`,
	);
}

function childAccountError(model: { provider: string; id: string }): Error {
	return new Error(
		`The child account cannot use ${model.provider}/${model.id}. Choose a model available to tasks in the models tool.`,
	);
}

/** The models a child process can authenticate for; naming a session-only provider explicitly is refused with the reason. */
function childAvailable(registry: FeatureContext["modelRegistry"] | undefined, explicit: string | undefined) {
	if (!registry) return [];
	const provider = explicit?.includes("/") ? explicit.slice(0, explicit.indexOf("/")) : undefined;
	if (provider && sessionOnlyProvider(registry, provider)) throw sessionOnlyError(provider);
	const all = registry.getAvailable();
	const requested = routedModel(explicit, all);
	if (requested && !modelAvailableToChild(registry, requested)) throw childAccountError(requested);
	return all.filter((model) => modelAvailableToChild(registry, model));
}

/**
 * What a call asks for, checked before anything waits, asks or starts: its profile, the model it routes to and, when
 * the task caps it, its soft request limit (`requests`).
 */
export type RunPlan = Pick<Run, "profile" | "route"> & { requests?: number };

/**
 * Checks the profile and routes the model; throws the refusal (unknown profile, unavailable model). `refused` holds why
 * each profile file was refused when the profiles loaded, by file name: an unknown name that is one of them says why.
 * `limits` is the session's `limits` settings: its request budget for the child's model applies to a task that names
 * none and whose profile has none.
 */
export function planRun(
	profiles: Map<string, AgentProfile>,
	params: Pick<AgentParams, "profile" | "model" | "headless" | "apps" | "background" | "maxRequests">,
	ctx: Pick<FeatureContext, "modelRegistry" | "model">,
	refused: ReadonlyMap<string, string> = new Map(),
	limits?: unknown,
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
	if (params.apps !== undefined && !profile?.permissions?.includes("desktop.control"))
		throw new Error("apps requires a profile that controls the desktop; use profile: desktop.");
	// An explicit model is strict; a profile's is a preference that falls back to this session's model; a task with
	// neither a model nor a profile takes the default purpose.
	const available = childAvailable(ctx.modelRegistry, params.model);
	const excludedParent = ctx.model && !modelEnabled(ctx.modelRegistry, ctx.model);
	const unavailableParent = ctx.model && !modelAvailableToChild(ctx.modelRegistry, ctx.model) ? ctx.model : undefined;
	if (excludedParent && !available.length)
		throw new Error("This session’s model is hidden or disabled. Enable a task model in /providers.");
	const routed = routeModel({
		explicit: params.model,
		preferred: profile ? profile.model : SUBAGENT_DEFAULT_TIER,
		available,
		parent: excludedParent || unavailableParent ? undefined : ctx.model,
		catalog: currentCatalog(),
		refused: (provider, id, proven, cost) => providerHealth.refused(provider, id, proven, cost),
		thinking: subagentThinking(),
		configured: configuredSubagentModels(),
		// A purpose prefers a model the user's subscription pays for; a background child skips a plan that forbids unattended use.
		billing: registryBilling(ctx.modelRegistry, params.background === true),
	});
	if ("error" in routed) throw new Error(routed.error);
	if (unavailableParent && !routed.model) {
		if (sessionOnlyProvider(ctx.modelRegistry, unavailableParent.provider))
			throw sessionOnlyError(unavailableParent.provider);
		throw childAccountError(unavailableParent);
	}
	if (excludedParent && !routed.model)
		throw new Error("No enabled model can run this task. Choose a task model in /providers.");
	const route = routed.model ? { ...routed, model: supportedThinking(routed.model, available) } : routed;
	const parent = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
	// `limits.subagent.maxRequests` for the model the child runs on (its `:level` suffix is no part of the key).
	const childKey = route.model ? route.model.replace(/:[^/:]*$/, "") : parent;
	const configured = resolveLimits(limits, childKey).subagent.maxRequests;
	const requests =
		params.maxRequests === undefined
			? profile?.maxRequests === undefined
				? configured
				: undefined
			: taskRequestLimit(profile, params.maxRequests, process.env, configured);
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
	const source = routeSource(route);
	const via = [asked, source, clamped].filter(Boolean).join("; ") || undefined;
	return {
		profile,
		route: { ...route, ...(via ? { via } : {}), ...(parent ? { parent } : {}) },
		...(requests !== undefined ? { requests } : {}),
	};
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
	params: Pick<AgentParams, "goal" | "name" | "sessionId" | "background" | "isolate" | "hooks" | "cache" | "apps">,
	ctx: Pick<FeatureContext, "cwd" | "sessionManager"> & Partial<Pick<FeatureContext, "model" | "modelRegistry">>,
	avoid: Iterable<string> = [],
	resumed?: Run["identity"],
	slot: { held: boolean } = { held: true },
	joined: RunTeamJoin = joinTeamNow(runs.team),
): Run {
	const { cwd } = ctx;
	const { profile, route } = plan;
	// Joining gives the child its parent's address for sendMessage; without a usable team database it still runs, alone.
	const { parentId, note: teamNote } = joined;
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
	// The handles the parent holds now: the child may cite or resolve them, read-only (`ParentHeap`).
	identity.heapHandles = sessionHeap(ctx.sessionManager)?.index.entries();
	identity.hooks = childHookMode(profile?.hooks, params.hooks, resumed?.hooks);
	if (params.apps?.length) identity.desktopApps = params.apps;
	if (plan.requests !== undefined) identity.maxRequests = plan.requests;
	// Resolved for the model the child runs on: its provider and model cache settings apply, not the parent's.
	const childModel = ctx.modelRegistry
		? (routedModel(route.model, ctx.modelRegistry.getAvailable()) ?? ctx.model)
		: undefined;
	if (childModel && ctx.modelRegistry) {
		const policy = ctx.modelRegistry.getCachePolicy(childModel, [
			{ source: "parent settings", values: runs.api.settings.get() },
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
				requests: plan.requests ?? maxRequests(profile),
			});
		identity.cachePreferences = childCachePreferences(policy, choice);
		// How long the entry the child writes lives: the stagger keeps its prefix warm for that long.
		identity.cacheTtlMs = getPromptCacheTtlMs(childModel, identity.cachePreferences);
		// Whether its siblings save by waiting for its cache entry (`stagger.ts`).
		identity.staggers = staggerPays(childModel, identity.cachePreferences);
	}
	const scratch = agentScratch(cwd, identity.id);
	if (scratch) identity.scratch = scratch;
	// Taken last: a throw above leaves no name behind (the caller gives the slot back when nothing is claimed).
	runs.running.set(identity.id, undefined);
	// A queued run has no progress to measure and shows as queued until it starts (`team/session/approvals.ts`).
	if (!slot.held) runs.team.approvals.noteQueued(identity.id);
	// A resumed run still works its item: the link is dropped once it is not running (`idle-items.ts`).
	if (identity.item) runs.items.set(identity.id, identity.item);
	const release = () => {
		if (!runs.running.delete(identity.id)) return;
		runs.handed?.end(identity.id);
		runs.team.approvals.noteStarted(identity.id);
		if (slot.held) runs.slots.give();
		const kept = scratch && !dropEmptyScratch(scratch);
		runs.team.rememberFinished(
			identity.id,
			`its report (or failure) reached you or arrives when your turn ends${kept ? ` (files it handed back, and its full report when cut, are in ${shortPath(scratch)})` : ""}.`,
		);
	};
	const agentRoute =
		childModel && ctx.modelRegistry?.billedBySubscription
			? deriveAgentRoute({ subscription: ctx.modelRegistry.billedBySubscription(childModel.provider, "child") })
			: undefined;
	return {
		identity,
		profile,
		route,
		...(childModel ? { model: childModel } : {}),
		...(agentRoute ? { agentRoute } : {}),
		teamNote,
		release,
	};
}
