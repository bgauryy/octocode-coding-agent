import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { reservationTargets, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { reservationPath } from "../../src/octocode/shared/home.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { INTERNAL_MESSAGE_TYPE } from "../../src/octocode/shared/messages.ts";
import { type AgentControl, registerAgentTool } from "../../src/octocode/subagents/tool.ts";
import { AgentsView } from "../../src/octocode/team/panel.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { TeamStore } from "../../src/octocode/team/store.ts";
import { registerCollab } from "../../src/octocode/team/tools.ts";
import { registerActivity } from "../../src/octocode/ui/activity.ts";
import { fakeCtx, fakePermission, fakeHost, rendered, theme } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/** `/agents` as index.ts wires it: a direct native command. */
function agentsCommand(api: Parameters<Subcommands["register"]>[0], control: AgentControl): void {
	const commands = new Subcommands();
	commands.add("agents", control.command);
	commands.register(api);
}

function member(dbFile: string, cwd: string) {
	const fake = fakeHost();
	const team = new Team(fake.api, { OCTOCODE_AGENT_DB: dbFile });
	// As index.ts wires it: the permission layer's bash parse names the paths a command writes.
	const { reservationGate } = registerCollab(fake.api, team, {
		shellWrites: async (command) => {
			await shellParserReady();
			return reservationTargets(command);
		},
	});
	// As index.ts wires it: the activity line reaches the team panel.
	registerActivity(fake.api, { workingLine: false, onChange: (line) => team.setActivity(line) });
	agentsCommand(
		fake.api,
		registerAgentTool(fake.api, () => new Map(), team, fakePermission()),
	);
	const ctx = fakeCtx({ cwd });
	// The reservation gate as index.ts runs it in the tool-call pipeline.
	const gate = async (event: unknown, context: unknown) => [await reservationGate(event as never, context as never)];
	return { ...fake, team, ctx, gate };
}

/**
 * What an edit of `file` meets: the reservation check the `file` tool runs for each change (the gate itself leaves `file`
 * to it), with the path resolved against the caller's cwd as that tool does.
 */
const editGate = async (agent: ReturnType<typeof member>, file: string) => {
	const reason = agent.team.reservation(reservationPath(agent.ctx.cwd, file), file);
	return [reason ? { block: true, reason } : undefined];
};

const run = (
	tool: { execute: (...args: unknown[]) => Promise<{ content: { text: string }[]; details: { id: string } }> },
	params: unknown,
	ctx: unknown,
) => tool.execute("call-1", params, undefined, undefined, ctx);
const text = (result: { content: Array<{ text: string }> }) => result.content.map((part) => part.text).join("\n");

describe("team shutdown order", () => {
	it("stops this session's subagents before leaving the team, so their last messages still reach it", async () => {
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") });
		const joinedWhileStopping: boolean[] = [];
		registerCollab(fake.api, team, {
			beforeLeave: async () => {
				joinedWhileStopping.push(team.id !== undefined);
				return undefined;
			},
		});
		const ctx = fakeCtx({ cwd: tmp() });
		await fake.emit("session_start", {}, ctx);
		team.join();
		await fake.emit("session_shutdown", {}, ctx);
		expect(joinedWhileStopping).toEqual([true]);
		expect(team.id).toBeUndefined();
	});
});

describe("team tools on a fake Octocode", () => {
	const started: Array<ReturnType<typeof member>> = [];
	afterEach(async () => {
		for (const agent of started.splice(0)) await agent.emit("session_shutdown", {}, agent.ctx);
	});

	async function pair() {
		const cwd = tmp();
		const db = path.join(tmp(), "team.sqlite");
		const a = member(db, cwd);
		const b = member(db, cwd);
		started.push(a, b);
		await a.emit("session_start", {}, a.ctx);
		await b.emit("session_start", {}, b.ctx);
		return { a, b, cwd };
	}

	it("joins, lists, locks, blocks a peer edit, unlocks and leaves", async () => {
		const { a, b } = await pair();
		const coordinate = a.tools.get("coordinate");
		// O6b (design B36): a main session joins at session_start, so before any `join` it lists itself and the other session.
		const before = text(await run(coordinate, { action: "list" }, a.ctx));
		expect(before).toContain(`${a.team.id} (you) · main`);
		expect(before).toContain(`${b.team.id} · main`);
		const joined = text(await run(coordinate, { action: "join", goal: "refactor auth\nsecond line" }, a.ctx));
		expect(joined).toContain(a.team.id!);
		await expect(run(coordinate, { action: "lock" }, a.ctx)).rejects.toThrow("lock needs paths.");
		expect(text(await run(coordinate, { action: "lock", paths: ["src/a.ts", "lib/"], reason: "auth" }, a.ctx))).toBe(
			"Reserved: src/a.ts, lib/. Unlock when your edits are done.",
		);
		expect(text(await run(coordinate, { action: "lock", paths: ["src/b.ts"] }, a.ctx))).toBe(
			"Reserved: src/b.ts. You now hold 3 reservations. Unlock when your edits are done.",
		);
		await run(coordinate, { action: "unlock", paths: ["src/b.ts"] }, a.ctx);

		// The peer sees the reservation: its own lock fails, and its edit/write tool calls are blocked.
		await run(b.tools.get("coordinate"), { action: "join" }, b.ctx);
		await expect(run(b.tools.get("coordinate"), { action: "lock", paths: ["lib/x.ts"] }, b.ctx)).rejects.toThrow(
			/Not reserved; nothing was locked/,
		);
		const [blocked] = await editGate(b, "src/a.ts");
		expect(blocked).toMatchObject({
			block: true,
			reason: expect.stringMatching(new RegExp(`reserved by ${a.team.id} \\(auth; locked \\d+s ago\\)`)),
		});
		expect(await editGate(b, "@lib/deep/y.ts")).toEqual([expect.objectContaining({ block: true })]);
		// A bash command whose parse writes a reserved path is refused like an edit; reads, unreserved writes and unresolved targets pass.
		for (const command of [
			"echo x > src/a.ts",
			"cat in | tee src/a.ts",
			"sed -i s/a/b/ src/a.ts",
			"rm -f lib/deep/y.ts",
			"sh -c 'cp free.ts src/a.ts'",
			// The parse gives up (here: too large; live: its time budget on a loaded machine), yet the command names a reserved path.
			`echo x >> src/a.ts; ${"true; ".repeat(30_000)}`,
		])
			expect(await b.gate({ toolName: "bash", input: { command } }, b.ctx), command).toEqual([
				expect.objectContaining({ block: true, reason: expect.stringContaining(`reserved by ${a.team.id}`) }),
			]);
		for (const command of [
			"cat src/a.ts",
			"echo x > free.ts",
			"git status",
			"echo x > $TARGET",
			"cd /tmp && mv free.ts src/a.ts",
			`echo x >> free.ts; ${"true; ".repeat(30_000)}`,
		])
			expect(await b.gate({ toolName: "bash", input: { command } }, b.ctx), command).toEqual([undefined]);
		// `file` is guarded inside the file tool itself; unrelated tools pass.
		expect(await b.gate({ toolName: "file", input: { queries: [{ path: "src/a.ts" }] } }, b.ctx)).toEqual([undefined]);
		expect(await editGate(b, "free.ts")).toEqual([undefined]);

		const listed = text(await run(b.tools.get("coordinate"), { action: "list" }, b.ctx));
		expect(listed).toContain(a.team.id!);
		expect(listed).toContain("src/a.ts");

		expect(text(await run(coordinate, { action: "unlock", paths: ["src/a.ts"] }, a.ctx))).toBe(
			"Released 1 reservation(s).",
		);
		expect(await editGate(b, "src/a.ts")).toEqual([undefined]);
		expect(text(await run(coordinate, { action: "unlock" }, a.ctx))).toBe("Released 1 reservation(s).");
		expect(text(await run(coordinate, { action: "leave" }, a.ctx))).toBe("Left the team.");
		expect(text(await run(b.tools.get("coordinate"), { action: "list" }, b.ctx))).not.toContain(a.team.id!);
	});

	it("resolves lock paths against the caller's cwd, as the edit tools do, when Octocode runs in a subfolder", async () => {
		const root = tmp();
		fs.mkdirSync(path.join(root, ".git"));
		fs.mkdirSync(path.join(root, "pkg"));
		const db = path.join(tmp(), "team.sqlite");
		const inPkg = member(db, path.join(root, "pkg"));
		const atRoot = member(db, root);
		const peerInPkg = member(db, path.join(root, "pkg"));
		started.push(inPkg, atRoot, peerInPkg);
		for (const agent of [inPkg, atRoot, peerInPkg]) await agent.emit("session_start", {}, agent.ctx);
		const coordinate = inPkg.tools.get("coordinate");
		expect(
			text(await run(coordinate, { action: "lock", paths: ["src/a.ts", "lib/"], reason: "work" }, inPkg.ctx)),
		).toContain("pkg/src/a.ts");
		for (const agent of [atRoot, peerInPkg]) await run(agent.tools.get("coordinate"), { action: "join" }, agent.ctx);
		expect(await editGate(atRoot, "pkg/src/a.ts")).toEqual([expect.objectContaining({ block: true })]);
		expect(await editGate(peerInPkg, "src/a.ts")).toEqual([expect.objectContaining({ block: true })]);
		expect(await editGate(peerInPkg, path.join(root, "pkg", "lib", "deep.ts"))).toEqual([
			expect.objectContaining({ block: true }),
		]);
		// The same relative path at the repository root is another file.
		expect(await editGate(atRoot, "src/a.ts")).toEqual([undefined]);
		// A peer's conflicting lock names the path as the peer typed it.
		await expect(
			run(peerInPkg.tools.get("coordinate"), { action: "lock", paths: ["src/a.ts"] }, peerInPkg.ctx),
		).rejects.toThrow(/src\/a\.ts/);
		expect(text(await run(coordinate, { action: "unlock", paths: ["src/a.ts", "lib/"] }, inPkg.ctx))).toBe(
			"Released 2 reservation(s).",
		);
		expect(await editGate(atRoot, "pkg/src/a.ts")).toEqual([undefined]);
	});

	it("delivers messages between agents and rejects unknown recipients", async () => {
		const { a, b } = await pair();
		await run(b.tools.get("coordinate"), { action: "join" }, b.ctx);
		const send = a.tools.get("sendMessage");
		const sent = await run(send, { to: b.team.id, message: "please review src/a.ts", replyRequired: false }, a.ctx);
		expect(text(sent)).toMatch(
			new RegExp(
				`Queued message #\\d+ for ${b.team.id} as an FYI \\(no reply requested\\)\\. ${b.team.id} is idle: it reads this on its next turn and will not act on it alone; replyRequired: true asks and wakes\\.`,
			),
		);
		expect(sent.details).toMatchObject({ to: [b.team.id] });
		await vi.waitFor(
			() => expect(b.sent.some((entry) => entry.message.customType === INTERNAL_MESSAGE_TYPE)).toBe(true),
			{ timeout: 5_000 },
		);
		const delivered = b.sent.find((entry) => entry.message.customType === INTERNAL_MESSAGE_TYPE)!;
		expect(delivered.message.details.messages).toEqual([
			expect.objectContaining({ from: a.team.id, text: "please review src/a.ts" }),
		]);

		await expect(run(send, { to: "nobody-0000", message: "hi" }, a.ctx)).rejects.toThrow();
		const reply = await run(b.tools.get("sendMessage"), { to: "parent", message: "x" }, b.ctx).catch(
			(error: Error) => error,
		);
		expect(reply).toBeInstanceOf(Error);
	});

	it("sends a reply to the sender of the message it answers, and a message is an FYI unless it asks", async () => {
		const { a, b } = await pair();
		await run(a.tools.get("coordinate"), { action: "join" }, a.ctx);
		await run(b.tools.get("coordinate"), { action: "join" }, b.ctx);
		const send = a.tools.get("sendMessage");
		const sent = await run(send, { to: b.team.id, message: "which file?" }, a.ctx);
		// An unmarked message goes out as an FYI, and the sender is told it will not act on it alone.
		expect(text(sent)).toMatch(
			new RegExp(
				`Queued message #\\d+ for ${b.team.id} as an FYI \\(no reply requested\\)\\. ${b.team.id} is idle: it reads this on its next turn and will not act on it alone; replyRequired: true asks and wakes\\.`,
			),
		);
		const mail = (agent: typeof a) =>
			agent.sent
				.filter((entry) => entry.message.customType === INTERNAL_MESSAGE_TYPE)
				.flatMap((entry) => entry.message.details.messages);
		await vi.waitFor(() => expect(mail(b)).toHaveLength(1), { timeout: 5_000 });
		expect(mail(b)[0]).toMatchObject({ from: a.team.id, text: "which file?", replyRequired: false });

		// No `to`: the answer goes to the sender of message #id.
		const reply = await run(b.tools.get("sendMessage"), { replyTo: sent.details.id, message: "src/a.ts" }, b.ctx);
		expect(reply.details).toMatchObject({ to: [a.team.id] });
		await vi.waitFor(() => expect(mail(a)).toHaveLength(1), { timeout: 5_000 });
		expect(mail(a)[0]).toMatchObject({ from: b.team.id, text: "src/a.ts", replyRequired: false });

		// A request says who must answer and how.
		const asked = await run(send, { to: b.team.id, message: "which file now?", replyRequired: true }, a.ctx);
		expect(text(asked)).toMatch(
			new RegExp(
				`Queued message #${asked.details.id} for ${b.team.id} as a request: ${b.team.id} is woken and must answer with replyTo ${asked.details.id}\\.`,
			),
		);
		await vi.waitFor(() => expect(mail(b)).toHaveLength(2), { timeout: 5_000 });
		expect(mail(b)[1]).toMatchObject({ text: "which file now?", replyRequired: true });

		await expect(run(send, { message: "to nobody" }, a.ctx)).rejects.toThrow(
			/Say who to send to: `to`.*or `replyTo`.*Nothing was sent/,
		);
		await expect(run(send, { replyTo: 987654, message: "x" }, a.ctx)).rejects.toThrow(/No message #987654/);
		expect(rendered(send.renderCall({ replyTo: 41, message: "m" }, theme, {}))).toBe("○ Send(reply to #41)");
		const properties = send.parameters.properties;
		expect(send.parameters.required ?? []).toEqual([]);
		expect(properties.forward.type).toBe("integer");
		expect(properties.replyRequired.description).toContain("Default false");
		expect(properties.replyRequired.description).toContain("a request you need answered");
		expect(send.description).toContain("Messages resume only reachable non-isolated background children");
		expect(send.description).toContain("(yours, or siblings via your parent)");
		expect(properties.forward.description).toContain("message becomes an optional note");
		expect(send.description).not.toContain("cannot receive");
		// The same text serves a parent and a child (a child cannot start tasks), so it names no role.
		expect(send.description).not.toMatch(/start a new task|your child/);
		expect(properties.interrupt.description).not.toContain("your child");
	});

	it("refuses a lock call whose own paths overlap, and reserves nothing", async () => {
		const { a, b, cwd } = await pair();
		const coordinate = a.tools.get("coordinate");
		await expect(run(coordinate, { action: "lock", paths: ["src/", "src/a.ts"] }, a.ctx)).rejects.toThrow(
			/Requested paths overlap: src and src\/a\.ts\. Nothing was locked; reserve the tree alone, or each path once\./,
		);
		await expect(run(coordinate, { action: "lock", paths: ["x.ts", "X.ts"] }, a.ctx)).rejects.toThrow(
			/Requested paths overlap/,
		);
		// The refusals reserved nothing: the member holds no lease, and a peer is not blocked on any requested path.
		const me = a.team.members().find((entry) => entry.id === a.team.id);
		expect(me).toMatchObject({ id: a.team.id });
		expect(me?.locks ?? []).toEqual([]);
		for (const file of ["src/a.ts", "x.ts"]) expect(b.team.reservation(path.join(cwd, file), file)).toBeUndefined();
		expect(text(await run(coordinate, { action: "unlock" }, a.ctx))).toBe("Released 0 reservation(s).");
	});

	it("offers join, leave and a goal only to an agent that joins by hand; a subagent joins and leaves with its run", () => {
		const fake = fakeHost();
		registerCollab(fake.api, new Team(fake.api, { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") }));
		const subagent = fake.tools.get("coordinate").parameters;
		expect(subagent.properties.action.enum).toEqual(["list", "lock", "unlock", "changes"]);
		expect(subagent.properties).not.toHaveProperty("goal");
		const main = fakeHost();
		registerCollab(main.api, new Team(main.api, { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") }), {
			stopAgent: () => undefined,
		});
		const parameters = main.tools.get("coordinate").parameters;
		expect(parameters.properties.action.enum).toEqual([
			"list",
			"join",
			"leave",
			"lock",
			"unlock",
			"stop",
			"merge",
			"grant",
			"changes",
		]);
		// A subagent starts no children, so nothing in its schema or its cached prompt names a grant.
		expect(subagent.properties).not.toHaveProperty("requests");
		expect(parameters.properties.requests.description).toMatch(/^grant: /);
		expect(parameters.properties.action.description).toContain(
			"grant: add requests to the limits of a running subagent you started, for this run only",
		);
		expect(parameters.properties.goal.description).toMatch(/^join: your goal, in the form of a task goal/);
		expect(parameters.properties).not.toHaveProperty("note");
	});

	it("tracks activity and renders messages and calls", async () => {
		const { a, b } = await pair();
		await run(a.tools.get("coordinate"), { action: "join" }, a.ctx);
		await a.emit("agent_start", {}, a.ctx);
		await a.emit("tool_execution_start", { toolCallId: "t1", toolName: "bash", args: { command: "yarn test" } }, a.ctx);
		await a.emit(
			"message_end",
			{
				message: {
					role: "assistant",
					usage: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, totalTokens: 1500, cost: { total: 0 } },
				},
			},
			a.ctx,
		);
		await a.emit("message_end", { message: { role: "user" } }, a.ctx);
		// Activity reaches the shared database on the member's next tick.
		await vi.waitFor(
			() => {
				const busy = b.team.members().find((entry) => entry.id === a.team.id)!;
				expect(busy).toMatchObject({ status: "working", input: 1200, output: 300 });
				expect(busy.activity).toContain("bash");
			},
			{ timeout: 3_000 },
		);
		await a.emit("agent_end", {}, a.ctx);
		// Queued messages, retries and compaction can continue after agent_end.
		await new Promise((resolve) => setTimeout(resolve, 1_100));
		expect(b.team.members().find((entry) => entry.id === a.team.id)!.status).toBe("working");
		await a.emit("agent_settled", {}, a.ctx);
		await vi.waitFor(() => expect(b.team.members().find((entry) => entry.id === a.team.id)!.status).toBe("idle"), {
			timeout: 3_000,
		});

		const renderer = a.renderers.get(INTERNAL_MESSAGE_TYPE);
		const message = {
			details: {
				messages: [
					{
						id: 133,
						from: "reviewer-1a2b",
						sender: { role: "reviewer", goal: "audit auth token refresh" },
						text: "first\nsecond",
						replyRequired: true,
						at: Date.parse("2026-01-01T10:00:00Z"),
					},
				],
			},
		};
		const collapsed = rendered(renderer(message, { expanded: false }, theme));
		expect(collapsed).toMatch(/^ ✉ reviewer-1a2b → you · #133 · \d\d:\d\d(:\d\d)? · reply requested$/m);
		// The sender's role and goal are on its Agent row, not repeated here.
		expect(collapsed).not.toContain("audit auth token refresh");
		expect(collapsed).not.toContain("from ");
		expect(collapsed).toMatch(/first\n\s*second/);
		expect(rendered(renderer(message, { expanded: true }, theme))).toMatch(/first\n\s*second/);
		expect(
			rendered(
				renderer({ details: { messages: [{ from: "x", text: "bad\u001b[31mred" }] } }, { expanded: false }, theme),
			),
		).toContain("badred");
		expect(rendered(renderer({}, { expanded: false }, theme))).toContain("agent → you");
		// Details that are not a batch (another writer, a damaged entry) show the text the model got.
		expect(rendered(renderer({ content: "plain text", details: { from: "x" } }, { expanded: false }, theme))).toContain(
			"plain text",
		);

		const coordinate = a.tools.get("coordinate");
		expect(rendered(coordinate.renderCall({ action: "lock", paths: ["a.ts", "b/"], goal: "n" }, theme, {}))).toBe(
			'○ Coordinate(lock 2 paths "n")',
		);
		expect(rendered(coordinate.renderCall({ action: "unlock", paths: ["a.ts"] }, theme, {}))).toBe(
			"○ Coordinate(unlock a.ts)",
		);
		expect(rendered(coordinate.renderCall({}, theme, {}))).toBe("○ Coordinate");
		const listed = await run(coordinate, { action: "list" }, a.ctx);
		expect(listed.details).toMatchObject({ summary: expect.stringMatching(/^\d+ agents? · \d+ working$/) });
		const listRow = rendered(
			coordinate.renderResult(listed, { expanded: false }, theme, { args: { action: "list" }, expanded: false }),
		);
		expect(listRow).toMatch(/^ {2}⎿ {2}\d+ agents? · \d+ working \(ctrl\+o to expand\)$/);
		expect(
			rendered(
				coordinate.renderResult(listed, { expanded: true }, theme, { args: { action: "list" }, expanded: true }),
			),
		).toContain(a.team.id!);
		expect(
			rendered(
				coordinate.renderResult(
					{ content: [{ type: "text", text: "Not reserved; nothing was locked:\n- a.ts is covered" }] },
					{},
					theme,
					{ isError: true },
				),
			),
		).toBe("  ⎿  Error: Not reserved; nothing was locked:\n     - a.ts is covered");
		const send = a.tools.get("sendMessage");
		const long = `hello\n${"x".repeat(500)}`;
		expect(rendered(send.renderCall({ to: "all", message: long }, theme, {}), 1_000)).toBe("○ Send(→ all)");
		expect(rendered(send.renderCall({ to: "x", replyTo: 41, message: "m" }, theme, {}))).toBe(
			"○ Send(→ x · reply to #41)",
		);
		expect(rendered(send.renderCall({}, theme, {}))).toBe("○ Send");
		// Queueing is instant: a duration under a second is not shown, a slower send keeps its time.
		const done = { isPartial: false, durationMs: 24 };
		expect(rendered(send.renderCall({ to: "x", message: "m" }, theme, done))).toMatch(/^✓ Send\(→ x\)$/);
		expect(rendered(send.renderCall({ to: "x", message: "m" }, theme, { ...done, durationMs: 1_500 }))).toMatch(
			/^✓ Send\(→ x\) · 1\.5s$/,
		);
		const delivered = {
			content: [{ type: "text", text: "Queued message #42 for b." }],
			details: { id: 42, to: ["b"] },
		};
		expect(rendered(send.renderResult(delivered, {}, theme, { args: { message: long }, expanded: false }))).toBe(
			'  ⎿  Queued #42 · "hello" (ctrl+o to expand)',
		);
		expect(rendered(send.renderResult(delivered, {}, theme, { args: { message: long }, expanded: true }), 1_000)).toBe(
			`  ⎿  Queued #42\n     hello\n     ${"x".repeat(500)}`,
		);
	});

	it("/agents and /agents tell report through the UI", async () => {
		const { a, b } = await pair();
		await run(b.tools.get("coordinate"), { action: "join" }, b.ctx);
		await a.commands.get("agents").handler("", a.ctx);
		expect(a.ctx.ui.notes.at(-1)).toMatchObject({ type: "info", message: expect.stringContaining(b.team.id!) });

		const agents = a.commands.get("agents");
		const tell = { handler: (args: string, ctx: unknown) => agents.handler(`tell ${args}`, ctx) };
		await tell.handler("   ", a.ctx);
		expect(a.ctx.ui.notes.at(-1)).toEqual({
			message: "Usage: /agents tell <agent|all> [#<message to answer>] <message>",
			type: "warning",
		});
		await tell.handler(`${b.team.id} line one\n  line two`, a.ctx);
		expect(a.ctx.ui.notes.at(-1)).toEqual({ message: `Queued for ${b.team.id}`, type: "info" });
		await vi.waitFor(() => expect(b.sent.length).toBeGreaterThan(0), { timeout: 5_000 });
		// The user's text reaches the agent as typed, line breaks included.
		expect(b.sent.at(-1)!.message.details.messages).toEqual([
			expect.objectContaining({ from: "user", text: "line one\n  line two" }),
		]);
		await tell.handler("ghost-0000 hi", a.ctx);
		expect(a.ctx.ui.notes.at(-1)!.type).toBe("warning");
		// `#n` answers a message: it reaches the agent as a reply, and the number is not part of its text.
		const numbered = b.sent.at(-1)!.message.details.messages[0].id;
		await tell.handler(`${b.team.id} #${numbered} the second`, a.ctx);
		await vi.waitFor(
			() =>
				expect(b.sent.at(-1)!.message.details.messages).toEqual([
					expect.objectContaining({ from: "user", text: "the second", replyTo: Number(numbered) }),
				]),
			{ timeout: 5_000 },
		);
		await tell.handler(`${b.team.id} #999999 nothing to answer`, a.ctx);
		expect(a.ctx.ui.notes.at(-1)).toMatchObject({
			type: "warning",
			message: expect.stringContaining("No message #999999"),
		});

		expect(await agents.getArgumentCompletions(`tell ${b.team.id!.slice(0, 3)}`)).toEqual([
			expect.objectContaining({ value: `tell ${b.team.id} ` }),
		]);
		expect(await agents.getArgumentCompletions("tell zzz")).toBeNull();
		expect(await agents.getArgumentCompletions("k")).toEqual([expect.objectContaining({ value: "kill " })]);
		expect(await agents.getArgumentCompletions("kill ")).toBeNull();
		await agents.handler("bogus", a.ctx);
		expect(a.ctx.ui.notes.at(-1)).toMatchObject({
			type: "warning",
			message: expect.stringContaining("Usage: /agents"),
		});
	});

	it("/agents warns when the team database is unusable", async () => {
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: path.join(tmp(), "team.sqlite") });
		agentsCommand(
			fake.api,
			registerAgentTool(fake.api, () => new Map(), team, fakePermission()),
		);
		vi.spyOn(team, "snapshot").mockReturnValue({ members: [], traffic: [], error: "schema v99 is newer" });
		const ctx = fakeCtx({ cwd: tmp() });
		await fake.commands.get("agents").handler("", ctx);
		expect(ctx.ui.notes.at(-1)).toMatchObject({
			type: "warning",
			message: expect.stringContaining("schema v99 is newer"),
		});
	});
});

/** A Team stand-in that honors the watch contract: one listener call now and one per second. */
function fakeTeam(read: () => { members: never[]; traffic: never[]; error?: string; retrying?: boolean }, id?: string) {
	return {
		id,
		get view() {
			return read();
		},
		watch(listener: () => void) {
			const timer = setInterval(listener, 1_000);
			listener();
			return () => clearInterval(timer);
		},
	} as never;
}

describe("AgentsView", () => {
	const now = Date.now();
	const peer = (id: string, status: "working" | "idle" = "working", parentId: string | null = "me-0001") =>
		({
			id,
			status,
			...(parentId ? { parentId } : {}),
			joinedAt: now - 5_000,
			updatedAt: now,
			toolCalls: 2,
			input: 1000,
			output: 200,
			goal: "review the parser",
			activity: "localSearch foo",
		}) as never;

	it("shows a widget for this session's subagents only, repaints, and clears when they leave", () => {
		vi.useFakeTimers();
		try {
			const otherSession = [peer("main-9999", "working", null), peer("researcher-8888", "working", "main-9999")];
			let members = [
				peer("me-0001", "working", null),
				peer("reviewer-1a2b"),
				peer("tester-3c4d", "idle"),
				...otherSession,
			];
			const traffic = [
				{ id: 2, from: "me-0001", to: ["reviewer-1a2b"], text: "look", at: now, state: "delivered" },
				{
					id: 3,
					from: "reviewer-1a2b",
					to: ["tester-3c4d"],
					text: "between subagents",
					at: now,
					state: "delivered",
				},
				{ id: 4, from: "main-9999", to: ["researcher-8888"], text: "theirs", at: now, state: "delivered" },
			] as never[];
			const view = new AgentsView(fakeTeam(() => ({ members, traffic }), "me-0001"));
			const ctx = fakeCtx({ cwd: tmp() });
			view.start(ctx);
			const factory = ctx.ui.widgets.get("octocode-agents") as (
				tui: unknown,
				theme: unknown,
			) => { render(width: number): string[]; invalidate(): void };
			expect(factory).toBeTypeOf("function");
			const requestRender = vi.fn();
			const widget = factory({ requestRender }, theme);
			widget.invalidate();
			const lines = widget.render(120).join("\n");
			expect(lines).toContain("1 working · 1 idle");
			expect(lines).toContain("reviewer-1a2b");
			// Only traffic between subagents: this session's own messages are already in its transcript.
			expect(lines).toContain("#3");
			expect(lines).not.toContain("#2");
			expect(lines).not.toContain("main-9999");
			expect(lines).not.toContain("researcher-8888");
			expect(lines).not.toContain("#4");
			// The widget counts the agents; the footer names this session, which peers address, and does not repeat them.
			expect(ctx.ui.statuses.get("octocode-team")).toBe("main: me-0001");
			vi.advanceTimersByTime(1_000);
			expect(requestRender).toHaveBeenCalled();

			// Both subagents leave: each keeps a final neutral `left` row for ten seconds, then the widget goes.
			members = [peer("me-0001", "working", null), ...otherSession];
			vi.advanceTimersByTime(1_000);
			expect(ctx.ui.widgets.has("octocode-agents")).toBe(true);
			const done = widget.render(120).join("\n");
			expect(done).toContain("2 left");
			expect(done).toMatch(/reviewer-1a2b .* left +\d/);
			expect(done).toMatch(/tester-3c4d .* left +\d/);
			expect(done).not.toContain("working");
			expect(ctx.ui.statuses.get("octocode-team")).toBe("main: me-0001");
			// Finished rows stay FINISHED_MS (30 s) so their outcome can be read.
			vi.advanceTimersByTime(31_000);
			expect(ctx.ui.widgets.has("octocode-agents")).toBe(false);
			expect(ctx.ui.statuses.get("octocode-team")).toBe("main: me-0001");

			members = [
				peer("me-0001", "working", null),
				{ ...(peer("reviewer-1a2b", "idle") as object), updatedAt: Date.now() } as never,
			];
			vi.advanceTimersByTime(1_000);
			expect(ctx.ui.widgets.has("octocode-agents")).toBe(true);
			view.stop(ctx);
			expect(ctx.ui.widgets.has("octocode-agents")).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("never mounts a widget for subagents whose heartbeat stopped, and clears it once they go silent", () => {
		vi.useFakeTimers({ now });
		try {
			const silent = { ...(peer("reviewer-1a2b") as object), updatedAt: now - 16_000 } as never;
			let members = [peer("me-0001", "working", null), silent];
			const view = new AgentsView(fakeTeam(() => ({ members, traffic: [] }), "me-0001"));
			const ctx = fakeCtx({ cwd: tmp() });
			view.start(ctx);
			expect(ctx.ui.widgets.has("octocode-agents")).toBe(false);
			members = [
				peer("me-0001", "working", null),
				{ ...(peer("reviewer-1a2b") as object), updatedAt: Date.now() } as never,
			];
			vi.advanceTimersByTime(1_000);
			expect(ctx.ui.widgets.has("octocode-agents")).toBe(true);
			// The heartbeat stops: 16 s later the agent is unresponsive and the widget unmounts.
			vi.advanceTimersByTime(16_000);
			expect(ctx.ui.widgets.has("octocode-agents")).toBe(false);
			view.stop(ctx);
		} finally {
			vi.useRealTimers();
		}
	});

	it("mounts the widget once a database error clears, and shows a transient error as a retry, not as team off", () => {
		vi.useFakeTimers({ now });
		try {
			let view: { members: never[]; traffic: never[]; error?: string; retrying?: boolean } = {
				members: [],
				traffic: [],
				error: "Team database unavailable: database is locked",
				retrying: true,
			};
			const agents = new AgentsView(fakeTeam(() => view, "me-0001"));
			const ctx = fakeCtx({ cwd: tmp() });
			agents.start(ctx);
			expect(ctx.ui.statuses.get("octocode-team")).toBe("team retrying");
			// One locked read is not news: the messages list says nothing until the second failed tick.
			expect(ctx.ui.notes).toEqual([]);
			expect(ctx.ui.widgets.has("octocode-agents")).toBe(false);
			vi.advanceTimersByTime(1_000);
			vi.advanceTimersByTime(1_000);
			expect(ctx.ui.notes).toEqual([
				{ message: "Team database busy, retrying: Team database unavailable: database is locked", type: "warning" },
			]);
			view = { members: [peer("me-0001", "working", null), peer("reviewer-1a2b")], traffic: [] };
			vi.advanceTimersByTime(1_000);
			expect(ctx.ui.statuses.get("octocode-team")).toBe("main: me-0001");
			expect(ctx.ui.notes.at(-1)).toEqual({ message: "Team database reachable again.", type: "info" });
			expect(ctx.ui.widgets.has("octocode-agents")).toBe(true);
			agents.stop(ctx);
			expect(ctx.ui.statuses.get("octocode-team")).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	it("reports an unusable team database in the status line and survives read failures", () => {
		const ctx = fakeCtx({ cwd: tmp() });
		const view = new AgentsView(
			fakeTeam(() => ({ members: [], traffic: [], error: "Team database schema v9 is newer\nupgrade" })),
		);
		view.start(ctx);
		expect(ctx.ui.statuses.get("octocode-team")).toBe("team off");
		expect(ctx.ui.statusTones.get("octocode-team")).toBe("error");
		expect(ctx.ui.notes).toEqual([{ message: "Team off: Team database schema v9 is newer", type: "error" }]);
		view.stop(ctx);
		expect(ctx.ui.statuses.get("octocode-team")).toBeUndefined();

		const failing = new AgentsView(
			fakeTeam(() => {
				throw new Error("boom");
			}),
		);
		expect(() => failing.start(ctx)).not.toThrow();
		failing.stop();

		const headless = fakeCtx({ cwd: tmp(), hasUI: false });
		const read = vi.fn(() => ({ members: [], traffic: [] }));
		new AgentsView(fakeTeam(read)).start(headless);
		expect(read).not.toHaveBeenCalled();
	});
});

describe("Team ticker", () => {
	it("runs one unref'd ticker only while joined or watched, and watchers read the cached view", async () => {
		vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const a = member(db, cwd);
		const b = member(db, cwd);
		try {
			a.team.start(a.ctx);
			b.team.start(b.ctx);
			// O6b (design B36): starting joins, and a joined session runs the one shared clock; leave to test it unjoined.
			expect(vi.getTimerCount()).toBe(1);
			a.team.leave();
			b.team.leave();
			expect(vi.getTimerCount()).toBe(0);
			const seen = vi.fn();
			const unwatch = a.team.watch(seen);
			expect(vi.getTimerCount()).toBe(1);
			expect(seen).toHaveBeenCalledTimes(1);
			// Nobody is in the team now: watching reads nothing.
			expect(a.team.view.members).toEqual([]);

			b.team.join("peer");
			// The second ticker shares the first one's timer: every ticker runs on the one clock.
			expect(vi.getTimerCount()).toBe(1);
			vi.advanceTimersByTime(1_000);
			expect(seen).toHaveBeenCalledTimes(2);
			expect(a.team.view.members.map((m) => m.id)).toContain(b.team.id);

			unwatch();
			expect(vi.getTimerCount()).toBe(1);
			b.team.leave();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			a.team.stop();
			b.team.stop();
			vi.useRealTimers();
		}
	});
});

describe("team database file", () => {
	it("is the agent database, private to the user", () => {
		const file = path.join(tmp(), "nested", "team", "team.sqlite");
		const cwd = tmp();
		TeamStore.open(cwd, file, {}).close();
		if (process.platform !== "win32") {
			expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700);
			expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		}
	});
});
