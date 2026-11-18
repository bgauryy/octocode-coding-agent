import type { AgentMessage } from "@octocodeai/octocode-agent-core";
import type { AssistantMessage } from "@octocodeai/octocode-ai";
import type { ApplicationMessage } from "@octocodeai/octocode-contracts";
import { Container, Image, Text, resetCapabilitiesCache, setCapabilities } from "@octocodeai/octocode-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { AgentSession, AgentSessionEvent } from "../src/core/agent-session.ts";
import type { SessionEntry } from "../src/core/session-manager.ts";
import {
	loadEarlierMessages,
	renderWindowedEntries,
} from "../src/modes/interactive/interactive-mode/session-window.ts";
import { getApplicationPort } from "../src/core/application/index.ts";
import { ApplicationAssets } from "../src/core/application/assets.ts";
import {
	ContentAttachmentComponent,
	FullContentReader,
} from "../src/modes/interactive/components/application-content.ts";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { SkillInvocationMessageComponent } from "../src/modes/interactive/components/skill-invocation-message.ts";
import { rebuildChatFromMessages } from "../src/modes/interactive/interactive-mode/session-render.ts";
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
		featureHost: { getMessageRenderer: () => undefined },
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
			buildContextEntries: (): SessionEntry[] =>
				messages.map((message, index) => ({
					type: "message",
					id: String(index),
					parentId: null,
					timestamp: new Date(0).toISOString(),
					message,
				})),
		},
		getRegisteredToolDefinition: (): ReturnType<InteractiveModeHost["getRegisteredToolDefinition"]> => undefined,
		programStatus: { handleEvent() {}, setPhase() {} },
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

	it.each([
		["single", false],
		["multiple", false],
		["overlapping", false],
		["single", true],
		["multiple", true],
		["overlapping", true],
	] as const)(
		"keeps interleaved %s tool results intact across history windows (earlier page: %s)",
		(kind, earlierPage) => {
			const call = (...ids: string[]) =>
				assistant(
					ids.map((id) => ({ type: "toolCall" as const, id, name: "inspect", arguments: { path: `${id}.ts` } })),
				);
			const result = (id: string): AgentMessage => ({
				role: "toolResult",
				toolCallId: id,
				toolName: "inspect",
				content: [{ type: "text", text: `RESULT-${id}` }],
				isError: false,
				timestamp: 2,
			});
			const notice: AgentMessage = {
				role: "custom",
				customType: "child-report",
				content: "CHILD REPORT",
				display: true,
				timestamp: 3,
			};
			const block =
				kind === "single"
					? [call("A"), notice, result("A")]
					: kind === "multiple"
						? [call("A", "B"), notice, result("B"), notice, result("A")]
						: [call("A"), notice, call("B"), result("A"), notice, result("B")];
			const messages: AgentMessage[] = [
				...Array.from({ length: 450 }, (_, i): AgentMessage => ({
					role: "user",
					content: `earlier ${i}`,
					timestamp: i,
				})),
				...block,
				...Array.from({ length: earlierPage ? 200 : 0 }, (_, i): AgentMessage => ({
					role: "user",
					content: `later ${i}`,
					timestamp: 1000 + i,
				})),
			];
			const entries = messages.map((message, i) => ({
				type: "message",
				id: `e${i}`,
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message,
			})) as SessionEntry[];
			const full = fixture();
			full.host.renderSessionEntries(entries);
			const windowed = fixture();
			renderWindowedEntries(windowed.host, entries, {}, 1);
			if (earlierPage) expect(loadEarlierMessages(windowed.host)).toBe(true);
			expect(windowed.text()).toContain("RESULT-A");
			if (kind !== "single") expect(windowed.text()).toContain("RESULT-B");
			expect(windowed.host.pendingTools.size).toBe(0);
			while (loadEarlierMessages(windowed.host));
			expect(windowed.text()).toBe(full.text());
			expect(windowed.host.pendingTools.size).toBe(0);
		},
	);

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

	it("reads a finished call's large structured output from its asset only when a renderer reads it", () => {
		const results: Array<{ structuredContent?: unknown; details?: unknown }> = [];
		const { host, emit } = fixture();
		host.getRegisteredToolDefinition = () => ({
			renderResult(result) {
				results.push(result);
				return new Container();
			},
		});
		subscribeToAgent(host);
		emit({ type: "tool_execution_start", toolCallId: "big", toolName: "structured", args: {} });
		const output = "line of output\n".repeat(10_000);
		emit({
			type: "tool_execution_end",
			toolCallId: "big",
			toolName: "structured",
			result: {
				content: [{ type: "text", text: "tail" }],
				details: { kept: 1 },
				structuredContent: { output, exit_code: 0 },
			},
			isError: false,
		});
		const last = results.at(-1)!;
		const structured = last.structuredContent as { output: string; exit_code: number };
		expect(last.details).toEqual({ kept: 1 });
		// A scan over the values (the purpose rows) leaves the output unread; reading it by name loads it.
		expect(Object.values(structured)).toEqual([0]);
		expect(structured.output).toBe(output);
		expect(structured.exit_code).toBe(0);
	});

	it("shares one reader and forgets a finished message's asset once its row holds it", () => {
		const assets = new ApplicationAssets({ memory: true });
		const reader = new FullContentReader();
		const read = vi.fn((id: string) => assets.get(id));
		const full = assets.put(
			JSON.stringify({ id: "m", role: "assistant", text: "whole", content: [], complete: true, status: "completed" }),
			"application/json",
		);
		const preview: ApplicationMessage = {
			id: "m",
			role: "assistant",
			text: "preview",
			content: [],
			complete: true,
			status: "completed",
			full,
		};
		expect(reader.message(preview, read).text).toBe("whole");
		reader.message(preview, read);
		expect(read).toHaveBeenCalledTimes(1);
		reader.forget(full);
		expect(reader.message(preview, read).text).toBe("whole");
		expect(read).toHaveBeenCalledTimes(2);
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

	it.each([false, true])("keeps an old live tool across reset (failed=%s)", (failed) => {
		const messages: AgentMessage[] = [
			assistant([{ type: "toolCall", id: "old-live", name: "bash", arguments: { command: "slow" } }]),
		];
		const { host, text } = fixture(messages);
		host.renderSessionItems(messages);
		expect(host.pendingTools.has("old-live")).toBe(true);
		const live = host.pendingTools.get("old-live");
		const disposed = vi.spyOn(live, "dispose");
		for (let index = 0; index < 450; index++)
			messages.push({ role: "user", content: `report ${index}`, timestamp: index });
		subscribeToAgent(host);
		const port = getApplicationPort(host.session);
		port.publishDomain({
			type: "tool.progress",
			toolCallId: "old-live",
			toolName: "bash",
			text: "PARTIAL LIVE RESULT",
		});
		port.publishDomain({
			type: "session.reset",
			messages: messages.map((message) => port.normalizeMessage(message)),
			tools: [],
		});
		expect(host.pendingTools.get("old-live")).toBe(live);
		expect(disposed).not.toHaveBeenCalled();
		expect(text()).toContain("PARTIAL LIVE RESULT");
		expect(host.chatContainer.children.length).toBeLessThan(410);
		port.publishDomain({
			type: "tool.completed",
			toolCallId: "old-live",
			toolName: "bash",
			text: "FINAL LIVE RESULT",
			failed,
		});
		expect(text()).toContain("FINAL LIVE RESULT");
		expect(host.pendingTools.has("old-live")).toBe(false);
		messages.push({
			role: "toolResult",
			toolCallId: "old-live",
			toolName: "bash",
			content: [{ type: "text", text: "FINAL LIVE RESULT" }],
			isError: failed,
			timestamp: 1000,
		});
		while (loadEarlierMessages(host));
		const full = fixture(messages);
		full.host.renderSessionEntries(full.host.sessionManager.buildContextEntries());
		expect(text()).toBe(full.text());
		expect(host.pendingTools.size).toBe(0);
	});

	it("keeps an old live tool across a direct transcript rebuild", () => {
		const messages: AgentMessage[] = [assistant([{ type: "toolCall", id: "old-live", name: "bash", arguments: {} }])];
		const { host } = fixture(messages);
		host.renderSessionItems(messages);
		for (let index = 0; index < 450; index++)
			messages.push({ role: "user", content: `report ${index}`, timestamp: index });
		rebuildChatFromMessages(host);
		expect(host.pendingTools.has("old-live")).toBe(true);
	});

	it.each(["cold", "error", "aborted", "completed"] as const)("keeps %s old calls bounded", (state) => {
		const call = assistant([{ type: "toolCall", id: "old", name: "bash", arguments: {} }]);
		if (state === "error" || state === "aborted") call.stopReason = state;
		const messages: AgentMessage[] = [call];
		if (state === "completed")
			messages.push({
				role: "toolResult",
				toolCallId: "old",
				toolName: "bash",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: 0,
			});
		for (let index = 0; index < 450; index++)
			messages.push({ role: "user", content: `report ${index}`, timestamp: index });
		const { host, text } = fixture(messages);
		renderWindowedEntries(host, host.sessionManager.buildContextEntries(), {
			liveToolIds: state === "cold" ? undefined : new Set(["old"]),
		});
		expect(host.pendingTools.has("old")).toBe(false);
		expect(text()).toContain("earlier entries not shown");
		expect(text()).not.toContain("report 0");
	});

	it.each([false, true])("fills sparse live-tool gaps newest first (compaction=%s)", (compaction) => {
		const call = (id: string) => assistant([{ type: "toolCall", id, name: "inspect", arguments: {} }]);
		const messages: AgentMessage[] = [];
		for (let index = 0; index < 1000; index++)
			messages.push(
				index === 100
					? call("A")
					: index === 500
						? call("B")
						: { role: "user", content: `row-${index}-end`, timestamp: index },
			);
		const windowed = fixture(messages);
		const entries = windowed.host.sessionManager.buildContextEntries();
		if (compaction)
			entries.unshift({
				type: "compaction",
				id: "summary",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				summary: "Earlier work",
				firstKeptEntryId: "0",
				tokensBefore: 1000,
			});
		windowed.host.sessionManager.buildContextEntries = () => entries;
		windowed.host.renderSessionItems([messages[100], messages[500]]);
		const original = new Map(windowed.host.pendingTools);
		const keepRowsInView = vi.fn();
		windowed.host.transcriptScrollView = { keepRowsInView } as unknown as InteractiveModeHost["transcriptScrollView"];
		rebuildChatFromMessages(windowed.host);
		expect(windowed.host.chatContainer.children.length).toBeLessThan(410);
		expect(windowed.host.pendingTools.get("A")).toBe(original.get("A"));
		expect(windowed.host.pendingTools.get("B")).toBe(original.get("B"));
		expect(loadEarlierMessages(windowed.host)).toBe(true);
		expect(windowed.text()).toContain("row-700-end");
		expect(windowed.text()).not.toContain("row-300-end");
		expect(keepRowsInView).toHaveBeenCalledOnce();
		while (loadEarlierMessages(windowed.host));
		const full = fixture(messages);
		full.host.renderSessionEntries(entries);
		expect(windowed.text()).toBe(full.text());
		expect(windowed.host.pendingTools.get("A")).toBe(original.get("A"));
		expect(windowed.host.pendingTools.get("B")).toBe(original.get("B"));
	});

	it("keeps old saved tools beside the streaming reply without duplicate subscriptions or rows", () => {
		const call = (id: string) => assistant([{ type: "toolCall", id, name: "inspect", arguments: {} }]);
		const messages: AgentMessage[] = [call("old")];
		const { host } = fixture(messages);
		host.renderSessionItems([messages[0], call("streaming")]);
		const parents = host.chatContainer.children.filter((child) => child instanceof AssistantMessageComponent);
		const oldParent = parents[0];
		const liveParent = parents[1];
		host.streamingComponent = liveParent;
		const oldDisposed = vi.spyOn(oldParent, "dispose");
		const liveDisposed = vi.spyOn(liveParent, "dispose");
		const tools = new Map(host.pendingTools);
		for (let index = 0; index < 450; index++)
			messages.push({ role: "user", content: `report ${index}`, timestamp: index });
		rebuildChatFromMessages(host);
		expect(oldDisposed).toHaveBeenCalledOnce();
		expect(liveDisposed).not.toHaveBeenCalled();
		expect(host.chatContainer.children.filter((child) => child === liveParent)).toHaveLength(1);
		const count = (component: unknown, target: unknown): number => {
			const children = (component as { children?: unknown[] }).children ?? [];
			return Number(component === target) + children.reduce<number>((total, child) => total + count(child, target), 0);
		};
		for (const [id, tool] of tools) {
			expect(host.pendingTools.get(id)).toBe(tool);
			expect(count(host.chatContainer, tool)).toBe(1);
		}
		expect(host.pendingTools.size).toBe(2);
	});

	it.each([null, undefined])("rebuilds old histories with missing assistant content (%s)", (content) => {
		const messages: AgentMessage[] = [assistant([{ type: "toolCall", id: "live", name: "inspect", arguments: {} }])];
		const { host } = fixture(messages);
		host.renderSessionItems(messages);
		const live = host.pendingTools.get("live");
		messages.push({ ...assistant([]), content } as unknown as AssistantMessage);
		for (let index = 0; index < 450; index++)
			messages.push({ role: "user", content: `report ${index}`, timestamp: index });
		expect(() => rebuildChatFromMessages(host)).not.toThrow();
		expect(host.pendingTools.get("live")).toBe(live);
	});

	it("keeps completed tools sparse across thousands of reports", () => {
		const messages: AgentMessage[] = [assistant([{ type: "toolCall", id: "old", name: "inspect", arguments: {} }])];
		for (let index = 0; index < 5000; index++)
			messages.push({
				role: "custom",
				customType: "child-report",
				content: `report ${index}`,
				display: true,
				timestamp: index,
			});
		messages.push({
			role: "toolResult",
			toolCallId: "old",
			toolName: "inspect",
			content: [{ type: "text", text: "FIRST RESULT" }],
			isError: false,
			timestamp: 5001,
		});
		messages.push({
			role: "toolResult",
			toolCallId: "old",
			toolName: "inspect",
			content: [{ type: "text", text: "IGNORED REPEAT" }],
			isError: false,
			timestamp: 5002,
		});
		const windowed = fixture(messages);
		const entries = windowed.host.sessionManager.buildContextEntries();
		let reads = 0;
		const counted = new Proxy(entries, {
			get(target, key, receiver) {
				if (typeof key === "string" && /^\d+$/.test(key)) reads++;
				return Reflect.get(target, key, receiver);
			},
		});
		renderWindowedEntries(windowed.host, counted);
		expect(windowed.host.chatContainer.children.length).toBeLessThan(410);
		expect(windowed.text()).toContain("FIRST RESULT");
		expect(windowed.text()).not.toContain("IGNORED REPEAT");
		expect(windowed.host.pendingTools.size).toBe(0);
		while (loadEarlierMessages(windowed.host));
		expect(reads).toBeLessThan(entries.length * 4);
		const full = fixture(messages);
		full.host.renderSessionEntries(entries);
		expect(windowed.text()).toBe(full.text());
	});

	it.each([1, 7, 23, 101, 997, 4093])(
		"matches full rendering with deterministic crossed/reused/orphan history (seed=%s)",
		(seed) => {
			let state = seed;
			const random = (limit: number) => {
				state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
				return state % limit;
			};
			const messages: AgentMessage[] = [];
			for (let index = 0; index < 650; index++) {
				const kind = random(5);
				if (kind === 0) {
					const message = assistant(
						Array.from({ length: 1 + random(2) }, () => ({
							type: "toolCall" as const,
							id: `id-${random(31)}`,
							name: "inspect",
							arguments: { at: index },
						})),
					);
					if (random(9) === 0) message.stopReason = "error";
					messages.push(message);
				} else if (kind === 1)
					messages.push({
						role: "toolResult",
						toolCallId: `id-${random(35)}`,
						toolName: "inspect",
						content: [{ type: "text", text: `result-${index}` }],
						isError: Boolean(random(2)),
						timestamp: index,
					});
				else
					messages.push({
						role: "custom",
						customType: "child-report",
						content: `report-${index}`,
						display: true,
						timestamp: index,
					});
			}
			const windowed = fixture(messages);
			const entries = windowed.host.sessionManager.buildContextEntries();
			renderWindowedEntries(windowed.host, entries, {}, 7);
			let pages = 0;
			while (loadEarlierMessages(windowed.host)) expect(++pages).toBeLessThan(20);
			const full = fixture(messages);
			full.host.renderSessionEntries(entries);
			expect(windowed.text()).toBe(full.text());
		},
	);

	it("does not link completed pairs merely because a provider reused the call ID", () => {
		const messages: AgentMessage[] = [];
		for (let index = 0; index < 1000; index++) {
			messages.push(assistant([{ type: "toolCall", id: "reused", name: "inspect", arguments: { index } }]));
			messages.push({
				role: "toolResult",
				toolCallId: "reused",
				toolName: "inspect",
				content: [{ type: "text", text: `result-${index}` }],
				isError: false,
				timestamp: index,
			});
			messages.push({
				role: "custom",
				customType: "child-report",
				content: `report-${index}`,
				display: true,
				timestamp: index,
			});
		}
		const windowed = fixture(messages);
		const entries = windowed.host.sessionManager.buildContextEntries();
		renderWindowedEntries(windowed.host, entries);
		expect(windowed.host.chatContainer.children.length).toBeLessThan(410);
		expect(windowed.text()).toContain("result-999");
		expect(windowed.text()).not.toContain("result-0");
		expect(windowed.host.pendingTools.size).toBe(0);
		while (loadEarlierMessages(windowed.host));
		const full = fixture(messages);
		full.host.renderSessionEntries(entries);
		expect(windowed.text()).toBe(full.text());
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
