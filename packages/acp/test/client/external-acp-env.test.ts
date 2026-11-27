import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AcpBackend } from "../../src/client/client.ts";
import { probeAcpSignIn } from "../../src/client/probe.ts";
import { AcpOutput } from "../../src/client/output.ts";
import { acpClientHost } from "../../../coding-agent/src/octocode/external/acp-host.ts";

const peer = fileURLToPath(new URL("./capability-peer.mjs", import.meta.url));
const roots: string[] = [];
const cancelled = async () => ({ outcome: { outcome: "cancelled" as const } });

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

function peerInput(behavior: object, vendor = "fixture") {
	const root = mkdtempSync(join(tmpdir(), "acp-env-"));
	roots.push(root);
	const journal = join(root, "journal.jsonl");
	return {
		journal,
		input: {
			command: process.execPath,
			args: [peer, journal, JSON.stringify(behavior)],
			vendor,
			cwd: root,
			timeoutMs: 60_000,
		},
	};
}

afterEach(() => {
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the environment an external ACP agent starts with", () => {
	const credentials = [
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
		"ANTHROPIC_BASE_URL",
		"OPENAI_API_KEY",
		"CODEX_API_KEY",
		"COPILOT_GITHUB_TOKEN",
		"GEMINI_API_KEY",
		"OCTOCODE_AGENT_ID",
		"OCTOCODE_PERMISSION_NONCE_FILE",
	];
	const own = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_CODE_OAUTH_TOKEN", "OCTOCODE_HOME"];

	it("leaves out provider credentials and Octocode's own variables, and keeps a runner's own configuration", async () => {
		for (const name of [...credentials, ...own]) vi.stubEnv(name, `value-of-${name}`);
		const { input, journal } = peerInput({ recordEnv: [...credentials, ...own, "PATH"] }, "claude-code");
		const backend = await AcpBackend.connect(acpClientHost, input, cancelled);
		await backend.close();
		const present = journalOf(journal).find((entry) => entry.event === "env")?.params.present;
		expect(present).toEqual(expect.arrayContaining([...own, "PATH"]));
		for (const name of credentials) expect(present).not.toContain(name);
	});
});

describe("the sign-in check of an ACP agent", () => {
	it("is signed in when a session opens, and closes it", async () => {
		const { input, journal } = peerInput({});
		expect(await probeAcpSignIn(acpClientHost, input)).toEqual({
			signedIn: true,
			models: [],
			capabilities: { image: false, mcpHttp: false },
		});
		expect(journalOf(journal).map((entry) => entry.event)).toEqual(["new"]);
	});

	it("is signed out on auth_required, naming the methods, and never authenticates (not even without a person)", async () => {
		const { input, journal } = peerInput({
			authMethods: [
				{ id: "login", name: "Log in" },
				{ id: "tui", name: "Sign in in a terminal", type: "terminal", args: [], env: {} },
			],
		});
		expect(await probeAcpSignIn(acpClientHost, input)).toEqual({
			signedIn: false,
			methods: ["Log in", "Sign in in a terminal"],
		});
		expect(journalOf(journal).map((entry) => entry.event)).toEqual(["new"]);
	});

	it("is unknown, with the reason, when the agent cannot start", async () => {
		const { input } = peerInput({});
		const found = await probeAcpSignIn(acpClientHost, { ...input, command: join(tmpdir(), "no-such-acp-agent") });
		expect(found).toEqual({ error: expect.any(String) });
	});
});

describe("a prompt response's usage", () => {
	it.each([
		{ inputTokens: 2 ** 53, outputTokens: 0, cachedReadTokens: 1, totalTokens: 2 ** 53 },
		{ inputTokens: 100, outputTokens: 10, cachedReadTokens: 0.5, cachedWriteTokens: 0.5, totalTokens: 110 },
	])("retains imprecise counts without inferring cache overlap: %j", (counts) => {
		const output = new AcpOutput(acpClientHost.saveOutput);
		expect(output.reply({ stopReason: "end_turn", usage: counts } as never).usage).toEqual(counts);
	});
	it.each<[Record<string, unknown>, number]>([
		[{ cachedReadTokens: 40, totalTokens: 110 }, 60],
		[{ cachedWriteTokens: 20, totalTokens: 110 }, 80],
		[{ cachedReadTokens: 40, cachedWriteTokens: 10, totalTokens: 110 }, 50],
		[{ cachedReadTokens: 40, cachedWriteTokens: null, totalTokens: 110 }, 60],
		[{ cachedReadTokens: 0, totalTokens: 110 }, 100],
		[{ cachedReadTokens: 40, totalTokens: 150 }, 100],
		[{ cachedReadTokens: 40 }, 100],
		[{ cachedReadTokens: 40, totalTokens: null }, 100],
		[{ cachedReadTokens: 40, totalTokens: -1 }, 100],
		[{ cachedReadTokens: 40, totalTokens: Number.NaN }, 100],
		[{ cachedReadTokens: 40, totalTokens: "110" }, 100],
		[{ cachedReadTokens: 40, totalTokens: 999 }, 100],
		[{ cachedReadTokens: 110, totalTokens: 110 }, 100],
		[{ cachedReadTokens: 40, cachedWriteTokens: -1, totalTokens: 110 }, 100],
		[{ cachedReadTokens: 40, cachedWriteTokens: "bad", totalTokens: 110 }, 100],
	])("normalizes cached input only when valid totals prove overlap: %j", (counts, expectedInput) => {
		const output = new AcpOutput(acpClientHost.saveOutput);
		const usage = output.reply({
			stopReason: "end_turn",
			usage: { inputTokens: 100, outputTokens: 10, ...counts },
		} as never).usage;
		expect(usage?.inputTokens).toBe(expectedInput);
		expect(usage?.outputTokens).toBe(10);
		expect(usage?.cachedReadTokens).toBe(
			typeof counts.cachedReadTokens === "number" ? counts.cachedReadTokens : undefined,
		);
		expect(usage?.cachedWriteTokens).toBe(
			typeof counts.cachedWriteTokens === "number" && counts.cachedWriteTokens >= 0
				? counts.cachedWriteTokens
				: undefined,
		);
		expect(usage?.totalTokens).toBe(
			typeof counts.totalTokens === "number" && Number.isFinite(counts.totalTokens) && counts.totalTokens >= 0
				? counts.totalTokens
				: undefined,
		);
	});

	it("keeps the token totals an agent reports and drops anything else", () => {
		const output = new AcpOutput(acpClientHost.saveOutput);
		const reply = output.reply({
			stopReason: "end_turn",
			usage: { inputTokens: 10, outputTokens: 4, cachedReadTokens: 2, totalTokens: 16, secret: "x" },
		} as never);
		expect(reply.usage).toEqual({ inputTokens: 10, outputTokens: 4, cachedReadTokens: 2, totalTokens: 16 });
		expect(new AcpOutput(acpClientHost.saveOutput).reply({ stopReason: "end_turn" }).usage).toBeUndefined();
	});
});
