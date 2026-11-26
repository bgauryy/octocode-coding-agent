import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, AssistantMessageEvent, Model } from "@octocodeai/octocode-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { overrideKeychainHost } from "../src/core/auth-storage/keychain.ts";
import { clearConfigValueCache } from "../src/core/config-value.ts";
import { ModelConfig } from "../src/core/model-config.ts";
import { type ModelRequestHost, streamSimpleChatModel } from "../src/core/model-runtime/requests.ts";
import { composeModelProvider } from "../src/core/provider-composer.ts";

const node = process.execPath;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "octocode-key-renewal-"));
	clearConfigValueCache();
});

afterEach(() => {
	overrideKeychainHost(undefined);
	clearConfigValueCache();
	rmSync(dir, { recursive: true, force: true });
});

const model = {
	id: "m",
	name: "m",
	api: "openai-completions",
	provider: "gw",
	baseUrl: "http://localhost:1/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1_000,
} as Model<"openai-completions">;

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "openai-completions",
		provider: "gw",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

/** A program that counts its runs in `counter` and prints `<prefix>-<run>`. */
function countingScript(counter: string, prefix: string): string {
	return `const fs=require("fs");const p=${JSON.stringify(counter)};const n=(fs.existsSync(p)?Number(fs.readFileSync(p,"utf8")):0)+1;fs.writeFileSync(p,String(n));process.stdout.write(${JSON.stringify(`${prefix}-`)}+n)`;
}

/**
 * The composed provider auth of a models.json provider behind the runtime's request path; only the provider's network
 * side is faked: it refuses every key but `second` with a 401 before any output.
 */
async function request(provider: Record<string, unknown>, second: string) {
	const path = join(dir, "models.json");
	writeFileSync(
		path,
		JSON.stringify({
			providers: {
				gw: { baseUrl: "http://localhost:1/v1", api: "openai-completions", models: [{ id: "m" }], ...provider },
			},
		}),
	);
	const config = await ModelConfig.load(path);
	expect(config.getError()).toBeUndefined();
	const composed = composeModelProvider("gw", undefined, config, undefined);
	const apiKey = composed.auth.apiKey;
	if (!apiKey) throw new Error("no api key auth");
	const ctx = { env: async () => undefined, fileExists: async () => false };
	const seen: Array<string | undefined> = [];
	const events = (key: string | undefined): AssistantMessageEvent[] => {
		seen.push(key);
		return key === second
			? [
					{ type: "start", partial: message() },
					{ type: "done", reason: "stop", message: message() },
				]
			: [
					{ type: "start", partial: message() },
					{
						type: "error",
						reason: "error",
						error: message({ stopReason: "error", errorMessage: "401 Unauthorized: invalid api key" }),
					},
				];
	};
	const fake = {
		id: "gw",
		stream: async function* (_m: unknown, _c: unknown, options: { apiKey?: string }) {
			yield* events(options.apiKey);
		},
		streamSimple: async function* (_m: unknown, _c: unknown, options: { apiKey?: string }) {
			yield* events(options.apiKey);
		},
	};
	const host: ModelRequestHost = {
		getProvider: () => fake as never,
		getAuth: async () => apiKey.resolve({ ctx, signal: new AbortController().signal }),
		getCachePolicy: () => ({ options: {} }) as ReturnType<ModelRequestHost["getCachePolicy"]>,
		resolveModel: async () => {
			throw new Error("not routed");
		},
		streamSimple: () => {
			throw new Error("not used");
		},
	};
	const result = await streamSimpleChatModel(host, model, {
		messages: [{ role: "user", content: "hi", timestamp: 0 }],
	}).result();
	return { result, seen };
}

describe("a refused models.json key through the runtime's request path", () => {
	it("runs an auth command exactly once more and sends its second key", async () => {
		const counter = join(dir, "runs");
		const { result, seen } = await request(
			{ auth: { command: node, args: ["-e", countingScript(counter, "key")], ttlMs: 60_000 } },
			"key-2",
		);
		expect(result.stopReason).toBe("stop");
		expect(seen).toEqual(["key-1", "key-2"]);
		expect(readFileSync(counter, "utf8")).toBe("2");
	});

	it("stops after one renewal when the second key is refused too", async () => {
		const counter = join(dir, "runs");
		const { result, seen } = await request(
			{ auth: { command: node, args: ["-e", countingScript(counter, "key")], ttlMs: 60_000 } },
			"never-accepted",
		);
		expect(result.stopReason).toBe("error");
		expect(seen).toEqual(["key-1", "key-2"]);
		expect(readFileSync(counter, "utf8")).toBe("2");
	});

	it("reads a keychain entry again once, through the injected runner", async () => {
		const counter = join(dir, "kc-runs");
		const tool = join(dir, "secret-tool");
		writeFileSync(tool, `#!${node}\n${countingScript(counter, "kc-key")}\n`);
		chmodSync(tool, 0o755);
		overrideKeychainHost({ platform: "linux", which: () => tool });
		const { result, seen } = await request({ apiKey: "keychain:gw-key" }, "kc-key-2");
		expect(result.stopReason).toBe("stop");
		expect(seen).toEqual(["kc-key-1", "kc-key-2"]);
		expect(readFileSync(counter, "utf8")).toBe("2");
	});
});
