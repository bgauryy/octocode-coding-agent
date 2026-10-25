import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { expect, it, vi } from "vitest";
import { createHarness } from "./suite/harness.ts";

it("cancels during before_agent_start without entering the provider and permits the next turn", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let first = true;
	const h = await createHarness({
		settings: { retry: { enabled: false } },
		extensionFactories: [
			(api) => {
				api.on("before_agent_start", async () => {
					if (!first) return;
					first = false;
					entered.resolve();
					await release.promise;
				});
			},
		],
	});
	const settled: boolean[] = [];
	h.session.subscribe((event) => {
		if (event.type === "agent_settled") settled.push(event.aborted);
	});
	try {
		await h.session.bindExtensions({});
		h.setResponses([fauxAssistantMessage("response")]);
		const provider = vi.spyOn(h.session.agent, "prompt");
		const prompt = h.session.prompt("cancel before provider");
		await entered.promise;
		const abort = h.session.abort();
		release.resolve();
		await Promise.all([prompt, abort]);
		expect(provider).not.toHaveBeenCalled();
		expect(settled).toEqual([true]);
		await h.session.prompt("later prompt");
		await h.session.waitForIdle();
		expect(provider).toHaveBeenCalledOnce();
		expect(settled).toEqual([true, false]);
	} finally {
		release.resolve();
		h.cleanup();
	}
});
