/**
 * Image files named in a user-typed prompt (terminal or /web) attach as image content at submit; extension and SDK
 * text is not scanned. Drives a real AgentSession with the faux provider and inspects what the provider received.
 */

import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AgentTool } from "@octocodeai/octocode-agent-core";
import { type Context, fauxAssistantMessage, fauxToolCall } from "@octocodeai/octocode-ai";
import type { ExtensionAPI } from "@octocodeai/octocodecode";
import { Type } from "typebox";
import { afterEach, expect, it, vi } from "vitest";
import { getApplicationPort } from "../../src/core/application/index.ts";
import { createHarness, type Harness, type HarnessOptions } from "./harness.ts";

const PNG = new URL("../../../ai/test/data/red-circle.png", import.meta.url);
const harnesses: Harness[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const harness of harnesses.splice(0)) harness.cleanup();
});

/** A harness whose provider records each request; `dir` holds the test's files and is the session cwd. */
async function setup(options: HarnessOptions = {}) {
	const harness = await createHarness(options);
	harnesses.push(harness);
	const requests: Context[] = [];
	const reply = (context: Context) => {
		requests.push(structuredClone(context));
		return fauxAssistantMessage("seen");
	};
	harness.setResponses([reply, reply, reply]);
	return { harness, requests, dir: harness.tempDir };
}

function png(dir: string, name: string): string {
	const path = join(dir, name);
	mkdirSync(join(path, ".."), { recursive: true });
	copyFileSync(PNG, path);
	return path;
}

/** The last user message the provider received: its text and image count. */
function lastUser(requests: Context[]): { text: string; images: number } {
	const message = requests.at(-1)?.messages.findLast((candidate) => candidate.role === "user");
	if (!message || typeof message.content === "string") return { text: String(message?.content ?? ""), images: 0 };
	return {
		text: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
		images: message.content.filter((part) => part.type === "image").length,
	};
}

/** Submit as the terminal does. */
async function typed(harness: Harness, text: string): Promise<void> {
	await getApplicationPort(harness.session).invoke("prompt", text, { attachImagePaths: true });
}

it("attaches an absolute png path, leaving the text unchanged, and shows it in the transcript", async () => {
	const { harness, requests, dir } = await setup();
	const path = png(dir, "shot.png");
	await typed(harness, `what is in ${path}?`);
	expect(lastUser(requests)).toEqual({ text: `what is in ${path}?`, images: 1 });
	const stored = harness.session.messages.find((message) => message.role === "user");
	const shown = getApplicationPort(harness.session).normalizeMessage(stored);
	expect(shown.content?.filter((block) => block.type === "image")).toHaveLength(1);
});

it("attaches quoted paths with spaces and U+202F, backslash-escaped spaces and file:// URLs", async () => {
	const { harness, requests, dir } = await setup();
	const screenshot = png(dir, "Screen Shots/Screenshot 2026-11-01 at 11.30.13\u202FAM.png");
	const dragged = png(dir, "drag drop/my image.png");
	const url = png(dir, "url dir/pic.png");
	const text = [
		`'${screenshot}'`,
		`"${screenshot.replace("\u202F", " ")}"`,
		dragged.replaceAll(" ", "\\ "),
		pathToFileURL(url).href,
	].join(" and ");
	await typed(harness, text);
	// The two spellings of the screenshot name the same file, so it attaches once.
	expect(lastUser(requests)).toEqual({ text, images: 3 });
});

it("resolves ~/ against the home directory and ./ and ../ against the session cwd", async () => {
	const root = mkdtempSync(join(tmpdir(), "octocode-image-paths-"));
	const cwd = join(root, "work");
	mkdirSync(cwd);
	try {
		const { harness, requests } = await setup({ cwd });
		const home = join(root, "home");
		png(home, "Desktop/home.png");
		vi.stubEnv("HOME", home);
		png(cwd, "local.png");
		png(root, "sibling.png");
		await typed(harness, `compare ~/Desktop/home.png with ./local.png and ../sibling.png`);
		expect(lastUser(requests).images).toBe(3);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

it("keeps missing and non-image paths as plain text without hints", async () => {
	const { harness, requests, dir } = await setup();
	const fake = join(dir, "fake.png");
	writeFileSync(fake, "not an image");
	const text = `read ${fake} and ${join(dir, "missing.png")} and ${dir}`;
	await typed(harness, text);
	expect(lastUser(requests)).toEqual({ text, images: 0 });
});

it("sends the prompt with a hint when an image cannot be read or is over 20 MB", async () => {
	const { harness, requests, dir } = await setup();
	const locked = png(dir, "locked.png");
	chmodSync(locked, 0o000);
	const huge = png(dir, "huge.png");
	truncateSync(huge, 21 * 1024 * 1024);
	try {
		await typed(harness, `${locked} ${huge}`);
	} finally {
		chmodSync(locked, 0o644);
	}
	const sent = lastUser(requests);
	expect(sent.images).toBe(0);
	expect(sent.text).toContain(`[Image not attached: ${locked}:`);
	expect(sent.text).toContain(`[Image not attached: ${huge} is over 20 MB.]`);
});

it("attaches at most 8 images and each real file once", async () => {
	const { harness, requests, dir } = await setup();
	const paths = Array.from({ length: 10 }, (_, index) => png(dir, `many-${index}.png`));
	await typed(harness, paths.join(" "));
	expect(lastUser(requests).images).toBe(8);
	expect(lastUser(requests).text).toContain("not attached");

	const one = png(dir, "one.png");
	symlinkSync(one, join(dir, "link.png"));
	await typed(harness, `${one} again ${one} via ./link.png`);
	expect(lastUser(requests)).toEqual({ text: `${one} again ${one} via ./link.png`, images: 1 });
});

it("does not scan SDK prompts or extension sendUserMessage text", async () => {
	let api: ExtensionAPI | undefined;
	const { harness, requests, dir } = await setup({ extensionFactories: [(extension) => void (api = extension)] });
	const path = png(dir, "shot.png");
	await harness.session.prompt(`sdk ${path}`);
	expect(lastUser(requests)).toEqual({ text: `sdk ${path}`, images: 0 });
	api!.sendUserMessage(`extension ${path}`);
	await vi.waitFor(() => expect(requests).toHaveLength(2));
	await harness.session.waitForIdle();
	expect(lastUser(requests)).toEqual({ text: `extension ${path}`, images: 0 });
});

it("attaches through /web prompt commands", async () => {
	const { harness, requests, dir } = await setup();
	const path = png(dir, "web.png");
	const application = getApplicationPort(harness.session);
	await application.execute({
		id: "web-prompt",
		action: "prompt",
		sessionId: harness.session.sessionId,
		text: `look ${path}`,
	});
	await vi.waitFor(() => expect(requests).toHaveLength(1));
	await harness.session.waitForIdle();
	expect(lastUser(requests)).toEqual({ text: `look ${path}`, images: 1 });
	application.dispose();
});

it("leaves a text-only model's prompt as text", async () => {
	const { harness, requests, dir } = await setup({ models: [{ id: "text-only", input: ["text"] }] });
	const path = png(dir, "shot.png");
	await typed(harness, `see ${path}`);
	expect(lastUser(requests)).toEqual({ text: `see ${path}`, images: 0 });
});

it("attaches images to queued follow-up and steering input while streaming", async () => {
	let release: (() => void) | undefined;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const waitTool: AgentTool = {
		name: "wait",
		label: "Wait",
		description: "Wait for release",
		parameters: Type.Object({}),
		execute: async () => {
			await gate;
			return { content: [{ type: "text", text: "released" }], details: {} };
		},
	};
	const { harness, requests, dir } = await setup({ tools: [waitTool] });
	const record = (context: Context) => {
		requests.push(structuredClone(context));
		return fauxAssistantMessage("seen");
	};
	harness.setResponses([fauxAssistantMessage(fauxToolCall("wait", {}), { stopReason: "toolUse" }), record, record]);
	const started = new Promise<void>((resolve) => {
		const unsubscribe = harness.session.subscribe((event) => {
			if (event.type === "tool_execution_start") {
				unsubscribe();
				resolve();
			}
		});
	});
	const run = harness.session.prompt("start");
	await started;
	const first = png(dir, "follow.png");
	const second = png(dir, "steer.png");
	const port = getApplicationPort(harness.session);
	await port.invoke("prompt", `later ${first}`, { streamingBehavior: "followUp", attachImagePaths: true });
	await port.invoke("steer", `now ${second}`, undefined, { attachImagePaths: true });
	expect(harness.session.getQueuedInputs().map((input) => input.imageCount)).toEqual([1, 1]);
	release?.();
	await run;
	await harness.session.waitForIdle();
	const users = requests.flatMap((context) => context.messages.filter((message) => message.role === "user"));
	const images = (text: string) => {
		const message = users.find(
			(candidate) =>
				Array.isArray(candidate.content) &&
				candidate.content.some((part) => part.type === "text" && part.text === text),
		);
		return Array.isArray(message?.content) ? message.content.filter((part) => part.type === "image").length : -1;
	};
	expect(images(`later ${first}`)).toBe(1);
	expect(images(`now ${second}`)).toBe(1);
});
