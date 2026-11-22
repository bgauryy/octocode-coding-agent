import { describe, expect, test } from "vitest";
import {
	detectKeychain,
	KeychainCommandError,
	KeychainSecretTooLargeError,
	type KeychainRunner,
	type KeychainRunResult,
} from "../src/core/auth-storage/keychain.ts";

interface Call {
	file: string;
	args: string[];
	input?: string;
}

const SECRET = "sk-secret-ünïcode-123";

function recorder(result: KeychainRunResult = { code: 0, stderr: "" }) {
	const calls: Call[] = [];
	const run: KeychainRunner = async (file, args, input) => {
		calls.push({ file, args: [...args], input });
		return result;
	};
	return { calls, run };
}

const onPath = (name: string) => (name === "powershell.exe" ? "C:\\ps\\powershell.exe" : undefined);

function decode(args: string[]): string {
	return Buffer.from(args[args.indexOf("-EncodedCommand") + 1] as string, "base64").toString("utf16le");
}

describe("Windows Credential Manager backend", () => {
	test("detects powershell.exe, then pwsh.exe, else nothing", () => {
		expect(detectKeychain("win32", onPath)?.name).toBe("Windows Credential Manager");
		expect(detectKeychain("win32", (n) => (n === "pwsh.exe" ? "C:\\ps\\pwsh.exe" : undefined))?.name).toBe(
			"Windows Credential Manager",
		);
		expect(detectKeychain("win32", () => undefined)).toBeUndefined();
	});

	test("store sends the secret on stdin only", async () => {
		const { calls, run } = recorder();
		await detectKeychain("win32", onPath, run)?.store("openai", SECRET);
		const [call] = calls;
		expect(calls).toHaveLength(1);
		expect(call?.file).toBe("C:\\ps\\powershell.exe");
		expect(call?.args.slice(0, 2)).toEqual(["-NoProfile", "-NonInteractive"]);
		expect(call?.input).toBe(SECRET);
		const script = decode(call?.args ?? []);
		expect(script).toContain("CredWriteW");
		expect(script).toContain("octocode/openai");
		expect(JSON.stringify(call?.args)).not.toContain(SECRET);
		expect(script).not.toContain(SECRET);
	});

	test("reference reads the entry without containing a secret", () => {
		const backend = detectKeychain("win32", onPath);
		const ref = backend?.referenceFor("openai") ?? "";
		expect(ref.startsWith("!powershell.exe -NoProfile -NonInteractive -EncodedCommand ")).toBe(true);
		expect(decode(ref.split(" "))).toContain("CredReadW");
		expect(backend?.isOwnReference(ref, "openai")).toBe(true);
		expect(backend?.isOwnReference(ref, "anthropic")).toBe(false);
	});

	test("remove deletes the target and treats not-found as success", async () => {
		const ok = recorder();
		await detectKeychain("win32", onPath, ok.run)?.remove("openai");
		expect(decode(ok.calls[0]?.args ?? [])).toContain("CredDeleteW");
		expect(ok.calls[0]?.input).toBeUndefined();
		await expect(
			detectKeychain("win32", onPath, recorder({ code: 44, stderr: "" }).run)?.remove("openai"),
		).resolves.toBeUndefined();
	});

	test("real errors fail loudly and never echo store output", async () => {
		const backend = (r: KeychainRunResult) => detectKeychain("win32", onPath, recorder(r).run);
		await expect(backend({ code: 1, stderr: `denied ${SECRET}` })?.store("openai", SECRET)).rejects.toSatisfy(
			(e: unknown) => e instanceof KeychainCommandError && !e.message.includes(SECRET),
		);
		await expect(backend({ code: 1, stderr: "Access is denied" })?.remove("openai")).rejects.toThrow(
			/Access is denied/,
		);
		await expect(backend({ code: null, stderr: "" })?.remove("openai")).rejects.toBeInstanceOf(KeychainCommandError);
	});

	test("refuses a secret over the credential blob limit before running", async () => {
		const { calls, run } = recorder();
		await expect(detectKeychain("win32", onPath, run)?.store("openai", "x".repeat(2600))).rejects.toBeInstanceOf(
			KeychainSecretTooLargeError,
		);
		expect(calls).toHaveLength(0);
	});
});
