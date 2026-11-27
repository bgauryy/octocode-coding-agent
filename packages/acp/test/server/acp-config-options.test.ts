import { methods } from "@agentclientprotocol/sdk";
import { describe, expect, it } from "vitest";
import { deferred, harness } from "./acp-test-harness.ts";

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

	it("switches to a model whose plan allows interactive use only, with a notice beside it", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		worker.getModels.mockImplementation(async () => ({
			current: worker.model,
			available: ["fixture/one", "fixture/two"],
			interactiveOnly: ["fixture/two"],
		}));
		const changed = await h.connection.agent.request(methods.agent.session.setConfigOption, {
			sessionId,
			configId: "model",
			value: "fixture/two",
		});
		expect(worker.setModel).toHaveBeenCalledWith("fixture/two");
		expect(changed.configOptions[0]).toMatchObject({
			currentValue: "fixture/two",
			options: [
				{ value: "fixture/one", name: "fixture/one" },
				{
					value: "fixture/two",
					name: "fixture/two",
					description: "The vendor's plan allows interactive use only.",
				},
			],
		});
	});

	it("refuses a model change when a prompt starts while the model catalog is loading", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		const listing = deferred<Awaited<ReturnType<typeof worker.getModels>>>();
		const listed = deferred<void>();
		const prompted = deferred<void>();
		worker.getModels.mockImplementationOnce(() => {
			listed.resolve();
			return listing.promise;
		});
		worker.prompt.mockImplementationOnce(async () => {
			prompted.resolve();
			return "started";
		});
		const change = h.connection.agent.request(methods.agent.session.setConfigOption, {
			sessionId,
			configId: "model",
			value: "fixture/two",
		});
		await listed.promise;
		const prompt = h.prompt(sessionId);
		await prompted.promise;
		listing.resolve({ current: worker.model, available: ["fixture/one", "fixture/two"] });
		try {
			await expect(change).rejects.toThrow("Session is busy");
			expect(worker.setModel).not.toHaveBeenCalled();
			expect(worker.model).toBe("fixture/one");
		} finally {
			worker.finish();
			await prompt;
		}
	});

	it("does not send a pending model change after its worker closes", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		const listing = deferred<Awaited<ReturnType<typeof worker.getModels>>>();
		const listed = deferred<void>();
		worker.getModels.mockImplementationOnce(() => {
			listed.resolve();
			return listing.promise;
		});
		const change = h.connection.agent.request(methods.agent.session.setConfigOption, {
			sessionId,
			configId: "model",
			value: "fixture/two",
		});
		await listed.promise;
		worker.fail();
		listing.resolve({ current: worker.model, available: ["fixture/one", "fixture/two"] });
		await expect(change).rejects.toThrow("Session is closed");
		expect(worker.setModel).not.toHaveBeenCalled();
	});

	it("keeps prompts and other model changes out of a pending mutation, then releases the reservation", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		worker.prompt.mockResolvedValue("handled");
		const changing = deferred<void>();
		const changed = deferred<void>();
		worker.setModel.mockImplementationOnce(async (model) => {
			changing.resolve();
			await changed.promise;
			worker.model = model;
		});
		const set = () =>
			h.connection.agent.request(methods.agent.session.setConfigOption, {
				sessionId,
				configId: "model",
				value: "fixture/two",
			});
		const change = set();
		await changing.promise;
		try {
			await expect(h.prompt(sessionId)).rejects.toThrow("Session is busy");
			await expect(set()).rejects.toThrow("Session is busy");
			expect(worker.prompt).not.toHaveBeenCalled();
			expect(worker.setModel).toHaveBeenCalledTimes(1);
		} finally {
			changed.resolve();
			await change;
		}
		await h.prompt(sessionId);
		expect(worker.model).toBe("fixture/two");
	});

	it("releases the mutation reservation when changing the model fails", async () => {
		const h = harness();
		await h.initialize();
		const { sessionId } = await h.newSession();
		const worker = h.workers[0];
		worker.setModel.mockRejectedValueOnce(new Error("Auth failed"));
		const set = () =>
			h.connection.agent.request(methods.agent.session.setConfigOption, {
				sessionId,
				configId: "model",
				value: "fixture/two",
			});
		await expect(set()).rejects.toThrow("Auth failed");
		await expect(set()).resolves.toMatchObject({ configOptions: [{ currentValue: "fixture/two" }] });
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
