/** @vitest-environment jsdom */
import { Blob as NodeBlob } from "node:buffer";
import type { ReactNode } from "react";
import type { ApplicationAsset, ApplicationSnapshot } from "@octocodeai/octocode-contracts";
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBacklogStore } from "../src/app/extension.ts";
import { ApplicationProjection } from "@octocodeai/octocode-projections";
import { ResultCard } from "../src/app/live/ResultCard.tsx";
import { LiveProvider } from "../src/app/live/session.tsx";
import { FakeSocket } from "./helpers.ts";

const NativeURL = URL;
const urls = new Map<string, Blob>();
let current: ApplicationAsset;

beforeEach(() => {
	urls.clear();
	FakeSocket.instances = [];
	vi.stubGlobal("WebSocket", FakeSocket);
	vi.stubGlobal("Blob", NodeBlob);
	vi.stubGlobal(
		"URL",
		class extends NativeURL {
			static createObjectURL(blob: Blob) {
				const url = `blob:asset-${urls.size + 1}`;
				urls.set(url, blob);
				return url;
			}
			static revokeObjectURL() {}
		},
	);
	vi.stubGlobal(
		"fetch",
		vi.fn(
			async () =>
				new Response(JSON.stringify({ asset: current, encoding: "utf8", data: "<script>alert(1)</script>" }), {
					status: 200,
				}),
		),
	);
});
afterEach(() => vi.unstubAllGlobals());

function Wrapper({ children }: { children: ReactNode }) {
	return (
		<LiveProvider
			access="t"
			backlog={createBacklogStore({ repo: "r", generatedAt: 0, states: ["todo"], idleMs: 1, items: [] })}
		>
			{children}
		</LiveProvider>
	);
}

async function downloadBlob(asset: ApplicationAsset): Promise<Blob> {
	current = asset;
	const snapshot: ApplicationSnapshot = {
		sessionId: "s",
		messages: [
			{
				id: "m",
				role: "assistant",
				text: "",
				complete: true,
				content: [{ id: "b", type: "media", asset, mimeType: asset.mimeType }],
			},
		],
		streaming: false,
		steering: [],
		followUp: [],
		receipts: [],
		capabilities: [],
	};
	const [event] = new ApplicationProjection().update(snapshot, 1);
	render(<ResultCard event={event} />, { wrapper: Wrapper });
	const link = await screen.findByRole("link", { name: `Download ${asset.name}` });
	return urls.get(link.getAttribute("href")!)!;
}

it.each(["text/html", "image/svg+xml", "application/xhtml+xml"])(
	"links a %s asset as opaque bytes, so opening the link cannot run it in the page's origin",
	async (mimeType) => {
		const blob = await downloadBlob({ id: "a", mimeType, size: 25, name: "page" });
		expect(blob.type).toBe("application/octet-stream");
		expect(await blob.text()).toBe("<script>alert(1)</script>");
	},
);

it("keeps the type of an asset the page previews", async () => {
	const blob = await downloadBlob({ id: "a", mimeType: "image/png", size: 25, name: "picture" });
	expect(blob.type).toBe("image/png");
});
