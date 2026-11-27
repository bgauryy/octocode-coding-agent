import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	initialTitle,
	isProcessTitle,
	isSessionTitle,
	isWebDaemonTitle,
	MAX_TITLE_LENGTH,
	processTitle,
	sessionProcessTitle,
} from "../../../src/octocode/shared/process-title.ts";
import { daemonProcessTitle } from "../../../src/octocode/web-daemon/main.ts";

const SESSION = "01a1a2c5-eb93-75f9-8dc5-67f9daa09bdb";

describe("process titles", () => {
	it("sets a title only when it changes (each change costs milliseconds on macOS)", () => {
		const resolver = fileURLToPath(new URL("../../../scripts/source-resolver.ts", import.meta.url));
		const source = fileURLToPath(new URL("../../../src/octocode/shared/process-title.ts", import.meta.url));
		// A child process: the counting stand-in replaces the real title property for good.
		const script = `
			let sets = 0;
			let value = process.title;
			Object.defineProperty(process, "title", { configurable: true, get: () => value, set: (next) => { sets++; value = next; } });
			const { setProcessTitle } = await import(${JSON.stringify(source)});
			setProcessTitle("octocode-agent-researcher-a1");
			setProcessTitle("octocode-agent-researcher-a1");
			setProcessTitle("octocode-agent-main-b2");
			console.log(sets, process.title);
		`;
		const output = execFileSync(process.execPath, ["--import", resolver, "--input-type=module", "-e", script], {
			encoding: "utf8",
		});
		expect(output.trim()).toBe("2 octocode-agent-main-b2");
	});

	it("names the web daemon octocode-agent-web-<pid>, and keeps its command line inside a test run", () => {
		const { OCTOCODE_TEST_GUARD_FILE: _guard, OCTOCODE_TEST_PROTECTED_HOMES: _homes, ...user } = process.env;
		expect(daemonProcessTitle(user, 4016)).toBe("octocode-agent-web-4016");
		expect(isProcessTitle("octocode-agent-web-4016")).toBe(true);
		expect(isWebDaemonTitle("octocode-agent-web-4016", 4016)).toBe(true);
		expect(isWebDaemonTitle("octocode-agent-web-4016", 4017)).toBe(false);
		// The run's teardown finds a daemon a test left running by its environment, which a renamed macOS process hides.
		expect(daemonProcessTitle({ ...user, OCTOCODE_TEST_GUARD_FILE: "/tmp/guard" }, 4016)).toBeUndefined();
	});

	it("names a main session octocode-agent-main-<last 8 characters of the session id>", () => {
		expect(sessionProcessTitle("main", SESSION)).toBe("octocode-agent-main-daa09bdb");
	});

	it("names an RPC process octocode-agent-rpc-<id>", () => {
		expect(sessionProcessTitle("rpc", SESSION)).toBe("octocode-agent-rpc-daa09bdb");
	});

	it("tells apart sessions started in the same minute (UUIDv7 ids share their timestamp prefix)", () => {
		const sibling = "01a1a2c5-eb94-7000-8000-0123456789ab";
		expect(sessionProcessTitle("main", sibling)).not.toBe(sessionProcessTitle("main", SESSION));
	});

	it("follows the session id when it changes (new, resume, fork)", () => {
		expect(sessionProcessTitle("main", "0000-ffffffff")).toBe("octocode-agent-main-ffffffff");
	});

	it("names a subagent octocode-agent-<role>-<agent id> from the environment its parent set", () => {
		const env = { OCTOCODE_SUBAGENT: "1", OCTOCODE_AGENT_ID: "nifty-beak", OCTOCODE_AGENT_ROLE: "implementer" };
		expect(initialTitle(env, "main")).toBe("octocode-agent-implementer-nifty-beak");
		expect(initialTitle(env, "rpc")).toBe("octocode-agent-implementer-nifty-beak");
	});

	it("starts a main or RPC process without an id until its session exists", () => {
		expect(initialTitle({}, "main")).toBe("octocode-agent-main");
		expect(initialTitle({}, "rpc")).toBe("octocode-agent-rpc");
	});

	it("ignores agent variables when the subagent marker is absent", () => {
		expect(initialTitle({ OCTOCODE_AGENT_ID: "x", OCTOCODE_AGENT_ROLE: "reviewer" }, "main")).toBe(
			"octocode-agent-main",
		);
	});

	it("keeps a title to safe characters and a bounded length", () => {
		expect(processTitle("my role!", "a b/c\n")).toBe("octocode-agent-my_role_-a_b_c_");
		expect(processTitle("main", "x".repeat(200))).toHaveLength(MAX_TITLE_LENGTH);
		expect(processTitle("main", "").startsWith("octocode-agent-main")).toBe(true);
	});

	it("recognises its own titles, and only them", () => {
		expect(isProcessTitle("octocode-agent-implementer-nifty-beak")).toBe(true);
		expect(isProcessTitle("octocode-agent-main-01a1a2c5")).toBe(true);
		expect(isProcessTitle("octocode-agent-main")).toBe(true);
		expect(isProcessTitle("octocode-agent-rpc")).toBe(true);
		expect(isProcessTitle("octocode-mcp")).toBe(false);
		expect(isProcessTitle("octocode")).toBe(false);
		expect(isProcessTitle("node /repo/octocode-mcp/dist/index.js")).toBe(false);
		expect(isProcessTitle("/usr/bin/octocode mcp")).toBe(false);
	});

	it("tells a main session or RPC host by its titled id, never a subagent, a bare title or the pre-agent spelling", () => {
		expect(isSessionTitle(sessionProcessTitle("main", SESSION))).toBe(true);
		expect(isSessionTitle(sessionProcessTitle("rpc", SESSION))).toBe(true);
		expect(isSessionTitle(processTitle("researcher", "inky"))).toBe(false);
		expect(isSessionTitle(processTitle("main"))).toBe(false);
		expect(isSessionTitle("octocode-main-daa09bdb")).toBe(false);
		expect(isProcessTitle("octocode-main-daa09bdb")).toBe(false);
	});
});
