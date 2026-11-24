/**
 * Hooks the session installs on its Agent once, at construction: input preparation, request
 * projection and virtual-model routing, next-turn prompt refresh, and the request projections of
 * hidden declarations and forced system prompts. Each hook wraps the one the Agent already had.
 */

import { randomUUID } from "node:crypto";
import type { AgentContext, AgentMessage, ThinkingLevel } from "@octocodeai/octocode-agent-core";
import { assertImageRequestContext } from "@octocodeai/octocode-ai/utils/image-input";
import type { Model, TextContent } from "@octocodeai/octocode-ai/compat";
import {
	estimateLeafContextTokens,
	estimateUndeclaredToolTokens,
	exceedsContextWindow,
	shouldStopForCompaction,
} from "../compaction/index.ts";
import { withoutHiddenDeclarations } from "../hidden-declarations.ts";
import { projectForcedSystemPrompt, type RequestSystemOverride } from "../forced-system-prompt.ts";
import { convertToLlm } from "../messages.ts";
import type { ReadonlySessionProjection } from "../session-manager.ts";
import { normalizeBuildSystemPromptOptions } from "../system-prompt.ts";
import {
	getVirtualModelState,
	isVirtualModel,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelStateData,
} from "../virtual-models.ts";
import { compactedSinceLastResponse, compactionCancelledForRequest } from "./compaction-check.ts";
import type { SessionInternals } from "./host.ts";
import type { SessionInputQueue } from "./input-queue.ts";
import type { SessionToolLoadout } from "./tool-loadout.ts";

export interface AgentHooksHost extends Pick<SessionInternals, "session" | "run" | "emit"> {
	readonly inputs: SessionInputQueue;
	readonly tools: SessionToolLoadout;
	expandMentionSkills(text: string, expandedPaths: Set<string>): TextContent[];
	runAutoCompaction(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		targetModel?: Model<any>,
		targetThinking?: ThinkingLevel,
	): Promise<boolean>;
	/** Requests the coming compaction's summary ahead when the context nears the threshold (`compaction-prewarm.ts`). */
	prewarmCompaction(tokens: number, model: Model<any>, thinking?: ThinkingLevel): void;
}

/**
 * Estimated tokens of a request to `model` built from `projection`, counting the tools it will declare that it does
 * not yet, at the model's tokenizer ratio.
 */
function requestTokens(host: AgentHooksHost, projection: ReadonlySessionProjection, model: Model<any>): number {
	const { session } = host;
	return (
		estimateLeafContextTokens(projection, session.sessionManager, model).tokens +
		estimateUndeclaredToolTokens(projection.messages, session.agent.state.tools, host.tools.hiddenDeclarations(), model)
	);
}

/**
 * Throws when the compaction that ran for this request found nothing it keeps can fit, and the context is still larger
 * than `model`'s whole window: such a request can only be refused, so the run ends with what the user can do instead.
 */
function assertFitsWindow(host: AgentHooksHost, model: Model<any>): void {
	if (!host.run.windowUnfit || !(model.contextWindow > 0)) return;
	const tokens = requestTokens(host, host.session.sessionManager.readSessionProjection(), model);
	const limit = Math.min(model.contextWindow, model.inputLimits?.maxInputTokens ?? Infinity);
	if (tokens <= limit) return;
	throw new Error(
		`The context is about ${tokens.toLocaleString("en-US")} tokens, more than ${model.id}'s ` +
			`${limit.toLocaleString("en-US")}-token ${limit < model.contextWindow ? "input limit" : "window"}, and compaction could not make it fit: ` +
			host.run.windowUnfit,
	);
}

/**
 * Whether the request built from `projection`, the current session projection, compacts first: past the compaction
 * threshold of `model` at `thinking` (default: the session's routed or selected level). At most one compaction per
 * request: after one since the latest response, only a request that would not fit the window at all compacts again.
 * One over the threshold but within the window is sent; the next request, or overflow recovery, compacts. After the
 * user cancelled an automatic compaction for this request, none runs.
 */
function needsCompaction(
	host: AgentHooksHost,
	model: Model<any>,
	projection: ReadonlySessionProjection,
	thinking?: ThinkingLevel,
): boolean {
	if (model.contextWindow <= 0) return false;
	const { session } = host;
	if (compactionCancelledForRequest(host.run, session.sessionManager)) return false;
	const tokens = requestTokens(host, projection, model);
	const settings = session.settingsManager.getCompactionSettings(
		model,
		thinking ?? session.routedModel?.thinkingLevel ?? session.thinkingLevel,
	);
	return compactedSinceLastResponse(projection, session.sessionManager)
		? exceedsContextWindow(tokens, model.contextWindow, settings, model.maxTokens)
		: shouldStopForCompaction(tokens, model.contextWindow, settings);
}

export function installAgentInputPreparation(host: AgentHooksHost): void {
	const { session, run, inputs } = host;
	const agent = session.agent;
	const previousInputSelected = agent.onInputSelected;
	agent.onInputSelected = (batch) => {
		inputs.deliverSelected(batch.messages);
		if (batch.kind === "followUp" && batch.messages.length > 0) run.logicalTurnId = randomUUID();
		previousInputSelected?.(batch);
	};
	agent.prepareInput = async (batch, signal, commit) => {
		const gated = session.featureHost.hasHandlers("user_input");
		let blocked = false;
		let accepted = false;
		const stop = () => {
			run.inputTerminated = true;
			return { messages: [], stop: true };
		};
		for (const message of batch.messages) {
			const input = inputs.getUserInput(message);
			if (!input) {
				await commit([message]);
				continue;
			}
			inputs.deleteUserInput(message);
			if (gated && signal?.aborted) return stop();
			const verdict = gated
				? await session.featureHost.emitUserInput({
						type: "user_input",
						text: input.text,
						images: input.images,
						source: input.source,
						streamingBehavior: batch.kind === "initial" ? undefined : batch.kind,
					})
				: {};
			if (gated && signal?.aborted) return stop();
			const contexts: AgentMessage[] = (verdict.additionalContext ?? []).map((content) => ({
				role: "custom",
				customType: "user-input-context",
				content,
				display: false,
				timestamp: Date.now(),
			}));
			if (verdict.block) {
				blocked = true;
				await commit(contexts, signal);
			} else {
				accepted = true;
				if (!signal?.aborted && input.expandedPaths && message.role === "user") {
					const fragments = host.expandMentionSkills(input.text, input.expandedPaths);
					if (fragments.length)
						message.content =
							typeof message.content === "string"
								? [{ type: "text", text: message.content }, ...fragments]
								: [...message.content, ...fragments];
				}
				await commit([message, ...contexts], gated ? signal : undefined);
			}
			if (gated && signal?.aborted) return stop();
		}
		return blocked && !accepted ? stop() : { messages: [] };
	};
}

export function installAgentContextPreparation(host: AgentHooksHost): void {
	const attempted = new WeakSet<AgentContext>();
	installAgentNextTurnRefresh(host, attempted);
	installAgentRequestProjection(host, attempted);
}

function installAgentRequestProjection(host: AgentHooksHost, attempted: WeakSet<AgentContext>): void {
	const { session, run } = host;
	const agent = session.agent;
	const previousPrepareRequest = agent.prepareRequest;
	agent.prepareRequest = async (request, signal) => {
		const failed = run.failedResponse;
		run.failedResponse = undefined;
		const prepare = async () => {
			const view = session.sessionManager.readSessionProjection();
			// The request owns its messages, and the estimates after the hooks below (which may append) need this read's
			// entries: both arrays are copied, the entry records the session never changes are not.
			const projection = { ...view, entries: view.entries.slice(), messages: view.messages.slice() };
			const canonicalContext = {
				...request.context,
				messages: projection.messages,
				// Messages declare the provider-visible loadout; context.tools keeps executable implementations.
				tools: agent.state.tools.slice(),
			};
			const previous = await previousPrepareRequest?.(
				{
					...request,
					context: canonicalContext,
					model: agent.state.model,
					thinkingLevel: agent.state.thinkingLevel,
				},
				signal,
			);
			return {
				previous,
				context: previous?.context ?? canonicalContext,
				projection,
			};
		};
		const prepared = await prepare();
		const { projection } = prepared;
		let { previous, context } = prepared;
		const model = previous?.model ?? agent.state.model;
		const thinkingLevel = previous?.thinkingLevel ?? agent.state.thinkingLevel;
		if (!isVirtualModel(model)) {
			let thresholdAttempted = attempted.has(request.context);
			let refreshInput = previous?.refreshInput;
			// Input gates and turn_prompt updates have committed. A late update can cross the threshold,
			// but a declined or insufficient early compaction must not be retried in the same request.
			if (!thresholdAttempted && needsCompaction(host, model, projection, thinkingLevel)) {
				thresholdAttempted = true;
				refreshInput = true;
				await host.runAutoCompaction("threshold", false, model, thinkingLevel);
				// Compaction handlers can queue input that belongs in this same request.
				host.inputs.flushDuringRun(host.run.outcome);
				({ previous, context } = await prepare());
				assertFitsWindow(host, model);
			}
			if (thresholdAttempted) attempted.add(context);
			else host.prewarmCompaction(requestTokens(host, projection, model), model, thinkingLevel);
			assertImageRequestContext(model, convertToLlm(context.messages));
			return { ...previous, context, model, thinkingLevel, refreshInput };
		}

		// The selection stays in agent state; only this request uses the routed model. A routing
		// failure rejects, which ends the run with an error response. Only messages the user wrote
		// start a turn; feature messages can follow them, e.g. from before_agent_start.
		const lastResponse = context.messages.findLastIndex((message) => message.role === "assistant");
		const userTurn = context.messages.slice(lastResponse + 1).some((message) => message.role === "user");
		const state = getVirtualModelState(session.sessionManager.getBranch(), model.provider, model.id);
		const route = await session.modelRuntime.resolveModel(model, convertToLlm(context.messages), {
			reason: failed ? "retry" : userTurn ? "user" : "continuation",
			thinkingLevel,
			signal,
			failed,
			state,
		});
		if (route.state !== undefined && route.state !== state) {
			const data: VirtualModelStateData = {
				provider: model.provider,
				modelId: model.id,
				state: route.state,
			};
			const entry = session.sessionManager.getEntry(
				session.sessionManager.appendCustomEntry(VIRTUAL_MODEL_STATE_ENTRY, data),
			);
			if (entry) host.emit({ type: "entry_appended", entry });
		}
		// The route stands: the router already decided this request. The state entry does not change
		// the projection.
		// The threshold is sized for this request's route: its model and thinking level.
		const routeThinking = route.thinkingLevel ?? thinkingLevel;
		// One attempt per request, as for a model that is not virtual: a declined or futile one is not retried when the
		// request is prepared again.
		let thresholdAttempted = attempted.has(request.context);
		if (!thresholdAttempted && needsCompaction(host, route.model, projection, routeThinking)) {
			thresholdAttempted = true;
			await host.runAutoCompaction("threshold", false, route.model, routeThinking);
			host.inputs.flushDuringRun(host.run.outcome);
			// The compaction changed the projection, so the request is prepared again: a `prepareRequest` hook this session
			// wraps runs twice for this request and must give the same answer for the same input.
			({ previous, context } = await prepare());
			assertFitsWindow(host, route.model);
		}
		if (thresholdAttempted) attempted.add(context);
		else host.prewarmCompaction(requestTokens(host, projection, route.model), route.model, routeThinking);
		assertImageRequestContext(route.model, convertToLlm(context.messages));
		return {
			...previous,
			context,
			model: route.model,
			thinkingLevel: route.thinkingLevel,
		};
	};
}

function installAgentNextTurnRefresh(host: AgentHooksHost, attempted: WeakSet<AgentContext>): void {
	const { session, tools } = host;
	const agent = session.agent;
	const previousPrepareNextTurnWithContext = agent.prepareNextTurnWithContext;
	agent.prepareNextTurnWithContext = async (turn, signal) => {
		let projection = session.sessionManager.readSessionProjection();
		const model = session.model;
		const compactEarly = model && !isVirtualModel(model) && needsCompaction(host, model, projection);
		if (compactEarly) {
			await host.runAutoCompaction("threshold", false);
			host.inputs.flushDuringRun(host.run.outcome);
			projection = session.sessionManager.readSessionProjection();
		}
		// The turn's context owns its messages: the kept ones grow with the session.
		const context = { ...turn.context, messages: projection.messages.slice() };
		const previousSnapshot = await previousPrepareNextTurnWithContext?.({ ...turn, context }, signal);
		const nextContext = previousSnapshot?.context ?? context;
		const runOptions = tools.runSystemPromptOptions ?? tools.baseSystemPromptOptions;
		const options = normalizeBuildSystemPromptOptions({
			...runOptions,
			selectedTools: session.getActiveToolNames(),
			toolSnippets: {
				...tools.baseSystemPromptOptions.toolSnippets,
				...runOptions.toolSnippets,
			},
			toolGuidelines: {
				...tools.baseSystemPromptOptions.toolGuidelines,
				...runOptions.toolGuidelines,
			},
		});
		// Producers whose sections change during a run (MCP blocks and status) update them for this turn.
		await session.featureHost.emit({ type: "turn_prompt", systemPromptOptions: options });
		const updateMessage = tools.preparePromptAndToolLoadout(options, nextContext.messages);
		// Keep session.systemPrompt and ctx.getSystemPrompt() in step with what the provider sees.
		tools.runSystemPromptOptions = options;

		const refreshedContext = { ...nextContext, tools: agent.state.tools.slice() };
		if (compactEarly) attempted.add(refreshedContext);
		return {
			...previousSnapshot,
			context: refreshedContext,
			messages: updateMessage ? [...(previousSnapshot?.messages ?? []), updateMessage] : previousSnapshot?.messages,
			model: agent.state.model,
			thinkingLevel: agent.state.thinkingLevel,
		};
	};
}

/**
 * Remove the declarations that `prepareLoadout` hooks hide from every request. The whole
 * transcript is filtered with the current set, so the projected declarations stay consistent
 * across requests and only change when the loadout does.
 */
export function installHiddenDeclarationsProjection(host: AgentHooksHost): void {
	const agent = host.session.agent;
	const previousTransformContext = agent.transformContext;
	agent.transformContext = async (messages, signal) => {
		const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
		return withoutHiddenDeclarations(transformed, host.tools.hiddenDeclarations(transformed));
	};
}

/**
 * Send a forced prompt as the provider's leading system prompt without recording it.
 *
 * A `before_agent_start` handler that returns `systemPrompt` needs that exact text at the
 * head of the request; a mid-conversation system message would leave the original prompt
 * in place. The forced text is a rendering of the current prompt, so the transcript keeps
 * its structured sections and the request is projected instead: the system messages
 * collapse into one head holding the forced text and the current tools. Runs after the
 * `context` feature handlers.
 */
export function installForcedPromptProjection(host: AgentHooksHost): void {
	const agent = host.session.agent;
	let pending: RequestSystemOverride | undefined;
	agent.subscribe((event) => {
		if (event.type !== "message_end" || event.message.role !== "assistant") return;
		if (pending && event.message.stopReason !== "aborted" && event.message.stopReason !== "error")
			host.tools.rememberRequestSystemOverride(pending);
		pending = undefined;
	});
	const previousTransformContext = agent.transformContext;
	agent.transformContext = async (messages, signal) => {
		const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
		const forced = host.tools.runSystemPromptOptions?.forceSystemPrompt;
		const session = host.session.sessionManager;
		pending = { sessionId: session.getSessionId(), leafId: session.getLeafId(), forced };
		return projectForcedSystemPrompt(transformed, forced);
	};
}
