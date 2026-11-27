import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { handleCommand, type RpcCommandHost } from "../src/modes/rpc/rpc-mode/commands.ts";
import { sessionFileRunningPid } from "../src/octocode/shared/session-liveness.ts";

vi.mock("../src/octocode/shared/session-liveness.ts", () => ({ sessionFileRunningPid: vi.fn() }));

function host(settingsManager = SettingsManager.inMemory()) {
	const switchSession = vi.fn(async () => ({ cancelled: false }));
	return {
		settingsManager,
		switchSession,
		rpc: {
			session: { settingsManager },
			runtimeHost: { switchSession },
			output: () => {},
		} as unknown as RpcCommandHost,
	};
}

afterEach(() => {
	vi.mocked(sessionFileRunningPid).mockReset();
});

describe("set_auto_retry", () => {
	it("changes this session only: nothing reaches the settings a later session reads", async () => {
		const { rpc, settingsManager } = host();
		await expect(handleCommand(rpc, { type: "set_auto_retry", enabled: false })).resolves.toMatchObject({
			success: true,
		});
		expect(settingsManager.getRetryEnabled()).toBe(false);
		expect(settingsManager.getGlobalSettings().retry).toBeUndefined();
	});

	it("survives a later write and reload of the session's settings", async () => {
		const { rpc, settingsManager } = host();
		await handleCommand(rpc, { type: "set_auto_retry", enabled: false });
		settingsManager.setSteeringMode("one-at-a-time");
		expect(settingsManager.getSteeringMode()).toBe("one-at-a-time");
		expect(settingsManager.getRetryEnabled()).toBe(false);
		await settingsManager.reload();
		expect(settingsManager.getRetryEnabled()).toBe(false);
		expect(settingsManager.getGlobalSettings().retry).toBeUndefined();
	});
});

describe("switch_session", () => {
	it("refuses a session another process has open and names the pid, without switching", async () => {
		vi.mocked(sessionFileRunningPid).mockResolvedValue(process.pid + 1);
		const { rpc, switchSession } = host();
		const response = await handleCommand(rpc, { type: "switch_session", id: "1", sessionPath: "/s/other.jsonl" });
		expect(response).toMatchObject({ id: "1", command: "switch_session", success: false });
		expect(response).toHaveProperty("error", expect.stringContaining(`pid ${process.pid + 1}`));
		expect(response).toHaveProperty("error", expect.stringContaining("--fork"));
		expect(switchSession).not.toHaveBeenCalled();
	});

	it.each([
		["no process has it", undefined],
		["this process has it", process.pid],
	])("switches when %s", async (_name, pid) => {
		vi.mocked(sessionFileRunningPid).mockResolvedValue(pid);
		const { rpc, switchSession } = host();
		const response = await handleCommand(rpc, { type: "switch_session", sessionPath: "/s/other.jsonl" });
		expect(response).toMatchObject({ success: true, data: { cancelled: false } });
		expect(switchSession).toHaveBeenCalledWith("/s/other.jsonl");
	});
});
