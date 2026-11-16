import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const aiEntryUrl = new URL("../src/index.ts", import.meta.url).href;
const compatEntryUrl = new URL("../src/compat.ts", import.meta.url).href;
const providersAllUrl = new URL("../src/providers/all.ts", import.meta.url).href;

const SDK_SPECIFIERS = [
	"@anthropic-ai/sdk",
	"@ai-sdk/anthropic",
	"openai",
	"@google/genai",
	"@ai-sdk/amazon-bedrock",
	"@ai-sdk/mistral",
	"@ai-sdk/openai",
	"@ai-sdk/google",
	"@ai-sdk/google-vertex",
	"@ai-sdk/azure",
	"@ai-sdk/openai-compatible",
	"google-auth-library",
	"@aws-sdk/credential-providers",
	"aws4fetch",
] as const;

type ProbeResult = {
	loadedSpecifiers: string[];
};

function runProbe(action: string): ProbeResult {
	const script = `
		import { registerHooks } from "node:module";

		const targets = new Set(${JSON.stringify(SDK_SPECIFIERS)});
		const loaded = [];

		registerHooks({
			resolve(specifier, context, nextResolve) {
				if (targets.has(specifier)) {
					loaded.push(specifier);
				}
				return nextResolve(specifier, context);
			},
		});

		const mod = await import(${JSON.stringify(aiEntryUrl)});
		${action}
		console.log(JSON.stringify({ loadedSpecifiers: [...new Set(loaded)] }));
	`;

	const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
		cwd: packageRoot,
		encoding: "utf8",
	});

	if (result.status !== 0) {
		throw new Error(`Probe failed (exit ${result.status})\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
	}

	const stdoutLines = result.stdout
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const lastLine = stdoutLines.at(-1);
	if (!lastLine) {
		throw new Error(`Probe produced no output\nSTDERR:\n${result.stderr}`);
	}

	return JSON.parse(lastLine) as ProbeResult;
}

describe("lazy provider module loading", () => {
	it("does not load provider SDKs when importing the root barrel", () => {
		const result = runProbe("");
		expect(result.loadedSpecifiers).toEqual([]);
	});

	it("does not load provider SDKs when building all builtin providers", () => {
		const result = runProbe(`
			const all = await import(${JSON.stringify(providersAllUrl)});
			const models = all.builtinModels();
			models.getModels();
		`);
		expect(result.loadedSpecifiers).toEqual([]);
	});

	it("does not load provider SDKs when importing the compat entrypoint", () => {
		const result = runProbe(`
			await import(${JSON.stringify(compatEntryUrl)});
		`);
		expect(result.loadedSpecifiers).toEqual([]);
	});

	it("loads only the Anthropic SDK when streaming through the lazy API wrapper", () => {
		const result = runProbe(`
			const compat = await import(${JSON.stringify(compatEntryUrl)});
			const model = {
				id: "claude-sonnet-4-6",
				name: "Claude Sonnet 4",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: "https://api.anthropic.com",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 200000,
				maxTokens: 8192,
			};
			const context = { messages: [{ role: "user", content: "hi" }] };
			const fetch = async () => new Response("{}", { status: 400 });
			await compat.anthropicMessagesApi().streamSimple(model, context, { apiKey: "test", fetch }).result();
		`);

		expect(result.loadedSpecifiers).toEqual(["@ai-sdk/anthropic"]);
	});

	it("loads only the Anthropic SDK when dispatching through streamSimple", () => {
		const result = runProbe(`
			const compat = await import(${JSON.stringify(compatEntryUrl)});
			const { getBuiltinModel } = await import(${JSON.stringify(providersAllUrl)});
			const model = getBuiltinModel("anthropic", "claude-sonnet-4-6");
			const context = { messages: [{ role: "user", content: "hi" }] };
			const fetch = async () => new Response("{}", { status: 400 });
			await compat.streamSimple(model, context, { apiKey: "test", fetch }).result();
		`);

		expect(result.loadedSpecifiers).toEqual(["@ai-sdk/anthropic"]);
	});

	it("loads only the Bedrock SDK when dispatching a Bedrock model", () => {
		const result = runProbe(`
			const compat = await import(${JSON.stringify(compatEntryUrl)});
			const { getBuiltinModel } = await import(${JSON.stringify(providersAllUrl)});
			const model = getBuiltinModel("amazon-bedrock", "us.anthropic.claude-opus-4-8");
			const context = { messages: [{ role: "user", content: "hi" }] };
			const fetch = async () => new Response("{}", { status: 400 });
			await compat.streamSimple(model, context, { apiKey: "test", env: {}, fetch }).result();
		`);

		// aws4fetch is Bedrock's own request signer.
		expect(result.loadedSpecifiers).toEqual(["@ai-sdk/amazon-bedrock", "aws4fetch"]);
	});
});
