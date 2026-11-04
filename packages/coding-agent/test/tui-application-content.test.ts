import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage } from "@octocodeai/octocode-ai";
import { Container, Image, Text, resetCapabilitiesCache, setCapabilities } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import { getApplicationPort } from "../src/core/application/index.ts";
import { ApplicationAssets } from "../src/core/application/assets.ts";
import {
	ContentAttachmentComponent,
	FullContentReader,
} from "../src/modes/interactive/components/application-content.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { subscribeToAgent } from "../src/modes/interactive/interactive-mode/agent-events.ts";
import { getMarkdownTheme, initTheme } from "../src/theme/theme.ts";
import type { InteractiveModeHost } from "../src/modes/interactive/interactive-mode/host.ts";
import { stripAnsi } from "../src/utils/ansi.ts";
import * as imageConvert from "../src/utils/image-convert.ts";
import { createFakeHost } from "./interactive-mode-host.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aPuoAAAAASUVORK5CYII=";
const sessions: AgentSession[] = [];

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "test",
		stopReason: "stop",
		timestamp: 1,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
}

function fixture(messages: AgentMessage[] = []) {
	const listeners = new Set<(event: AgentSessionEvent) => void>();
	const session = {
		sessionId: `content-${sessions.length}`,
		messages,
		isStreaming: false,
		getSteeringMessages: () => [],
		getFollowUpMessages: () => [],
		retryAttempt: 0,
		subscribe(listener: (event: AgentSessionEvent) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		extensionRunner: { getMessageRenderer: () => undefined },
	} as unknown as AgentSession;
	sessions.push(session);
	const host = createFakeHost({
		session,
		chatContainer: new Container(),
		editor: {},
		isInitialized: true,
		getMarkdownTransformers: () => [],
		getMarkdownThemeWithSettings: getMarkdownTheme,
		hiddenThinkingLabel: "Thinking…",
		outputPad: 1,
		pendingTools: new Map(),
		entriesRenderedByRebuild: new Set<string>(),
		uiStore: createUiStore(),
		ui: { requestRender() {} },
		settingsManager: { getShowImages: () => true, getImageWidthCells: () => 20, getShowCacheMissNotices: () => false },
		sessionManager: {
			getCwd: () => "/tmp",
			buildContextEntries: () =>
				messages.map((message, index) => ({
					type: "message",
					id: String(index),
					parentId: null,
					timestamp: new Date(0).toISOString(),
					message,
				})),
		},
		getRegisteredToolDefinition: (): ReturnType<InteractiveModeHost["getRegisteredToolDefinition"]> => undefined,
		programStatus: { handleEvent() {} },
		pendingMessagesContainer: new Container(),
		maybeShowThinkingDropNotice() {},
		maybeShowCacheMissNotice() {},
		maybeShowInstallChangeWarning() {},
		maybeSuggestBugReport() {},
	});
	return {
		host,
		emit(event: AgentSessionEvent) {
			for (const listener of listeners) listener(event);
		},
		text: () => stripAnsi(host.chatContainer.render(100).join("\n")),
	};
}

describe("shared application data in the TUI", () => {
	beforeAll(() => initTheme("dark"));
	afterEach(() => {
		for (const session of sessions.splice(0)) getApplicationPort(session).dispose();
		resetCapabilitiesCache();
	});

	it("renders a user image in Kitty and provides an explicit fallback without graphics", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const { host, emit } = fixture();
		subscribeToAgent(host);
		emit({
			type: "message_start",
			message: { role: "user", content: [{ type: "image", data: PNG, mimeType: "image/png" }], timestamp: 0 },
		});
		expect(host.chatContainer.render(100).join("\n")).toContain("\x1b_G");
		host.unsubscribe?.();
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const restored = fixture();
		restored.host.renderSessionItems([
			{ role: "user", content: [{ type: "image", data: PNG, mimeType: "image/png" }], timestamp: 0 },
		]);
		expect(restored.text()).toContain("Image attachment: image/png");
	});

	it("redraws existing attachments when terminal graphics support arrives or disappears", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const f = fixture();
		f.host.renderSessionItems([
			{ role: "user", content: [{ type: "image", data: PNG, mimeType: "image/png" }], timestamp: 0 },
		]);
		expect(f.text()).toContain("Image attachment: image/png");
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		f.host.chatContainer.invalidate();
		expect(f.host.chatContainer.render(100).join("\n")).toContain("\x1b_G");
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		f.host.chatContainer.invalidate();
		expect(f.text()).toContain("Image attachment: image/png");
		expect(f.host.chatContainer.render(100).join("\n")).not.toContain("\x1b_G");
	});

	it("reuses an image through text revisions and reloads changed or unavailable assets", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const asset = { id: "image-id", revision: "first", mimeType: "image/png", size: 68, name: "first.png" };
		const block = { id: "image-block", type: "image" as const, asset };
		const readAsset = vi.fn(() => ({ asset, encoding: "base64" as const, data: PNG }));
		const attachment = new ContentAttachmentComponent(block, { readAsset });
		const image = attachment.children[0];
		expect(image).toBeInstanceOf(Image);
		for (let i = 0; i < 20; i++) attachment.updateBlock({ ...block, asset: { ...asset } });
		expect(readAsset).toHaveBeenCalledTimes(1);
		expect(attachment.children[0]).toBe(image);

		const changed = { ...block, asset: { ...asset, revision: "second" } };
		attachment.updateBlock(changed);
		expect(readAsset).toHaveBeenCalledTimes(2);
		expect(attachment.children[0]).not.toBe(image);
		const newId = { ...changed, asset: { ...changed.asset, id: "next-image-id" } };
		attachment.updateBlock(newId);
		expect(readAsset).toHaveBeenCalledTimes(3);

		const missing = vi.fn(() => undefined);
		attachment.updateBlock(newId, { readAsset: missing });
		expect(missing).toHaveBeenCalledTimes(1);
		expect(attachment.children[0]).not.toBeInstanceOf(Image);
		attachment.updateBlock(newId, { readAsset });
		expect(readAsset).toHaveBeenCalledTimes(4);
		expect(attachment.children[0]).toBeInstanceOf(Image);
	});

	it("registers one deferred image conversion callback through streamed updates", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		const callbacks: Array<() => void> = [];
		const registration = vi.spyOn(imageConvert, "ensurePngTranscoder").mockImplementation((callback) => {
			callbacks.push(callback);
		});
		try {
			const asset = { id: "jpeg-id", revision: "first", mimeType: "image/jpeg", size: 4 };
			const block = { id: "jpeg-block", type: "image" as const, asset };
			const attachment = new ContentAttachmentComponent(block, {
				readAsset: () => ({ asset, encoding: "base64", data: "AAAA" }),
			});
			for (let i = 0; i < 20; i++) attachment.updateBlock({ ...block, asset: { ...asset } });
			attachment.updateBlock({ ...block, asset: { ...asset, revision: "second" } });
			expect(callbacks).toHaveLength(1);
		} finally {
			registration.mockRestore();
		}
	});

	it("preserves assistant block order and final execution arguments in live and restored transcripts", async () => {
		const message = assistant([
			{ type: "text", text: "BEFORE" },
			{ type: "toolCall", id: "t", name: "inspect", arguments: { path: "old.ts" } },
			{ type: "text", text: "AFTER" },
		]);
		const live = fixture();
		subscribeToAgent(live.host);
		live.emit({ type: "message_start", message });
		live.emit({ type: "message_end", message });
		live.emit({ type: "tool_execution_start", toolCallId: "t", toolName: "inspect", args: { path: "actual.ts" } });
		live.emit({
			type: "tool_execution_end",
			toolCallId: "t",
			toolName: "inspect",
			result: { content: [{ type: "text", text: "RESULT" }], details: {} },
			isError: false,
		});
		await Promise.resolve();
		const rendered = live.text();
		expect(rendered.indexOf("BEFORE")).toBeLessThan(rendered.indexOf("inspect"));
		expect(rendered.indexOf("RESULT")).toBeLessThan(rendered.indexOf("AFTER"));
		expect(rendered).toContain("actual.ts");
		expect(rendered).not.toContain("old.ts");
		expect(live.host.chatContainer.children.filter((child) => child instanceof AssistantMessageComponent)).toHaveLength(
			1,
		);
		const history = fixture();
		history.host.renderSessionItems([
			message,
			{
				role: "toolResult",
				toolCallId: "t",
				toolName: "inspect",
				content: [{ type: "text", text: "RESULT" }],
				isError: false,
				timestamp: 2,
			},
		]);
		const replay = history.text();
		expect(replay.indexOf("BEFORE")).toBeLessThan(replay.indexOf("inspect"));
		expect(replay.indexOf("RESULT")).toBeLessThan(replay.indexOf("AFTER"));
	});

	it("renders citations, full asset-backed text, and explicit unsupported content", () => {
		const { host, emit, text } = fixture();
		subscribeToAgent(host);
		const longText = `START ${"middle ".repeat(800)} END`;
		emit({
			type: "message_start",
			message: assistant([
				{
					type: "text",
					text: longText,
					annotations: [{ type: "url_citation", url: "https://example.com/source", title: "Source" }],
				},
				{ type: "unsupported", providerType: "vendor-artifact", text: "Artifact not supported by this terminal" },
			]),
		});
		expect(text()).toContain("START");
		expect(text()).toContain("END");
		expect(text()).not.toContain("Full content available");
		expect(text()).toContain("https://example.com/source");
		expect(text()).toContain("Artifact not supported by this terminal");
	});

	it("does not lose structured data when rendering custom tools", () => {
		const observed = vi.fn();
		const { host, emit } = fixture();
		host.getRegisteredToolDefinition = () => ({
			renderResult(result) {
				observed(result);
				return new Container();
			},
		});
		subscribeToAgent(host);
		emit({ type: "tool_execution_start", toolCallId: "t", toolName: "structured", args: {} });
		emit({
			type: "tool_execution_end",
			toolCallId: "t",
			toolName: "structured",
			result: { content: [], details: { completed: true }, structuredContent: { records: [1, 2] } },
			isError: false,
		});
		expect(observed).toHaveBeenLastCalledWith(
			expect.objectContaining({ structuredContent: { records: [1, 2] }, details: { completed: true } }),
		);
	});

	it("resolves full message and tool assets before handing data to renderers", () => {
		const calls = vi.fn();
		const results = vi.fn();
		const { host, emit, text } = fixture();
		host.getRegisteredToolDefinition = () => ({
			renderCall(args) {
				calls(args);
				return new Text("FULL CALL", 0, 0);
			},
			renderResult(result) {
				results(result);
				return new Text("FULL RESULT", 0, 0);
			},
		});
		subscribeToAgent(host);
		const args = { payload: "x".repeat(70000), path: "actual.ts" };
		const message = assistant([
			{ type: "toolCall", id: "large", name: "structured", arguments: args },
			{ type: "text", text: "AFTER LARGE CALL" },
		]);
		emit({ type: "message_start", message });
		emit({ type: "message_end", message });
		emit({ type: "tool_execution_start", toolCallId: "large", toolName: "structured", args });
		const structuredContent = { data: "record ".repeat(2000) };
		emit({
			type: "tool_execution_end",
			toolCallId: "large",
			toolName: "structured",
			result: { content: [{ type: "text", text: "done" }], details: { note: "retained" }, structuredContent },
			isError: false,
		});
		expect(calls).toHaveBeenLastCalledWith(args);
		expect(results).toHaveBeenLastCalledWith(
			expect.objectContaining({ structuredContent, details: { note: "retained" } }),
		);
		expect(text().indexOf("FULL RESULT")).toBeLessThan(text().indexOf("AFTER LARGE CALL"));
	});

	it("restores nested full content and error metadata while retaining current lifecycle state", () => {
		const assets = new ApplicationAssets({ memory: true });
		const complete = {
			id: "nested",
			role: "assistant",
			text: "complete answer",
			complete: false,
			content: [{ id: "text", type: "text", text: "complete answer" }],
			stopReason: "error",
			errorMessage: "provider failure",
			model: "source-model",
		};
		const deep = assets.put(JSON.stringify(complete), "application/json");
		const outer = assets.put(
			JSON.stringify({ ...complete, text: "preview", content: [], full: deep }),
			"application/json",
		);
		const message = new FullContentReader().message(
			{ id: "nested", role: "assistant", text: "preview", content: [], complete: true, status: "failed", full: outer },
			(id) => assets.get(id),
		);
		expect(message).toMatchObject({
			text: "complete answer",
			content: complete.content,
			complete: true,
			status: "failed",
			errorMessage: "provider failure",
			model: "source-model",
		});
	});

	it("replaces the transcript on a same-session context reset", () => {
		const messages: AgentMessage[] = [{ role: "user", content: "OLD BRANCH", timestamp: 0 }];
		const { host, text } = fixture(messages);
		host.renderSessionItems(messages);
		subscribeToAgent(host);
		messages.splice(0, 1, { role: "user", content: "NEW BRANCH", timestamp: 2 });
		const port = getApplicationPort(host.session);
		port.publishDomain({
			type: "session.reset",
			messages: messages.map((message) => port.normalizeMessage(message)),
			tools: [],
			errors: [
				{
					type: "application.error",
					id: "restore",
					code: "content-unavailable",
					message: "Restored attachment unavailable",
				},
			],
		});
		expect(text()).toContain("NEW BRANCH");
		expect(text()).not.toContain("OLD BRANCH");
		expect(text()).toContain("Restored attachment unavailable");
	});

	it("shows projection failures safely while the next streamed update remains usable", () => {
		const { host, emit, text } = fixture();
		subscribeToAgent(host);
		const message = assistant([{ type: "text", text: "initial" }]);
		emit({ type: "message_start", message });
		const port = getApplicationPort(host.session);
		port.publishDomain({
			type: "application.error",
			id: "capacity",
			code: "content-unavailable",
			message: "Asset unavailable\x1b[2J",
		});
		const normalized = port.normalizeMessage(message);
		port.publishDomain({
			type: "message.delta",
			messageId: normalized.id,
			delta: "",
			text: "continued",
			content: [{ id: `${normalized.id}:0`, type: "text", text: "continued" }],
		});
		expect(text()).toContain("Asset unavailable");
		expect(text()).toContain("continued");
		expect(host.chatContainer.render(100).join("\n")).not.toContain("\x1b[2J");
	});

	it("keeps skill invocation folding identical in live and restored user rows", () => {
		const message = {
			role: "user" as const,
			content: '<skill name="example" location="/tmp/example/SKILL.md">\nSkill instructions\n</skill>\n\nRun this task',
			timestamp: 0,
		};
		const live = fixture();
		subscribeToAgent(live.host);
		live.emit({ type: "message_start", message });
		const restored = fixture();
		restored.host.renderSessionItems([message]);
		for (const view of [live, restored]) {
			expect(view.text()).toContain("[skill]");
			expect(view.text()).toContain("Run this task");
			expect(view.text()).not.toContain("Skill instructions");
			const skill = view.host.chatContainer.children.find((child) => child instanceof SkillInvocationMessageComponent);
			expect(skill).toBeDefined();
			(skill as SkillInvocationMessageComponent).setExpanded(true);
			expect(view.text()).toContain("Skill instructions");
		}
	});
});
