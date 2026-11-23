import fs from "node:fs";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, type TranscriptContext } from "@octocodeai/octocode-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { FeatureSetup, FeatureRegister } from "../../src/core/features/index.ts";
import { emitSessionShutdownEvent } from "../../src/core/features/runner.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { createTestSession } from "../helpers/session.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { getApplicationPort } from "../../src/core/application/index.ts";
import { Delivery } from "../../src/octocode/ui/delivery.ts";
import { fakeCtx } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { testFeatures } from "../helpers/features.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";

const REPORT = "Unique background report: delivery-native";

describe("Delivery with the native Octocode session queue", () => {
	// These are the session operations the TUI uses for dequeue and Esc. Only the UI display is a double;
	// registration, tool execution, queues, messages, settlement and transcript projection are real Octocode.
	// interrupt: the application "abort" command (webview, RPC). It is a user Stop, which withdraws the queued input as Esc
	// does (`AgentSession.abort`), so the report is appended once without a turn. An abort that leaves the queue (a peer's
	// held mail) keeps the report queued for the next run: `delivery.test.ts` covers that case.
	it.each(["delivered", "dequeue", "escape", "interrupt"] as const)(
		"retains exactly one report after %s without an extra run",
		async (action) => {
			const cwd = tmp();
			const agentDir = path.join(cwd, "agent");
			fs.mkdirSync(agentDir);
			const faux = createFauxCore({
				provider: "faux",
				models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4096 }],
			});
			let host!: FeatureSetup;
			let delivery!: Delivery;
			let release!: () => void;
			let entered!: () => void;
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			const started = new Promise<void>((resolve) => {
				entered = resolve;
			});
			const factory: FeatureRegister = (api) => {
				host = api;
				delivery = Delivery.install(api);
				api.providers.register("faux", {
					name: "Faux",
					api: faux.api,
					baseUrl: "http://127.0.0.1:0",
					apiKey: "test",
					models: faux.models,
					streamSimple: faux.streamSimple,
				} as never);
				api.tools.register({
					name: "hold",
					label: "Hold",
					description: "Wait for this test to release the call",
					parameters: Type.Object({}),
					async execute(_id, _args, signal) {
						const abort = () => release();
						signal?.addEventListener("abort", abort, { once: true });
						try {
							entered();
							await held;
							signal?.throwIfAborted();
							return { content: [{ type: "text", text: "Released" }], details: undefined };
						} finally {
							signal?.removeEventListener("abort", abort);
						}
					},
				});
			};
			const settingsManager = SettingsManager.inMemory({
				retry: { enabled: false },
			});
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				nativeFeatures: nativeFeatureSet(),
				features: testFeatures([{ name: "delivery-test", factory }]),
				disabledFeatures: ["mcp"],
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await resourceLoader.reload();
			const sessionManager = SessionManager.inMemory(cwd);
			const { session } = await createTestSession({
				cwd,
				agentDir,
				resourceLoader,
				settingsManager,
				sessionManager,
				tools: ["hold"],
			});
			const ui = fakeCtx({ cwd }).ui;
			const turns: number[] = [];
			let runs = 0;
			session.subscribe((event) => {
				if (event.type === "agent_start") runs += 1;
			});
			const record = (context: TranscriptContext) => {
				turns.push(context.messages.filter((message) => JSON.stringify(message.content).includes(REPORT)).length);
			};
			const reports = () =>
				sessionManager
					.getBranch()
					.filter((entry) => entry.type === "custom_message" && entry.customType === "delivery-native");
			let running: Promise<void> | undefined;
			try {
				await session.bindFeatures({ mode: "tui", uiContext: ui, shutdownHandler: () => undefined });
				await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
				faux.setResponses([
					(context) => {
						record(context);
						return fauxAssistantMessage([fauxToolCall("hold", {})], { stopReason: "toolUse" });
					},
					(context) => {
						record(context);
						return fauxAssistantMessage("Finished the original task");
					},
					(context) => {
						record(context);
						return fauxAssistantMessage("Read the queued report");
					},
				]);
				running = session.prompt("Run the hold tool.");
				await started;
				const report = {
					customType: "delivery-native",
					content: REPORT,
					display: true,
					details: { id: "report-1" },
				};
				host.session.sendMessage(report, { deliverAs: "followUp", triggerTurn: true });
				expect(delivery.pending).toBe(1);
				expect(reports()).toHaveLength(0);
				if (action === "dequeue" || action === "escape") {
					// Custom messages are in Octocode's agent queue, not its separately tracked user-text queue.
					expect(session.clearQueue()).toEqual({ steering: [], followUp: [] });
				}
				if (action === "escape") await session.abort();
				else if (action === "interrupt") await getApplicationPort(session).invoke("abort");
				else release();
				await running;
				await session.waitForIdle();
				const stopped = action === "escape" || action === "interrupt";
				expect(runs).toBe(1);
				expect(turns).toEqual(stopped ? [0] : action === "delivered" ? [0, 0, 1] : [0, 0]);
				expect(delivery.pending).toBe(0);
				expect(reports()).toHaveLength(1);
				expect(reports()[0]).toMatchObject(report);
				expect(ui.notes.filter((note) => note.message.includes("kept 1 queued message"))).toHaveLength(
					action === "delivered" ? 0 : 1,
				);

				faux.setResponses([
					(context) => {
						record(context);
						return fauxAssistantMessage("Read the retained report");
					},
					(context) => {
						record(context);
						return fauxAssistantMessage("Read the queued report after the prompt");
					},
				]);
				await session.prompt("Continue using the background report.");
				expect(turns.at(-1)).toBe(1);
				expect(Math.max(...turns)).toBe(1);
				expect(runs).toBe(2);
				expect(delivery.pending).toBe(0);
				expect(reports()).toHaveLength(1);
				expect(reports()[0]).toMatchObject(report);
			} finally {
				release();
				await session.abort();
				await running;
				await emitSessionShutdownEvent(session.featureHost, { type: "session_shutdown", reason: "quit" });
				session.dispose();
			}
		},
	);
});
