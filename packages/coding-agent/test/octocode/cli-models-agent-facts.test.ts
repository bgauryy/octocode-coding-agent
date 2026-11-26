import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Message, normalizeContext } from "@octocodeai/octocode-ai";
import { describe, expect, it, vi } from "vitest";
import { acpCapabilities, promptBlocks } from "../../../acp/src/client/session-config.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { externalModelEntry, idRefusal } from "../../src/modes/interactive/interactive-mode/provider-external-model.ts";
import { createRouteBackend } from "../../src/octocode/cli-models/backend.ts";
import { externalRoutes } from "../../src/octocode/cli-models/register.ts";
import { promptImages, promptText } from "../../src/octocode/cli-models/transcript.ts";
import { bin, runner, setup } from "./cli-models-helpers.ts";
import { tmp } from "./helpers.ts";

const picture = { type: "image" as const, data: "AAAA", mimeType: "image/png" };
const withPicture: Message = {
	role: "user",
	content: [{ type: "text", text: "what is this?" }, picture],
	timestamp: 1,
};

describe("what an ACP agent advertises", () => {
	it("lists the models and images the agent reported, and notes a missing tool path", () => {
		const env = { PATH: bin({ "my-agent": "exit 0" }) };
		const { agentDir, cwd } = setup({
			externalModels: [{ id: "mine", kind: "acp", command: "my-agent" }],
		});
		const [route] = externalRoutes({ states: [], cwd, agentDir, env, projectTrusted: false }).routes;
		expect(route.models.map((model) => model.id)).toEqual(["default"]);
		expect(route.models[0].input).toEqual(["text"]);

		route.learn!({ models: ["fast", "deep", "default"], images: true, mcpHttp: false });
		expect(route.models.map((model) => model.id)).toEqual(["default", "fast", "deep"]);
		expect(route.models.every((model) => model.input.includes("image"))).toBe(true);
		expect(route.models[1].name).toContain("no Octocode tools");

		route.learn!({ models: ["fast"], images: false, mcpHttp: true });
		expect(route.models[0].input).toEqual(["text"]);
		expect(route.models[0].name).not.toContain("no Octocode tools");
	});

	it("keeps the models an entry configures, whatever the agent advertises", () => {
		const env = { PATH: bin({ "my-agent": "exit 0" }) };
		const { agentDir, cwd } = setup({
			externalModels: [{ id: "mine", kind: "acp", command: "my-agent", models: ["only"] }],
		});
		const [route] = externalRoutes({ states: [], cwd, agentDir, env, projectTrusted: false }).routes;
		route.learn!({ models: ["fast", "deep"], images: false, mcpHttp: true });
		expect(route.models.map((model) => model.id)).toEqual(["only"]);
	});

	it("starts a built-in CLI with the models its sign-in check found", () => {
		const env = { PATH: bin({ "gemini": "exit 0" }) };
		const state = { ...runner("gemini"), models: ["flash", "pro"], acceptsImages: true, acceptsMcpHttp: false };
		const [route] = externalRoutes({ states: [state], cwd: setup({}).cwd, agentDir: setup({}).agentDir, env }).routes;
		expect(route.models.map((model) => model.id)).toEqual(["default", "flash", "pro"]);
		expect(route.models[0].input).toContain("image");
		expect(route.models[0].name).toContain("no Octocode tools");
	});

	it("treats a runner checked before agents were asked what they accept as unknown: no label, no image input", () => {
		const env = { PATH: bin({ gemini: "exit 0" }) };
		const { agentDir, cwd } = setup({});
		const old = { id: "gemini", name: "gemini", cli: true, adapter: true, checkedAt: 1, auth: { signedIn: true } };
		const [route] = externalRoutes({ states: [old], cwd, agentDir, env }).routes;
		expect(route.models.map((model) => [model.id, model.input, model.name.includes("no Octocode tools")])).toEqual([
			["default", ["text"], false],
		]);
	});

	it("reads image and MCP-over-HTTP support from the initialize answer", () => {
		expect(acpCapabilities(undefined)).toEqual({ image: false, mcpHttp: false });
		expect(acpCapabilities({ promptCapabilities: { image: true }, mcpCapabilities: { http: true } })).toEqual({
			image: true,
			mcpHttp: true,
		});
	});
});

describe("images in a prompt", () => {
	it("sends the user's new images as image blocks, not as a name in the text", () => {
		expect(promptImages([withPicture])).toEqual([{ data: "AAAA", mimeType: "image/png" }]);
		expect(promptText([withPicture], true)).toBe("what is this?");
		expect(promptText([withPicture])).toContain("[image image/png]");
		expect(promptBlocks("hi", promptImages([withPicture]))).toEqual([
			{ type: "text", text: "hi" },
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
	});

	it("leaves out images of messages that are history", () => {
		const answer: Message = {
			role: "assistant",
			content: [{ type: "text", text: "a cat" }],
		} as unknown as Message;
		expect(promptImages([withPicture, answer, { role: "user", content: "and now?", timestamp: 2 }])).toEqual([]);
	});
});

describe("the /providers form for an own agent", () => {
	it("builds an entry from the answers and refuses a built-in id", () => {
		expect(
			externalModelEntry({ id: " mine ", kind: "cli", command: "x", args: "--model  {model}", models: "a, b," }),
		).toEqual({ id: "mine", kind: "cli", command: "x", args: ["--model", "{model}"], models: ["a", "b"] });
		expect(externalModelEntry({ id: "m", kind: "acp", command: "x", args: "", models: "" })).toEqual({
			id: "m",
			kind: "acp",
			command: "x",
		});
		expect(idRefusal("codex-cli")).toMatch(/built-in/);
		expect(idRefusal("Bad Id")).toBeTruthy();
		expect(idRefusal("my-agent")).toBeUndefined();
	});

	it("writes the entry to the global settings, replacing one with the same id", async () => {
		const { agentDir, cwd } = setup({ theme: "dark" });
		const settings = SettingsManager.create(cwd, agentDir);
		settings.addExternalModel({ id: "mine", kind: "cli", command: "x" });
		settings.addExternalModel({ id: "mine", kind: "acp", command: "y" });
		await settings.flush();
		const saved = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf8"));
		expect(saved.externalModels).toEqual([{ id: "mine", kind: "acp", command: "y" }]);
		expect(saved.theme).toBe("dark");
	});
});

describe("a follow-up sent while the agent works", () => {
	it("reaches the agent with its image, as a prompt of its own", async () => {
		const journal = path.join(tmp("octocode-image-peer-"), "journal.jsonl");
		const peer = fileURLToPath(new URL("./fixtures/image-peer.mjs", import.meta.url));
		const { agentDir, cwd } = setup({
			externalModels: [{ id: "img", kind: "acp", command: process.execPath, args: [peer, journal] }],
		});
		const [route] = externalRoutes({ states: [], cwd, agentDir, projectTrusted: false }).routes;
		const backend = createRouteBackend(route);
		await backend.bind("s1", cwd);
		const prompts = () =>
			fs.existsSync(journal)
				? fs
						.readFileSync(journal, "utf8")
						.split("\n")
						.filter(Boolean)
						.map((line) => JSON.parse(line) as { types: string[]; text: string })
				: [];
		const start = (messages: Message[], signal?: AbortSignal) => {
			backend.markTurn();
			return backend.provider.streamSimple(
				route.models[0],
				normalizeContext({ systemPrompt: "", messages }),
				{ sessionId: "s1", ...(signal ? { signal } : {}) },
			);
		};
		const first = new AbortController();
		const opening = start([{ role: "user", content: "first", timestamp: 1 }], first.signal);
		await vi.waitFor(() => expect(prompts()).toHaveLength(1));
		const followUp = start([{ role: "user", content: "first", timestamp: 1 }, withPicture]);
		await followUp.result();
		first.abort();
		await opening.result();
		await backend.close();
		expect(prompts()[0].types).toEqual(["text"]);
		expect(prompts()[1].types).toEqual(["text", "image"]);
		expect(prompts()[1].text).toContain("what is this?");
	});
});

describe("a prompt of an image alone", () => {
	it("has no text block", () => {
		expect(promptBlocks("", [{ data: "AAAA", mimeType: "image/png" }])).toEqual([
			{ type: "image", data: "AAAA", mimeType: "image/png" },
		]);
	});
});
