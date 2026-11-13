import diagnosticsChannel from "node:diagnostics_channel";
import module from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";

/** A fresh copy: whether the cache was written is process state. */
async function fresh() {
	vi.resetModules();
	return import("../src/cli/compile-cache.ts");
}

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));
const requestSent = () => diagnosticsChannel.channel("undici:request:bodySent").publish({});

afterEach(() => vi.restoreAllMocks());

describe("writing the compile cache before exit", () => {
	it("without a screen, writes once, on the turn after the first request body went out", async () => {
		const flush = vi.spyOn(module, "flushCompileCache").mockImplementation(() => {});
		const { flushCompileCacheOnNextRequest } = await fresh();
		flushCompileCacheOnNextRequest();
		expect(flush).not.toHaveBeenCalled();
		requestSent();
		// Not inside the request's own step: the work in hand goes first.
		expect(flush).not.toHaveBeenCalled();
		await nextTurn();
		expect(flush).toHaveBeenCalledTimes(1);
		flushCompileCacheOnNextRequest();
		requestSent();
		await nextTurn();
		expect(flush).toHaveBeenCalledTimes(1);
		expect(diagnosticsChannel.hasSubscribers("undici:request:bodySent")).toBe(false);
	});

	it("in the interactive mode, writes nothing before exit, whatever requests go out", async () => {
		const flush = vi.spyOn(module, "flushCompileCache").mockImplementation(() => {});
		const { flushCompileCacheOnNextRequest, holdCompileCacheFlush } = await fresh();
		flushCompileCacheOnNextRequest();
		holdCompileCacheFlush();
		for (let i = 0; i < 3; i++) {
			requestSent();
			await nextTurn();
		}
		expect(flush).not.toHaveBeenCalled();
		expect(diagnosticsChannel.hasSubscribers("undici:request:bodySent")).toBe(false);
	});

	it("leaves the write to the exit when writing fails", async () => {
		vi.spyOn(module, "flushCompileCache").mockImplementation(() => {
			throw new Error("read-only cache folder");
		});
		const { flushCompileCacheOnNextRequest } = await fresh();
		flushCompileCacheOnNextRequest();
		requestSent();
		await expect(nextTurn()).resolves.toBeUndefined();
	});
});
