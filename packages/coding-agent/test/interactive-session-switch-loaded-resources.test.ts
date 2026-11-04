import { Container } from "@octocodeai/octocode-tui";
import { describe, expect, it } from "vitest";
import { LoadedRow } from "../src/modes/interactive/interactive-mode/loaded-row.ts";
import { renderCurrentSessionState } from "../src/modes/interactive/interactive-mode/session-binding.ts";
import { createFakeHost, heldStore } from "./interactive-mode-host.ts";

/** A state source that counts live listeners, like the MCP status row's event-bus subscription. */
function countingSource() {
	const listeners = new Set<() => void>();
	return {
		listeners,
		getState: () => [],
		subscribe(listener: () => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
}

describe("session switch rendering", () => {
	it("stops the outgoing session's live resource rows before clearing them", () => {
		const source = countingSource();
		const loadedResourcesContainer = new Container();
		loadedResourcesContainer.addChild(
			new LoadedRow(
				{ label: "MCP", count: () => 1, summary: () => "octocode", source },
				() => ({ label: 3, count: 1 }),
				false,
				() => {},
			),
		);
		expect(source.listeners.size).toBe(1);

		const host = createFakeHost({
			loadedResourcesContainer,
			chatContainer: new Container(),
			pendingMessagesContainer: new Container(),
			uiStore: heldStore(),
			pendingTools: new Map(),
			renderInitialMessages: () => {},
		});
		renderCurrentSessionState(host);

		expect(loadedResourcesContainer.children).toHaveLength(0);
		expect(source.listeners.size).toBe(0);
	});
});
