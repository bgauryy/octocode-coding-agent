/**
 * How agent mail draws in the transcript: an outgoing `agent` message call (header and result row) and delivered
 * mail. Both name sender → recipient, the kind and the message number; the body previews collapsed and shows whole expanded.
 */
import { describe, expect, it } from "vitest";
import { agentModes } from "../../src/octocode/native/tools/agent/tool.ts";
import { INTERNAL_MESSAGE_TYPE } from "../../src/octocode/shared/messages.ts";
import { ENTITY } from "../../src/octocode/shared/entity.ts";
import { registerMessageRenderer, registerSendMessageTool } from "../../src/octocode/team/tools/messages.ts";
import type { Team } from "../../src/octocode/team/session.ts";
import type { Endpoint } from "@octocodeai/octocode-contracts/team";
import { mailRows } from "../../src/octocode/team/tools/message-rows.ts";
import { rendered, theme } from "./fake-host.ts";

type Any = any;

function setup() {
	const modes = agentModes();
	const tools = new Map<string, Any>();
	const renderers = new Map<string, Any>();
	const api = {
		tools: { register: (tool: Any) => tools.set(tool.name, tool) },
		renderers: { message: (type: string, render: Any) => renderers.set(type, render) },
	} as Any;
	registerSendMessageTool(api, {} as Team, modes.collect);
	modes.register(api);
	registerMessageRenderer(api);
	return { agent: tools.get("agent"), mail: renderers.get(INTERNAL_MESSAGE_TYPE) };
}

const BODY = "one\ntwo\nthree\nfour\nfive";
const done = { isPartial: false, durationMs: 12 };

describe("outgoing agent message rows", () => {
	const { agent } = setup();
	const call = (args: Record<string, unknown>) =>
		rendered(agent.renderCall({ type: "message", ...args }, theme, { ...done, args: { type: "message", ...args } }));
	const result = (args: Record<string, unknown>, details: Record<string, unknown>, expanded: boolean) =>
		rendered(
			agent.renderResult(
				{ content: [{ type: "text", text: "Queued" }], details: { ...details, agentType: "message" } },
				{ expanded },
				theme,
				{ ...done, args: { type: "message", ...args }, expanded },
			),
			1_000,
		);

	it("names sender, recipient and kind on the call row", () => {
		expect(call({ to: "parent", message: "m" })).toBe("✓ Send(you → parent · FYI)");
		expect(call({ to: "ink", message: "m", replyRequired: true })).toBe("✓ Send(you → ink · request)");
		expect(call({ replyTo: 17, message: "m" })).toBe("✓ Send(you → sender of #17 · reply)");
		expect(call({ to: "ink", replyTo: 17, message: "m" })).toBe("✓ Send(you → ink · reply to #17)");
		expect(call({ to: "kelp", message: "m", interrupt: true })).toBe("✓ Send(you → kelp · interrupt)");
		expect(call({ to: "kelp", message: "m", wake: true })).toBe("✓ Send(you → kelp · FYI)");
		expect(call({ to: "kelp", message: "m", wake: false })).toBe("✓ Send(you → kelp · FYI · no wake)");
		expect(call({ replyTo: 17, message: "m", wake: true })).toBe("✓ Send(you → sender of #17 · reply · wake)");
		expect(call({ to: "eel", forward: 17 })).toBe("✓ Send(you → eel · forward #17)");
	});

	it("shows the number and resolved recipients, the body previewed collapsed and whole expanded", () => {
		const args = { to: "parent", message: BODY };
		expect(result(args, { id: 42, to: ["kraken"] }, false)).toBe(
			'  ⎿  #42 queued for kraken · "one" (ctrl+o to expand)',
		);
		expect(result(args, { id: 42, to: ["kraken"] }, true)).toBe(
			"  ⎿  #42 queued for kraken\n     one\n     two\n     three\n     four\n     five",
		);
		// A recipient the header already names is not repeated.
		expect(result({ to: "ink", message: "hi" }, { id: 43, to: ["ink"] }, false)).toBe(
			'  ⎿  #43 queued · "hi" (ctrl+o to expand)',
		);
		expect(result({ to: "all", message: "hi" }, { id: 47, to: ["a", "b", "c"] }, false)).toMatch(
			/^ {2}⎿ {2}#47 queued for 3 agents · "hi"/,
		);
		expect(result({ to: "eel", forward: 17 }, { id: 17, to: ["eel"], forwarded: true }, false)).toBe(
			"  ⎿  #17 forwarded",
		);
	});
});

describe("delivered agent mail rows", () => {
	const { mail } = setup();
	const at = Date.UTC(2026, 10, 15, 14, 5, 0);
	const row = (entry: Record<string, unknown>, expanded: boolean) =>
		rendered(
			mail({ details: { messages: [{ at, text: BODY, replyRequired: false, ...entry }] } }, { expanded }, theme),
		);

	it("names the sender with its entity mark and role, the real recipient, number and kind", () => {
		expect(row({ id: 51, from: "ink", sender: { role: "implementer" }, to: "kraken" }, false).split("\n")[0]).toMatch(
			new RegExp(`^ ✉ ${ENTITY.subagent} ink\\(implementer\\) → kraken · #51 · FYI · \\d\\d:\\d\\d:\\d\\d$`),
		);
		expect(row({ id: 52, from: "kraken", sender: { role: "main" }, to: "ink", replyRequired: true }, false)).toContain(
			`✉ ${ENTITY.main} kraken(main) → ink · #52 · request ·`,
		);
		expect(row({ id: 53, from: "kelp", to: "ink", replyTo: 43 }, false)).toContain(
			"✉ kelp → ink · #53 · reply to #43 ·",
		);
		expect(row({ id: 54, from: "kraken", to: "ink", interrupt: true }, false)).toContain("· #54 · interrupt ·");
		const forwarded = row({ id: 17, from: "dolphin", to: "ink", forwardedBy: "kraken", note: "please handle" }, true);
		expect(forwarded).toContain("✉ dolphin → ink · #17 · FYI · forwarded by kraken ·");
		expect(forwarded).toContain("kraken: please handle");
	});

	it("falls back to the sender alone when the entry names no recipient, and never says `you`", () => {
		const line = row({ id: 51, from: "ink", sender: { role: "implementer" } }, false).split("\n")[0];
		expect(line).toMatch(/^ ✉ \S+ ink\(implementer\) · #51 · FYI · /);
		expect(line).not.toContain("→");
		expect(row({ id: 51, from: "ink", to: "kraken" }, false)).not.toContain("you");
	});

	it("names each end with its role, worktree and tmux marks when the endpoints resolve", () => {
		const ends: Record<string, Endpoint> = {
			ink: { id: "ink", role: "implementer", worktree: "worktree fix", branch: "fix/x", tmuxPane: "%4" },
			kraken: { id: "kraken", role: "main", worktree: "main", departed: true },
		};
		const message = { details: { messages: [{ at, id: 7, from: "ink", to: "kraken", text: "hi" }] } };
		const header = rendered(mailRows(message, { expanded: false, endpoints: (id) => ends[id] ?? { id } }, theme)).split(
			"\n",
		)[0];
		expect(header).toMatch(
			/ink\(implementer\) \[worktree fix, fix\/x, tmux [^\]]+\] → kraken\(main, left\) \[main\] · #7 · FYI · /,
		);
		expect(header).not.toContain("→ you");
	});

	it("previews the body collapsed and shows it whole expanded", () => {
		const collapsed = row({ id: 51, from: "ink" }, false);
		expect(collapsed).toMatch(/⎿ {2}one\n\s+two\n\s+three\n\s+… \+2 lines/);
		expect(collapsed).not.toContain("five");
		expect(row({ id: 51, from: "ink" }, true)).toMatch(/one\n\s+two\n\s+three\n\s+four\n\s+five$/);
	});
});
