import fs from "node:fs";
import path from "node:path";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { describe, expect, it, vi } from "vitest";
import { entryActivity } from "../../src/core/application/service/activity-data.ts";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { compactionOutcome, liftedLine } from "../../src/core/compaction/outcome-read.ts";
import { USER_NOTICE_CHANNEL, publishUserNotice } from "../../src/octocode/shared/user-notice.ts";
import { NOTICE_LINE_TYPE } from "../../src/core/notice-line.ts";
import { registerNoticeLines } from "../../src/octocode/ui/notice-lines.ts";
import { approveFixtureHooks } from "./guard-helpers.ts";
import { fakeCtx, fakeHost, rendered, theme } from "./fake-host.ts";
import { HOOK_SETTINGS, tmp } from "./helpers.ts";

const lifted = [
	{ id: "C3", text: "Never push to main", reason: "the user allowed it" },
	{ id: "D2", text: "Use the v2 API", reason: "" },
];
const compactionEntry = (details: unknown) => ({
	type: "compaction",
	id: "c1",
	summary: "summary",
	tokensBefore: 212_000,
	details,
});

function host(settings: Record<string, unknown> = {}) {
	const f = fakeHost(settings);
	const channels = createEventBus();
	Object.assign(f.api, { channels });
	const notices: unknown[] = [];
	channels.on(USER_NOTICE_CHANNEL, (notice) => notices.push(notice));
	registerNoticeLines(f.api);
	return { ...f, notices };
}

const session = (entries: unknown[] = []) => ({ getEntries: () => entries });

describe("compaction outcome line", () => {
	it("names the lifted rules and decisions, a few of them, in one line", () => {
		expect(liftedLine(lifted)).toBe(
			"Compaction lifted 1 rule and 1 decision: [C3] Never push to main (the user allowed it); [D2] Use the v2 API",
		);
		const many = Array.from({ length: 5 }, (_, i) => ({ id: `C${i}`, text: `rule ${i}`, reason: "" }));
		expect(liftedLine(many)).toBe("Compaction lifted 5 rules: [C0] rule 0; [C1] rule 1; [C2] rule 2; 2 more");
		expect(liftedLine([])).toBeUndefined();
	});

	it("reads the outcome the entry records, and nothing from an older entry", () => {
		expect(
			compactionOutcome(
				compactionEntry({ trigger: "agent", estimatedTokensAfter: 96_000, focus: { source: "agent" }, lifted }),
			),
		).toEqual({ tokensBefore: 212_000, estimatedTokensAfter: 96_000, trigger: "agent", focusSource: "agent", lifted });
		expect(compactionOutcome({ tokensBefore: 5 })).toEqual({
			tokensBefore: 5,
			estimatedTokensAfter: undefined,
			trigger: undefined,
			focusSource: undefined,
			lifted: [],
		});
	});

	it("writes one note and announces it when a compaction lifted carried bullets, and nothing otherwise", async () => {
		const f = host();
		const ctx = fakeCtx({ cwd: tmp() });
		await f.fire("session_compact", { reason: "threshold", compactionEntry: compactionEntry({ lifted }) }, ctx);
		await f.fire("session_compact", { reason: "threshold", compactionEntry: compactionEntry({}) }, ctx);
		expect(f.entries).toEqual([
			{ customType: NOTICE_LINE_TYPE, data: { kind: "compaction_lifted", text: liftedLine(lifted) } },
		]);
		expect(f.notices).toEqual([
			{ type: "compaction_lifted", title: "Octocode: compaction lifted rules", message: liftedLine(lifted) },
		]);
		const line = f.renderers.get(NOTICE_LINE_TYPE)({ data: f.entries[0].data }, {}, theme);
		expect(rendered(line)).toContain("Compaction lifted 1 rule");
		// The web view lists the same line.
		expect(
			entryActivity({ type: "custom", customType: NOTICE_LINE_TYPE, data: f.entries[0].data } as never),
		).toMatchObject({
			kind: "custom",
			text: liftedLine(lifted),
			data: { kind: "compaction_lifted" },
		});
	});

	it("keeps the outcome a saved compaction entry records in the web activity", () => {
		const activity = entryActivity({
			...compactionEntry({ estimatedTokensAfter: 96_000, lifted, readFiles: ["private.ts"] }),
			firstKeptEntryId: "k",
			parentId: null,
			timestamp: "",
		} as never);
		expect(activity?.data).toMatchObject({ tokensBefore: 212_000, estimatedTokensAfter: 96_000, liftedCount: 2 });
		expect(JSON.stringify(activity?.data)).not.toContain("private.ts");
	});
});

describe("lean prompt note", () => {
	const small = { provider: "local", id: "tiny", contextWindow: 32_000 };
	const large = { provider: "anthropic", id: "claude-opus-5-5", contextWindow: 1_000_000 };

	it("says once per model when leanPrompt auto turns the lean policy on", async () => {
		const f = host();
		const ctx = { ...fakeCtx({ cwd: tmp() }), sessionManager: session() };
		await f.fire("session_start", { reason: "startup" }, ctx);
		await f.fire("before_agent_start", {}, { ...ctx, model: large });
		await f.fire("before_agent_start", {}, { ...ctx, model: small });
		await f.fire("before_agent_start", {}, { ...ctx, model: small });
		expect(f.entries).toEqual([
			{
				customType: NOTICE_LINE_TYPE,
				data: {
					kind: "lean_prompt",
					model: "local/tiny",
					text: 'Lean prompt on for local/tiny: its 32k-token window is at most 65.5k (leanPrompt "auto"; no delegation or skill list)',
				},
			},
		]);
		expect(f.notices).toEqual([]);
	});

	it("names the small-tier model, stays quiet when the user chose the lean prompt, and on a resume that said it", async () => {
		const tiered = host({ subagents: { models: { small: "anthropic/claude-opus-5-5" } } });
		const ctx = { ...fakeCtx({ cwd: tmp() }), sessionManager: session() };
		await tiered.fire("session_start", { reason: "startup" }, ctx);
		await tiered.fire("before_agent_start", {}, { ...ctx, model: large });
		expect(tiered.entries[0]?.data).toMatchObject({ text: expect.stringContaining("subagents.models.small") });

		const chosen = host({ leanPrompt: "on" });
		await chosen.fire("session_start", { reason: "startup" }, ctx);
		await chosen.fire("before_agent_start", {}, { ...ctx, model: small });
		expect(chosen.entries).toEqual([]);

		const resumed = host();
		const said = {
			type: "custom",
			customType: NOTICE_LINE_TYPE,
			data: { kind: "lean_prompt", model: "local/tiny", text: "x" },
		};
		const resumedCtx = { ...fakeCtx({ cwd: tmp() }), sessionManager: session([said]) };
		await resumed.fire("session_start", { reason: "resume" }, resumedCtx);
		await resumed.fire("before_agent_start", {}, { ...resumedCtx, model: small });
		expect(resumed.entries).toEqual([]);
	});
});

describe("Notification hooks for announced notices", () => {
	it("runs the hooks matching the notice type, with notification_type, in the session it belongs to", async () => {
		const cwd = tmp("octocode-notice-hooks-");
		vi.stubEnv("OCTOCODE_HOME", tmp());
		fs.mkdirSync(path.join(cwd, ".git"));
		fs.mkdirSync(path.join(cwd, ".octocode"));
		const hooks = {
			Notification: [
				{ matcher: "compaction_lifted|memory_update", hooks: [{ type: "command", command: "cat >> notes.jsonl" }] },
			],
		};
		fs.writeFileSync(path.join(cwd, ".octocode", "hooks.json"), JSON.stringify({ hooks }));
		approveFixtureHooks(cwd);
		const f = fakeHost(HOOK_SETTINGS);
		const channels = createEventBus();
		Object.assign(f.api, { channels });
		registerHooks(f.api, { env: {}, home: tmp() });
		const ctx = {
			cwd,
			hasUI: false,
			isProjectTrusted: () => true,
			sessionManager: { getSessionId: () => "sess-1", getSessionFile: () => undefined },
			ui: { notify: () => undefined },
		};
		// Before the session starts there is no session to run them in.
		publishUserNotice(channels, { type: "memory_update", title: "early", message: "before start" });
		await f.fire("session_start", { reason: "startup" }, ctx);
		publishUserNotice(channels, { type: "model_stalled", title: "Octocode", message: "not matched" });
		publishUserNotice(channels, {
			type: "compaction_lifted",
			title: "Octocode: compaction lifted rules",
			message: "line",
		});
		const file = path.join(cwd, "notes.jsonl");
		await vi.waitFor(() => expect(fs.existsSync(file) && fs.readFileSync(file, "utf8")).toBeTruthy());
		const sent = fs
			.readFileSync(file, "utf8")
			.split(/(?<=\})\s*(?=\{)/)
			.map((text) => JSON.parse(text));
		expect(sent).toEqual([
			expect.objectContaining({
				hook_event_name: "Notification",
				notification_type: "compaction_lifted",
				title: "Octocode: compaction lifted rules",
				message: "line",
			}),
		]);
		await f.fire("session_shutdown", { reason: "quit" }, ctx);
	}, 15_000);
});
