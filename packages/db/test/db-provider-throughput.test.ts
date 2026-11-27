import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type AgentDb, openDatabase, providerThroughput as t } from "../src/api.ts";
import { tmp } from "./helpers.ts";

let agent: AgentDb;
let locations: Parameters<typeof openDatabase>[0];
beforeEach(() => {
	const dir = tmp();
	locations = {
		file: path.join(dir, "agent.db"),
		mirrorFile: path.join(dir, "transcripts.db"),
		archiveDir: path.join(dir, "archive"),
		privateParent: false,
	};
	agent = openDatabase(locations);
});
afterEach(() => agent.close());

const W = 120_000;
const req = (patch: Partial<Parameters<typeof t.reserve>[1]> = {}): Parameters<typeof t.reserve>[1] => ({
	key: "model/us-east-1",
	reservationId: "r1",
	windowStart: W,
	now: W + 10,
	estimatedTokens: 100,
	tokenLimit: 1000,
	requestLimit: 10,
	...patch,
});

describe("providerThroughput reserve", () => {
	it("admits up to the exact token capacity and refuses past it with retryAt", () => {
		expect(t.reserve(agent.db, req({ reservationId: "a", estimatedTokens: 600 })).admitted).toBe(true);
		expect(t.reserve(agent.db, req({ reservationId: "b", estimatedTokens: 400 }))).toMatchObject({
			admitted: true,
			usage: { tokens: 1000, requests: 2 },
		});
		expect(t.reserve(agent.db, req({ reservationId: "c", estimatedTokens: 1 }))).toEqual({
			admitted: false,
			effectiveTokenLimit: 1000,
			effectiveRequestLimit: 10,
			usage: { tokens: 1000, requests: 2 },
			retryAt: W + 60_010,
		});
		expect(t.usage(agent.db, "model/us-east-1", W)).toEqual({ tokens: 1000, requests: 2 });
	});

	it("limits requests per minute at the boundary", () => {
		for (const id of ["a", "b", "c"]) {
			expect(t.reserve(agent.db, req({ reservationId: id, estimatedTokens: 1, requestLimit: 3 })).admitted).toBe(true);
		}
		const refused = t.reserve(agent.db, req({ reservationId: "d", estimatedTokens: 1, requestLimit: 3 }));
		expect(refused).toMatchObject({ admitted: false, usage: { requests: 3 } });
	});

	it("keeps the RPM charge across a wall-clock minute until the send is sixty seconds old", () => {
		const first = req({ now: W + 59_999, requestLimit: 1 });
		expect(t.reserve(agent.db, first).admitted).toBe(true);
		const second = { ...first, reservationId: "next", windowStart: W + 60_000 };
		expect(t.reserve(agent.db, { ...second, now: W + 60_000 })).toMatchObject({
			admitted: false,
			retryAt: W + 119_999,
		});
		expect(t.reserve(agent.db, { ...second, now: W + 119_999 }).admitted).toBe(true);
	});

	it("keeps keys and windows independent", () => {
		t.reserve(agent.db, req({ estimatedTokens: 1000 }));
		expect(t.reserve(agent.db, req({ reservationId: "x", key: "other/us-east-1" })).admitted).toBe(true);
		expect(t.reserve(agent.db, req({ reservationId: "y", windowStart: W + 60_000, now: W + 60_010 })).admitted).toBe(
			true,
		);
		expect(t.reserve(agent.db, req({ reservationId: "z" })).admitted).toBe(false);
	});

	it("scales capacity by utilization and by the adaptive scale", () => {
		const first = t.reserve(agent.db, req({ utilization: 0.5, estimatedTokens: 500 }));
		expect(first).toMatchObject({ admitted: true, effectiveTokenLimit: 500, effectiveRequestLimit: 5 });
		expect(t.reserve(agent.db, req({ reservationId: "b", utilization: 0.5, estimatedTokens: 1 })).admitted).toBe(false);
		t.recordThrottle(agent.db, "model/us-east-1", W);
		expect(t.reserve(agent.db, req({ reservationId: "c", windowStart: W + 60_000, now: W + 61_000 }))).toMatchObject({
			effectiveTokenLimit: 500,
			effectiveRequestLimit: 5,
		});
	});

	it("admits one oversized reservation into an empty window only", () => {
		expect(t.reserve(agent.db, req({ estimatedTokens: 50_000 })).admitted).toBe(true);
		expect(t.reserve(agent.db, req({ reservationId: "b", estimatedTokens: 1 })).admitted).toBe(false);
		expect(
			t.reserve(
				agent.db,
				req({ reservationId: "c", estimatedTokens: 50_000, windowStart: W + 60_000, now: W + 60_010 }),
			).admitted,
		).toBe(true);
	});

	it("is idempotent for a reservation id already held", () => {
		t.reserve(agent.db, req());
		t.reserve(agent.db, req());
		expect(t.usage(agent.db, "model/us-east-1", W)).toEqual({ tokens: 100, requests: 1 });
	});

	it("validates inputs", () => {
		expect(() => t.reserve(agent.db, req({ estimatedTokens: 1.5 }))).toThrow(RangeError);
		expect(() => t.reserve(agent.db, req({ estimatedTokens: -1 }))).toThrow(RangeError);
		expect(() => t.reserve(agent.db, req({ tokenLimit: 0 }))).toThrow(RangeError);
		expect(() => t.reserve(agent.db, req({ utilization: 0 }))).toThrow(RangeError);
		expect(() => t.reserve(agent.db, req({ utilization: 1.1 }))).toThrow(RangeError);
		expect(() => t.reserve(agent.db, req({ key: "" }))).toThrow(RangeError);
	});
});

describe("providerThroughput reconcile and release", () => {
	it("replaces the estimate with the actual tokens, keeping the request counted", () => {
		t.reserve(agent.db, req({ estimatedTokens: 1000 }));
		expect(
			t.reconcile(agent.db, { key: "model/us-east-1", windowStart: W, reservationId: "r1", actualTokens: 300 }),
		).toBe(true);
		expect(t.usage(agent.db, "model/us-east-1", W)).toEqual({ tokens: 300, requests: 1 });
		expect(t.reserve(agent.db, req({ reservationId: "b", estimatedTokens: 700 })).admitted).toBe(true);
	});

	it("frees the token budget when the actual is zero but still counts the request", () => {
		t.reserve(agent.db, req({ estimatedTokens: 1000, requestLimit: 2 }));
		t.reconcile(agent.db, { key: "model/us-east-1", windowStart: W, reservationId: "r1", actualTokens: 0 });
		expect(t.usage(agent.db, "model/us-east-1", W)).toEqual({ tokens: 0, requests: 1 });
		expect(t.reserve(agent.db, req({ reservationId: "b", estimatedTokens: 1000, requestLimit: 2 })).admitted).toBe(
			true,
		);
		expect(t.reserve(agent.db, req({ reservationId: "c", estimatedTokens: 0, requestLimit: 2 })).admitted).toBe(false);
	});

	it("reports an unknown reservation and rejects a bad actual", () => {
		expect(t.reconcile(agent.db, { key: "k", windowStart: W, reservationId: "none", actualTokens: 1 })).toBe(false);
		expect(() => t.reconcile(agent.db, { key: "k", windowStart: W, reservationId: "none", actualTokens: -1 })).toThrow(
			RangeError,
		);
	});

	it("releases a reservation that never reached the transport", () => {
		t.reserve(agent.db, req({ estimatedTokens: 1000, requestLimit: 1 }));
		expect(t.release(agent.db, { key: "model/us-east-1", windowStart: W, reservationId: "r1" })).toBe(true);
		expect(t.release(agent.db, { key: "model/us-east-1", windowStart: W, reservationId: "r1" })).toBe(false);
		expect(t.usage(agent.db, "model/us-east-1", W)).toEqual({ tokens: 0, requests: 0 });
		expect(t.reserve(agent.db, req({ reservationId: "b", estimatedTokens: 1000, requestLimit: 1 })).admitted).toBe(
			true,
		);
	});
});

describe("providerThroughput maintenance", () => {
	const k = "model/us-east-1";
	const settle = (id: string, windowStart: number) =>
		t.reconcile(agent.db, { key: k, windowStart, reservationId: id, actualTokens: 5 });

	it("deletes settled windows older than two minutes on write and keeps recent ones", () => {
		t.reserve(agent.db, req({ windowStart: 0, now: 10 }));
		t.reserve(agent.db, req({ reservationId: "p", windowStart: 60_000, now: 60_010 }));
		settle("r1", 0);
		settle("p", 60_000);
		t.reserve(agent.db, req({ reservationId: "n", windowStart: 180_000, now: 180_000 }));
		expect(t.usage(agent.db, k, 0).requests).toBe(0);
		expect(t.usage(agent.db, k, 60_000).requests).toBe(1);
		t.reserve(agent.db, req({ reservationId: "m", windowStart: 240_000, now: 240_010 }));
		expect(t.usage(agent.db, k, 60_000).requests).toBe(0);
		expect(t.usage(agent.db, k, 180_000).requests).toBe(1);
	});

	it("keeps a pending reservation past two minutes so a long stream can reconcile", () => {
		t.reserve(agent.db, req({ windowStart: 0, now: 10, estimatedTokens: 900 }));
		t.reserve(agent.db, req({ reservationId: "later", windowStart: 600_000, now: 600_000 }));
		expect(t.usage(agent.db, k, 0)).toEqual({ tokens: 900, requests: 1 });
		expect(t.reconcile(agent.db, { key: k, windowStart: 0, reservationId: "r1", actualTokens: 40 })).toBe(true);
		expect(t.usage(agent.db, k, 0)).toEqual({ tokens: 40, requests: 1 });
		t.reserve(agent.db, req({ reservationId: "after", windowStart: 660_000, now: 660_000 }));
		expect(t.usage(agent.db, k, 0).requests).toBe(0);
	});

	it("expires a pending reservation after fifteen minutes", () => {
		t.reserve(agent.db, req({ windowStart: 0, now: 10 }));
		t.reserve(agent.db, req({ reservationId: "a", windowStart: 900_000, now: 900_000 }));
		expect(t.usage(agent.db, k, 0).requests).toBe(1);
		t.reserve(agent.db, req({ reservationId: "b", windowStart: 960_000, now: 960_000 }));
		expect(t.usage(agent.db, k, 0).requests).toBe(0);
		expect(t.reconcile(agent.db, { key: k, windowStart: 0, reservationId: "r1", actualTokens: 1 })).toBe(false);
	});

	it("prunes in bounded batches", () => {
		for (let i = 0; i < 250; i++) {
			t.reserve(
				agent.db,
				req({ reservationId: `s${i}`, windowStart: 0, now: 10, tokenLimit: 1e9, requestLimit: 1000 }),
			);
			settle(`s${i}`, 0);
		}
		t.reserve(agent.db, req({ reservationId: "n", windowStart: 600_000, now: 600_000 }));
		expect(t.usage(agent.db, k, 0).requests).toBe(50);
	});
});

describe("providerThroughput adaptive state", () => {
	const k = "model/us-east-1";
	it("starts at scale 1, halves on throttle with floor 0.1 and resets successes", () => {
		expect(t.state(agent.db, k)).toEqual({ scale: 1, successes: 0 });
		t.recordSuccess(agent.db, k, 1);
		expect(t.recordThrottle(agent.db, k, 2)).toEqual({ scale: 0.5, successes: 0 });
		for (let i = 0; i < 6; i++) t.recordThrottle(agent.db, k, 3);
		expect(t.state(agent.db, k)).toEqual({ scale: 0.1, successes: 0 });
		expect(t.state(agent.db, "other")).toEqual({ scale: 1, successes: 0 });
	});

	it("raises the scale by 0.1 after five successes, capped at 1", () => {
		t.recordThrottle(agent.db, k, 1);
		for (let i = 0; i < 4; i++) expect(t.recordSuccess(agent.db, k, 2)).toMatchObject({ scale: 0.5, successes: i + 1 });
		expect(t.recordSuccess(agent.db, k, 3)).toEqual({ scale: 0.6, successes: 0 });
		for (let i = 0; i < 5 * 6; i++) t.recordSuccess(agent.db, k, 4);
		expect(t.state(agent.db, k)).toEqual({ scale: 1, successes: 0 });
	});

	it("resets only the success streak on an ordinary failure", () => {
		t.recordThrottle(agent.db, k, 1);
		for (let i = 0; i < 4; i++) t.recordSuccess(agent.db, k, 2);
		expect(t.recordFailure(agent.db, k, 3)).toEqual({ scale: 0.5, successes: 0 });
		for (let i = 0; i < 4; i++) t.recordSuccess(agent.db, k, 4);
		expect(t.state(agent.db, k)).toEqual({ scale: 0.5, successes: 4 });
	});
});

describe("providerThroughput across connections", () => {
	it("never admits more than the capacity when two connections contend", () => {
		const other = openDatabase(locations);
		try {
			const dbs = [agent.db, other.db];
			let admitted = 0;
			for (let i = 0; i < 20; i++) {
				const r = t.reserve(dbs[i % 2], req({ reservationId: `c${i}`, estimatedTokens: 100 }));
				if (r.admitted) admitted++;
			}
			expect(admitted).toBe(10);
			expect(t.usage(other.db, "model/us-east-1", W)).toEqual({ tokens: 1000, requests: 10 });
		} finally {
			other.close();
		}
	});
});
