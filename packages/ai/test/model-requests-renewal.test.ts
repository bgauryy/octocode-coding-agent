import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelRequests } from "../src/models/requests.ts";
import type { AssistantMessage, AssistantMessageEvent, Context, Model } from "../src/types.ts";
import {
	clearCredentialCommandCache,
	forgetCredentialCommand,
	runCredentialCommand,
} from "../src/utils/credential-command.ts";

const node = process.execPath;
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "octocode-requests-renewal-"));
	clearCredentialCommandCache();
});

afterEach(() => {
	clearCredentialCommandCache();
	rmSync(dir, { recursive: true, force: true });
});

const model = {
	id: "m",
	provider: "gw",
	api: "openai-completions",
	input: ["text"],
} as unknown as Model<"openai-completions">;
const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

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

/** A provider that accepts only the key `key-2`; anything else is a 401 before any output. */
function setup() {
	const counter = join(dir, "runs");
	const script = `const fs=require("fs");const p=${JSON.stringify(counter)};const n=(fs.existsSync(p)?Number(fs.readFileSync(p,"utf8")):0)+1;fs.writeFileSync(p,String(n));process.stdout.write("key-"+n)`;
	const spec = { command: node, args: ["-e", script], ttlMs: 60_000 };
	const seen: Array<string | undefined> = [];
	const events = (apiKey: string | undefined): AssistantMessageEvent[] => {
		seen.push(apiKey);
		return apiKey === "key-2"
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
	const provider = {
		stream: async function* (_m: unknown, _c: unknown, options: { apiKey?: string }) {
			yield* events(options.apiKey);
		},
		streamSimple: async function* (_m: unknown, _c: unknown, options: { apiKey?: string }) {
			yield* events(options.apiKey);
		},
	};
	const requests = new ModelRequests({
		getProvider: () => provider as never,
		getAuth: async (_model, overrides) => ({
			auth: { apiKey: overrides?.apiKey ?? (await runCredentialCommand(spec)) },
			renew: () => forgetCredentialCommand(spec),
		}),
	});
	const runs = () => Number(readFileSync(counter, "utf8"));
	return { requests, seen, runs };
}

async function types(stream: AsyncIterable<AssistantMessageEvent>): Promise<string[]> {
	const out: string[] = [];
	for await (const event of stream) out.push(event.type === "error" ? `error:${event.error.errorMessage}` : event.type);
	return out;
}

describe("ModelRequests credential renewal", () => {
	it("stream: a refused command key is dropped and the command runs once more", async () => {
		const { requests, seen, runs } = setup();
		expect(await types(requests.stream(model, context))).toEqual(["start", "done"]);
		expect(seen).toEqual(["key-1", "key-2"]);
		expect(runs()).toBe(2);
	});

	it("streamSimple: a refused command key is dropped and the command runs once more", async () => {
		const { requests, seen, runs } = setup();
		expect(await types(requests.streamSimple(model, context))).toEqual(["start", "done"]);
		expect(seen).toEqual(["key-1", "key-2"]);
		expect(runs()).toBe(2);
	});

	it("an explicit apiKey is the caller's own: refused, it is neither renewed nor retried", async () => {
		const { requests, seen } = setup();
		expect(await types(requests.stream(model, context, { apiKey: "caller-key" }))).toEqual([
			"start",
			"error:401 Unauthorized: invalid api key",
		]);
		expect(await types(requests.streamSimple(model, context, { apiKey: "caller-key" }))).toEqual([
			"start",
			"error:401 Unauthorized: invalid api key",
		]);
		expect(seen).toEqual(["caller-key", "caller-key"]);
	});
});
