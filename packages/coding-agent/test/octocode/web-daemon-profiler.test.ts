import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { workspaces } from "../../../db/src/api.ts";
import { sharedAgentDb } from "../../src/config/database.ts";
import { AttachClient } from "../../src/octocode/web-daemon/attach-client.ts";
import { startAttachServer, type AttachEndpoint } from "../../src/octocode/web-daemon/attach-server.ts";
import { startDaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { attachRecordPath } from "../../src/octocode/web-daemon/paths.ts";
import { readAttachRecord } from "../../src/octocode/web-daemon/records.ts";
import type { ProfilerPort } from "../../src/octocode/profiler/index.ts";
import { fixtureBacklog } from "./backlog-fixture.ts";
import { fakeSession, isolatedEnv } from "./web-daemon-fixture.ts";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

const REPO_KEY = "ce04658b-7c62-406f-b82b-f2dbd3e8536f";

/** A profiler that counts its subscribers, standing in for the session's poll. */
function countingProfiler() {
	const state = { subscribed: 0, unsubscribed: 0 };
	const profiler = {
		subscribe: () => {
			state.subscribed++;
			return () => void state.unsubscribed++;
		},
	} as unknown as ProfilerPort;
	return { state, profiler };
}

describe("profiler subscription over the attach connection", () => {
	it("profiler.unsubscribe stops the session's subscription and a later subscribe starts a new one", async () => {
		const { env } = isolatedEnv();
		const { state, profiler } = countingProfiler();
		const session = fakeSession("s1");
		const endpoint: AttachEndpoint = await startAttachServer(
			{
				sessionId: "s1",
				cwd: "/repo",
				repo: { key: "/repo/.git", name: "repo", root: "/repo" },
				workspace: { ...session.workspace, profiler },
			},
			env,
		);
		cleanup.push(() => endpoint.close());
		const client = await AttachClient.connect(readAttachRecord(attachRecordPath(env, "s1"))!);
		cleanup.push(() => client.close());
		await client.profiler.subscribe();
		await client.profiler.subscribe();
		expect(state).toEqual({ subscribed: 1, unsubscribed: 0 });
		await client.profiler.unsubscribe();
		expect(state).toEqual({ subscribed: 1, unsubscribed: 1 });
		await client.profiler.unsubscribe();
		expect(state.unsubscribed).toBe(1);
		await client.profiler.subscribe();
		expect(state.subscribed).toBe(2);
	});

	it("the daemon unsubscribes when the last tab of a session closes, not before", async () => {
		const { env } = isolatedEnv();
		const server = await startDaemonServer({
			env,
			onActivity: () => {},
			config: async () => ({ protocolVersion: 1, providers: [] }),
			onDrain: () => {},
		});
		cleanup.push(() => server.close());
		workspaces.register(sharedAgentDb(env).db, { id: REPO_KEY, name: "demo", root: "/work/demo", binding: "mock" });
		fixtureBacklog(() => sharedAgentDb(env), REPO_KEY);
		const { state, profiler } = countingProfiler();
		const session = fakeSession("sess-1");
		const endpoint = await startAttachServer(
			{
				sessionId: "sess-1",
				cwd: "/work/demo",
				repo: { key: REPO_KEY, name: "demo", root: "/work/demo" },
				workspace: { ...session.workspace, profiler },
			},
			env,
		);
		cleanup.push(() => endpoint.close());
		await vi.waitFor(async () => {
			await server.registry.refresh();
			expect(server.registry.attached).toBe(1);
		});
		const origin = `http://127.0.0.1:${server.port}`;
		const open = async () => {
			const socket = new WebSocket(`ws://127.0.0.1:${server.port}/s/sess-1/api/backlogs/live`, {
				headers: { Origin: origin },
			});
			cleanup.push(() => socket.terminate());
			const packets: string[] = [];
			socket.on("message", (data) => packets.push(String(data)));
			await new Promise<void>((resolve) => socket.on("open", () => resolve()));
			socket.send(JSON.stringify({ token: server.token, protocolVersion: 1 }));
			await vi.waitFor(() => expect(packets.some((p) => p.includes('"workspace"'))).toBe(true));
			return socket;
		};
		const first = await open();
		const second = await open();
		await vi.waitFor(() => expect(server.tabs.count).toBe(2));
		expect(state).toEqual({ subscribed: 1, unsubscribed: 0 });
		first.close();
		await vi.waitFor(() => expect(server.tabs.count).toBe(1));
		await new Promise((resolve) => setTimeout(resolve, 150));
		expect(state.unsubscribed).toBe(0);
		second.close();
		await vi.waitFor(() => expect(state).toEqual({ subscribed: 1, unsubscribed: 1 }));
	});
});
