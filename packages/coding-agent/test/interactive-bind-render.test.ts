import { describe, expect, it, vi } from "vitest";
import { bindRender } from "../src/modes/interactive/state/bind-render.ts";
import { createUiStore } from "../src/modes/interactive/state/store.ts";

describe("bindRender", () => {
	it("requests one frame per real change in any slice and none for a no-op", () => {
		const store = createUiStore();
		const requestRender = vi.fn();
		const stop = bindRender(store, { requestRender });
		const actions = store.getState();

		actions.setHideThinking(true);
		expect(requestRender).toHaveBeenCalledTimes(1);
		actions.setHideThinking(true);
		expect(requestRender).toHaveBeenCalledTimes(1);

		actions.setBashMode(true);
		actions.setBashMode(true);
		actions.takeSlot({});
		expect(requestRender).toHaveBeenCalledTimes(3);

		stop();
		actions.setBashMode(false);
		expect(requestRender).toHaveBeenCalledTimes(3);
	});
});
