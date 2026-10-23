import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OctocodeServer, RETRY_COOL_DOWN_MS } from "../../src/octocode/mcp/client.ts";
import { tmp } from "./helpers.ts";

const ECHO = path.join(import.meta.dirname, "fixtures", "echo-mcp.mjs");
const DRIFT = "[octocode-mcp] Contract drift (fingerprint mismatch): core c313 != native 3d71";

describe("the Octocode server's cool-down retry", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("stays failed on contract drift until fixed, then a call past the cool-down connects and reports the recovery", async () => {
		// Only the clock is fake: the server processes are real.
		vi.useFakeTimers({ toFake: ["Date"] });
		let fixed = false;
		const launch = vi.fn((cwd: string) =>
			fixed
				? { command: process.execPath, args: [ECHO], cwd, env: {} }
				: {
						command: process.execPath,
						args: ["-e", `process.stderr.write(${JSON.stringify(DRIFT)}); process.exit(1)`],
						cwd,
						env: {},
					},
		);
		const failures: string[] = [];
		const recovered: number[] = [];
		const server = new OctocodeServer({
			launch,
			clientInfo: { name: "test", version: "0" },
			onTools: () => undefined,
			onFailure: (message) => failures.push(message),
			onRecovered: (at) => recovered.push(at),
		});
		try {
			server.start(tmp());
			expect(await server.ready()).toBe(false);
			// The one automatic reconnect, then nothing until the cool-down.
			expect(await server.ready()).toBe(false);
			expect(await server.ready()).toBe(false);
			expect(launch).toHaveBeenCalledTimes(2);
			// Still drifted past the cool-down: one more attempt, still an error the call reports.
			vi.setSystemTime(Date.now() + RETRY_COOL_DOWN_MS + 1_000);
			await expect(server.call("shout", { text: "hi" })).rejects.toThrow(/Contract drift/);
			expect(launch).toHaveBeenCalledTimes(3);
			expect(server.status().state).toBe("failed");
			// Fixed, but within the cool-down of the last failure: no attempt yet.
			fixed = true;
			expect(await server.ready()).toBe(false);
			expect(launch).toHaveBeenCalledTimes(3);
			vi.setSystemTime(Date.now() + RETRY_COOL_DOWN_MS + 1_000);
			const result = await server.call("shout", { text: "hi" });
			expect(JSON.stringify(result.content)).toContain("HI");
			expect(server.status().state).toBe("connected");
			expect(failures).toHaveLength(1);
			expect(recovered).toEqual([Date.now()]);
		} finally {
			await server.close();
		}
	});
});
