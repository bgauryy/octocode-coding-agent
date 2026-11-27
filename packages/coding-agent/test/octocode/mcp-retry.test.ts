import "../mcp-host.ts";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectionFixture } from "../../../mcp/test/mcp-connection-fixture.ts";

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
		const transitions: string[] = [];
		const server = connectionFixture({
			launch,

			onTools: () => undefined,
			onChange: (connection) => transitions.push(connection.state),
		});
		try {
			expect(
				await server.getClient().then(
					() => true,
					() => false,
				),
			).toBe(false);
			// The shared host allows three immediate failures, then applies increasing backoff.
			expect(
				await server.getClient().then(
					() => true,
					() => false,
				),
			).toBe(false);
			expect(
				await server.getClient().then(
					() => true,
					() => false,
				),
			).toBe(false);
			expect(
				await server.getClient().then(
					() => true,
					() => false,
				),
			).toBe(false);
			expect(launch).toHaveBeenCalledTimes(3);
			// Still drifted past the cool-down: one more attempt, still an error the call reports.
			vi.setSystemTime(Date.now() + 61_000);
			await expect(server.callTool("shout", { text: "hi" }, {})).rejects.toThrow(/Contract drift/);
			expect(launch).toHaveBeenCalledTimes(4);
			expect(server.state).toBe("failed");
			// Fixed, but within the cool-down of the last failure: no attempt yet.
			fixed = true;
			expect(
				await server.getClient().then(
					() => true,
					() => false,
				),
			).toBe(false);
			expect(launch).toHaveBeenCalledTimes(4);
			vi.setSystemTime(Date.now() + 61_000);
			const result = await server.callTool("shout", { text: "hi" }, {});
			expect(JSON.stringify(result.content)).toContain("HI");
			expect(server.state).toBe("connected");
			expect(transitions).toContain("failed");
			expect(transitions.at(-1)).toBe("connected");
		} finally {
			await server.close();
		}
	});
});
