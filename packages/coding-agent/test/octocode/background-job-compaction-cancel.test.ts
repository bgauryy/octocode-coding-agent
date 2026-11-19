import fs from "node:fs";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, type TranscriptContext } from "@octocodeai/octocode-ai";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { FeatureRegister } from "../../src/core/features/index.ts";
import { NothingToCompactError } from "../../src/core/agent-session/compaction-control.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestSession } from "../helpers/session.ts";
import { testFeatures } from "../helpers/features.ts";
import { nativeFeatureSet } from "../helpers/native-features.ts";
import { nativeCall } from "./e2e-calls.ts";
import { fakeCtx } from "./fake-host.ts";
import { harnessToggles } from "./e2e-helpers/harness-toggles.ts";
import { resetOctocodeEnv, tmp } from "./helpers.ts";

/**
 * A background job that finishes after a manual compaction cancelled the run it started in: its report is still
 * recorded once, with the job's exit status.
 */
const savedEnv = { ...process.env };
const root = fs.realpathSync(tmp("octocode-job-compact-"));
const cwd = path.join(root, "project");

let session: Awaited<ReturnType<typeof createTestSession>>["session"];
let faux: ReturnType<typeof createFauxCore>;

beforeAll(async () => {
	fs.mkdirSync(path.join(cwd, ".octocode"), { recursive: true });
	fs.writeFileSync(path.join(cwd, ".octocode", "settings.json"), "{}");
	resetOctocodeEnv();
	Object.assign(process.env, {
		HOME: path.join(root, "home"),
		OCTOCODE_CODING_AGENT_DIR: path.join(root, "agent"),
		OCTOCODE_HOME: path.join(root, "home", ".octocode"),
		OCTOCODE_AGENT_DB: path.join(root, "team.sqlite"),
		OCTOCODE_PERMISSION: "workspace",
	});
	faux = createFauxCore({
		provider: "faux",
		models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4_096 }] as never,
	});
	const provider: FeatureRegister = (api) => {
		api.providers.register("faux", {
			name: "Faux",
			api: faux.api,
			baseUrl: "http://127.0.0.1:0",
			apiKey: "test",
			models: faux.models.map((model) => ({ ...model, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
			streamSimple: faux.streamSimple,
		} as never);
	};
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, toggles: harnessToggles("claude") });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: path.join(root, "agent"),
		settingsManager,
		nativeFeatures: nativeFeatureSet(),
		features: testFeatures([{ name: "faux-provider", factory: provider }]),
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	({ session } = await createTestSession({
		cwd,
		agentDir: path.join(root, "agent"),
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	}));
	await session.bindFeatures({
		uiContext: fakeCtx({ cwd: root }).ui,
		mode: "rpc",
		shutdownHandler: () => undefined,
	} as never);
	await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
}, 60_000);

afterAll(async () => {
	await session?.dispose?.();
	process.env = savedEnv;
	fs.rmSync(root, { recursive: true, force: true });
});

/** A model turn that waits until the run is aborted. */
const untilAborted = (context: TranscriptContext, options?: { signal?: AbortSignal }) =>
	new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
		void context;
		options?.signal?.addEventListener("abort", () => resolve(fauxAssistantMessage("stopped")), { once: true });
	});

const jobReports = () =>
	session.sessionManager
		.getEntries()
		.flatMap((entry) => (entry.type === "custom_message" ? [entry] : []))
		.filter((entry) => String(entry.content).includes("MARKER-83-ORBIT"));

describe("a background job finishing after a manual compaction cancelled its run", () => {
	it("records its report once with the exit status", async () => {
		faux.setResponses([
			() =>
				fauxAssistantMessage(
					[nativeCall("bash", { command: "sleep 1; echo MARKER-83-ORBIT; exit 3", background: true })],
					{ stopReason: "toolUse" },
				),
			untilAborted,
			() => fauxAssistantMessage("saw the job"),
		]);
		const prompting = session.prompt("start the job");
		await vi.waitFor(() => expect(faux.getPendingResponseCount()).toBe(1), { timeout: 10_000 });
		// The run waits on its model while the job pends: the compaction cancels that run.
		await expect(session.compact()).rejects.toBeInstanceOf(NothingToCompactError);
		await prompting.catch(() => undefined);
		await vi.waitFor(() => expect(jobReports()).toHaveLength(1), { timeout: 15_000 });
		expect(String(jobReports()[0].content)).toContain("[exit 3 ");
		await session.settled();
		expect(jobReports()).toHaveLength(1);
	}, 30_000);
});
