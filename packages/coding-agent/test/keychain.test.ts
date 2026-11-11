import { describe, expect, test } from "vitest";
import {
	detectKeychain,
	isValidKeychainProviderId,
	KeychainSecretTooLargeError,
	type KeychainRunner,
	type KeychainRunResult,
} from "../src/core/auth-storage/keychain.ts";

interface Call {
	file: string;
	args: string[];
	input?: string;
}

function recorder(result: KeychainRunResult = { code: 0, stderr: "" }): { calls: Call[]; run: KeychainRunner } {
	const calls: Call[] = [];
	return {
		calls,
		run: async (file, args, input) => {
			calls.push({ file, args: [...args], input });
			return result;
		},
	};
}

const available = (name: string) => name;
const missing = () => undefined;

describe("detectKeychain", () => {
	test("uses /usr/bin/security on macOS", () => {
		const which = (name: string) => (name === "/usr/bin/security" ? name : undefined);
		expect(detectKeychain("darwin", which)?.name).toBe("macOS Keychain");
		expect(detectKeychain("darwin", missing)).toBeUndefined();
	});

	test("uses secret-tool on Linux only when it is on PATH", () => {
		const which = (name: string) => (name === "secret-tool" ? "/usr/bin/secret-tool" : undefined);
		expect(detectKeychain("linux", which)?.name).toBe("Secret Service");
		expect(detectKeychain("linux", missing)).toBeUndefined();
	});

	test("has no backend on Windows or other platforms", () => {
		expect(detectKeychain("win32", available)).toBeUndefined();
		expect(detectKeychain("freebsd", available)).toBeUndefined();
	});
});

describe("provider id validation", () => {
	test("accepts catalog ids and rejects shell metacharacters", () => {
		for (const id of ["opencode", "opencode-go", "llama.cpp", "amazon-bedrock", "qwen_2"]) {
			expect(isValidKeychainProviderId(id)).toBe(true);
		}
		for (const id of ["", "a;rm -rf", "a b", "$(id)", "a'b", "-flag", "A", "a\nb", "a`b`"]) {
			expect(isValidKeychainProviderId(id)).toBe(false);
		}
	});

	test("every operation refuses an invalid id before running a command", async () => {
		const { calls, run } = recorder();
		const keychain = detectKeychain("darwin", available, run);
		expect(keychain).toBeDefined();
		await expect(keychain?.store("a;rm -rf", "secret")).rejects.toThrow(/provider id/i);
		await expect(keychain?.remove("a;rm -rf")).rejects.toThrow(/provider id/i);
		expect(() => keychain?.referenceFor("a;rm -rf")).toThrow(/provider id/i);
		expect(keychain?.isOwnReference("!x", "a;rm -rf")).toBe(false);
		expect(calls).toEqual([]);
	});
});

describe("macOS backend", () => {
	test("stores through `security -i` with the secret only on stdin", async () => {
		const { calls, run } = recorder();
		const keychain = detectKeychain("darwin", available, run);
		await keychain?.store("opencode", "sk-secret-123");
		expect(calls).toHaveLength(1);
		expect(calls[0].file).toBe("/usr/bin/security");
		expect(calls[0].args).toEqual(["-i"]);
		expect(calls[0].args.join(" ")).not.toContain("sk-secret-123");
		expect(calls[0].input).toBe('add-generic-password -U -s octocode -a opencode -w "sk-secret-123"\n');
	});

	test("escapes quotes and backslashes in the secret", async () => {
		const { calls, run } = recorder();
		await detectKeychain("darwin", available, run)?.store("opencode", 'a"b\\c');
		expect(calls[0].input).toBe('add-generic-password -U -s octocode -a opencode -w "a\\"b\\\\c"\n');
	});

	test("rejects secrets that could end the command line", async () => {
		const { calls, run } = recorder();
		const keychain = detectKeychain("darwin", available, run);
		await expect(keychain?.store("opencode", "abc\ndelete-generic-password")).rejects.toThrow(/control/i);
		await expect(keychain?.store("opencode", "")).rejects.toThrow(/empty/i);
		expect(calls).toEqual([]);
	});

	test("a failed write reports the exit code but never the secret", async () => {
		const { run } = recorder({ code: 1, stderr: "User interaction is not allowed." });
		const keychain = detectKeychain("darwin", available, run);
		const error = await keychain?.store("opencode", "sk-secret-123").catch((cause: Error) => cause);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toBe("macOS Keychain could not store the key (exit code 1)");
		expect((error as Error).message).not.toContain("sk-secret-123");
	});

	test("failed writes never expose echoed escaped key input", async () => {
		const keychain = detectKeychain("darwin", available, async (_file, _args, input) => ({
			code: 1,
			stderr: `Could not parse ${input}`,
		}));
		const error = await keychain?.store("opencode", 'fixture-secret-"quoted"').catch((cause: Error) => cause);
		expect((error as Error).message).toBe("macOS Keychain could not store the key (exit code 1)");
		expect((error as Error).message).not.toContain("fixture-secret");
	});

	test("removes an entry and ignores not-found", async () => {
		const ok = recorder();
		await detectKeychain("darwin", available, ok.run)?.remove("opencode");
		expect(ok.calls[0]).toEqual({
			file: "/usr/bin/security",
			args: ["delete-generic-password", "-s", "octocode", "-a", "opencode"],
			input: undefined,
		});
		const notFound = recorder({ code: 44, stderr: "could not be found" });
		await expect(detectKeychain("darwin", available, notFound.run)?.remove("opencode")).resolves.toBeUndefined();
		const denied = recorder({ code: 1, stderr: "denied" });
		await expect(detectKeychain("darwin", available, denied.run)?.remove("opencode")).rejects.toThrow(/denied/);
	});

	test("builds a reference that reads the entry back", () => {
		const keychain = detectKeychain("darwin", available, recorder().run);
		expect(keychain?.referenceFor("opencode-go")).toBe(
			"!/usr/bin/security find-generic-password -s octocode -a opencode-go -w",
		);
	});
});

describe("Linux backend", () => {
	const which = (name: string) => (name === "secret-tool" ? "/usr/bin/secret-tool" : undefined);

	test("stores through secret-tool with the secret only on stdin", async () => {
		const { calls, run } = recorder();
		await detectKeychain("linux", which, run)?.store("opencode", "sk-secret-123");
		expect(calls).toEqual([
			{
				file: "secret-tool",
				args: ["store", "--label=octocode opencode", "service", "octocode", "account", "opencode"],
				input: "sk-secret-123",
			},
		]);
		expect(calls[0].args.join(" ")).not.toContain("sk-secret-123");
	});

	test("removes an entry and builds a lookup reference", async () => {
		const { calls, run } = recorder();
		const keychain = detectKeychain("linux", which, run);
		await keychain?.remove("opencode");
		expect(calls[0].args).toEqual(["clear", "service", "octocode", "account", "opencode"]);
		expect(keychain?.referenceFor("opencode")).toBe("!secret-tool lookup service octocode account opencode");
	});
});

describe("own references", () => {
	test("matches only the exact reference for the same provider", () => {
		const keychain = detectKeychain("darwin", available, recorder().run);
		const reference = keychain?.referenceFor("opencode") ?? "";
		expect(keychain?.isOwnReference(reference, "opencode")).toBe(true);
		expect(keychain?.isOwnReference(reference, "opencode-go")).toBe(false);
		expect(keychain?.isOwnReference(`${reference}; echo hi`, "opencode")).toBe(false);
		expect(keychain?.isOwnReference("!security find-generic-password -ws 'opencode'", "opencode")).toBe(false);
		expect(keychain?.isOwnReference("sk-plain", "opencode")).toBe(false);
		expect(keychain?.isOwnReference(undefined, "opencode")).toBe(false);
	});
});

describe("macOS write size", () => {
	test("refuses a secret longer than one `security -i` line before running anything; a long API key still fits", async () => {
		const { calls, run } = recorder();
		const keychain = detectKeychain("darwin", available, run)!;
		await expect(keychain.store("openai", "x".repeat(4000))).rejects.toBeInstanceOf(KeychainSecretTooLargeError);
		expect(calls).toEqual([]);
		await keychain.store("openai", "x".repeat(3500));
		expect(calls).toHaveLength(1);
	});
});
