import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@octocodeai/octocode-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAgentSessionServices, createSessionFromServices } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { CacheWarmer } from "../src/core/cache-warmer.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { nativeFeatureSet } from "./helpers/native-features.ts";

const MARKER = "TOOL_SNAPSHOT_MARKER";

const cleanups: Array<() => void> = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A real session through the services path (`createSessionFromServices` builds the warmer's check) with a marked tool. */
async function openSession() {
	const dir = join(tmpdir(), `cache-context-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	const faux = registerFauxProvider();
	cleanups.push(() => {
		faux.unregister();
		rmSync(dir, { recursive: true, force: true });
	});
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(dir, "models.json") });
	const model = faux.getModel();
	modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [{ ...model }] });
	const services = await createAgentSessionServices({
		cwd: dir,
		agentDir: dir,
		modelRuntime,
		resourceLoaderOptions: {
			nativeFeatures: nativeFeatureSet(),
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		},
	});
	const marked = {
		name: "marked",
		label: "marked",
		description: `A tool whose description carries ${MARKER}.`,
		parameters: Type.Object({}),
		execute: async () => ({ content: [], details: {} }),
	};
	const { session } = await createSessionFromServices({
		services,
		sessionManager: SessionManager.inMemory(),
		model,
		customTools: [marked],
	});
	cleanups.push(() => session.dispose());
	await session.bindFeatures({});
	return { session, faux };
}

/** Serializations of the marked tool by the session's request check while `work` runs, until it settles. */
async function serializations(work: () => unknown): Promise<number> {
	const real = JSON.stringify;
	let count = 0;
	const spy = vi.spyOn(JSON, "stringify").mockImplementation(((...args: Parameters<typeof JSON.stringify>) => {
		const text = real(...args) as string | undefined;
		// The session's own check (`create-session.ts`); the faux provider serializes the tools to count tokens too.
		if (text?.includes(MARKER) && new Error("caller").stack?.includes("create-session.ts")) count++;
		return text;
	}) as typeof JSON.stringify);
	try {
		await work();
	} finally {
		spy.mockRestore();
	}
	return count;
}

describe("the cache warmer's check that a request is still current", () => {
	it("serializes each declared tool once, not per request or check, and still sees a changed tool", async () => {
		const { session, faux } = await openSession();
		const checks: Array<() => boolean> = [];
		vi.spyOn(CacheWarmer.prototype, "start").mockImplementation((_request, isCurrent) => void checks.push(isCurrent));
		faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("again")]);
		await session.prompt("go");
		expect(session.agent.state.tools.some((tool) => tool.name === "marked")).toBe(true);
		expect(checks.length).toBeGreaterThan(0);
		// The next request declares the same tool objects again: their text is kept, not serialized per request.
		const requests = checks.length;
		vi.mocked(CacheWarmer.prototype.start).mockImplementation((_request, isCurrent) => {
			checks.push(isCurrent);
			// The check itself, as the warmer runs it when it decides whether to warm.
			isCurrent();
		});
		const declaredAgain = await serializations(() => session.prompt("again"));
		expect(checks.length).toBeGreaterThan(requests);
		expect(declaredAgain).toBe(0);
		const latest = checks.at(-1)!;
		// The tools did not change since the request: no check serializes their schemas again.
		expect(
			await serializations(() => {
				for (let index = 0; index < 5; index++) expect(latest()).toBe(true);
			}),
		).toBe(0);
		const { state } = session.agent;
		state.tools = state.tools.map((tool) =>
			tool.name === "marked" ? { ...tool, description: `${tool.description} Changed.` } : tool,
		);
		expect(latest()).toBe(false);
		// The same new array again: its text is kept, so a second check reads no schema.
		expect(await serializations(() => expect(latest()).toBe(false))).toBe(0);
	});
});
