import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { ReportQueue } from "../../src/octocode/subagents/handoff.ts";
import { ReadReports } from "../../src/octocode/subagents/handoff/scratch.ts";
import { childStagger } from "../../src/octocode/subagents/stagger.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { fakeHost, rendered, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";
import { reportOf, setup, unsourced, useScriptedChild } from "./subagent-tool-harness.ts";

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

useScriptedChild();

describe("agent tool with a scripted child", () => {
	let s: ReturnType<typeof setup>;
	beforeEach(() => {
		s = setup();
	});

	it("reports a background child that crashed while starting as failed (startup), with its cause in the details", async () => {
		await s.run({ task: "startup plain", background: true });
		await vi.waitFor(() => expect(s.sent.length).toBeGreaterThan(0));
		const report = s.sent.at(-1)!.message;
		expect(report.content).toContain("exited with code 2");
		expect(report.details).toMatchObject({
			outcome: "failed",
			startup: { failed: true, cause: "No API key for provider" },
		});
		expect(report.details).not.toHaveProperty("firstTurnTokens");
		s.sent.length = 0;
	});

	it("still tells the parent when building its background report throws twice", async () => {
		const add = vi.spyOn(ReportQueue.prototype, "add");
		add.mockImplementationOnce(() => {
			throw new Error("report path broke");
		});
		add.mockImplementationOnce(() => {
			throw new Error("stop report broke too");
		});
		try {
			await s.run({ task: "report from the background", background: true });
			// The parent session is sent one report: failed, naming the second failure, and it starts a turn.
			await vi.waitFor(() => expect(s.sent).toHaveLength(1));
			const { message, options } = s.sent[0];
			expect(message.customType).toBe("octocode-agent-result");
			expect(String(message.content)).toContain("stop report broke too");
			expect(message.details).toMatchObject({ status: "failed", outcome: "failed" });
			expect(options).toMatchObject({ triggerTurn: true });
			await s.control.settle();
			expect(s.sent).toHaveLength(1);
		} finally {
			add.mockRestore();
		}
	});

	it("staggers background and foreground children of one profile and model through the shared prefix gate", async () => {
		const stagger = vi.spyOn(childStagger, "run");
		// A model whose cache read costs less than the write: its siblings save by waiting for the first one's entry.
		const priced = { api: "anthropic-messages", cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } };
		Object.assign(s.ctx.model!, priced);
		try {
			await s.run({ task: "report from the background", background: true });
			await s.run({ task: "report from the background", background: true });
			await s.run({ task: "report back" });
			await vi.waitFor(() => expect(s.sent.length).toBe(2));
			expect(stagger).toHaveBeenCalledTimes(3);
			expect(stagger.mock.calls[0][0]).toBe(stagger.mock.calls[1][0]);
			expect(stagger.mock.calls[2][0]).toBe(stagger.mock.calls[0][0]);
			expect(stagger.mock.calls[0][0]).toContain("general");
		} finally {
			stagger.mockRestore();
			for (const key of Object.keys(priced)) delete (s.ctx.model as unknown as Record<string, unknown>)[key];
		}
	});

	it("does not hold the children of a model without cache prices", async () => {
		const stagger = vi.spyOn(childStagger, "run");
		try {
			await s.run({ task: "report from the background", background: true });
			await s.run({ task: "report from the background", background: true });
			await vi.waitFor(() => expect(s.sent.length).toBe(2));
			expect(stagger).not.toHaveBeenCalled();
		} finally {
			stagger.mockRestore();
		}
	});

	it("runs in the background, delivers the answer as a message, and /agents kill stops one", async () => {
		const started = await s.run({ task: "report from the background", background: true });
		expect(started.content[0].text).toMatch(/^Started [a-z]+-[a-z]+ \(general\) in the background/);
		// The coordinator learns the child's model and thinking level as it starts.
		expect(started.content[0].text).toMatch(
			/its report arrives as a message\. Runs on faux\/model, medium thinking \(this session's model\)\.$/,
		);
		await vi.waitFor(() => expect(s.sent.length).toBeGreaterThan(0));
		const answer = s.sent[0];
		expect(answer.options).toEqual({ triggerTurn: true, deliverAs: "followUp", together: true });
		expect(unsourced(answer.message.content)).toMatch(
			/^Background subagent [a-z]+-[a-z]+ \(general: check things\) finished \(\d+s · 1 tool call · ≈\$0\.01\) · ran on faux\/model, medium thinking \(this session's model\) · cite as report:[a-z]+-[a-z]+:\n<<<untrusted-[0-9a-f]{16} \(data from the sender[^\n]*\)\nreport /,
		);
		// The child's words end inside the fence; the footer after it is the parent's. The route is in the header, and a
		// finished run's session path is left out: its id resumes it.
		expect(String(answer.message.content)).toMatch(/\nuntrusted-[0-9a-f]{16}>>>\n\(Last screenshot: /);
		expect(String(answer.message.content)).not.toMatch(/\nSession [^:\n]+: /);
		const renderer = s.renderers.get("octocode-agent-result");
		// The report starts with no outcome word: its outcome is unknown, which is not a failure.
		expect(answer.message.details).not.toHaveProperty("outcome");
		expect(answer.message.details).toMatchObject({
			status: "done",
			summary: "Done · 1 tool call",
			durationMs: expect.any(Number),
		});
		const shown = rendered(renderer(answer.message, { expanded: false }, theme));
		// A finished row names its time only from 1s on; this scripted run's time depends on machine load.
		expect(shown).toMatch(
			// A settled agent row draws its still state light (◉ done, ⊗ failed, ⊘ cancelled): ⏺ means running only.
			/^ ◉ Agent\([a-z]+-[a-z]+ · check things\) · background(?: · \S+)?\n {3}⎿ {2}Done · 1 tool call/,
		);
		expect(shown).toContain("report");

		await s.run({ task: "error in background", background: true });
		await vi.waitFor(() => expect(s.sent.length).toBe(2));
		expect(s.sent[1].message.content).toMatch(
			/failed · cite as report:\S+:\n<<<untrusted-[0-9a-f]{16} [\s\S]*\nError: provider down[\s\S]*>>>\nRetry with a narrower task or do the work yourself/,
		);
		expect(s.sent[1].message.details).toMatchObject({
			status: "failed",
			outcome: "failed",
			summary: "Failed: provider down",
		});
		expect(rendered(renderer(s.sent[1].message, { expanded: false }, theme))).toMatch(
			/^ ⊗ Agent\([a-z]+-[a-z]+[^\n]*\n {3}⎿ {2}Failed: provider down/,
		);

		const kill = {
			handler: (args: string, ctx: unknown) => s.commands.get("agents").handler(`kill ${args}`, ctx),
			getArgumentCompletions: (prefix: string) => s.commands.get("agents").getArgumentCompletions(`kill ${prefix}`),
		};
		await kill.handler("", s.ctx);
		expect(s.ctx.ui.notes.at(-1)).toEqual({ message: "Usage: /agents kill <id>. None is running.", type: "warning" });
		const slow = await s.run({ task: "slow background", background: true });
		const id = slow.details.id as string;
		expect(await kill.getArgumentCompletions(id.slice(0, 3))).toEqual([
			expect.objectContaining({ value: `kill ${id}`, label: id }),
		]);
		await kill.handler("ghost", s.ctx);
		expect(s.ctx.ui.notes.at(-1)!.message).toBe(`No running subagent "ghost". Running: ${id}`);
		// settle() resolves once every background subagent has reported (index.ts holds a headless run on it).
		let settled = false;
		const waiting = s.control.settle().then(() => {
			settled = true;
			return settled;
		});
		// No fixed sleep: flush pending callbacks; settle cannot resolve before the kill below.
		await new Promise((resolve) => setImmediate(resolve));
		expect(settled).toBe(false);
		// Declining stops nothing.
		const accept = s.ctx.ui.confirm;
		s.ctx.ui.confirm = async () => false;
		await kill.handler(id, s.ctx);
		expect(s.ctx.ui.notes.at(-1)!.message).toBe("Cancelled: nothing was stopped.");
		expect(settled).toBe(false);
		s.ctx.ui.confirm = accept;
		await kill.handler(id, s.ctx);
		expect(s.ctx.ui.notes.at(-1)).toEqual({ message: `Stopping ${id}…`, type: "info" });
		await waiting;
		await vi.waitFor(() => expect(s.sent.length).toBe(3));
		expect(unsourced(s.sent[2].message.content)).toBe(
			`Background subagent ${id} (general: check things) cancelled by the user`,
		);
		// A stop the user asked for is an interruption, not a failure; the prompt is one expand away.
		expect(rendered(renderer(s.sent[2].message, { expanded: false }, theme))).toMatch(
			/^ ⊘ Agent.*\n {3}⎿ {2}Cancelled by the user\n {6}… prompt \(ctrl\+o to expand\)$/,
		);
		expect(s.sent[2].options).toEqual({ triggerTurn: false, deliverAs: "followUp", together: true });
	});

	it("lets the parent agent stop only the background subagents it started, with coordinate stop", async () => {
		registerCollab(s.api, s.team, { stopAgent: (id, by) => s.control.stop(id, by) });
		const coordinate = s.tools.get("coordinate");
		const stop = (id?: string) =>
			coordinate.execute("c1", { action: "stop", ...(id ? { id } : {}) }, undefined, undefined, s.ctx);
		await expect(stop("ghost")).rejects.toThrow('No background subagent "ghost". None is running.');
		const slow = await s.run({ task: "slow background", background: true });
		const id = slow.details.id as string;
		expect((await stop(id)).content[0].text).toBe(
			`Stopping ${id}: its process tree is killed and its report arrives as a message.`,
		);
		await vi.waitFor(() =>
			expect(unsourced(s.sent.at(-1)?.message.content)).toBe(
				`Background subagent ${id} (general: check things) stopped by ${s.team.id}`,
			),
		);
		// The parent asked for the stop: the report is queued without waking it for another turn.
		expect(s.sent.at(-1)!.options).toEqual({ triggerTurn: false, deliverAs: "followUp", together: true });
		await expect(stop(id)).rejects.toThrow(/No background subagent/);
		// A subagent has no children to stop: `stop` is not offered to it at all (a stray call is still refused).
		const child = fakeHost();
		registerCollab(child.api, new Team(child.api));
		const childTool = child.tools.get("coordinate");
		expect(childTool.parameters.properties.action.enum).not.toContain("stop");
		expect(childTool.parameters.properties.id).toBeUndefined();
		await expect(childTool.execute("c2", { action: "stop", id }, undefined, undefined, s.ctx)).rejects.toThrow(
			/Only the agent that started a subagent can stop it/,
		);
	});

	it("stops background runs at session shutdown and waits for them to file their reports", async () => {
		const slow = await s.run({ task: "slow at shutdown", background: true });
		await s.emit("session_shutdown", {}, s.ctx);
		// Shutdown returns only after the stopped child exited and its report was filed.
		expect(unsourced(s.sent.at(-1)?.message.content)).toBe(
			`Background subagent ${slow.details.id} (general: check things) stopped by session shutdown`,
		);
		expect(s.sent.at(-1)!.options.triggerTurn).toBe(false);
	});

	/** The background reports sent to the parent (its team mail, the child's questions, is sent too). */
	const reports = () => s.sent.filter((entry) => entry.message.customType === "octocode-agent-result");

	/** Acts as the gated child's team: joins it, asks its parent twice (one FYI too), and returns the store to answer with. */
	async function askAsChild(id: string) {
		const store = TeamStore.open(s.cwd, process.env.OCTOCODE_AGENT_DB);
		const parentId = s.team.id!;
		store.save({
			id,
			role: "general",
			parentId,
			pid: process.pid,
			status: "working",
			joinedAt: Date.now(),
			updatedAt: Date.now(),
			toolCalls: 0,
			input: 0,
			cacheRead: 0,
			output: 0,
			cost: 0,
			unpriced: false,
		});
		const first = store.send(id, [parentId], "Which database should the migration target?", {
			replyRequired: true,
		}).id!;
		store.send(id, [parentId], "FYI: tests are slow", { replyRequired: false });
		const second = store.send(id, [parentId], "Rename the column too?", { replyRequired: true }).id!;
		return { store, parentId, first, second };
	}

	it("records a child's questions to its parent in the run details, the report footer and /agents", async () => {
		const gate = path.join(tmp(), "gate");
		process.env.OCTOCODE_FAKE_GATE = gate;
		const started = await s.run({ task: "gated background", background: true });
		const id = started.details.id as string;
		const { store, parentId, first, second } = await askAsChild(id);
		try {
			await vi.waitFor(() => expect(store.asks(id, parentId, 0)).toHaveLength(2));
			// The parent answers the first question; the second stays open. /agents shows the live count.
			store.send(parentId, [id], "Postgres", { replyRequired: false, replyTo: first });
			// With a UI `/agents` opens a picker (agents-detail.test.ts); the text listing is what a session without one gets.
			const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
			s.ctx.hasUI = false;
			try {
				await s.commands.get("agents").handler("", s.ctx);
			} finally {
				s.ctx.hasUI = true;
				stderr.mockRestore();
			}
			expect(s.ctx.ui.notes.at(-1)!.message).toMatch(
				/\n {2}2 asks \(1 answered in \d+s, 1 unanswered\) to its coordinator/,
			);
			fs.writeFileSync(gate, "");
			await vi.waitFor(() => expect(reports()).toHaveLength(1));
		} finally {
			store.close();
			delete process.env.OCTOCODE_FAKE_GATE;
		}
		const { message } = reports()[0];
		expect(String(message.content)).toMatch(/2 asks[\s\S]*1 answered[\s\S]*1 unanswered/);
		// An unanswered ask keeps the child resumable, and the report says it waits for a reply.
		expect(String(message.content)).toContain("600 s");
		expect(message.details.asks).toEqual([
			{
				id: first,
				text: "Which database should the migration target?",
				askedAt: expect.any(Number),
				answer: { id: expect.any(Number), at: expect.any(Number), by: parentId },
			},
			{ id: second, text: "Rename the column too?", askedAt: expect.any(Number) },
		]);
		expect(message.details.asks[0].answer.at).toBeGreaterThanOrEqual(message.details.asks[0].askedAt);
	});

	it("returns a foreground run's asks in its details and marks an answer that followed an askUser call", async () => {
		const gate = path.join(tmp(), "gate");
		process.env.OCTOCODE_FAKE_GATE = gate;
		let id: string | undefined;
		const running = s.run({ task: "gated foreground" }, undefined, (update) => {
			id ||= (update as { details: { id: string } }).details.id;
			return id;
		});
		try {
			await vi.waitFor(() => expect(id).toBeTruthy());
			const { store, parentId, first } = await askAsChild(id!);
			try {
				// The parent asks the user, then answers: the answer is marked.
				await s.emit("tool_execution_start", { toolCallId: "ask-1", toolName: "askUser" }, s.ctx);
				await s.emit("tool_execution_end", { toolCallId: "ask-1", toolName: "askUser" }, s.ctx);
				store.send(parentId, [id!], "Postgres, the user said", { replyRequired: false, replyTo: first });
			} finally {
				store.close();
			}
			fs.writeFileSync(gate, "");
			const result = await running;
			expect(
				result.details.asks.map((ask: { id: number; answer?: { afterAskUser?: boolean } }) => [
					ask.id,
					ask.answer?.afterAskUser,
				]),
			).toEqual([
				[first, true],
				[first + 2, undefined],
			]);
			expect(result.content[0].text).toMatch(
				/\nAsks to its coordinator: 2 asks \(1 answered in \d+s \(1 after askUser\), 1 unanswered\)\./,
			);
		} finally {
			fs.writeFileSync(gate, "");
			delete process.env.OCTOCODE_FAKE_GATE;
		}
	});

	it("omits asks from a run that asked nothing", async () => {
		const result = await s.run({ task: "report quickly" });
		expect(result.details).not.toHaveProperty("asks");
		expect(result.content[0].text).not.toContain("Asks to its coordinator");
	});

	it("propagates the coordinator identity while another teammate is running", async () => {
		const first = await s.run({ task: "slow teammate", goal: "slow teammate", background: true });
		const second = await s.run({ task: "report as a teammate" });
		const facts = reportOf(second.content[0].text);
		expect(facts.task).toContain(s.team.id);
		await s.commands.get("agents").handler(`kill ${first.details.id}`, s.ctx);
		await vi.waitFor(() => expect(s.sent.at(-1)?.message.content).toContain("cancelled by the user"));
	});
});

describe("background report delivery", () => {
	it("batches reports so only the last of a batch may start a turn", () => {
		const f = fakeHost();
		const queue = new ReportQueue(f.api);
		const report = (id: string, wake: boolean) => ({
			content: id,
			details: { id, status: "done" as const, summary: "Done" },
			wake,
		});
		queue.add(report("a", true));
		queue.add(report("b", false));
		queue.add(report("c", false));
		expect(f.sent).toHaveLength(0);
		queue.flush();
		expect(f.sent.map((entry) => [unsourced(entry.message.content), entry.options.triggerTurn])).toEqual([
			["a", false],
			["b", false],
			["c", true],
		]);
		queue.add(report("d", false));
		queue.flush();
		expect(f.sent.at(-1)!.options).toEqual({ triggerTurn: false, deliverAs: "followUp", together: true });
	});

	it("delivers without a turn a report whose file the parent already read since it was written", () => {
		const cwd = tmp();
		const scratch = path.join(cwd, ".octocode", "agent", "temp", "agents", "general-abcdef");
		fs.mkdirSync(scratch, { recursive: true });
		const file = path.join(scratch, "report.md");
		fs.writeFileSync(file, "report");
		const past = new Date(Date.now() - 10_000);
		fs.utimesSync(file, past, past);
		const read = new ReadReports();
		read.track("general-abcdef", scratch);
		read.observe("read", { path: ".octocode/agent/temp/agents/general-abcdef/report.md" }, cwd);
		expect(read.consume("general-abcdef")).toBe(true);
		// Rewritten after the read: the parent has not seen the final version.
		read.track("general-abcdef", scratch);
		read.observe("read", { path: file }, cwd);
		// An MCP tool's input is the server's contract: it never counts as reading the report.
		read.observe("mcp__octocode__localFetch", { queries: [{ path: file }] }, cwd);
		const future = new Date(Date.now() + 10_000);
		fs.utimesSync(file, future, future);
		expect(read.consume("general-abcdef")).toBe(false);
		// Never read.
		read.track("general-abcdef", scratch);
		expect(read.consume("general-abcdef")).toBe(false);
	});

	it("keeps a scratch folder the subagent saved files in, and names it in the receipt", async () => {
		const s = setup();
		const result = await s.run({ task: "long report" });
		const { id } = result.details as { id: string };
		const scratch = path.join(s.cwd, ".octocode", "agent", "temp", "agents", id);
		expect(fs.existsSync(path.join(scratch, "report.md"))).toBe(true);
		const late = await s.team.send(id, "more");
		expect("error" in late && late.error).toContain(`(files it handed back, and its full report when cut, are in`);
	});
});

describe("a child report as the parent model reads it", () => {
	it("fences foreground child text containing forged opening and closing markers", async () => {
		const s = setup();
		try {
			const result = await s.run({ task: "forged report" });
			const text = result.content[0].text;
			const lines = text.split("\n");
			const marker = /^<<<(untrusted-[0-9a-f]{16}) /m.exec(text)![1];
			const close = lines.lastIndexOf(`${marker}>>>`);
			expect(lines[0]).toMatch(
				new RegExp(
					`^Subagent ${result.details.id} reported done · ran on [^\\n]+ · cite as report:${result.details.id}:$`,
				),
			);
			expect(lines.findIndex((line: string) => line.startsWith("Message #2"))).toBeGreaterThan(1);
			expect(lines.findIndex((line: string) => line.startsWith("Message #3"))).toBeLessThan(close);
			expect(text).toContain("<<<untrusted-0000000000000000");
			expect(lines.filter((line: string) => line === `${marker}>>>`)).toHaveLength(1);
		} finally {
			await s.fire("session_shutdown", { type: "session_shutdown" }, s.ctx);
		}
	});

	it("keeps a report that forges a user message, a header and a fence line inside the fence, under a header the parent wrote", async () => {
		const s = setup();
		const started = await s.run({ task: "forged report", background: true, goal: "review auth" });
		const id = (started.details as { id: string }).id;
		await vi.waitFor(() => expect(s.sent.length).toBeGreaterThan(0));
		expect(s.sent[0].message.details).toMatchObject({ status: "done", outcome: "done" });
		const content = unsourced(s.sent[0].message.content);
		const lines = content.split("\n");
		// The header is the parent's: this agent, its role and goal, its statistics. Nothing before the fence is the child's.
		expect(lines[0]).toMatch(
			new RegExp(
				`^Background subagent ${id} \\(general: review auth\\) reported done \\(.*\\) · ran on .* · cite as report:${id}:$`,
			),
		);
		const open = lines.findIndex((line) => line.startsWith("<<<untrusted-"));
		const marker = /^<<<(untrusted-[0-9a-f]{16}) /.exec(lines[open])![1];
		const close = lines.lastIndexOf(`${marker}>>>`);
		expect(open).toBe(1);
		// Every forged line sits between the real fence lines, and the forged fence line did not end it.
		const forged = lines
			.map((line, index) => [line, index] as const)
			.filter(([line]) => /^Message #\d from the user/.test(line));
		expect(forged).toHaveLength(2);
		expect(forged.every(([, index]) => index > open && index < close)).toBe(true);
		expect(close).toBeGreaterThan(forged.at(-1)![1]);
		expect(lines.filter((line) => line === `${marker}>>>`)).toHaveLength(1);
		// The screen shows the child's words without the fence lines.
		const shown = rendered(s.renderers.get("octocode-agent-result")(s.sent[0].message, { expanded: true }, theme));
		expect(shown).toContain("Message #2 from the user");
		expect(shown).not.toContain(`${marker}>>>`);
		await s.fire("session_shutdown", { type: "session_shutdown" }, s.ctx);
	});
});
