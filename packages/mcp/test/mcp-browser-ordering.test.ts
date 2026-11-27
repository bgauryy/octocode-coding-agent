import { describe, expect, it } from "vitest";
import { createBrowserGuard } from "../src/presets/browser/proxy.ts";
import { tmp } from "../../coding-agent/test/octocode/helpers.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const fakeProxy = async () => ({ port: 1, url: "http://127.0.0.1:1", close: async () => {} }) as never;

describe("browser calls reach the server in call order", () => {
	it("prepares a parallel open and targets in call order although open is slow", async () => {
		const guard = createBrowserGuard({
			running: async () => {
				await sleep(60);
				return false;
			},
			start: fakeProxy,
		});
		const order: string[] = [];
		const cwd = tmp();
		const calls = [
			guard.call("open", {}, cwd).then(() => order.push("open")),
			guard.call("targets", {}, cwd).then(() => order.push("targets")),
			guard.call("run", {}, cwd).then(() => order.push("run")),
		];
		await Promise.all(calls);
		expect(order).toEqual(["open", "targets", "run"]);
		await guard.dispose();
	});

	it("does not let a failed call block the ones after it", async () => {
		let starts = 0;
		const guard = createBrowserGuard({
			running: async () => false,
			start: async () => {
				if (starts++ === 0) throw new Error("proxy refused");
				return fakeProxy();
			},
		});
		const cwd = tmp();
		const first = guard.call("open", {}, cwd);
		const second = guard.call("targets", {}, cwd);
		await expect(first).rejects.toThrow("proxy refused");
		await expect(second).resolves.toMatchObject({ args: {} });
	});

	it("does not let a cancelled call block the queue, and keeps later calls behind earlier ones", async () => {
		const guard = createBrowserGuard({
			running: async () => {
				await sleep(40);
				return false;
			},
			start: fakeProxy,
		});
		const cwd = tmp();
		const controller = new AbortController();
		const order: string[] = [];
		const open = guard.call("open", {}, cwd).then(() => order.push("open"));
		const cancelled = guard.call("targets", {}, cwd, controller.signal);
		const last = guard.call("run", {}, cwd).then(() => order.push("run"));
		controller.abort(new Error("stop"));
		await expect(cancelled).rejects.toThrow("stop");
		await Promise.all([open, last]);
		expect(order).toEqual(["open", "run"]);
		await expect(guard.call("targets", {}, cwd, AbortSignal.abort(new Error("early")))).rejects.toThrow("early");
		await expect(guard.call("targets", {}, cwd)).resolves.toBeDefined();
		await guard.dispose();
	});
});
