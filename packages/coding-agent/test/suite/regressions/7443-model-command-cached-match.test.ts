import type { Api, Model } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as modelControls from "../../../src/modes/interactive/interactive-mode/model-controls.ts";
import { createFakeHost } from "../../interactive-mode-host.ts";
import { createHarness, type Harness } from "../harness.ts";

function findExactModelMatch(context: object, searchTerm: string): Promise<Model<Api> | undefined> {
	return modelControls.findExactModelMatch(createFakeHost(context), searchTerm);
}

describe("issue #7443 /model cached match", () => {
	let harness: Harness | undefined;

	afterEach(() => {
		harness?.cleanup();
		harness = undefined;
		vi.restoreAllMocks();
	});

	it("matches the availability snapshot without starting a catalog refresh", async () => {
		harness = await createHarness({ models: [{ id: "cached", name: "Cached" }] });
		const refresh = vi.spyOn(harness.session.modelRuntime, "refresh").mockImplementation(() => new Promise(() => {}));
		const context = { session: harness.session, showStatus: vi.fn(), showWarning: vi.fn() };

		const model = await findExactModelMatch(context, harness.models[0].id);

		expect(model?.id).toBe("cached");
		expect(refresh).not.toHaveBeenCalled();
		expect(context.showStatus).not.toHaveBeenCalled();
	});

	it("uses a caller-owned deadline only after a cache miss", async () => {
		harness = await createHarness({ models: [{ id: "cached", name: "Cached" }] });
		const refresh = vi.spyOn(harness.session.modelRuntime, "refresh").mockResolvedValue({
			aborted: true,
			errors: new Map(),
		});
		const context = { session: harness.session, showStatus: vi.fn(), showWarning: vi.fn() };

		await expect(findExactModelMatch(context, "not-cached")).resolves.toBeUndefined();

		expect(refresh).toHaveBeenCalledOnce();
		expect(refresh.mock.calls[0]?.[0]?.signal).toBeInstanceOf(AbortSignal);
		expect(context.showStatus).toHaveBeenCalledWith("Refreshing model catalogs…");
	});
});
