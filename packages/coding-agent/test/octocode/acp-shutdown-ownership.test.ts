import { beforeEach, expect, it, vi } from "vitest";
import type * as Processes from "../../src/octocode/shared/process.ts";
import { acpClientHost } from "../../src/octocode/external/acp-host.ts";

const mocks = vi.hoisted(() => ({ capture: vi.fn(), stop: vi.fn() }));
vi.mock("../../src/octocode/shared/process-descendants.ts", () => ({ descendantRows: mocks.capture }));
vi.mock("../../src/octocode/shared/process.ts", async (original) => ({
	...(await original<typeof Processes>()),
	stopTree: mocks.stop,
}));
beforeEach(() => {
	vi.resetAllMocks();
	mocks.capture.mockResolvedValue([]);
	mocks.stop.mockResolvedValue(undefined);
});

it("keeps the direct stop default without taking a second snapshot", async () => {
	await acpClientHost.processTree.stop(123);
	expect(mocks.capture).not.toHaveBeenCalled();
	expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(123);
});

it.each([undefined, 123])("runs graceful shutdown once even without captured descendants: %s", async (pid) => {
	const graceful = vi.fn(async () => {
		expect(mocks.capture).toHaveBeenCalledExactlyOnceWith(pid);
	});
	await acpClientHost.processTree.stop(pid, graceful);
	expect(graceful).toHaveBeenCalledTimes(1);
	expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(pid, acpClientHost.processTree.graceMs, []);
});

it("still runs the callback and authoritative stop when capture fails", async () => {
	mocks.capture.mockRejectedValue(new Error("ps unavailable"));
	const graceful = vi.fn(async () => undefined);
	await acpClientHost.processTree.stop(123, graceful);
	expect(graceful).toHaveBeenCalledTimes(1);
	expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(123, acpClientHost.processTree.graceMs, []);
});

it("stops retained identities in finally when graceful shutdown rejects", async () => {
	const retained = [{ pid: 456, ppid: 123, pgid: 456, stat: "S", started: "789" }];
	mocks.capture.mockResolvedValue(retained);
	const graceful = vi.fn(async () => {
		throw new Error("peer rejected");
	});
	await expect(acpClientHost.processTree.stop(123, graceful)).rejects.toThrow("peer rejected");
	expect(graceful).toHaveBeenCalledTimes(1);
	expect(mocks.stop).toHaveBeenCalledExactlyOnceWith(123, acpClientHost.processTree.graceMs, retained);
});
