import { methods } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { harness } from "./acp-test-harness.ts";

describe("ACP session config options", () => {
	it("returns the worker's models from session/new and switches the model through session/set_config_option", async () => {
		const h = harness();
		await h.initialize();
		const created = await h.newSession();
		expect(created.configOptions).toEqual([
			{
				id: "model",
				name: "Model",
				category: "model",
				type: "select",
				currentValue: "fixture/one",
				options: [
					{ value: "fixture/one", name: "fixture/one" },
					{ value: "fixture/two", name: "fixture/two" },
				],
			},
		]);
		const changed = await h.connection.agent.request(methods.agent.session.setConfigOption, {
			sessionId: created.sessionId,
			configId: "model",
			value: "fixture/two",
		});
		expect(h.workers[0].setModel).toHaveBeenCalledWith("fixture/two");
		expect(changed.configOptions[0]).toMatchObject({ id: "model", currentValue: "fixture/two" });
	});

	it("refuses an unknown option, an unknown model and an unknown session without changing the model", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const set = (id: string, configId: string, value: string) =>
			h.connection.agent.request(methods.agent.session.setConfigOption, { sessionId: id, configId, value });
		await expect(set(sessionId, "mode", "x")).rejects.toThrow();
		await expect(set(sessionId, "model", "nope/none")).rejects.toThrow();
		await expect(set("missing", "model", "fixture/two")).rejects.toThrow();
		expect(h.workers[0].setModel).not.toHaveBeenCalled();
	});
});
