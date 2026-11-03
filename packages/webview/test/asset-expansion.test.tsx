/** @vitest-environment jsdom */
import { Blob as NodeBlob } from "node:buffer";
import type { ReactNode } from "react";
import type { ApplicationAsset, ApplicationMessage, ApplicationTool } from "@octocodeai/octocode-contracts";
import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { ResultCard } from "../src/app/live/ResultCard.tsx";
import { LiveProvider } from "../src/app/live/session.tsx";
import { FakeSocket } from "./helpers.ts";

const full: ApplicationAsset = { id: "full", mimeType: "application/json", size: 100 };
const image: ApplicationAsset = { id: "image", mimeType: "image/png", size: 1, name: "result.png" };
let fullValue: unknown;
const payloads = new Map<string, unknown>();
const reads: string[] = [];
const NativeURL = URL;
beforeEach(() => {
	FakeSocket.instances = [];
	payloads.clear();
	reads.length = 0;
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("Blob", NodeBlob);
	vi.stubGlobal(
		"URL",
		class extends NativeURL {
			static createObjectURL() {
				return "blob:result";
			}
			static revokeObjectURL() {}
		},
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL) => {
			const id = new NativeURL(String(url), "http://localhost").pathname.split("/").at(-1)!;
			reads.push(id);
			return new Response(
				JSON.stringify(
					id === "image"
						? { asset: image, encoding: "base64", data: "eA==" }
						: {
								asset: { ...full, id },
								encoding: "utf8",
								data: JSON.stringify(id === "full" ? fullValue : payloads.get(id)),
							},
				),
			);
		}),
	);
});
afterEach(() => vi.unstubAllGlobals());
function Wrapper({ children }: { children: ReactNode }) {
	return (
		<LiveProvider
			access="token"
			backlog={createBacklogStore({ repo: "r", generatedAt: 0, states: ["todo"], idleMs: 1, items: [] })}
		>
			{children}
		</LiveProvider>
	);
}

it("expands a full message into validated ordered rich content", async () => {
	const message: ApplicationMessage = { id: "m", role: "assistant", text: "Preview", complete: true, full };
	fullValue = {
		...message,
		full: undefined,
		content: [
			{ id: "t", type: "text", text: "Complete answer" },
			{ id: "i", type: "image", asset: image },
		],
	};
	render(<ResultCard event={{ id: -1, at: 1, type: "message", text: "Preview", sessionId: "s", message }} />, {
		wrapper: Wrapper,
	});
	await userEvent.click(screen.getByRole("button", { name: "Load full message" }));
	await screen.findByText("Complete answer");
	expect(await screen.findByRole("img", { name: "result.png" })).toHaveAttribute("src", "blob:result");
	expect(screen.queryByText("Preview")).toBeNull();
});

it("merges a full partial tool result with its call identity before rendering", async () => {
	const tool: ApplicationTool = { toolCallId: "t", toolName: "screenshot", text: "Preview", status: "completed", full };
	fullValue = { content: [{ id: "i", type: "image", asset: image }], structuredContent: { page: "example" } };
	render(
		<ResultCard event={{ id: -1, at: 1, type: "tool.result", text: "screenshot\nPreview", sessionId: "s", tool }} />,
		{ wrapper: Wrapper },
	);
	await userEvent.click(screen.getByRole("button", { name: "Load full tool result" }));
	expect(await screen.findByRole("img", { name: "result.png" })).toHaveAttribute("src", "blob:result");
	expect(screen.getByText(/"page": "example"/)).toBeInTheDocument();
});

it("rejects a full payload for another message instead of replacing the displayed one", async () => {
	const message: ApplicationMessage = { id: "m", role: "assistant", text: "Original preview", complete: true, full };
	fullValue = { id: "other", role: "assistant", text: "Wrong message", complete: true };
	render(<ResultCard event={{ id: -1, at: 1, type: "message", text: "Original preview", sessionId: "s", message }} />, {
		wrapper: Wrapper,
	});
	await userEvent.click(screen.getByRole("button", { name: "Load full message" }));
	await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Invalid full message content"));
	expect(screen.getByText("Original preview")).toBeInTheDocument();
	expect(screen.queryByText("Wrong message")).toBeNull();
});

it("follows nested full messages while retaining the outer message identity and outcome", async () => {
	const message: ApplicationMessage = {
		id: "m",
		role: "assistant",
		text: "Preview",
		complete: true,
		status: "failed",
		full,
	};
	fullValue = { ...message, status: "completed", full: { ...full, id: "inner" }, model: "model-a" };
	payloads.set("inner", {
		id: "m",
		role: "assistant",
		complete: false,
		status: "streaming",
		text: "Deep answer",
		content: [
			{ id: "t", type: "text", text: "Deep answer" },
			{ id: "i", type: "image", asset: image },
		],
	});
	render(
		<ResultCard
			event={{
				id: -1,
				at: 1,
				type: "message",
				text: "Preview",
				sessionId: "s",
				message,
				details: { status: "failed" },
			}}
		/>,
		{ wrapper: Wrapper },
	);
	await userEvent.click(screen.getByRole("button", { name: "Load full message" }));
	await screen.findByText("Deep answer");
	expect(await screen.findByRole("img", { name: "result.png" })).toHaveAttribute("src", "blob:result");
	expect(screen.getByText("failed")).toBeInTheDocument();
	expect(screen.getByText("model-a")).toBeInTheDocument();
	expect(reads).toEqual(["full", "inner", "image"]);
});

it("merges nested tool payloads without losing images, arguments, or the final outcome", async () => {
	const tool: ApplicationTool = {
		toolCallId: "t",
		toolName: "screenshot",
		text: "Preview",
		status: "failed",
		arguments: { page: "actual" },
		full,
	};
	fullValue = {
		content: [{ id: "i", type: "image", asset: image }],
		full: { ...full, id: "inner" },
		status: "completed",
	};
	payloads.set("inner", {
		structuredContent: { result: "deep data" },
		arguments: { page: "stale" },
		status: "running",
	});
	render(
		<ResultCard event={{ id: -1, at: 1, type: "tool.result", text: "screenshot\nPreview", sessionId: "s", tool }} />,
		{ wrapper: Wrapper },
	);
	await userEvent.click(screen.getByRole("button", { name: "Load full tool result" }));
	await screen.findByRole("img", { name: "result.png" });
	expect(screen.getByText(/"result": "deep data"/)).toBeInTheDocument();
	expect(screen.getByText(/"page": "actual"/)).toBeInTheDocument();
	expect(screen.queryByText(/"page": "stale"/)).toBeNull();
	expect(screen.getByText("failed")).toBeInTheDocument();
	expect(reads).toEqual(["full", "inner", "image"]);
});

it("reports a cyclic reference and keeps the original preview", async () => {
	const message: ApplicationMessage = { id: "m", role: "assistant", text: "Original preview", complete: true, full };
	fullValue = { ...message, full: { ...full, id: "inner" } };
	payloads.set("inner", { full });
	render(<ResultCard event={{ id: -1, at: 1, type: "message", text: message.text, sessionId: "s", message }} />, {
		wrapper: Wrapper,
	});
	await userEvent.click(screen.getByRole("button", { name: "Load full message" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("Content reference cycle detected");
	expect(screen.getByText("Original preview")).toBeInTheDocument();
	expect(reads).toEqual(["full", "inner"]);
});

it("reports malformed nested payloads before they reach a renderer", async () => {
	const tool: ApplicationTool = {
		toolCallId: "t",
		toolName: "inspect",
		text: "Original preview",
		status: "completed",
		full,
	};
	fullValue = { full: { ...full, id: "inner" } };
	payloads.set("inner", { content: [{ type: "image", asset: "not an asset" }] });
	render(
		<ResultCard
			event={{ id: -1, at: 1, type: "tool.result", text: "inspect\nOriginal preview", sessionId: "s", tool }}
		/>,
		{ wrapper: Wrapper },
	);
	await userEvent.click(screen.getByRole("button", { name: "Load full tool result" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("Invalid full tool content");
	expect(screen.getByText("Original preview")).toBeInTheDocument();
	expect(reads).toEqual(["full", "inner"]);
});

it("stops after eight referenced payloads instead of following an unbounded chain", async () => {
	const message: ApplicationMessage = { id: "m", role: "assistant", text: "Original preview", complete: true, full };
	fullValue = { ...message, full: { ...full, id: "level-1" } };
	for (let index = 1; index < 9; index++)
		payloads.set(`level-${index}`, { full: { ...full, id: `level-${index + 1}` } });
	render(<ResultCard event={{ id: -1, at: 1, type: "message", text: message.text, sessionId: "s", message }} />, {
		wrapper: Wrapper,
	});
	await userEvent.click(screen.getByRole("button", { name: "Load full message" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("Content reference depth limit reached (8)");
	expect(reads).toHaveLength(8);
	expect(reads.at(-1)).toBe("level-7");
	expect(screen.getByText("Original preview")).toBeInTheDocument();
});

it("clears a failed load's alert when the message's full content changes revision", async () => {
	const card = (revision: string) => {
		const message: ApplicationMessage = {
			id: "m",
			role: "assistant",
			text: "Preview",
			complete: true,
			full: { ...full, revision },
		};
		return <ResultCard event={{ id: -1, at: 1, type: "message", text: "Preview", sessionId: "s", message }} />;
	};
	fullValue = { id: "other", role: "assistant", text: "Wrong message", complete: true };
	const view = render(card("one"), { wrapper: Wrapper });
	await userEvent.click(screen.getByRole("button", { name: "Load full message" }));
	expect(await screen.findByRole("alert")).toHaveTextContent("Invalid full message content");
	view.rerender(card("two"));
	expect(screen.queryByRole("alert")).toBeNull();
	expect(screen.getByRole("button", { name: "Load full message" })).toBeEnabled();
});
