import { expect, it } from "vitest";
import { Value } from "typebox/value";
import {
	ATTACH_PROTOCOL_VERSION,
	AttachEventSchema,
	AttachRecordSchema,
	AttachRequestSchema,
	AttachResponseSchema,
	DAEMON_PROTOCOL_VERSION,
	DaemonHealthSchema,
	DaemonRecordSchema,
	DaemonSessionsSchema,
	DaemonStatusSchema,
	RemoteLinkSchema,
	RemotePublishSchema,
	RemoteStatusSchema,
} from "../src/daemon.ts";
import { DAEMON_ROUTES } from "../src/protocol.ts";

const record = {
	pid: 12,
	pid_started: "1700000000",
	port: 4040,
	url: "http://127.0.0.1:4040/#access=abc",
	protocolVersion: DAEMON_PROTOCOL_VERSION,
	build: "1.3.0:abc",
	startedAt: 1,
	nonce: "n",
};

it("round-trips the daemon record and refuses unknown fields or versions", () => {
	expect(Value.Check(DaemonRecordSchema, record)).toBe(true);
	expect(Value.Check(DaemonRecordSchema, { ...record, extra: 1 })).toBe(false);
	expect(Value.Check(DaemonRecordSchema, { ...record, protocolVersion: 2 })).toBe(false);
	expect(Value.Check(DaemonRecordSchema, { ...record, port: 0 })).toBe(false);
});

it("keeps the unauthenticated health answer to compatibility only", () => {
	const health = { ok: true, protocolVersion: DAEMON_PROTOCOL_VERSION, build: "b" };
	expect(Value.Check(DaemonHealthSchema, health)).toBe(true);
	expect(Value.Check(DaemonHealthSchema, { ...health, nonce: "n" })).toBe(false);
	expect(
		Value.Check(DaemonStatusSchema, {
			...health,
			nonce: "n",
			pid: 1,
			startedAt: 1,
			tabs: 0,
			sessions: 0,
			draining: false,
		}),
	).toBe(true);
});

it("validates attach records, requests, responses and events", () => {
	expect(
		Value.Check(AttachRecordSchema, {
			protocolVersion: ATTACH_PROTOCOL_VERSION,
			sessionId: "s1",
			pid: 5,
			port: 5000,
			token: "t",
			cwd: "/repo",
			repo: { key: "/repo/.git", name: "repo", root: "/repo" },
			startedAt: 1,
		}),
	).toBe(true);
	const hello = { id: "1", method: "attach.hello", params: { token: "t", protocolVersion: 1 } };
	expect(Value.Check(AttachRequestSchema, hello)).toBe(true);
	expect(Value.Check(AttachRequestSchema, { ...hello, params: { token: "t", protocolVersion: 2 } })).toBe(false);
	expect(Value.Check(AttachRequestSchema, { id: "2", method: "workspace.snapshot" })).toBe(true);
	expect(Value.Check(AttachRequestSchema, { id: "3", method: "shell.exec", params: {} })).toBe(false);
	expect(
		Value.Check(AttachRequestSchema, { id: "4", method: "application.readAsset", params: { id: "../etc/passwd" } }),
	).toBe(false);
	expect(
		Value.Check(AttachResponseSchema, { id: "1", ok: false, error: { code: "unauthorized", message: "no" } }),
	).toBe(true);
	expect(Value.Check(AttachEventSchema, { event: "session.closed" })).toBe(true);
	expect(Value.Check(AttachEventSchema, { event: "application.end" })).toBe(false);
});

it("names daemon routes beside, not inside, the workspace routes", () => {
	expect(DAEMON_ROUTES.health).toBe("/api/health");
	expect(DAEMON_ROUTES.scope).toEqual({ session: "/s", repo: "/r" });
	expect(Value.Check(DaemonSessionsSchema, { sessions: [] })).toBe(true);
});

it("caps unsolicited lines below responses and lets lists say they were cut short", async () => {
	const { ATTACH_MAX_EVENT_BYTES, ATTACH_MAX_REQUEST_BYTES, ATTACH_MAX_RESPONSE_BYTES, DaemonReposSchema } =
		await import("../src/daemon.ts");
	expect(ATTACH_MAX_EVENT_BYTES).toBe(ATTACH_MAX_REQUEST_BYTES);
	expect(ATTACH_MAX_EVENT_BYTES).toBeLessThan(ATTACH_MAX_RESPONSE_BYTES);
	expect(
		Value.Check(DaemonSessionsSchema, {
			sessions: [],
			truncated: true,
			unavailable: [{ id: "s", repoName: "r", cwd: "/", message: "restart it" }],
		}),
	).toBe(true);
	expect(Value.Check(DaemonReposSchema, { repos: [], truncated: true })).toBe(true);
	expect(Value.Check(DaemonReposSchema, { repos: [], truncated: "yes" })).toBe(false);
});

it("lets a listed session say it is busy or needs the user, and keeps older lists valid without it", () => {
	const session = { id: "s", repoId: "r", repoName: "demo", cwd: "/w", startedAt: 1, attached: true };
	expect(Value.Check(DaemonSessionsSchema, { sessions: [session] })).toBe(true);
	expect(Value.Check(DaemonSessionsSchema, { sessions: [{ ...session, busy: true, needsYou: "Run tests?" }] })).toBe(
		true,
	);
	expect(Value.Check(DaemonSessionsSchema, { sessions: [{ ...session, needsYou: 1 }] })).toBe(false);
});

it("describes remote publication: a transport, an access level, links with their capability in the fragment", () => {
	expect(DAEMON_ROUTES.remote).toBe("/api/admin/remote");
	expect(Value.Check(RemotePublishSchema, { transport: "ssh", access: "view" })).toBe(true);
	expect(Value.Check(RemotePublishSchema, { transport: "relay", access: "control", relayUrl: "wss://r" })).toBe(true);
	expect(Value.Check(RemotePublishSchema, { transport: "tunnel", access: "control" })).toBe(false);
	expect(Value.Check(RemotePublishSchema, { transport: "ssh", access: "admin" })).toBe(false);
	const link = {
		transport: "ssh",
		access: "control",
		url: "http://127.0.0.1:4040/#access=t",
		issuedAt: 1,
		forward: "ssh -L",
	};
	expect(Value.Check(RemoteLinkSchema, link)).toBe(true);
	expect(Value.Check(RemoteLinkSchema, { ...link, token: "t" })).toBe(false);
	expect(Value.Check(RemoteStatusSchema, { links: [link] })).toBe(true);
	expect(Value.Check(RemoteStatusSchema, { links: [], relay: { url: "wss://r", state: "connected", peers: 2 } })).toBe(
		true,
	);
	expect(Value.Check(RemoteStatusSchema, { links: [], relay: { url: "wss://r", state: "open", peers: 0 } })).toBe(
		false,
	);
});
