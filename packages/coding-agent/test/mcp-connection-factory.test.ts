import { describe, expect, it } from "vitest";
import { InMemoryAuthStorageBackend } from "../src/core/auth-storage.ts";
import type { McpServerEntry } from "../src/extensions/mcp/config.ts";
import { createServerConnection } from "../src/extensions/mcp/connection-factory.ts";
import { McpOAuthCredentialStore } from "../src/extensions/mcp/oauth.ts";

/** A server that writes `stderr` and exits before it speaks MCP, so the connect fails with its stderr. */
function dying(stderr: string, extra: Partial<Parameters<typeof createServerConnection>[0]> = {}) {
	const entry: McpServerEntry = {
		name: "dying",
		config: {
			command: process.execPath,
			args: ["-e", `require('node:fs').writeSync(2, ${JSON.stringify(stderr)}); process.exit(3)`],
		},
		source: "test",
	};
	return createServerConnection({
		entry,
		cwd: process.cwd(),
		credentials: new McpOAuthCredentialStore(new InMemoryAuthStorageBackend()),
		...extra,
	});
}

describe("createServerConnection", () => {
	it("shows control characters of a server's stderr as escapes, not as raw terminal sequences", async () => {
		const connection = dying("\u001b]0;pwned\u0007\u001b[2Jreal diagnostic\u202e");
		try {
			await expect(connection.getClient()).rejects.toThrow();
			const error = connection.error ?? "";
			expect(error).not.toMatch(/[\u001b\u0007\u202e]/);
			expect(error).toContain("\\u{1b}]0;pwned\\u{7}\\u{1b}[2Jreal diagnostic\\u{202e}");
		} finally {
			await connection.close();
		}
	});

	it("keeps only the end of a long stderr", async () => {
		const stderr = `${"head ".repeat(2_000)}the end`;
		const connection = dying(stderr);
		try {
			await expect(connection.getClient()).rejects.toThrow();
			const error = connection.error ?? "";
			expect(error.endsWith("the end")).toBe(true);
			expect(error).not.toContain("head ".repeat(1_000));
			expect(error.length).toBeLessThan(2_300);
		} finally {
			await connection.close();
		}
	});

	it("launches the entry that prepareLaunch returns and reports it", async () => {
		const launched: McpServerEntry[] = [];
		const connection = dying("unused", {
			prepareLaunch: (entry) => ({
				...entry,
				config: { command: process.execPath, args: ["-e", "process.stderr.write('prepared launch'); process.exit(3)"] },
			}),
			onLaunch: (_connection, entry) => launched.push(entry),
		});
		try {
			await expect(connection.getClient()).rejects.toThrow(/prepared launch/);
			expect(launched).toHaveLength(1);
			expect(launched[0].config).toMatchObject({ command: process.execPath });
		} finally {
			await connection.close();
		}
	});
});
