import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { KeychainBackend } from "../../src/core/auth-storage/keychain.ts";
import { writeConfigCredential } from "../../src/octocode/web-daemon/credential-write.ts";
import type { ConfigWriteError } from "../../src/octocode/web-daemon/config-write.ts";

const KEY = "SENTINEL-CHECK-77c1d2";
let root: string;
let agentDir: string;
const requests: Array<{ url: string; init: RequestInit | undefined }> = [];

beforeEach(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-key-check-"));
	agentDir = path.join(root, "agent");
	fs.mkdirSync(agentDir);
	requests.length = 0;
});
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	fs.rmSync(root, { recursive: true, force: true });
});

/** The provider network boundary is the only thing stubbed. */
function provider(answer: (init: RequestInit | undefined) => Promise<Response>) {
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), init });
		return answer(init);
	});
}

/** A keychain kept in a temp folder, so no test reaches the real one. */
function fakeKeychain(): KeychainBackend {
	const file = (account: string) => path.join(root, `kc-${account}`);
	return {
		name: "fake keychain",
		store: async (account, secret) => fs.writeFileSync(file(account), secret),
		remove: async (account) => fs.rmSync(file(account), { force: true }),
		referenceFor: (account) => `!cat ${file(account)}`,
		isOwnReference: (key, account) => key === `!cat ${file(account)}`,
	};
}

const save = (extra: object = {}, keychain: KeychainBackend | null = fakeKeychain()) =>
	writeConfigCredential(
		{ action: "set", provider: "openai", key: KEY, ...extra },
		{ agentDir, keychain, env: {}, actor: "test" },
	);
const saved = () => fs.existsSync(path.join(agentDir, "auth.json"));
const failure = (promise: Promise<unknown>) =>
	promise.then(
		() => undefined,
		(error: unknown) => error as ConfigWriteError,
	);

describe("key check before a web save", () => {
	it("saves an accepted key after one bounded request that follows no redirect", async () => {
		provider(async () => new Response("{}", { status: 200 }));
		await save();
		expect(saved()).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toBe("https://api.openai.com/v1/models");
		expect(requests[0].init).toMatchObject({ redirect: "error" });
		expect(requests[0].init?.signal).toBeInstanceOf(AbortSignal);
	});

	it("refuses a rejected key without echoing the key or the provider's reply", async () => {
		provider(async () => new Response(`{"error":"bad ${KEY} PROVIDER-BODY"}`, { status: 401 }));
		const error = await failure(save());
		expect(error).toMatchObject({ status: 400, code: "rejected" });
		expect(error?.message).not.toContain(KEY);
		expect(error?.message).not.toContain("PROVIDER-BODY");
		expect(saved()).toBe(false);
	});

	it("asks for confirmation when the check times out after 10 s, then saves once acknowledged", async () => {
		vi.useFakeTimers();
		provider(
			(init) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
				}),
		);
		const pending = failure(save());
		await vi.advanceTimersByTimeAsync(9_999);
		expect(saved()).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		const error = await pending;
		expect(error).toMatchObject({ status: 409, code: "unverified" });
		expect(error?.message).not.toContain(KEY);
		expect(saved()).toBe(false);

		const acknowledged = save({ acknowledgeUnverified: true });
		await vi.advanceTimersByTimeAsync(10_000);
		await acknowledged;
		expect(saved()).toBe(true);
	});
});

describe("clearing a credential uses the request's keychain", () => {
	it("removes an OAuth sign-in's keychain entry from the keychain the request names", async () => {
		const keychain = fakeKeychain();
		const account = "openai.oauth";
		await keychain.store(account, JSON.stringify({ access: "ACC", refresh: "REF-9", expires: 1 }));
		fs.writeFileSync(
			path.join(agentDir, "auth.json"),
			JSON.stringify({
				openai: { type: "oauth", access: "", refresh: "", expires: 1, keychain: keychain.referenceFor(account) },
			}),
		);
		provider(async () => new Response("{}", { status: 200 }));
		await writeConfigCredential(
			{ action: "clear", provider: "openai" },
			{ agentDir, keychain, env: {}, actor: "test" },
		);
		expect(fs.existsSync(path.join(root, `kc-${account}`))).toBe(false);
		expect(JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8")).openai?.keychain).toBeUndefined();
	});
});
