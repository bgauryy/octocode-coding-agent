import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@octocodeai/octocode-ai/compat";
import { setProviderTextRedactor } from "@octocodeai/octocode-ai/utils/error-body";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createSessionFromServices,
} from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { clearSecretValues } from "@octocodeai/octocode-common/sanitize";

/** Opaque on purpose: no pattern recognizes it, only the registry of resolved credentials does. */
const OPAQUE_KEY = "synthetic0123456789abcdef0123456789";
/** Recognized by pattern; never a real key. */
const PATTERN_KEY = "sk-test-0123456789abcdef0123456789";

describe("a provider error in a real session", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	// Start with nothing installed: the wiring under test is what `ModelRuntime.create` does.
	beforeEach(() => {
		setProviderTextRedactor(undefined);
		clearSecretValues();
	});
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
		setProviderTextRedactor(undefined);
		clearSecretValues();
	});

	/** A session whose model answers with `failure` thrown as a provider error, and whose stored key is `storedKey`. */
	async function failingSession(failure: string, storedKey: string) {
		const tempDir = join(tmpdir(), `octocode-error-redaction-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
		const faux = registerFauxProvider();
		faux.setResponses([
			() => {
				throw new Error(failure);
			},
			fauxAssistantMessage("later"),
		]);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: storedKey }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: join(tempDir, "models.json"),
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [
				{
					id: model.id,
					name: model.name,
					api: model.api,
					reasoning: model.reasoning,
					input: model.input,
					cost: model.cost,
					contextWindow: model.contextWindow,
					maxTokens: model.maxTokens,
					baseUrl: model.baseUrl,
				},
			],
		});
		const runtimeOptions = {
			agentDir: tempDir,
			modelRuntime,
			model,
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
		};
		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({ ...runtimeOptions, cwd });
			return {
				...(await createSessionFromServices({ services, sessionManager, sessionStartEvent, model })),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const host = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: SessionManager.create(tempDir),
		});
		await host.session.bindExtensions({});
		cleanups.push(async () => {
			await host.dispose();
			faux.unregister();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		});
		return { session: host.session, tempDir };
	}

	/** Every file the session wrote, so a key kept anywhere on disk shows. */
	function filesText(dir: string): string {
		const names = readdirSync(dir, { recursive: true, withFileTypes: true });
		return names
			.filter((entry) => entry.isFile())
			.map((entry) => readFileSync(join(entry.parentPath, entry.name), "utf8"))
			.join("\n");
	}

	async function runFailure(failure: string, storedKey: string, secrets: string[]) {
		const { session, tempDir } = await failingSession(failure, storedKey);
		const shown: string[] = [];
		session.subscribe((event) => {
			shown.push(JSON.stringify(event));
		});
		await session.prompt("hello");
		const entries = JSON.stringify(session.sessionManager.getEntries());
		const stored = JSON.stringify(session.messages);
		const written = filesText(tempDir);
		const failed = session.messages.find((message) => message.role === "assistant" && message.stopReason === "error");
		expect(failed, "the provider error reached the session").toBeDefined();
		for (const secret of secrets) {
			expect(entries).not.toContain(secret);
			expect(stored).not.toContain(secret);
			expect(written).not.toContain(secret);
			expect(shown.join("\n")).not.toContain(secret);
		}
		return String((failed as { errorMessage?: string }).errorMessage);
	}

	it("holds a key with a known prefix in neither the session, its file nor the events", async () => {
		const message = await runFailure(`401 Incorrect API key provided: ${PATTERN_KEY}`, "faux-key", [PATTERN_KEY]);
		expect(message).toContain("[redacted]");
	});

	it("holds a registered opaque key nowhere either", async () => {
		const message = await runFailure(`401 invalid credential ${OPAQUE_KEY} for this account`, OPAQUE_KEY, [OPAQUE_KEY]);
		expect(message).toContain("[redacted]");
		expect(message).toContain("401 invalid credential");
	});

	it("holds the key and query credentials of a URL a failed request quoted nowhere", async () => {
		const url = `https://user:s3cretpass@gateway.example/v1?api_key=${OPAQUE_KEY}&mode=x`;
		const message = await runFailure(`403 forbidden for ${url}`, OPAQUE_KEY, [OPAQUE_KEY, "s3cretpass"]);
		expect(message).toContain("gateway.example");
	});

	it("redacts a short key in a URL query by its parameter name", async () => {
		const message = await runFailure("403 forbidden for https://gateway.example/v1?key=abc&x=1", "faux-key", [
			"key=abc",
		]);
		expect(message).toContain("gateway.example");
	});
});
