import { describe, expect, it, vi } from "vitest";
import { runUserBash, UserBashHookError, type UserBashHost } from "../src/core/agent-session/user-bash.ts";

const ran = { output: "ran here", exitCode: 0, cancelled: false, truncated: false };

function host(emitUserBash: UserBashHost["featureHost"]["emitUserBash"]) {
	return {
		featureHost: { emitUserBash },
		sessionManager: { getCwd: () => "/work" },
		executeBash: vi.fn(async () => ran),
		recordBashResult: vi.fn(),
	};
}

describe("a user bash command", () => {
	it("runs here, streaming, when no handler takes it", async () => {
		const session = host(async () => undefined);
		const onStart = vi.fn();
		const onChunk = vi.fn();
		await expect(runUserBash(session, "ls", { excludeFromContext: true, id: "r1", onStart, onChunk })).resolves.toBe(
			ran,
		);
		expect(onStart).toHaveBeenCalledOnce();
		expect(session.executeBash).toHaveBeenCalledWith("ls", onChunk, { excludeFromContext: true, id: "r1" });
		expect(session.recordBashResult).not.toHaveBeenCalled();
	});

	it("runs with the operations a handler supplies", async () => {
		const operations = { exec: vi.fn() };
		const session = host(async () => ({ operations }));
		await runUserBash(session, "ls");
		expect(session.executeBash).toHaveBeenCalledWith("ls", undefined, { excludeFromContext: false, operations });
	});

	it("records and returns a handler's own result without running anything", async () => {
		const result = { output: "remote", exitCode: 0, cancelled: false, truncated: false };
		const session = host(async () => ({ result }));
		const onStart = vi.fn();
		await expect(runUserBash(session, "ls", { onStart })).resolves.toBe(result);
		expect(session.recordBashResult).toHaveBeenCalledWith("ls", result, { excludeFromContext: false });
		expect(session.executeBash).not.toHaveBeenCalled();
		expect(onStart).not.toHaveBeenCalled();
	});

	it("fails closed when a handler fails: nothing runs and the failure names the handler's error", async () => {
		const session = host(async () => {
			throw new Error("Routing failed");
		});
		const onStart = vi.fn();
		const run = runUserBash(session, "rm -rf build", { onStart });
		await expect(run).rejects.toBeInstanceOf(UserBashHookError);
		await expect(run).rejects.toThrow("Routing failed");
		expect(session.executeBash).not.toHaveBeenCalled();
		expect(session.recordBashResult).not.toHaveBeenCalled();
		expect(onStart).not.toHaveBeenCalled();
	});
});
