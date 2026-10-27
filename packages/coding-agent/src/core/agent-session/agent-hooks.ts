/**
 * Hooks the session installs on its Agent once, at construction: input preparation, request
 * projection and virtual-model routing, next-turn prompt refresh, and the request projections of
 * hidden declarations and forced system prompts. Each hook wraps the one the Agent already had.
 */

import { randomUUID } from "node:crypto";
import type {
	AgentContext,
	AgentMessage,
	PrepareNextTurnContext,
	ThinkingLevel,
} from "@octocodeai/octocode-agent-core";
import { getCurrentSystemMessage } from "@octocodeai/octocode-ai";
import { assertImageRequestContext } from "@octocodeai/octocode-ai/utils/image-input";
import type { Model, SystemMessage, TextContent } from "@octocodeai/octocode-ai/compat";
import { estimateProjectedContextTokens, estimateUndeclaredToolTokens, shouldCompact } from "../compaction/index.ts";
import { convertToLlm } from "../messages.ts";
import type { SessionProjection } from "../session-manager.ts";
import { normalizeBuildSystemPromptOptions } from "../system-prompt.ts";
import {
	getVirtualModelState,
	isVirtualModel,
	VIRTUAL_MODEL_STATE_ENTRY,
	type VirtualModelStateData,
} from "../virtual-models.ts";
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
}

/**
 * Whether `projection`, the current session projection, exceeds the compaction threshold of `model` at `thinking`
 * (default: the session's routed or selected level).
 */
function exceedsCompactionThreshold(
	host: AgentHooksHost,
	model: Model<any>,
	projection: SessionProjection,
	thinking?: ThinkingLevel,
): boolean {
	if (model.contextWindow <= 0) return false;
	const { session } = host;
	// The estimate also counts tools the transcript does not declare yet: this request will.
	const tokens =
		estimateProjectedContextTokens(projection, session.sessionManager.getBranch()).tokens +
		estimateUndeclaredToolTokens(projection.messages, session.agent.state.tools, host.tools.hiddenDeclarations);
	const settings = session.settingsManager.getCompactionSettings(
		model,
		thinking ?? session.routedModel?.thinkingLevel ?? session.thinkingLevel,
	);
	return shouldCompact(tokens, model.contextWindow, settings);
}

async function compactBeforeNextAssistantResponse(host: AgentHooksHost, context: AgentContext): Promise<AgentContext> {
	const { session } = host;
	const projection = session.sessionManager.buildSessionProjection();
	// A virtual selection is checked in prepareRequest, against the model the request is routed to.
	const model = session.model;
	if (!model || isVirtualModel(model) || !exceedsCompactionThreshold(host, model, projection)) {
		return { ...context, messages: projection.messages };
	}
	await host.runAutoCompaction("threshold", false);
	return {
		...context,
		messages: session.sessionManager.buildSessionProjection().messages,
	};
}

export function installAgentInputPreparation(host: AgentHooksHost): void {
	const { session, run, inputs } = host;
	const agent = session.agent;
	const previousInputSelected = agent.onInputSelected;
	agent.onInputSelected = (batch) => {
		for (const message of batch.messages) inputs.consumeQueuedUserMessage(message);
		if (batch.kind === "followUp" && batch.messages.length > 0) run.logicalTurnId = randomUUID();
		previousInputSelected?.(batch);
	};
	agent.prepareInput = async (batch, signal, commit) => {
		const gated = session.extensionRunner.hasHandlers("user_input");
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
				? await session.extensionRunner.emitUserInput({
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

export function installAgentRequestProjection(host: AgentHooksHost): void {
	const { session, run } = host;
	const agent = session.agent;
	const previousPrepareRequest = agent.prepareRequest;
	agent.prepareRequest = async (request, signal) => {
		const failed = run.failedResponse;
		run.failedResponse = undefined;
		const prepare = async () => {
			const projection = session.sessionManager.buildSessionProjection();
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
			assertImageRequestContext(model, convertToLlm(context.messages));
			return { ...previous, context, model, thinkingLevel };
		}

		// The selection stays in agent state; only this request uses the routed model. A routing
		// failure rejects, which ends the run with an error response. Only messages the user wrote
		// start a turn; extension messages can follow them, e.g. from before_agent_start.
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
		if (exceedsCompactionThreshold(host, route.model, projection, routeThinking)) {
			await host.runAutoCompaction("threshold", false, route.model, routeThinking);
			// The compaction changed the projection, so the request is prepared again: a `prepareRequest` hook this session
			// wraps runs twice for this request and must give the same answer for the same input.
			({ previous, context } = await prepare());
		}
		assertImageRequestContext(route.model, convertToLlm(context.messages));
		return {
			...previous,
			context,
			model: route.model,
			thinkingLevel: route.thinkingLevel,
		};
	};
}

export function installAgentNextTurnRefresh(host: AgentHooksHost): void {
	const { session, tools } = host;
	const agent = session.agent;
	const previousPrepareNextTurnWithContext =
		agent.prepareNextTurnWithContext ??
		(agent.prepareNextTurn
			? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await agent.prepareNextTurn?.(signal)
			: undefined);
	agent.prepareNextTurnWithContext = async (turn, signal) => {
		const context = await compactBeforeNextAssistantResponse(host, turn.context);
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
		const updateMessage = tools.preparePromptAndToolLoadout(options, nextContext.messages);
		// Keep session.systemPrompt and ctx.getSystemPrompt() in step with what the provider sees.
		tools.runSystemPromptOptions = options;

		return {
			...previousSnapshot,
			context: {
				...nextContext,
				tools: agent.state.tools.slice(),
			},
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
		const hidden = host.tools.hiddenDeclarations;
		if (hidden.size === 0) return transformed;
		return transformed.map((message) => {
			if (message.role !== "system" || (!message.toolsAdded && !message.toolsRemoved)) return message;
			const { toolsAdded, toolsRemoved, ...rest } = message;
			const added = toolsAdded?.filter((tool) => !hidden.has(tool.name)) ?? [];
			const removed = toolsRemoved?.filter((tool) => !hidden.has(tool.name)) ?? [];
			return {
				...rest,
				...(added.length > 0 ? { toolsAdded: added } : {}),
				...(removed.length > 0 ? { toolsRemoved: removed } : {}),
			};
		});
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
 * `context` extension handlers.
 */
export function installForcedPromptProjection(host: AgentHooksHost): void {
	const agent = host.session.agent;
	const previousTransformContext = agent.transformContext;
	agent.transformContext = async (messages, signal) => {
		const transformed = previousTransformContext ? await previousTransformContext(messages, signal) : messages;
		const forced = host.tools.runSystemPromptOptions?.forceSystemPrompt;
		if (forced === undefined) return transformed;
		const current = getCurrentSystemMessage(transformed);
		const head: SystemMessage = {
			role: "system",
			content: forced,
			...(current?.toolsAdded ? { toolsAdded: current.toolsAdded } : {}),
			timestamp: current?.timestamp ?? Date.now(),
		};
		return [head, ...transformed.filter((message) => message.role !== "system")];
	};
}
