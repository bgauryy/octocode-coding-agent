import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import { afterEach, expect, it } from "vitest";
import type { ApplicationPort } from "@octocodeai/octocode-contacts";
import { ApplicationAssets } from "../src/core/application/assets.ts";
import { handleApplicationDataRequest } from "../src/octocode/workspace/application-data.ts";

const assets = new ApplicationAssets({ memory: true });
afterEach(() => assets.clear());
const port: ApplicationPort = {
	connect: () => {
		throw new Error("Unused stream");
	},
	execute: async (command) => ({ id: command.id, status: "accepted" }),
	uploadAsset: (input) => assets.upload(input),
	readAsset: (id) => assets.get(id),
	history: (options) => ({
		messages: [{ id: "m", role: "user", text: options?.before ?? "first", complete: true }],
		tools: [],
		hasMore: false,
		activities: [{ id: options?.activityBefore ?? "current", kind: "usage", at: 1, text: "Usage", source: "session" }],
		hasMoreActivities: false,
	}),
};
async function request(path: string, method = "GET", input?: unknown) {
	const body = input === undefined ? "" : JSON.stringify(input);
	const req = Object.assign(Readable.from([Buffer.from(body)]), {
		method,
		headers: { "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) },
	}) as IncomingMessage;
	let response: { status: number; body: unknown } | undefined;
	const handled = await handleApplicationDataRequest(
		req,
		new URL(path, "http://localhost"),
		port,
		"session",
		(status, value) => {
			response = { status, body: value };
		},
	);
	return { handled, ...response };
}

it("routes validated uploads, asset reads and paged history without filesystem authority", async () => {
	const upload = await request("/api/application/assets", "POST", {
		sessionId: "session",
		mimeType: "image/png",
		data: "aW1hZ2U=",
		name: "image.png",
	});
	expect(upload.status).toBe(201);
	const body = upload.body as { asset: { id: string } };
	expect(await request(`/api/application/assets/${body.asset.id}?sessionId=session`)).toMatchObject({
		status: 200,
		body: { encoding: "base64", data: "aW1hZ2U=" },
	});
	expect(await request(`/api/application/assets/${body.asset.id}?sessionId=other`)).toMatchObject({ status: 409 });
	expect(await request("/api/application/history?sessionId=session&before=older&limit=20")).toMatchObject({
		status: 200,
		body: { messages: [{ text: "older" }], hasMore: false },
	});
	expect(await request("/api/application/history?sessionId=session&limit=0")).toMatchObject({ status: 400 });
	expect(await request("/api/application/history?sessionId=session&activityBefore=usage-older")).toMatchObject({
		status: 200,
		body: { activities: [{ id: "usage-older" }], hasMoreActivities: false },
	});
	expect(await request("/api/application/assets/not-an-id?sessionId=session")).toMatchObject({ status: 404 });
	expect(await request("/api/backlogs")).toMatchObject({ handled: false });
});

it("rejects invalid payloads and applies frame redaction to full-content retrieval", async () => {
	for (const input of [
		{ sessionId: "session", mimeType: "image/svg+xml", data: "PHN2Zy8+" },
		{ sessionId: "session", mimeType: "image/png", data: "invalid" },
		{ sessionId: "session", mimeType: "image/png", data: "aW1hZ2U=", path: "/private/file" },
	])
		expect((await request("/api/application/assets", "POST", input)).status).toBe(400);
	const secret = "sk-" + "x".repeat(32);
	const full = assets.put(JSON.stringify({ text: secret }), "application/json");
	const response = await request(`/api/application/assets/${full.id}?sessionId=session`);
	expect(response).toMatchObject({ status: 200, body: { encoding: "utf8", data: '{"text":"[redacted]"}' } });
	expect(JSON.stringify(response)).not.toContain(secret);
});
