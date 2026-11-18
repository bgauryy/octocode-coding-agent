import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
/**
 * Shared test utilities for coding-agent tests.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, createEventBus, type EventBus } from "@octocodeai/octocode-agent-core";
import { streamSimple } from "@octocodeai/octocode-ai/compat";
import { getBuiltinModel } from "@octocodeai/octocode-ai/providers/all";
import { AgentSession } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { FeatureRecord, LoadedFeatures } from "../src/core/features/index.ts";
import { registerFeature } from "../src/core/features/register.ts";
import { createFeatureRuntime, type TestFeatureInput, testFeatures } from "./helpers/features.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createBashTool } from "../src/core/tools/index.ts";

/**
 * API key for authenticated tests. Tests using this should be wrapped in
 * describe.skipIf(!API_KEY)
 */
export const API_KEY = process.env.ANTHROPIC_API_KEY;

/**
 * Create a minimal user message for testing.
 */
export function userMsg(text: string) {
	return { role: "user" as const, content: text, timestamp: Date.now() };
}

/**
 * Create a minimal assistant message for testing.
 */
export function assistantMsg(text: string) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages" as const,
		provider: "anthropic",
		model: "test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

/**
 * Read a session JSONL file and return one label per record: the message role for
 * message entries, otherwise the entry type (e.g. "session", "model_change").
 */
export function readSessionFileRoles(file: string): string[] {
	return readFileSync(file, "utf-8")
		.trim()
		.split("\n")
		.map((line) => {
			const record = JSON.parse(line);
			return record.message?.role ?? record.type;
		});
}

/**
 * Options for creating a test session.
 */
export interface TestSessionOptions {
	/** Use in-memory session (no file persistence) */
	inMemory?: boolean;
	/** Custom system prompt */
	systemPrompt?: string;
	/** Custom settings overrides */
	settingsOverrides?: Record<string, unknown>;
}

/**
 * Resources returned by createTestSession that need cleanup.
 */
export interface TestSessionContext {
	session: AgentSession;
	sessionManager: SessionManager;
	tempDir: string;
	cleanup: () => void;
}

export async function createTestFeaturesResult(
	inputs: readonly TestFeatureInput[],
	_cwd = process.cwd(),
	eventBus: EventBus = createEventBus(),
): Promise<LoadedFeatures> {
	const runtime = createFeatureRuntime();
	const features: FeatureRecord[] = [];
	for (const feature of testFeatures(inputs)) features.push(await registerFeature(feature, eventBus, runtime));
	return { features, errors: [], runtime };
}

export interface CreateTestResourceLoaderOptions {
	featuresResult?: LoadedFeatures;
}

export function createTestResourceLoader(options: CreateTestResourceLoaderOptions = {}): ResourceLoader {
	const featuresResult = options.featuresResult ?? {
		features: [],
		errors: [],
		runtime: createFeatureRuntime(),
	};

	return {
		getFeatures: () => featuresResult,
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

/**
 * Create an AgentSession for testing with proper setup and cleanup.
 * Use this for e2e tests that need real LLM calls.
 */
export async function createTestSession(options: TestSessionOptions = {}): Promise<TestSessionContext> {
	const tempDir = join(tmpdir(), `octocode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = getBuiltinModel("anthropic", "claude-sonnet-4-5");
	const agent = new Agent({
		getApiKey: () => API_KEY,
		initialState: {
			model,
			systemPrompt: options.systemPrompt ?? "You are a helpful assistant. Be extremely concise.",
			tools: [createBashTool(process.cwd())],
		},
		streamFn: streamSimple,
	});

	const sessionManager = options.inMemory ? SessionManager.inMemory() : SessionManager.create(tempDir);
	const settingsManager = SettingsManager.create(tempDir, tempDir);

	if (options.settingsOverrides) {
		settingsManager.applyOverrides(options.settingsOverrides);
	}

	const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
	const modelRegistry = await createModelRegistry(authStorage, tempDir);

	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd: tempDir,
		modelRuntime: getModelRuntime(modelRegistry),
		resourceLoader: createTestResourceLoader(),
	});

	// Must subscribe to enable session persistence
	session.subscribe(() => {});

	const cleanup = () => {
		session.dispose();
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	};

	return { session, sessionManager, tempDir, cleanup };
}
