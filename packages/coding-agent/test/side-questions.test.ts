import { createAssistantMessageEventStream, fauxAssistantMessage, getCurrentTools } from "@octocodeai/octocode-ai";
import { afterEach, expect, it, vi } from "vitest";
import { sideQuestionsFor } from "../src/core/agent-session/side-questions.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

let harness: Harness;
afterEach(() => harness?.cleanup());

it("uses a separate tool-free request while the main turn continues and persists only usage", async () => {
	harness = await createHarness();
	const { session, sessionManager } = harness;
	let finishMain!: () => void;
	let mainStarted!: () => void;
	const started = new Promise<void>((resolve) => {
		mainStarted = resolve;
	});
	const requests: string[] = [];
	session.agent.streamFunction = (model, context, options) => {
		const stream = createAssistantMessageEventStream();
		const side = options?.sessionId?.includes(":side:");
		const finish = () => {
			const message = {
				...fauxAssistantMessage(side ? "private answer" : "main answer"),
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: {
					input: 10,
					output: 2,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 12,
					cost: { input: 0.1, output: 0.1, cacheRead: 0, cacheWrite: 0, total: 0.2 },
				},
			};
			stream.push({ type: "done", reason: "stop", message });
		};
		if (side) {
			expect(getCurrentTools(context.messages)).toEqual([]);
			requests.push(JSON.stringify(context));
			queueMicrotask(finish);
		} else {
			finishMain = finish;
			mainStarted();
		}
		return stream;
	};
	const main = session.prompt("main task");
	await started;
	const before = sessionManager.getEntries().filter((entry) => entry.type !== "usage");
	expect(await session.askSideQuestion("private question")).toBe("private answer");
	expect(session.isStreaming).toBe(true);
	expect(requests).toHaveLength(1);
	expect(sessionManager.getEntries().filter((entry) => entry.type !== "usage")).toEqual(before);
	expect(sessionManager.getEntries().filter((entry) => entry.type === "usage")).toMatchObject([
		{ kind: "side_question", usage: { totalTokens: 12 } },
	]);
	expect(JSON.stringify(sessionManager.getEntries())).not.toContain("private question");
	expect(JSON.stringify(sessionManager.getEntries())).not.toContain("private answer");
	finishMain();
	await main;
	expect(session.getSessionStats().tokens.output).toBe(4);
});

it("rejects concurrent requests, ignores late cleared output and never executes tool calls", async () => {
	harness = await createHarness();
	const { session } = harness;
	let finish!: () => void;
	let started!: () => void;
	const ready = new Promise<void>((resolve) => {
		started = resolve;
	});
	session.agent.streamFunction = (model) => {
		const stream = createAssistantMessageEventStream();
		finish = () =>
			stream.push({
				type: "done",
				reason: "stop",
				message: { ...fauxAssistantMessage("late"), api: model.api, provider: model.provider, model: model.id },
			});
		started();
		return stream;
	};
	const service = sideQuestionsFor(session);
	const pending = service.ask("first");
	await ready;
	await expect(service.ask("second")).rejects.toThrow("already running");
	service.clear();
	finish();
	await expect(pending).rejects.toThrow();
	expect(service.snapshot()).toEqual({ exchanges: [], running: false, question: undefined, error: undefined });
	const execute = vi.fn();
	session.agent.streamFunction = (model) => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() =>
			stream.push({
				type: "done",
				reason: "toolUse",
				message: {
					...fauxAssistantMessage(""),
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "toolUse",
					content: [{ type: "toolCall", id: "bad", name: "execute", arguments: {} }],
				},
			}),
		);
		return stream;
	};
	session.agent.state.tools = [
		{
			name: "execute",
			description: "should not run",
			parameters: { type: "object", properties: {} } as never,
			label: "Execute",
			execute,
		},
	];
	await expect(service.ask("third")).rejects.toThrow("tool call");
	expect(execute).not.toHaveBeenCalled();
	expect(service.snapshot().exchanges).toEqual([]);
});

it("clears the side thread on disposal and bounds history to twenty exchanges", async () => {
	harness = await createHarness();
	harness.setResponses(Array.from({ length: 22 }, () => fauxAssistantMessage("side answer")));
	for (let index = 0; index < 22; index++) await harness.session.askSideQuestion(`question ${index}`);
	expect(sideQuestionsFor(harness.session).snapshot().exchanges).toHaveLength(20);
	harness.session.dispose();
	expect(sideQuestionsFor(harness.session).snapshot().exchanges).toEqual([]);
});
