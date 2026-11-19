import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { FeatureContext } from "../../src/core/features/index.ts";
import { EventLog } from "../../src/octocode/api/events.ts";
import { ownInstance, publishOwnInstance } from "../../src/octocode/api/identity.ts";
import { PREPARING, SEND_REPLY_MS } from "../../src/octocode/api/protocol.ts";
import {
	apiDir,
	ensurePrivateDir,
	type InstanceRecord,
	instancesDir,
	removeSocket,
	socketPath,
} from "../../src/octocode/api/registry.ts";
import { ApiServer } from "../../src/octocode/api/server.ts";
import { Peers } from "../../src/octocode/external/peers.ts";
import { tmp } from "./helpers.ts";

let home: string;
let closing: (() => Promise<void>) | undefined;
beforeEach(() => {
	home = tmp("octocode-peers-stalled-");
	vi.stubEnv("OCTOCODE_HOME", home);
	ensurePrivateDir(apiDir());
});
afterEach(async () => {
	vi.useRealTimers();
	vi.unstubAllEnvs();
	publishOwnInstance(undefined, ownInstance());
	await closing?.();
	closing = undefined;
});

/** A receiver that takes the connection but answers only the calls it is told to. */
async function receiver(answer: (params: Record<string, unknown>) => Record<string, unknown> | undefined) {
	const socket = socketPath(apiDir(), "oc-slow");
	const received: Record<string, unknown>[] = [];
	const server = new ApiServer(
		async (method, params) => {
			if (method !== "message.send") return undefined;
			received.push(params);
			const reply = answer(params);
			return reply ?? new Promise(() => undefined);
		},
		new EventLog(),
		"token",
	);
	await server.listenUnix(socket);
	closing = async () => {
		await server.close();
		removeSocket(socket);
	};
	writeFileSync(
		join(instancesDir(apiDir()), "oc-slow.json"),
		JSON.stringify({
			id: "oc-slow",
			pid: process.ppid,
			name: "octocode-main-slow",
			cwd: "/w",
			startedAt: 1,
			protocol: 1,
			socket,
		}),
	);
	return received;
}

function sender() {
	const self: InstanceRecord = {
		id: "oc-self",
		pid: process.pid,
		cwd: "/w",
		startedAt: 1,
		protocol: 1,
		name: "octocode-main-self",
	};
	writeFileSync(join(instancesDir(apiDir()), "oc-self.json"), JSON.stringify(self));
	publishOwnInstance(self);
	const notices: string[] = [];
	const peers = new Peers({ authorize: async () => undefined, notice: (text) => void notices.push(text) }, process.env);
	const ctx = { cwd: home } as unknown as FeatureContext;
	return { notices, send: (text: string) => peers.send("octocode-main-slow", text, {}, ctx) };
}

it("gives up on a receiver that never answers within the reply bound, and a retry reuses the first call's key", async () => {
	const received = await receiver(() => undefined);
	const { send } = sender();
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const first = send("hello").catch((error: unknown) => error);
	await vi.waitFor(() => expect(received).toHaveLength(1));
	await vi.advanceTimersByTimeAsync(SEND_REPLY_MS);
	await expect(first).resolves.toMatchObject({ execution: "unknown" });
	const retry = send("hello").catch((error: unknown) => error);
	await vi.waitFor(() => expect(received).toHaveLength(2));
	await vi.advanceTimersByTimeAsync(SEND_REPLY_MS);
	await retry;
	expect(received[1].key).toBe(received[0].key);
	expect(received[0].key).toEqual(expect.any(String));
});

it("reports a message the receiver acknowledged as still preparing, not as uncertain", async () => {
	await receiver((params) => ({ id: "m1", queued: PREPARING, key: params.key }));
	const { send } = sender();
	const sent = await send("hello");
	expect(sent.details).toMatchObject({ queued: PREPARING });
	expect(sent.text).toMatch(/preparing/);
});

it("uses a new key for the same text once the first send was answered", async () => {
	const received = await receiver(() => ({ id: "m", queued: "turn" }));
	const { send } = sender();
	await send("hello");
	await send("hello");
	expect(received[1].key).not.toBe(received[0].key);
});
