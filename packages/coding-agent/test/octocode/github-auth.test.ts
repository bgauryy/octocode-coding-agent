import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
	describeGithubStatus,
	parseDeviceCode,
	runGithubAuth,
	type GithubAuthOptions,
} from "../../../mcp/src/presets/octocode/github-auth.ts";

const fixture = fileURLToPath(new URL("../fixtures/fake-octocode-auth.mjs", import.meta.url));

function options(mode = "ok", extra: Partial<GithubAuthOptions> = {}): GithubAuthOptions {
	return {
		invocation: { command: process.execPath, prefix: [fixture] },
		env: { ...process.env, FAKE_OCTOCODE_AUTH: mode },
		...extra,
	};
}

describe("parseDeviceCode", () => {
	it("reads the URL and code from the native device prompt", () => {
		expect(parseDeviceCode("Open https://github.com/login/device and enter code ABCD-1234")).toEqual({
			verificationUri: "https://github.com/login/device",
			userCode: "ABCD-1234",
		});
	});

	it("ignores other lines", () => {
		expect(parseDeviceCode("⚠ GITHUB_TOKEN is set and takes priority")).toBeUndefined();
	});
});

describe("runGithubAuth", () => {
	it("reports status, also when the CLI exits with the unauthenticated code", async () => {
		await expect(runGithubAuth("status", options())).resolves.toMatchObject({
			authenticated: true,
			username: "octo",
			tokenSource: "octocode-storage",
		});
		await expect(runGithubAuth("status", options("signed-out"))).resolves.toMatchObject({
			authenticated: false,
			tokenSource: "none",
		});
	});

	it("shows the device code, then resolves with the signed-in account", async () => {
		const onDeviceCode = vi.fn();
		const result = await runGithubAuth("login", options("ok", { onDeviceCode }));
		expect(onDeviceCode).toHaveBeenCalledWith({
			verificationUri: "https://github.com/login/device",
			userCode: "ABCD-1234",
		});
		expect(result).toMatchObject({ success: true, action: "login", username: "octo" });
	});

	it("interrupts a pending login when cancelled", async () => {
		const controller = new AbortController();
		const pending = runGithubAuth(
			"login",
			options("slow", { signal: controller.signal, onDeviceCode: () => controller.abort() }),
		);
		await expect(pending).rejects.toThrow("Login cancelled");
	});

	it("passes the CLI error message through", async () => {
		await expect(runGithubAuth("logout", options("error"))).rejects.toThrow("GitHub rejected the request");
		await expect(runGithubAuth("status", options("text"))).rejects.toThrow("native crash");
	});

	it("logs out", async () => {
		await expect(runGithubAuth("logout", options())).resolves.toMatchObject({
			loggedOut: true,
			hostname: "github.com",
		});
	});
});

describe("describeGithubStatus", () => {
	const base = { verification: "verified", hostname: "github.com" } as const;

	it("names the account and where its token comes from", () => {
		expect(
			describeGithubStatus({ ...base, authenticated: true, username: "octo", tokenSource: "octocode-storage" }),
		).toBe("GitHub: signed in as octo on github.com (Octocode login)");
		expect(describeGithubStatus({ ...base, authenticated: true, username: "octo", tokenSource: "env:GH_TOKEN" })).toBe(
			"GitHub: signed in as octo on github.com (GH_TOKEN)",
		);
		expect(describeGithubStatus({ ...base, authenticated: true, username: "octo", tokenSource: "gh-cli" })).toBe(
			"GitHub: signed in as octo on github.com (gh CLI)",
		);
	});

	it("says when the token could not be checked, was rejected, or is missing", () => {
		expect(
			describeGithubStatus({
				...base,
				verification: "unverified",
				authenticated: true,
				username: null,
				tokenSource: "gh-cli",
			}),
		).toBe("GitHub: token found on github.com (gh CLI), not verified: GitHub could not be reached");
		expect(
			describeGithubStatus({
				...base,
				verification: "invalid",
				authenticated: false,
				username: null,
				tokenSource: "env:GITHUB_TOKEN",
			}),
		).toBe("GitHub: GitHub rejected GITHUB_TOKEN. Fix or unset it; it takes priority over /github login.");
		expect(
			describeGithubStatus({
				...base,
				verification: "invalid",
				authenticated: false,
				username: null,
				tokenSource: "gh-cli",
			}),
		).toBe("GitHub: GitHub rejected the token from gh CLI. Run /github login.");
		expect(
			describeGithubStatus({
				...base,
				verification: "none",
				authenticated: false,
				username: null,
				tokenSource: "none",
			}),
		).toBe("GitHub: not signed in. Run /github login, or set GITHUB_TOKEN.");
	});
});
