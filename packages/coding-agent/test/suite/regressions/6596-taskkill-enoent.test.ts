import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { win32 as path } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof ChildProcess>();
	return { ...actual, spawn: spawnMock };
});

import { signalTree } from "../../../src/utils/process-tree.ts";

function withWindowsPlatform(test: () => void): void {
	const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
	try {
		Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
		test();
	} finally {
		if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
	}
}

afterEach(() => {
	spawnMock.mockReset();
	vi.unstubAllEnvs();
});

describe("issue #6596 taskkill spawn failures", () => {
	// #9490: missing or empty SystemRoot must retain an absolute taskkill fallback.
	it.each([
		["D:\\CustomWindows", "D:\\CustomWindows"],
		[undefined, "C:\\Windows"],
		["", "C:\\Windows"],
	] as const)("uses System32 taskkill and consumes its spawn error with SystemRoot=%j", (systemRoot, expectedRoot) => {
		const child = new EventEmitter();
		vi.stubEnv("SystemRoot", systemRoot);
		spawnMock.mockReturnValue(child);

		withWindowsPlatform(() => {
			signalTree(1234, "SIGKILL");
		});

		expect(spawnMock).toHaveBeenCalledWith(
			path.join(expectedRoot, "System32", "taskkill.exe"),
			["/pid", "1234", "/T", "/F"],
			{ stdio: "ignore", windowsHide: true },
		);
		expect(() => child.emit("error", new Error("spawn taskkill ENOENT"))).not.toThrow();
	});
});
