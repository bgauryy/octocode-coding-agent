import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { OctocodeApi } from "../../src/octocode/api/bridge.ts";
import { externalFacts } from "../../src/octocode/api/bridge/caller.ts";
import { provenOn, verifyCaller } from "../../src/octocode/api/bridge/verify.ts";
import { ApiClient } from "../../src/octocode/api/client.ts";
import { EventLog } from "../../src/octocode/api/events.ts";
import { issueTicket, ownInstance } from "../../src/octocode/api/identity.ts";
import {
	apiDir,
	type InstanceRecord,
	instancesDir,
	readInstance,
	removeSocket,
	socketPath,
	writeRecord,
} from "../../src/octocode/api/registry.ts";
import { ApiServer, type Connection } from "../../src/octocode/api/server.ts";
import { Permission } from "../../src/octocode/permission/ask.ts";
import { ALLOW_ONCE, denySessionOption, sessionOption } from "../../src/octocode/permission/ask/text.ts";
import { admitExternalMessage } from "../../src/octocode/permission/external-message.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * A caller's process grant rests on a verified identity (user decision 3): before a "messages from <process>" grant is
 * honored, the receiver calls the claimed peer back on its own registered socket with a random nonce, and only the real
 * peer, which holds the ticket of the call in flight, echoes it. A forged claim copied from the registry is unverified:
 * it is asked about as any other caller, or refused with nobody to ask, never allowed by the grant.
 */

let home: string;
const running: OctocodeApi[] = [];
const impostors: { server: ApiServer; socket: string }[] = [];
beforeEach(() => {
	home = tmp("octocode-comm-identity-");
	vi.stubEnv(ENV_AGENT_DIR, home);
	vi.stubEnv("OCTOCODE_HOME", home);
});
afterEach(async () => {
	vi.unstubAllEnvs();
	await Promise.all(running.splice(0).map((api) => api.stop()));
	for (const { server, socket } of impostors.splice(0)) {
		await server.close();
		removeSocket(socket);
	}
});

/**
 * What another process of the same user can do without touching any session's own record: run a socket that echoes every
 * `identity.confirm` nonce, and write a record of its choosing under `instances/<file>.json`.
 */
async function impostor(file: string, record: Pick<InstanceRecord, "id" | "pid"> & Partial<InstanceRecord>) {
	const socket = socketPath(apiDir(), `oc-${file}`);
	const server = new ApiServer(
		async (method, params) => (method === "identity.confirm" ? { nonce: params.nonce } : undefined),
		new EventLog(),
		"impostor-token",
	);
	await server.listenUnix(socket);
	impostors.push({ server, socket });
	writeFileSync(
		join(instancesDir(apiDir()), `${file}.json`),
		JSON.stringify({ cwd: "/w", startedAt: Date.now(), protocol: 1, ...record, socket }),
	);
}

/** One session with its API on; `asked` records each dialog's options, answered from `selects` in order. */
async function boot(options: { mode: "workspace" | "full" | "manual"; hasUI: boolean; selects?: string[] }) {
	const fake = fakeHost();
	const permission = new Permission({ api: fake.api, env: { OCTOCODE_PERMISSION: options.mode }, isSubagent: false });
	const base = fakeCtx({ cwd: tmp(), hasUI: options.hasUI, ui: { selects: options.selects ?? [] } });
	const asked: string[][] = [];
	const select = base.ui.select;
	const aborted: string[] = [];
	const ctx = Object.assign(base, {
		isIdle: () => false,
		hasPendingMessages: () => false,
		abort: () => {
			aborted.push("abort");
		},
		sessionManager: { ...base.sessionManager, getSessionId: () => "s1" },
	});
	ctx.ui.select = async (title: string, choices: string[], ...rest: unknown[]) => {
		asked.push(choices);
		return (select as (...args: unknown[]) => Promise<string | undefined>)(title, choices, ...rest);
	};
	permission.start(ctx);
	const externalCall = vi.fn(async () => ({ listed: true }));
	const api = new OctocodeApi(
		fake.api,
		{ list: () => [], tell: () => ({ sent: [] }), deliverable: (text) => text },
		() => "1.0.0",
		{ OCTOCODE_HOME: home },
		{
			admit: (claim, askCtx, signal, onAsk) =>
				admitExternalMessage(permission, askCtx, claim, {
					self: claim.self,
					planning: false,
					...(claim.ceiling ? { ceiling: claim.ceiling } : {}),
					...(onAsk ? { onAsk } : {}),
					...(signal ? { signal } : {}),
				}),
			capTurn: (ceiling) => permission.turnCap.set(ceiling),
			externalCall,
		},
	);
	running.push(api);
	await api.start(ctx, { socket: true });
	return { api, ctx, permission, fake, asked, aborted, externalCall, client: new ApiClient(api.instance!) };
}

/** A second running session: the peer a caller claims to be. Its API answers `identity.confirm`. */
async function peer() {
	const { api } = await boot({ mode: "full", hasUI: false });
	return api.instance!;
}

describe("identity.confirm", () => {
	it("echoes the nonce for a ticket this process issued for a call to that receiver, and refuses any other", async () => {
		const self = await peer();
		const client = new ApiClient(self);
		const via = "/sockets/receiver-1.sock";
		const { ticket, release } = issueTicket("receiver-1", via);
		await expect(client.call("identity.confirm", { nonce: "n-1", ticket, to: "receiver-1", via })).resolves.toEqual({
			nonce: "n-1",
		});
		await expect(client.call("identity.confirm", { nonce: "n-2", ticket, to: "someone-else", via })).rejects.toThrow();
		await expect(
			client.call("identity.confirm", { nonce: "n-3", ticket: "made-up", to: "receiver-1", via }),
		).rejects.toThrow();
		// The ticket is for the endpoint the call went to: the same id on another socket, or no endpoint, is refused.
		await expect(
			client.call("identity.confirm", { nonce: "n-5", ticket, to: "receiver-1", via: "/sockets/other.sock" }),
		).rejects.toThrow();
		await expect(client.call("identity.confirm", { nonce: "n-6", ticket, to: "receiver-1" })).rejects.toThrow();
		release();
		await expect(client.call("identity.confirm", { nonce: "n-4", ticket, to: "receiver-1", via })).rejects.toThrow();
	});
});

describe("a 'messages from this process' grant needs the claimed peer to confirm", () => {
	it("is not honored for a forged pid and instanceId copied from the registry; the real peer still has it", async () => {
		const sender = await peer();
		const name = sender.name ?? sender.id;
		const { client, api, fake, asked } = await boot({
			mode: "workspace",
			hasUI: true,
			selects: [sessionOption(`messages from ${name}`)],
		});
		const real = issueTicket(api.instance!.id, api.instance!.socket);
		const claim = { instanceId: sender.id, pid: sender.pid };
		// The real peer: verified, offered the process grant, and granted it (a call that does not wait hears at once that
		// the user decides; the message arrives once they answer).
		await client.call("message.send", { text: "first", caller: { ...claim, ticket: real.ticket } });
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain(sessionOption(`messages from ${name}`));
		expect(fake.sent).toHaveLength(1);

		// A forged claim with the same pid and instanceId (both readable in the registry): it is asked about as any caller,
		// with no process grant to offer, and with no answer queued the dialog closes unanswered: refused, nothing sent.
		await expect(
			client.call("message.send", { text: "forged", caller: { ...claim, ticket: "guessed" }, wait: true }),
		).rejects.toMatchObject({ data: { execution: "not-sent" } });
		await expect(
			client.call("message.send", { text: "forged again", caller: claim, wait: true }),
		).rejects.toMatchObject({ data: { execution: "not-sent" } });
		expect(asked).toHaveLength(3);
		expect(asked[1]).not.toContain(sessionOption(`messages from ${name}`));
		expect(fake.sent).toHaveLength(1);

		// The real peer again: its grant answers, no dialog.
		await client.call("message.send", { text: "second", caller: { ...claim, ticket: real.ticket } });
		expect(asked).toHaveLength(3);
		expect(fake.sent).toHaveLength(2);
		real.release();
	});

	it("refuses an unverified claim when nobody can be asked, even when a peer that is offline is named", async () => {
		const { client, fake } = await boot({ mode: "workspace", hasUI: false });
		writeRecord(apiDir(), {
			id: "oc-offline",
			pid: process.pid,
			cwd: "/w",
			startedAt: Date.now(),
			protocol: 1,
			name: "octocode-main-offline",
			socket: join(home, "nobody-listens.sock"),
		});
		await expect(
			client.call("message.send", {
				text: "hi",
				caller: { instanceId: "oc-offline", pid: process.pid, ticket: "t" },
			}),
		).rejects.toMatchObject({ data: { execution: "not-sent" } });
		expect(fake.sent).toEqual([]);
	});
});

describe("agents.tell and external.call from a confirmed process", () => {
	it("are answered by that process's grant, as its messages are", async () => {
		const sender = await peer();
		const name = sender.name ?? sender.id;
		const { client, api, asked, fake, externalCall } = await boot({
			mode: "workspace",
			hasUI: true,
			selects: [sessionOption(`messages from ${name}`)],
		});
		const real = issueTicket(api.instance!.id, api.instance!.socket);
		const caller = { instanceId: sender.id, pid: sender.pid, ticket: real.ticket };
		await client.call("message.send", { text: "start", caller });
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		await expect(client.call("agents.tell", { to: "all", text: "look", caller })).resolves.toEqual({ sent: [] });
		await expect(
			client.call("external.call", { action: "connect", transport: "acp", vendor: "x", command: "/bin/sh", caller }),
		).resolves.toEqual({ listed: true });
		expect(asked).toHaveLength(1);
		expect(externalCall).toHaveBeenCalledTimes(1);
		real.release();
	});
});

describe("deny this process for the session", () => {
	it("is offered beside the process grant, and answers later messages from that process without a dialog", async () => {
		const sender = await peer();
		const name = sender.name ?? sender.id;
		const { client, api, fake, asked } = await boot({
			mode: "workspace",
			hasUI: true,
			selects: [denySessionOption(`messages from ${name}`)],
		});
		const real = issueTicket(api.instance!.id, api.instance!.socket);
		const caller = { instanceId: sender.id, pid: sender.pid, ticket: real.ticket };
		await expect(client.call("message.send", { text: "one", caller, wait: true })).rejects.toThrow(
			`denied messages from ${name} for this session`,
		);
		expect(asked).toHaveLength(1);
		expect(asked[0]).toContain(denySessionOption(`messages from ${name}`));
		// The remembered answer: refused as the user's denial, with no second dialog, and the sender reads that it lasts.
		const second = client.call("message.send", { text: "two", caller, wait: true });
		await expect(second).rejects.toThrow(`denied messages from ${name} for this session`);
		await expect(second).rejects.not.toThrow("when asked again");
		expect(asked).toHaveLength(1);
		expect(fake.sent).toEqual([]);
		real.release();
	});

	it("is an answer, not a cap: clearing the message grants asks again, and full mode takes the message", async () => {
		const fake = fakeHost();
		const permission = new Permission({ api: fake.api, env: { OCTOCODE_PERMISSION: "workspace" }, isSubagent: false });
		const answers = [denySessionOption("messages from octocode-a"), ALLOW_ONCE];
		const asked: string[][] = [];
		const ctx = fakeCtx({ cwd: tmp(), hasUI: true });
		ctx.ui.select = async (_title: string, choices: string[]) => {
			asked.push(choices);
			return answers.shift();
		};
		permission.start(ctx);
		const claim = { from: "a", process: { id: "oc-a#1", name: "octocode-a" }, details: [], text: "hi" };
		const admit = () => admitExternalMessage(permission, ctx, claim, { self: "octocode-b", planning: false });
		await expect(admit()).rejects.toThrow("The user of octocode-b denied messages from octocode-a for this session");
		await expect(admit()).rejects.toThrow("The user of octocode-b denied messages from octocode-a for this session");
		expect(asked).toHaveLength(1);
		expect(permission.grants()).toContain("message.external: denied messages from octocode-a");
		expect(permission.clearMessageGrants()).toBe(1);
		await expect(admit()).resolves.toBeUndefined();
		expect(asked).toHaveLength(2);
		answers.unshift(denySessionOption("messages from octocode-a"));
		await expect(admit()).rejects.toThrow("denied");
		permission.setMode("full", ctx);
		await expect(admit()).resolves.toBeUndefined();
	});
});

describe("read methods stay open, and each call is recorded naming the caller", () => {
	const audits = (fake: ReturnType<typeof fakeHost>) =>
		fake.entries
			.filter((entry) => entry.customType === "octocode-external")
			.map((entry) => entry.data as Record<string, unknown>);

	it("status, messages.list and events.subscribe answer a workspace session with nobody to ask, audited", async () => {
		const { client, fake } = await boot({ mode: "workspace", hasUI: false });
		const caller = { name: "dashboard", pid: 4242 };
		await expect(client.call("status", { caller })).resolves.toMatchObject({ sessionId: "s1" });
		await expect(client.call("messages.list", { caller })).resolves.toBeDefined();
		await expect(client.call("events.subscribe", { caller })).resolves.toBeDefined();
		await expect(client.call("agents.list", { caller })).resolves.toEqual({ agents: [] });
		const reads = audits(fake).filter((data) => data.read === true);
		expect(reads.map((data) => data.method)).toEqual(["status", "messages.list", "events.subscribe", "agents.list"]);
		for (const data of reads)
			expect(data).toMatchObject({
				caller: { name: "dashboard", pid: 4242 },
				callerVerified: false,
				transport: "socket",
			});
	});

	it("external.call list is read-only: open and audited; connect still needs admission", async () => {
		const { client, fake, externalCall } = await boot({ mode: "workspace", hasUI: false });
		await expect(client.call("external.call", { action: "list" })).resolves.toEqual({ listed: true });
		expect(audits(fake).some((data) => data.read === true && data.method === "external.call")).toBe(true);
		await expect(
			client.call("external.call", { action: "connect", transport: "acp", vendor: "x", command: "/bin/sh" }),
		).rejects.toMatchObject({ data: { execution: "not-sent" } });
		expect(externalCall).toHaveBeenCalledTimes(1);
	});
});

describe("turn.abort is admitted like message.send", () => {
	it("is refused outside full mode when nobody can be asked, and the turn keeps running", async () => {
		const { client, aborted } = await boot({ mode: "workspace", hasUI: false });
		await expect(client.call("turn.abort")).rejects.toMatchObject({ data: { execution: "not-sent" } });
		expect(aborted).toEqual([]);
	});

	it("runs unasked in full mode", async () => {
		const { client, aborted } = await boot({ mode: "full", hasUI: false });
		await expect(client.call("turn.abort")).resolves.toEqual({ aborted: true });
		expect(aborted).toEqual(["abort"]);
	});

	it("is covered by a verified process grant", async () => {
		const sender = await peer();
		const name = sender.name ?? sender.id;
		const { client, api, asked, aborted, fake } = await boot({
			mode: "workspace",
			hasUI: true,
			selects: [sessionOption(`messages from ${name}`)],
		});
		const real = issueTicket(api.instance!.id, api.instance!.socket);
		const caller = { instanceId: sender.id, pid: sender.pid, ticket: real.ticket };
		await client.call("message.send", { text: "start", caller });
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		await expect(client.call("turn.abort", { caller })).resolves.toEqual({ aborted: true });
		expect(asked).toHaveLength(1);
		expect(aborted).toEqual(["abort"]);
		real.release();
	});
});

describe("a process grant or denial belongs to the confirmed instance, not to its name", () => {
	it("is not used by another confirmed instance whose record carries the granted instance's name", async () => {
		const sender = await peer();
		const name = sender.name ?? sender.id;
		const { client, api, fake, asked } = await boot({
			mode: "workspace",
			hasUI: true,
			selects: [sessionOption(`messages from ${name}`)],
		});
		const real = issueTicket(api.instance!.id, api.instance!.socket);
		await client.call("message.send", {
			text: "first",
			caller: { instanceId: sender.id, pid: sender.pid, ticket: real.ticket },
		});
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		// Its own record, socket and pid: it confirms its own calls. Only its name is the granted instance's.
		await impostor("atk", { id: "oc-atk", pid: process.ppid, name });
		await expect(
			client.call("message.send", {
				text: "as them",
				caller: { instanceId: "oc-atk", pid: process.ppid, ticket: "any" },
				wait: true,
			}),
		).rejects.toMatchObject({ data: { execution: "not-sent" } });
		expect(asked).toHaveLength(2);
		expect(fake.sent).toHaveLength(1);
		real.release();
	});

	it("does not answer another confirmed instance whose record carries the denied instance's name", async () => {
		const sender = await peer();
		const name = sender.name ?? sender.id;
		const { client, api, fake, asked } = await boot({
			mode: "workspace",
			hasUI: true,
			selects: [denySessionOption(`messages from ${name}`), ALLOW_ONCE],
		});
		const real = issueTicket(api.instance!.id, api.instance!.socket);
		await expect(
			client.call("message.send", {
				text: "first",
				caller: { instanceId: sender.id, pid: sender.pid, ticket: real.ticket },
				wait: true,
			}),
		).rejects.toThrow(/denied/);
		await impostor("atk", { id: "oc-atk", pid: process.ppid, name });
		await client.call("message.send", {
			text: "its own",
			caller: { instanceId: "oc-atk", pid: process.ppid, ticket: "any" },
		});
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		expect(asked).toHaveLength(2);
		real.release();
	});
});

describe("the claimed instance is read from its own record file", () => {
	it("leaves a claim unconfirmed while another live record repeats that instance's id and pid", async () => {
		const sender = await peer();
		const name = sender.name ?? sender.id;
		const { client, api, fake, asked } = await boot({
			mode: "workspace",
			hasUI: true,
			selects: [sessionOption(`messages from ${name}`)],
		});
		const real = issueTicket(api.instance!.id, api.instance!.socket);
		const claim = { instanceId: sender.id, pid: sender.pid };
		await client.call("message.send", { text: "first", caller: { ...claim, ticket: real.ticket } });
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		// A second record for the same instance, sorted first, pointing at a socket that confirms anything.
		await impostor("zz", { ...claim, id: sender.id, name, startedAt: 0 });
		await expect(
			client.call("message.send", { text: "forged", caller: { ...claim, ticket: "any" }, wait: true }),
		).rejects.toMatchObject({ data: { execution: "not-sent" } });
		expect(asked).toHaveLength(2);
		expect(asked[1]).not.toContain(sessionOption(`messages from ${name}`));
		// Fail closed: while the records disagree, the real instance is asked too.
		await expect(
			client.call("message.send", { text: "real", caller: { ...claim, ticket: real.ticket }, wait: true }),
		).rejects.toMatchObject({ data: { execution: "not-sent" } });
		expect(asked).toHaveLength(3);
		expect(fake.sent).toHaveLength(1);
		real.release();
	});
});

describe("an admitted turn.abort stops only the run it was asked about", () => {
	it("stops nothing when that run settled while the user decided, and says so", async () => {
		const { client, api, ctx, aborted, asked, fake } = await boot({ mode: "workspace", hasUI: true });
		api.observe();
		let answer: (value: string) => void = () => undefined;
		const answered = new Promise<string>((resolve) => {
			answer = resolve;
		});
		ctx.ui.select = async (_title: string, choices: string[]) => {
			asked.push(choices);
			return answered;
		};
		const call = client.call("turn.abort");
		await vi.waitFor(() => expect(asked).toHaveLength(1));
		await fake.emit("agent_settled", { aborted: false }, ctx);
		answer(ALLOW_ONCE);
		await expect(call).resolves.toMatchObject({ aborted: false, settled: true });
		expect(aborted).toEqual([]);
	});
});

describe("external.call admission", () => {
	it("never shows or records the caller's ticket", async () => {
		const { client, fake } = await boot({ mode: "workspace", hasUI: false });
		const ticket = "ticket-that-must-stay-private";
		const refused = client.call("external.call", {
			action: "connect",
			transport: "acp",
			vendor: "x",
			command: "/bin/sh",
			caller: { name: "tool", ticket },
		});
		await expect(refused).rejects.toMatchObject({ data: { execution: "not-sent" } });
		await expect(refused).rejects.not.toThrow(ticket);
		expect(JSON.stringify(fake.entries)).not.toContain(ticket);
	});
});

describe("a record that repeats the receiver's id", () => {
	/**
	 * What another process of the same user can do without touching a session's own record file: publish `zz.json` with
	 * the receiver's id, a name of its own and its own socket. A sender that picked that record would issue a ticket for
	 * the receiver and hand it to the impostor, which could replay the sender's claim to the real receiver.
	 */
	it("leaves a replayed claim unconfirmed: asked without the process grant, never admitted by it", async () => {
		const sender = await peer();
		const name = sender.name ?? sender.id;
		const { client, api, fake, asked } = await boot({
			mode: "workspace",
			hasUI: true,
			selects: [sessionOption(`messages from ${name}`)],
		});
		const receiver = api.instance!;
		const claim = { instanceId: sender.id, pid: sender.pid };
		const first = issueTicket(receiver.id, receiver.socket);
		await client.call("message.send", { text: "first", caller: { ...claim, ticket: first.ticket } });
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		first.release();
		await impostor("zz", { id: receiver.id, pid: process.ppid, name: "helper" });
		// The ticket a sender hands out for the receiver's id, as the impostor would capture it.
		const harvested = issueTicket(receiver.id, receiver.socket);
		await expect(
			client.call("message.send", { text: "forged", caller: { ...claim, ticket: harvested.ticket }, wait: true }),
		).rejects.toMatchObject({ data: { execution: "not-sent" } });
		expect(asked).toHaveLength(2);
		expect(asked[1]).not.toContain(sessionOption(`messages from ${name}`));
		expect(fake.sent).toHaveLength(1);
		harvested.release();
	});

	it("does not stop the real peer once the duplicate is gone", async () => {
		const sender = await peer();
		const name = sender.name ?? sender.id;
		const { client, api, fake, asked } = await boot({
			mode: "workspace",
			hasUI: true,
			selects: [sessionOption(`messages from ${name}`)],
		});
		const receiver = api.instance!;
		const claim = { instanceId: sender.id, pid: sender.pid };
		await impostor("zz", { id: receiver.id, pid: process.ppid, name: "helper" });
		rmSync(join(instancesDir(apiDir()), "zz.json"));
		const real = issueTicket(receiver.id, receiver.socket);
		await client.call("message.send", { text: "first", caller: { ...claim, ticket: real.ticket } });
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		expect(asked[0]).toContain(sessionOption(`messages from ${name}`));
		await client.call("message.send", { text: "second", caller: { ...claim, ticket: real.ticket } });
		expect(asked).toHaveLength(1);
		expect(fake.sent).toHaveLength(2);
		real.release();
	});
});

describe("this process's own claim", () => {
	it("is the record its API wrote, published on start and withdrawn on stop", async () => {
		const { api } = await boot({ mode: "full", hasUI: false });
		expect(ownInstance()).toBe(api.instance);
		const record = api.instance!;
		await api.stop();
		expect(ownInstance()).toBeUndefined();
		expect(record.id).toMatch(/^oc-/);
	});
});

describe("a ticket is bound to the endpoint it was sent to", () => {
	/**
	 * Another process of the same user overwrites the receiver's own `<id>.json` with the receiver's id, pid and name but a
	 * socket of its own. A sender that reads the file then sends its call, and its ticket, to that socket; the impostor
	 * restores the file and replays the claim to the real receiver. The ticket names the socket it was sent to, so the
	 * sender does not confirm it for the real receiver's socket.
	 */
	it("leaves a claim replayed with a ticket harvested on another socket unconfirmed", async () => {
		const sender = await peer();
		const name = sender.name ?? sender.id;
		const { client, api, fake, asked } = await boot({
			mode: "workspace",
			hasUI: true,
			selects: [sessionOption(`messages from ${name}`)],
		});
		const receiver = api.instance!;
		const claim = { instanceId: sender.id, pid: sender.pid };
		const real = issueTicket(receiver.id, receiver.socket);
		await client.call("message.send", { text: "first", caller: { ...claim, ticket: real.ticket } });
		await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
		real.release();
		const file = join(instancesDir(apiDir()), `${receiver.id}.json`);
		const original = readFileSync(file, "utf8");
		writeFileSync(file, JSON.stringify({ ...receiver, socket: socketPath(apiDir(), "oc-forged") }));
		// What a sender does with the record it reads: the ticket is for the endpoint it sends the call to.
		const forged = readInstance(apiDir(), receiver.id)!;
		expect(forged).toMatchObject({ id: receiver.id, pid: receiver.pid, name: receiver.name });
		const harvested = issueTicket(forged.id, forged.socket ?? forged.http?.url);
		writeFileSync(file, original);
		await new ApiClient(receiver).call("message.send", {
			text: "forged",
			caller: { ...claim, ticket: harvested.ticket },
		});
		await vi.waitFor(() => expect(asked).toHaveLength(2));
		expect(asked[1]).not.toContain(sessionOption(`messages from ${name}`));
		expect(fake.sent).toHaveLength(1);
		harvested.release();
	});
});

describe("a proof cached on a connection", () => {
	it("no longer counts once a record repeating the proven instance appears", async () => {
		const sender = await peer();
		const { api } = await boot({ mode: "workspace", hasUI: false });
		const receiver = api.instance!;
		const connection = { transport: "socket" } as unknown as Connection;
		const facts = externalFacts("x", { instanceId: sender.id, pid: sender.pid }, "socket", false);
		const ticket = issueTicket(receiver.id, receiver.socket);
		await expect(
			verifyCaller(facts, { caller: { ticket: ticket.ticket } }, connection, receiver),
		).resolves.toMatchObject({
			verified: true,
		});
		ticket.release();
		// The proof answers without a call back while the registry is unchanged.
		await expect(verifyCaller(facts, {}, connection, receiver)).resolves.toMatchObject({ verified: true });
		expect(provenOn(connection, facts)).toBe(true);
		await impostor("zz", { id: sender.id, pid: process.ppid, name: "helper" });
		await expect(verifyCaller(facts, {}, connection, receiver)).resolves.not.toHaveProperty("verified");
		expect(provenOn(connection, facts)).toBe(false);
	});

	it("no longer counts once the proven instance's own file is overwritten in place", async () => {
		const sender = await peer();
		const { api } = await boot({ mode: "workspace", hasUI: false });
		const receiver = api.instance!;
		const connection = { transport: "socket" } as unknown as Connection;
		const facts = externalFacts("x", { instanceId: sender.id, pid: sender.pid }, "socket", false);
		const ticket = issueTicket(receiver.id, receiver.socket);
		await expect(
			verifyCaller(facts, { caller: { ticket: ticket.ticket } }, connection, receiver),
		).resolves.toMatchObject({ verified: true });
		ticket.release();
		const folder = statSync(instancesDir(apiDir())).mtimeMs;
		// Written in place, the file keeps its directory entry: the instances folder's mtime does not change.
		writeFileSync(
			join(instancesDir(apiDir()), `${sender.id}.json`),
			JSON.stringify({ ...sender, socket: socketPath(apiDir(), "oc-elsewhere") }),
		);
		expect(statSync(instancesDir(apiDir())).mtimeMs).toBe(folder);
		await expect(verifyCaller(facts, {}, connection, receiver)).resolves.not.toHaveProperty("verified");
		expect(provenOn(connection, facts)).toBe(false);
	});
});

describe("two confirmed instances with one name", () => {
	it("are told apart in the grant label by their instance id", async () => {
		const sender = await peer();
		const name = sender.name ?? sender.id;
		const { client, api, asked } = await boot({ mode: "workspace", hasUI: true, selects: [] });
		await impostor("twin", { id: "oc-twin", pid: process.ppid, name });
		const real = issueTicket(api.instance!.id, api.instance!.socket);
		await expect(
			client.call("message.send", {
				text: "hi",
				caller: { instanceId: sender.id, pid: sender.pid, ticket: real.ticket },
				wait: true,
			}),
		).rejects.toMatchObject({ data: { execution: "not-sent" } });
		expect(asked[0]).toContain(sessionOption(`messages from ${name} (${sender.id})`));
		real.release();
	});
});
