import type { AuthInteraction } from "@octocodeai/octocode-ai";
import { SignInStateSchema, type SignInState } from "@octocodeai/octocode-contracts/config";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfigAuditEntry } from "../../../db/src/api.ts";
import { buildConfigSnapshot } from "../../src/octocode/web-daemon/config-status.ts";
import { CredentialSynchronizationError } from "../../src/core/model-runtime.ts";
import { SignInManager } from "../../src/octocode/web-daemon/credential-signin.ts";
import { startDaemonServer, type DaemonServer } from "../../src/octocode/web-daemon/server.ts";
import { isolatedEnv } from "./web-daemon-fixture.ts";

const ROUTE = "/api/admin/config/signin";
const TOKEN_TEXT = "sk-ant-oat01-Zq8Lm3Vx7Rt2Yb9Kc4Wd6Hn1Pf5Js0Ae";
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** A login the test drives by hand: it announces a link, asks for a code, then finishes or fails. */
function fakeLogin() {
	const control = {
		interaction: undefined as AuthInteraction | undefined,
		finish: (_ok: boolean) => {},
		answer: undefined as string | undefined,
	};
	const login = (_provider: string, interaction: AuthInteraction) =>
		new Promise<void>((resolve, reject) => {
			control.interaction = interaction;
			control.finish = (ok) => (ok ? resolve() : reject(new Error(`token exchange failed for ${TOKEN_TEXT}`)));
			interaction.signal?.addEventListener("abort", () => reject(new Error("Login cancelled")));
			interaction.notify({ type: "auth_url", url: "https://example.com/authorize?state=1", instructions: "Sign in" });
			interaction.notify({ type: "auth_url", url: "javascript:alert(1)" });
			interaction.prompt({ type: "manual_code", message: "Paste the code" }).then(
				(value) => {
					control.answer = value;
				},
				() => {},
			);
		});
	return { login, control };
}

async function daemon(
	options: {
		lifetimeMs?: number;
		abortGraceMs?: number;
		offers?: (provider: string) => boolean;
		login?: (provider: string, interaction: AuthInteraction) => Promise<unknown>;
	} = {},
) {
	const { env } = isolatedEnv();
	const fake = fakeLogin();
	const audits: ConfigAuditEntry[] = [];
	const manager = new SignInManager({
		login: options.login ?? fake.login,
		abortGraceMs: options.abortGraceMs,
		offersOAuth: async (provider) => options.offers?.(provider) ?? provider === "openai-codex",
		lifetimeMs: options.lifetimeMs,
		actor: () => "web:test",
		audit: (entry) => audits.push(entry),
	});
	const server: DaemonServer = await startDaemonServer({
		env,
		onActivity: () => {},
		config: () =>
			buildConfigSnapshot({ agentDir: env.OCTOCODE_CODING_AGENT_DIR ?? "/nonexistent", keychain: null, env }),
		signIn: (command) => manager.handle(command),
		onDrain: () => {},
	});
	cleanup.push(
		() => manager.closeAll(),
		() => server.close(),
	);
	const bodies: string[] = [];
	const call = async (token: string, body: unknown) => {
		const response = await fetch(`http://127.0.0.1:${server.port}${ROUTE}`, {
			method: "POST",
			headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(body),
		});
		const text = await response.text();
		bodies.push(text);
		return { status: response.status, json: () => JSON.parse(text) as SignInState & { error?: string } };
	};
	return { server, call, fake, audits, bodies, manager };
}
const start = { action: "start", provider: "openai-codex" };
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("POST /api/admin/config/signin", () => {
	it("relays the link, takes the answer, and reports success", async () => {
		const { server, call, fake, audits } = await daemon();
		const started = await call(server.token, start);
		expect(started.status).toBe(200);
		const state = started.json();
		expect(Value.Check(SignInStateSchema, state)).toBe(true);
		expect(state.status).toBe("running");
		// The unsafe link is dropped, with a note in its place; the https link is relayed.
		expect(state.events).toEqual([
			{ type: "auth_url", url: "https://example.com/authorize?state=1", instructions: "Sign in" },
			expect.objectContaining({ type: "progress", message: expect.stringContaining("cannot be shown") }),
		]);
		const polled = (await call(server.token, { action: "status", provider: "openai-codex" })).json();
		expect(polled.prompt?.type).toBe("manual_code");

		const stale = await call(server.token, {
			action: "answer",
			provider: "openai-codex",
			promptId: "nope",
			value: "x",
		});
		expect(stale.status).toBe(409);
		const answered = await call(server.token, {
			action: "answer",
			provider: "openai-codex",
			promptId: polled.prompt?.id,
			value: "the-code",
		});
		expect(answered.status).toBe(200);
		await tick();
		expect(fake.control.answer).toBe("the-code");
		fake.control.finish(true);
		await tick();
		expect((await call(server.token, { action: "status", provider: "openai-codex" })).json().status).toBe("succeeded");
		// The stale answer above is audited too, as refused; this checks the sign-in itself.
		expect(audits.filter((entry) => entry.outcome !== "refused")).toEqual([
			expect.objectContaining({ action: "credential.signin", outcome: "ok", target: "openai-codex" }),
		]);
	});

	it("cancels a running sign-in and allows a new one afterwards", async () => {
		const { server, call, audits } = await daemon();
		await call(server.token, start);
		const cancelled = await call(server.token, { action: "cancel", provider: "openai-codex" });
		expect(cancelled.json().status).toBe("cancelled");
		expect(audits[0]?.errorCode).toBe("cancelled");
		expect((await call(server.token, start)).json().status).toBe("running");
	});

	it("reports a failure without quoting a token", async () => {
		const { server, call, fake, bodies } = await daemon();
		await call(server.token, start);
		fake.control.finish(false);
		await tick();
		const failed = (await call(server.token, { action: "status", provider: "openai-codex" })).json();
		expect(failed.status).toBe("failed");
		expect(failed.error).toContain("token exchange failed");
		expect(bodies.join("\n")).not.toContain(TOKEN_TEXT);
	});

	it("runs one sign-in per provider and refuses a provider without account sign-in", async () => {
		const { server, call } = await daemon({ offers: (provider) => provider !== "plain" });
		await call(server.token, start);
		const second = await call(server.token, start);
		expect(second.status).toBe(409);
		expect((await call(server.token, { action: "start", provider: "plain" })).status).toBe(400);
	});

	it("stops a sign-in after its lifetime", async () => {
		const { server, call } = await daemon({ lifetimeMs: 30 });
		await call(server.token, start);
		await new Promise((resolve) => setTimeout(resolve, 80));
		const state = (await call(server.token, { action: "status", provider: "openai-codex" })).json();
		expect(state.status).toBe("failed");
		expect(state.error).toContain("too long");
	});

	it("accepts only the launch token and a valid command", async () => {
		const { server, call } = await daemon();
		expect((await call(server.remoteToken, start)).status).toBe(403);
		expect((await call(server.viewToken, start)).status).toBe(403);
		expect((await call("wrong", start)).status).toBe(401);
		expect((await call(server.token, { action: "start", provider: "Bad Id" })).status).toBe(400);
		expect((await call(server.token, { action: "answer", provider: "openai-codex" })).status).toBe(400);
	});
});

describe("sign-in hardening", () => {
	const never = () => new Promise<void>(() => {});

	it("abandons a login that ignores cancel, so a new sign-in can start", async () => {
		const { server, call } = await daemon({ login: never, abortGraceMs: 30 });
		await call(server.token, start);
		expect((await call(server.token, { action: "cancel", provider: "openai-codex" })).json().status).toBe("running");
		await new Promise((resolve) => setTimeout(resolve, 80));
		expect((await call(server.token, { action: "status", provider: "openai-codex" })).json().status).toBe("cancelled");
		expect((await call(server.token, start)).status).toBe(200);
	});

	it("refuses to start once the manager is closing", async () => {
		const { server, call, manager } = await daemon();
		manager.closeAll();
		expect((await call(server.token, start)).status).toBe(503);
	});

	it("audits refused starts and stale answers with a fixed code", async () => {
		const { server, call, audits } = await daemon({ offers: (provider) => provider !== "plain" });
		await call(server.token, start);
		await call(server.token, start);
		await call(server.token, { action: "start", provider: "plain" });
		await call(server.token, { action: "answer", provider: "openai-codex", promptId: "nope", value: "x" });
		expect(audits.filter((entry) => entry.outcome === "refused").map((entry) => entry.errorCode)).toEqual([
			"busy",
			"unsupported",
			"stale",
		]);
	});

	it("redacts a pasted code that a failing login quotes back", async () => {
		const pasted = "Zk3pQ9vLm2Xc7Rt5Yb8Nd4";
		const login = async (_provider: string, interaction: AuthInteraction) => {
			const code = await interaction.prompt({ type: "manual_code", message: "Paste the code" });
			throw new Error(`exchange rejected code ${code}`);
		};
		const { server, call, bodies } = await daemon({ login });
		await call(server.token, start);
		await tick();
		const prompt = (await call(server.token, { action: "status", provider: "openai-codex" })).json().prompt;
		await call(server.token, { action: "answer", provider: "openai-codex", promptId: prompt?.id, value: pasted });
		await tick();
		const failed = (await call(server.token, { action: "status", provider: "openai-codex" })).json();
		expect(failed.status).toBe("failed");
		expect(failed.error).toContain("exchange rejected code");
		expect(bodies.join("\n")).not.toContain(pasted);
	});

	it("says the credential was saved when only the follow-up step failed", async () => {
		const login = async () => {
			throw new CredentialSynchronizationError("openai-codex", "login", undefined, { cause: new Error("refresh") });
		};
		const { server, call } = await daemon({ login });
		await call(server.token, start);
		await tick();
		const state = (await call(server.token, { action: "status", provider: "openai-codex" })).json();
		expect(state.status).toBe("failed");
		expect(state.credentialSaved).toBe(true);
		expect(state.error).toContain("credential was saved");
	});
});

describe("config snapshot sign-in methods", () => {
	it("names the sign-ins and the key page, without any credential", async () => {
		const { env } = isolatedEnv();
		const snapshot = await buildConfigSnapshot({ agentDir: "/nonexistent-agent-dir", keychain: null, env });
		const openai = snapshot.providers.find((row) => row.provider === "openai");
		expect(openai?.auth?.oauth?.isSubscription).toBe(true);
		expect(openai?.auth?.keyAuth?.keyPage).toMatch(/^https:\/\//);
	});
});
