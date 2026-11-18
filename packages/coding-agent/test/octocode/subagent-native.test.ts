import fs from "node:fs";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import type { FeatureRegister } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestSession } from "../helpers/session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { runSubagent } from "../../src/octocode/subagents/process.ts";
import { tmp } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

describe("native Octocode subagent completion", () => {
	it.each(["answer", "tool", "completed"] as const)("respects native settlement after %s", async (boundary) => {
		const cwd = tmp();
		const agentDir = path.join(cwd, "agent");
		fs.mkdirSync(agentDir);
		fs.writeFileSync(path.join(cwd, "evidence.txt"), "evidence");
		const faux = createFauxCore({
			provider: "faux",
			models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4096 }],
		});
		const provider: FeatureRegister = (api) =>
			api.providers.register("faux", {
				name: "Faux",
				api: faux.api,
				baseUrl: "http://127.0.0.1:0",
				apiKey: "test",
				models: faux.models,
				streamSimple: faux.streamSimple,
			} as never);
		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			nativeFeatures: nativeFeatureSet(),
			features: testFeatures([{ name: "faux", factory: provider }]),
			disabledFeatures: ["mcp"],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const { session } = await createTestSession({
			cwd,
			agentDir,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(cwd),
			tools: ["read"],
		});
		const records: string[] = [];
		let aborted: boolean | undefined;
		let abortedMessage = false;
		let cancellation: Promise<void> | undefined;
		const oldScript = process.argv[1];
		try {
			await session.bindFeatures({ mode: "json", shutdownHandler: () => undefined } as never);
			await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
			faux.setResponses(
				boundary === "tool"
					? [
							() =>
								fauxAssistantMessage([fauxToolCall("read", { path: "evidence.txt" })], {
									stopReason: "toolUse",
								}),
							() => fauxAssistantMessage("Unexpected continuation"),
						]
					: [() => fauxAssistantMessage("REPORT")],
			);
			session.subscribe((event) => {
				records.push(JSON.stringify(event));
				if (event.type === "agent_settled") aborted = event.aborted;
				if (event.type === "message_end" && event.message.role === "assistant") {
					abortedMessage ||= event.message.stopReason === "aborted";
					if (boundary === "answer" && event.message.stopReason === "stop") cancellation = session.abort();
				}
				if (boundary === "tool" && event.type === "tool_execution_end") cancellation = session.abort();
			});
			await session.prompt("Inspect the evidence and report.");
			await cancellation;
			expect(aborted).toBe(boundary !== "completed");
			// Aborted during its tools, the loop ends with an aborted assistant message marking the interruption;
			// an answer or a finished run is never replaced by one.
			expect(abortedMessage).toBe(boundary === "tool");
			// Replay the real native event sequence through the supervisor's child-process boundary.
			const script = path.join(cwd, "octocode");
			fs.writeFileSync(script, `process.stdout.write(${JSON.stringify(`${records.join("\n")}\n`)});`);
			process.argv[1] = script;
			const result = await runSubagent({
				task: "",
				args: [],
				cwd,
				identity: { id: "native-test" },
				onProgress: () => undefined,
			});
			if (boundary === "completed") {
				expect(result.text).toBe("REPORT");
				expect(result.error).toBeUndefined();
			} else {
				expect(result.error).toMatch(/cancelled/i);
				if (boundary === "answer") expect(result.text).toContain("REPORT");
			}
		} finally {
			process.argv[1] = oldScript!;
			session.dispose();
		}
	});
});

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));
