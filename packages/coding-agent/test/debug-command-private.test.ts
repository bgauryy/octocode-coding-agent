import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, getDebugLogPath } from "../src/config.ts";
import { handleDebugCommand } from "../src/modes/interactive/interactive-mode/info-commands.ts";
import { initTheme } from "../src/theme/theme.ts";

const SECRET = "sk-ant-api03-" + "A".repeat(40);

function host(): Parameters<typeof handleDebugCommand>[0] {
	const children: unknown[] = [];
	return {
		ui: {
			terminal: { columns: 80, rows: 24 },
			render: () => [`screen line with ${SECRET}`],
			requestRender: () => {},
		},
		session: { messages: [{ role: "user", content: `my key is ${SECRET}`, timestamp: 0 }] },
		chatContainer: { addChild: (child: unknown) => children.push(child) },
		outputPad: 1,
	} as unknown as Parameters<typeof handleDebugCommand>[0];
}

describe("/debug log", () => {
	let dir: string;
	const previous = process.env[ENV_AGENT_DIR];
	beforeAll(() => initTheme("dark"));
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "debug-private-"));
		process.env[ENV_AGENT_DIR] = join(dir, "agent");
	});
	afterEach(() => {
		if (previous === undefined) delete process.env[ENV_AGENT_DIR];
		else process.env[ENV_AGENT_DIR] = previous;
		rmSync(dir, { recursive: true, force: true });
	});

	it.skipIf(process.platform === "win32")("creates an owner-only log in an owner-only directory", () => {
		handleDebugCommand(host());
		const file = getDebugLogPath();
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(statSync(join(dir, "agent")).mode & 0o777).toBe(0o700);
		const text = readFileSync(file, "utf8");
		expect(text).toContain("=== Agent messages (JSONL) ===");
		expect(text).toContain("my key is");
		expect(text).not.toContain(SECRET);
	});

	it.skipIf(process.platform === "win32")("replaces a pre-existing world-readable log with an owner-only one", () => {
		const file = getDebugLogPath();
		mkdirSync(join(dir, "agent"), { recursive: true });
		writeFileSync(file, "old");
		chmodSync(file, 0o644);
		handleDebugCommand(host());
		expect(statSync(file).mode & 0o777).toBe(0o600);
		expect(readFileSync(file, "utf8")).not.toContain("old\n");
	});
});
