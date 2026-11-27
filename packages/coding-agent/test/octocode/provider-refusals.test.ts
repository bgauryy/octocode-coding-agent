import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProviderHealth } from "../../src/octocode/subagents/provider-health.ts";
import { authFingerprint, fileRefusalStore } from "../../src/octocode/subagents/provider-refusals.ts";

const INVALID_GRANT = '401 {"error":"invalid_grant","error_description":"Refresh token has been revoked"}';

let dir: string;
let authFile: string;
let refusals: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "octocode-refusals-"));
	authFile = join(dir, "auth.json");
	refusals = join(dir, "state", "provider-refusals.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const signIn = (entries: Record<string, unknown>) => writeFileSync(authFile, JSON.stringify(entries));
const processStart = () => new ProviderHealth(fileRefusalStore(refusals, authFingerprint(authFile)));

describe("a credential refusal at the next process start", () => {
	it("is known before any child runs, while the saved credential is the one that was refused", () => {
		signIn({ openai: { type: "oauth", access: "a1", refresh: "r1", expires: 1 } });
		processStart().noteRun("openai/gpt", INVALID_GRANT);

		const next = processStart();
		expect(next.refused("openai")).toBe(true);
		expect(next.get("openai")).toMatchObject({ ok: false, via: "run" });
		expect(next.get("openai")?.detail).toContain("invalid_grant");
	});

	it("is dropped when the provider's credential was replaced since", () => {
		signIn({ openai: { type: "oauth", access: "a1", refresh: "r1", expires: 1 } });
		processStart().noteRun("openai/gpt", INVALID_GRANT);
		signIn({ openai: { type: "oauth", access: "a2", refresh: "r2", expires: 2 } });
		expect(processStart().refused("openai")).toBe(false);
	});

	it("survives a refreshed access token: only the credential itself identifies it", () => {
		signIn({ openai: { type: "oauth", access: "a1", refresh: "r1", expires: 1 } });
		processStart().noteRun("openai/gpt", INVALID_GRANT);
		signIn({ openai: { type: "oauth", access: "a2", refresh: "r1", expires: 99 } });
		expect(processStart().refused("openai")).toBe(true);
	});

	it("ignores a change to another provider's credential", () => {
		signIn({ openai: { type: "api_key", key: "k1" }, groq: { type: "api_key", key: "g1" } });
		processStart().noteRun("openai/gpt", INVALID_GRANT);
		signIn({ openai: { type: "api_key", key: "k1" }, groq: { type: "api_key", key: "g2" } });
		expect(processStart().refused("openai")).toBe(true);
	});

	it("is forgotten once a run or a check succeeds, or the credential changes in the process", () => {
		signIn({ openai: { type: "api_key", key: "k1" }, groq: { type: "api_key", key: "g1" } });
		const first = processStart();
		first.noteRun("openai/gpt", INVALID_GRANT);
		first.noteCheck("groq", INVALID_GRANT);
		first.noteRun("openai/gpt");
		first.credentialChanged("groq");
		const next = processStart();
		expect(next.refused("openai")).toBe(false);
		expect(next.refused("groq")).toBe(false);
	});

	it("keeps only refusals the credential causes: a usage limit lapses by itself and is not saved", () => {
		signIn({ openai: { type: "api_key", key: "k1" } });
		processStart().noteRun("openai/gpt", "429 Monthly usage limit reached");
		expect(processStart().get("openai")).toBeUndefined();
	});

	it("is not saved for a credential that is not stored (an environment key cannot be told apart)", () => {
		signIn({});
		processStart().noteRun("openai/gpt", INVALID_GRANT);
		expect(() => readFileSync(refusals, "utf8")).toThrow();
		expect(processStart().refused("openai")).toBe(false);
	});

	it("starts clean from a missing or damaged file, and the file holds no credential", () => {
		signIn({ openai: { type: "api_key", key: "sk-secret-value" } });
		expect(processStart().refused("openai")).toBe(false);
		mkdirSync(join(dir, "state"), { recursive: true });
		writeFileSync(refusals, "{not json");
		expect(processStart().refused("openai")).toBe(false);
		processStart().noteRun("openai/gpt", INVALID_GRANT);
		expect(readFileSync(refusals, "utf8")).not.toContain("sk-secret-value");
		expect(processStart().refused("openai")).toBe(true);
	});
});
