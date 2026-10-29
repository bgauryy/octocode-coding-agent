import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	HOOK_CATALOG,
	HOOK_EVENTS,
	profileEvents,
	profileSupport,
	UPSTREAM_ONLY_EVENTS,
	type HookHandlerType,
	type HookProtocol,
} from "../../src/octocode/hooks/catalog.ts";
import { parseHooks } from "../../src/octocode/hooks/config/parse.ts";
import { hookEventsReport } from "../../src/octocode/hooks/register/report.ts";

const HOOKS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../src/octocode/hooks");
const PROTOCOLS: HookProtocol[] = ["octocode", "claude", "codex"];
const HANDLERS: Record<HookHandlerType, Record<string, unknown>> = {
	command: { type: "command", command: "true" },
	http: { type: "http", url: "https://hooks.example.test/check" },
	prompt: { type: "prompt", prompt: "Check $ARGUMENTS" },
	mcp_tool: { type: "mcp_tool", server: "policy", tool: "check" },
};

const parse = (protocol: HookProtocol, event: string, handler: Record<string, unknown>) => {
	const errors: string[] = [];
	const config = parseHooks(
		{ hooks: { [event]: [{ hooks: [handler] }] } },
		"fixture",
		undefined,
		errors,
		undefined,
		protocol,
	);
	const loaded = (config as Record<string, Array<{ hooks: unknown[] }>>)[event] ?? [];
	return { loaded: loaded.flatMap((group) => group.hooks).length, errors };
};

describe("hook catalog", () => {
	it("is the parser's allowlist: every profile accepts exactly the events and handler types the catalog declares", () => {
		const mismatches: string[] = [];
		for (const protocol of PROTOCOLS)
			for (const event of HOOK_EVENTS)
				for (const [type, handler] of Object.entries(HANDLERS) as Array<[HookHandlerType, Record<string, unknown>]>) {
					const support = profileSupport(protocol, event);
					const expected = support !== undefined && (type === "command" || support.handlers.includes(type));
					const { loaded } = parse(protocol, event, handler);
					if (loaded > 0 !== expected) mismatches.push(`${protocol} ${event} ${type}: expected ${expected}`);
				}
		expect(mismatches).toEqual([]);
	});

	it("applies each profile's default and maximum timeout", () => {
		for (const protocol of PROTOCOLS)
			for (const event of profileEvents(protocol)) {
				const support = profileSupport(protocol, event)!;
				const config = parseHooks(
					{ hooks: { [event]: [{ hooks: [{ type: "command", command: "true", timeout: 10_000 }] }] } },
					"fixture",
					undefined,
					[],
					undefined,
					protocol,
				);
				const [hook] = (config as Record<string, Array<{ hooks: Array<{ timeoutMs: number }> }>>)[event][0].hooks;
				expect(hook.timeoutMs, `${protocol} ${event}`).toBe((support.maxTimeout ?? 600) * 1000);
			}
	});

	it("reports upstream events Octocode lacks as not implemented, distinct from unknown names", () => {
		for (const protocol of ["claude", "codex"] as const)
			for (const event of UPSTREAM_ONLY_EVENTS[protocol]) {
				expect(Object.hasOwn(HOOK_CATALOG, event), event).toBe(false);
				expect(parse(protocol, event, HANDLERS.command).errors.join()).toContain("not implemented in Octocode yet");
			}
		expect(parse("claude", "NoSuchEvent", HANDLERS.command).errors.join()).toContain(
			"unsupported hook event NoSuchEvent",
		);
	});

	it("names a dispatcher for every event it lists", () => {
		const sources = [
			path.join(HOOKS_DIR, "register.ts"),
			...fs.readdirSync(path.join(HOOKS_DIR, "register")).map((file) => path.join(HOOKS_DIR, "register", file)),
		]
			.map((file) => fs.readFileSync(file, "utf8"))
			.join("\n");
		// A dispatcher passes the event as a string literal, directly or through a variable it selects.
		const undispatched = HOOK_EVENTS.filter((event) => !sources.includes(`"${event}"`));
		expect(undispatched).toEqual([]);
	});

	it("drives /hooks events", () => {
		const report = hookEventsReport();
		for (const event of HOOK_EVENTS) expect(report).toContain(event);
		for (const event of UPSTREAM_ONLY_EVENTS.claude) expect(report).toContain(event);
		expect(report).toContain(`claude: ${profileEvents("claude").length} events`);
	});
});
