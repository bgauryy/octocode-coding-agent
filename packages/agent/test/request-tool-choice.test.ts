import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type Model,
	type UserMessage,
} from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import { createAgentLoopConfig } from "../src/agent/loop-config.ts";
import { PendingMessageQueue } from "../src/agent/state.ts";
import type { AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const model: Model<"openai-responses"> = {
	id: "mock",
	name: "mock",
	api: "openai-responses",
	provider: "openai",
	baseUrl: "https://example.invalid",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 8192,
	maxTokens: 2048,
};
const reply = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
	role: "assistant",
	content,
	api: "openai-responses",
	provider: "openai",
	model: "mock",
	usage,
	stopReason,
	timestamp: Date.now(),
});
const toolCall = { type: "toolCall" as const, id: "c", name: "probe", arguments: {} };
const probe: AgentTool = {
	name: "probe",
	label: "probe",
	description: "probe",
	parameters: Type.Object({}),
	execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
};
const user: UserMessage = { role: "user", content: "go", timestamp: Date.now() };
const convertToLlm = (messages: AgentMessage[]) => messages as never;

describe("a request's tool choice", () => {
	it("applies to the one request that asked for it", async () => {
		let prepared = 0;
		const config: AgentLoopConfig = {
			model,
			convertToLlm,
			prepareRequest: () => (++prepared === 2 ? { toolChoice: "none" } : undefined),
		};
		const choices: unknown[] = [];
		await runAgentLoop(
			[user],
			{ messages: [], tools: [probe] },
			config,
			() => undefined,
			undefined,
			(_model, _context, options) => {
				choices.push(options?.toolChoice);
				const response = createAssistantMessageEventStream();
				const last = choices.length === 3;
				queueMicrotask(() =>
					response.push({
						type: "done",
						reason: last ? "stop" : "toolUse",
						message: last ? reply([{ type: "text", text: "done" }], "stop") : reply([toolCall], "toolUse"),
					}),
				);
				return response;
			},
		);
		expect(choices).toEqual([undefined, "none", undefined]);
	});

	it("is taken from the agent for its next request only", async () => {
		const host = {
			convertToLlm,
			transport: "sse" as const,
			toolExecution: "parallel" as const,
			nextToolChoice: "none" as const,
			signal: undefined,
		};
		const config = createAgentLoopConfig(
			host,
			{ model, thinkingLevel: "off" },
			new PendingMessageQueue("one-at-a-time"),
			new PendingMessageQueue("one-at-a-time"),
		);
		const request = { context: { messages: [], tools: [] }, model, thinkingLevel: "off" as const };
		expect(await config.prepareRequest?.(request)).toMatchObject({ toolChoice: "none" });
		expect(host.nextToolChoice).toBeUndefined();
		expect(await config.prepareRequest?.(request)).toBeUndefined();
	});

	it.each(["none", "required", { type: "function", name: "probe" }] as const)(
		"%j survives an input refresh with late steering, and the next request resets it",
		async (choice) => {
			const steering = new PendingMessageQueue("one-at-a-time");
			const host = {
				convertToLlm,
				transport: "sse" as const,
				toolExecution: "parallel" as const,
				nextToolChoice: choice as never,
				signal: undefined,
				// The first preparation asks for a refresh while steering has arrived since.
				prepareRequest: (() => {
					let calls = 0;
					return () => {
						if (++calls === 1) {
							steering.enqueue({ role: "user", content: "late", timestamp: Date.now() });
							return { refreshInput: true };
						}
						return undefined;
					};
				})(),
			};
			const config = createAgentLoopConfig(
				host,
				{ model, thinkingLevel: "off" },
				steering,
				new PendingMessageQueue("one-at-a-time"),
				{ skipInitialSteeringPoll: true },
			);
			const choices: unknown[] = [];
			await runAgentLoop(
				[user],
				{ messages: [], tools: [probe] },
				config,
				() => undefined,
				undefined,
				(_model, _context, options) => {
					choices.push(options?.toolChoice);
					const response = createAssistantMessageEventStream();
					const last = choices.length === 2;
					queueMicrotask(() =>
						response.push({
							type: "done",
							reason: last ? "stop" : "toolUse",
							message: last ? reply([{ type: "text", text: "done" }], "stop") : reply([toolCall], "toolUse"),
						}),
					);
					return response;
				},
			);
			expect(choices).toEqual([choice, undefined]);
		},
	);
});
