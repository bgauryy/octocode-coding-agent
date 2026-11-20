import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFauxCore, fauxAssistantMessage, type TranscriptContext } from "@octocodeai/octocode-ai";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FeatureRegister } from "../../src/core/features/index.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { buildSessionContext, SessionManager } from "../../src/core/session-manager.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { createTestSession } from "../helpers/session.ts";
import { testFeatures } from "../helpers/features.ts";

/**
 * What a session's model request holds of the custom messages around it: a display-only message (a notice for the
 * user) reaches the transcript but never the request, and a long message the model is meant to read travels once.
 */
const NOTICE = "NOTICE-FOR-THE-USER-ONLY provider x is disabled";
const LONG = `${"agent report line\n".repeat(400)}the long message ends here`;

let root: string;
let session: Awaited<ReturnType<typeof createTestSession>>["session"];
let requests: string[] = [];
let dispose: () => Promise<void>;
let faux: ReturnType<typeof createFauxCore>;

beforeAll(async () => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-display-only-"));
	const cwd = path.join(root, "project");
	const agentDir = path.join(root, "agent");
	fs.mkdirSync(cwd, { recursive: true });
	fs.mkdirSync(agentDir, { recursive: true });
	faux = createFauxCore({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000, maxTokens: 4_096 }] });
	const provider: FeatureRegister = (api) => {
		api.providers.register("faux", {
			name: "Faux",
			api: faux.api,
			baseUrl: "http://127.0.0.1:0",
			apiKey: "test",
			models: faux.models.map((model) => ({
				...model,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			})),
			streamSimple: faux.streamSimple,
		} as never);
	};
	const settingsManager = SettingsManager.inMemory({ retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir,
		settingsManager,
		features: testFeatures([{ name: "faux-provider", factory: provider }]),
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const created = await createTestSession({
		cwd,
		agentDir,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
	});
	session = created.session;
	await session.bindFeatures({ mode: "json", shutdownHandler: () => undefined } as never);
	await session.setModel(session.modelRuntime.getModel("faux", "faux-1")!);
	dispose = async () => {
		await session.dispose?.();
		fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
	};
	requests = [];
	faux.setResponses([
		(context: TranscriptContext) => {
			requests.push(JSON.stringify(context.messages));
			return fauxAssistantMessage("ok");
		},
	]);
	await session.sendCustomMessage(
		{ customType: "octocode-test-notice", content: NOTICE, display: "only" },
		{ deliverAs: "nextTurn" },
	);
	await session.sendCustomMessage(
		{ customType: "octocode-test-mail", content: LONG, display: true },
		{ deliverAs: "nextTurn" },
	);
	await session.prompt("go on");
}, 60_000);

afterAll(async () => {
	await dispose?.();
});

describe("a display-only custom message", () => {
	it("is in the session's transcript entries and its rebuilt messages", () => {
		const entries = session.sessionManager.getEntries();
		const notice = entries.find(
			(entry) => entry.type === "custom_message" && entry.customType === "octocode-test-notice",
		);
		expect(notice).toMatchObject({ display: "only", content: NOTICE });
		const rebuilt = buildSessionContext(entries).messages;
		expect(JSON.stringify(rebuilt)).toContain(NOTICE);
	});

	it("never reaches the model request", () => {
		expect(requests).toHaveLength(1);
		expect(requests[0]).not.toContain("NOTICE-FOR-THE-USER-ONLY");
	});

	it("leaves a message the model should read in the request exactly once", () => {
		const copies = requests[0].split("the long message ends here").length - 1;
		expect(copies).toBe(1);
	});
});
