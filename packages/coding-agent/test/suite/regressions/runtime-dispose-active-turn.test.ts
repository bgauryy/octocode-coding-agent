import type { AgentTool, AgentToolResult } from "@octocodeai/octocode-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { afterEach, expect, it } from "vitest";
import {
	AgentSessionRuntime,
	type AgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
} from "../../../src/core/agent-session-runtime.ts";
import { createHarness, type Harness } from "../harness.ts";

let harness: Harness | undefined;
afterEach(() => harness?.cleanup());

it("settles and saves the active turn before shutting the session down", async () => {
	let markToolStarted = () => {};
	const toolStarted = new Promise<void>((resolve) => {
		markToolStarted = resolve;
	});
	const blockingTool: AgentTool = {
		name: "block",
		label: "Block",
		description: "Wait until aborted",
		parameters: Type.Object({}),
		execute: (_toolCallId, _params, signal) =>
			new Promise<AgentToolResult<unknown>>((resolve) => {
				markToolStarted();
				signal?.addEventListener(
					"abort",
					() => resolve({ content: [{ type: "text", text: "tool aborted" }], details: {} }),
					{ once: true },
				);
			}),
	};
	harness = await createHarness({ tools: [blockingTool] });
	const services: AgentSessionServices = {
		cwd: harness.tempDir,
		agentDir: harness.tempDir,
		modelRuntime: harness.session.modelRuntime,
		settingsManager: harness.settingsManager,
		resourceLoader: harness.session.resourceLoader,
		diagnostics: [],
	};
	const unused: CreateAgentSessionRuntimeFactory = async () => {
		throw new Error("not used");
	};
	const runtime = new AgentSessionRuntime(harness.session, services, unused);

	harness.setResponses([fauxAssistantMessage(fauxToolCall("block", {}), { stopReason: "toolUse" })]);
	const prompt = runtime.session.prompt("start blocking tool");
	await toolStarted;
	await runtime.dispose();
	await prompt.catch(() => undefined);

	const saved = harness.session.sessionManager.getEntries();
	expect(JSON.stringify(saved)).toContain("tool aborted");
});
