import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { AcpBackend } from "../../src/client/client.ts";
import { acpClientHost } from "../../../coding-agent/src/octocode/external/acp-host.ts";

const peer = fileURLToPath(new URL("./capability-peer.mjs", import.meta.url));
const roots: string[] = [];
const backends: AcpBackend[] = [];
const deny = async () => ({ outcome: { outcome: "cancelled" as const } });

function journalOf(path: string): { event: string; params: Record<string, unknown> }[] {
	try {
		return readFileSync(path, "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	} catch {
		return [];
	}
}

async function connect(behavior: object, extra: { sessionId?: string; mcpServers?: never[] } = {}) {
	const root = mkdtempSync(join(tmpdir(), "acp-capabilities-"));
	roots.push(root);
	const journal = join(root, "journal.jsonl");
	const run = AcpBackend.connect(
		acpClientHost,
		{
			command: process.execPath,
			args: [peer, journal, JSON.stringify(behavior)],
			vendor: "fixture",
			cwd: root,
			timeoutMs: 60_000,
			...extra,
		},
		deny,
	);
	return { run, journal };
}

afterEach(async () => {
	await Promise.all(backends.splice(0).map((backend) => backend.close()));
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("external ACP peer capabilities", () => {
	it("authenticates with a method that needs no person when the peer answers auth_required, then retries", async () => {
		const { run, journal } = await connect({
			authMethods: [{ id: "login", name: "Log in" }],
		});
		const backend = await run;
		backends.push(backend);
		expect(journalOf(journal).map((entry) => entry.event)).toEqual(["new", "authenticate", "new"]);
		expect(journalOf(journal)[1].params).toEqual({ methodId: "login" });
		expect(backend.sessionId).toBe("peer-session");
	});

	it("names the methods in the error when each one needs a person, and does not authenticate", async () => {
		const { run, journal } = await connect({
			authMethods: [{ id: "tui", name: "Sign in in a terminal", type: "terminal", args: [], env: {} }],
		});
		await expect(run).rejects.toThrow(/needs a person.*tui \(Sign in in a terminal\)/);
		expect(journalOf(journal).map((entry) => entry.event)).toEqual(["new"]);
	});

	it("prefers session/resume over session/load when the peer advertises it", async () => {
		const { run, journal } = await connect({ capabilities: { resume: {} } }, { sessionId: "saved" });
		backends.push(await run);
		expect(journalOf(journal).map((entry) => entry.event)).toEqual(["resume"]);
		expect(journalOf(journal)[0].params).toMatchObject({ sessionId: "saved" });
	});

	it("falls back to session/load when the peer has no resume", async () => {
		const { run, journal } = await connect({}, { sessionId: "saved" });
		backends.push(await run);
		expect(journalOf(journal).map((entry) => entry.event)).toEqual(["load"]);
	});

	it("passes mcpServers to the session", async () => {
		const servers = [{ name: "docs", command: "/bin/true", args: [], env: [] }];
		const root = mkdtempSync(join(tmpdir(), "acp-capabilities-"));
		roots.push(root);
		const journal = join(root, "journal.jsonl");
		backends.push(
			await AcpBackend.connect(
				acpClientHost,
				{
					command: process.execPath,
					args: [peer, journal, "{}"],
					vendor: "fixture",
					cwd: root,
					mcpServers: servers,
					timeoutMs: 60_000,
				},
				deny,
			),
		);
		expect(journalOf(journal)[0].params.mcpServers).toEqual(servers);
	});

	it("sends session/close on disconnect when the peer supports it, and not otherwise", async () => {
		const withClose = await connect({ capabilities: { close: {} } });
		const backend = await withClose.run;
		await backend.close();
		expect(journalOf(withClose.journal).map((entry) => entry.event)).toEqual(["new", "close"]);
		expect(journalOf(withClose.journal)[1].params).toEqual({ sessionId: "peer-session" });
		const without = await connect({});
		await (await without.run).close();
		expect(journalOf(without.journal).map((entry) => entry.event)).toEqual(["new"]);
	});
});
