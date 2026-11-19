import { describe, expect, it } from "vitest";
import {
	initialTitle,
	isProcessTitle,
	MAX_TITLE_LENGTH,
	processTitle,
	sessionProcessTitle,
} from "../../../src/octocode/processes/title.ts";

const SESSION = "01a1a2c5-eb93-75f9-8dc5-67f9daa09bdb";

describe("process titles", () => {
	it("names a main session octocode-main-<last 8 characters of the session id>", () => {
		expect(sessionProcessTitle("main", SESSION)).toBe("octocode-main-daa09bdb");
	});

	it("names an RPC process octocode-rpc-<id>", () => {
		expect(sessionProcessTitle("rpc", SESSION)).toBe("octocode-rpc-daa09bdb");
	});

	it("tells apart sessions started in the same minute (UUIDv7 ids share their timestamp prefix)", () => {
		const sibling = "01a1a2c5-eb94-7000-8000-0123456789ab";
		expect(sessionProcessTitle("main", sibling)).not.toBe(sessionProcessTitle("main", SESSION));
	});

	it("follows the session id when it changes (new, resume, fork)", () => {
		expect(sessionProcessTitle("main", "0000-ffffffff")).toBe("octocode-main-ffffffff");
	});

	it("names a subagent octocode-<role>-<agent id> from the environment its parent set", () => {
		const env = { OCTOCODE_SUBAGENT: "1", OCTOCODE_AGENT_ID: "nifty-beak", OCTOCODE_AGENT_ROLE: "implementer" };
		expect(initialTitle(env, "main")).toBe("octocode-implementer-nifty-beak");
		expect(initialTitle(env, "rpc")).toBe("octocode-implementer-nifty-beak");
	});

	it("starts a main or RPC process without an id until its session exists", () => {
		expect(initialTitle({}, "main")).toBe("octocode-main");
		expect(initialTitle({}, "rpc")).toBe("octocode-rpc");
	});

	it("ignores agent variables when the subagent marker is absent", () => {
		expect(initialTitle({ OCTOCODE_AGENT_ID: "x", OCTOCODE_AGENT_ROLE: "reviewer" }, "main")).toBe("octocode-main");
	});

	it("keeps a title to safe characters and a bounded length", () => {
		expect(processTitle("my role!", "a b/c\n")).toBe("octocode-my_role_-a_b_c_");
		expect(processTitle("main", "x".repeat(200))).toHaveLength(MAX_TITLE_LENGTH);
		expect(processTitle("main", "").startsWith("octocode-main")).toBe(true);
	});

	it("recognises its own titles, and only them", () => {
		expect(isProcessTitle("octocode-implementer-nifty-beak")).toBe(true);
		expect(isProcessTitle("octocode-main-01a1a2c5")).toBe(true);
		expect(isProcessTitle("octocode-main")).toBe(true);
		expect(isProcessTitle("octocode-rpc")).toBe(true);
		expect(isProcessTitle("octocode-mcp")).toBe(false);
		expect(isProcessTitle("octocode")).toBe(false);
		expect(isProcessTitle("node /repo/octocode-mcp/dist/index.js")).toBe(false);
		expect(isProcessTitle("/usr/bin/octocode mcp")).toBe(false);
	});
});
