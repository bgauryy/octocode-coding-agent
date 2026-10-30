import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import { contentText, normalizeContext } from "@octocodeai/octocode-ai";
import { streamSimple } from "@octocodeai/octocode-ai/compat";
import type { AgentSession } from "../agent-session.ts";
import { completeSummarization, serializeConversation } from "../compaction/index.ts";
import { CHARS_PER_TOKEN } from "../compaction/tokens.ts";
import { convertToLlm } from "../messages.ts";
import { createSessionUsageRecorder } from "../usage-totals.ts";
import { getSummarizationRequestAuth } from "./request-auth.ts";
import { buildSideQuestionPrompt, SIDE_QUESTION_SYSTEM_PROMPT } from "./side-question-prompt.ts";

export interface SideQuestionExchange {
	question: string;
	answer: string;
}
export interface SideQuestionState {
	exchanges: readonly SideQuestionExchange[];
	question?: string;
	error?: string;
	running: boolean;
}

/** A detached, tool-free request. Only usage receipts enter session persistence. */
export class SideQuestions {
	private exchanges: SideQuestionExchange[] = [];
	private controller?: AbortController;
	private generation = 0;
	private question?: string;
	private error?: string;
	private readonly listeners = new Set<() => void>();
	private readonly session: AgentSession;
	constructor(session: AgentSession) {
		this.session = session;
	}
	snapshot(): SideQuestionState {
		return {
			exchanges: this.exchanges.map((item) => ({ ...item })),
			question: this.question,
			error: this.error,
			running: Boolean(this.controller),
		};
	}
	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	private changed(): void {
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				/* A disposed overlay cannot interrupt the session. */
			}
		}
	}
	cancel(): void {
		this.controller?.abort();
	}
	clear(): void {
		this.generation++;
		this.controller?.abort();
		this.controller = undefined;
		this.exchanges = [];
		this.question = undefined;
		this.error = undefined;
		this.changed();
	}
	async ask(question: string): Promise<string> {
		if (this.controller) throw new Error("A side question is already running. Cancel it before asking another.");
		if (this.session.isCompacting) throw new Error("Wait for compaction to finish before asking a side question.");
		if (!question.trim() || question.length > 8000) throw new Error("Side questions require 1–8000 characters.");
		const selected = this.session.model;
		if (!selected) throw new Error("Select a model before asking a side question.");
		const messages = completedMessages(this.session.sessionManager.buildSessionProjection().messages);
		const generation = this.generation;
		const controller = new AbortController();
		const record = createSessionUsageRecorder(this.session.sessionManager, "side_question");
		this.controller = controller;
		this.question = question;
		this.error = undefined;
		const streamFn = this.session.agent.streamFunction ?? streamSimple;
		const thinkingLevel = this.session.thinkingLevel;
		const sessionId = `${this.session.sessionId}:side:${randomUUID()}`;
		this.changed();
		try {
			const request = await getSummarizationRequestAuth(
				{ modelRuntime: this.session.modelRuntime, agent: this.session.agent, messages, thinkingLevel },
				selected,
				controller.signal,
			);
			controller.signal.throwIfAborted();
			const maxTokens = Math.min(4096, request.model.maxTokens || 4096, Math.floor(request.model.contextWindow / 4));
			const budget =
				Math.floor((request.model.contextWindow - maxTokens) * CHARS_PER_TOKEN * 0.65) -
				SIDE_QUESTION_SYSTEM_PROMPT.length -
				256;
			const transcript = serializeConversation(convertToLlm(messages));
			const { prompt, history } = buildSideQuestionPrompt(question, transcript, this.exchanges, budget);
			const response = await completeSummarization(
				request.model,
				normalizeContext({
					systemPrompt: SIDE_QUESTION_SYSTEM_PROMPT,
					messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
					tools: [],
				}),
				{
					...request,
					signal: controller.signal,
					sessionId,
					maxTokens,
					reasoning: request.thinkingLevel === "off" ? undefined : request.thinkingLevel,
				},
				async (model, context, options) => {
					const stream = await streamFn(model, context, options);
					const result = stream.result.bind(stream);
					stream.result = async () => {
						const message = await result();
						record(message);
						return message;
					};
					return stream;
				},
				this.session.settingsManager.getRetrySettings(),
			);
			controller.signal.throwIfAborted();
			if (generation !== this.generation) throw new Error("The side question's session changed.");
			if (response.stopReason === "error" || response.stopReason === "aborted")
				throw new Error(response.errorMessage || "Side question cancelled.");
			if (response.content.some((part) => part.type === "toolCall"))
				throw new Error("The side answer attempted a tool call. Nothing was executed.");
			const answer =
				contentText(response.content).trim() +
				(response.stopReason === "length" ? "\n\n[Answer truncated at the output limit.]" : "");
			if (!answer) throw new Error("The side answer was empty.");
			this.exchanges = [...history, { question, answer }].slice(-20);
			return answer;
		} catch (error) {
			if (generation === this.generation)
				this.error = controller.signal.aborted
					? "Side question cancelled."
					: error instanceof Error
						? error.message
						: String(error);
			// An abort surfaces as provider-specific text; callers show the message the state holds.
			throw controller.signal.aborted ? new Error("Side question cancelled.") : error;
		} finally {
			if (generation === this.generation) {
				this.controller = undefined;
				this.changed();
			}
		}
	}
}

/** Persisted projection excludes streaming text; remove unfinished/failed tool exchanges too. */
export function completedMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	const results = new Set(messages.flatMap((message) => (message.role === "toolResult" ? [message.toolCallId] : [])));
	const calls = new Set<string>();
	return structuredClone(
		messages.flatMap((message): AgentMessage[] => {
			if (message.role === "assistant") {
				if (message.stopReason === "error" || message.stopReason === "aborted") return [];
				const content = message.content.filter((part) => part.type !== "toolCall" || results.has(part.id));
				for (const part of content) if (part.type === "toolCall") calls.add(part.id);
				return content.length ? [{ ...message, content }] : [];
			}
			if (message.role === "toolResult" && !calls.has(message.toolCallId)) return [];
			return message.role === "system" ? [] : [message];
		}),
	);
}

const services = new WeakMap<AgentSession, SideQuestions>();
export function sideQuestionsFor(session: AgentSession): SideQuestions {
	let service = services.get(session);
	if (!service) {
		service = new SideQuestions(session);
		services.set(session, service);
	}
	return service;
}
export function clearSideQuestions(session: AgentSession): void {
	services.get(session)?.clear();
}
