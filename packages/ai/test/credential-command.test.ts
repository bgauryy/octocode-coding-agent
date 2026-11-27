import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	clearCredentialCommandCache,
	CredentialCommandError,
	forgetCredentialCommand,
	runCredentialCommand,
} from "../src/utils/credential-command.ts";

const node = process.execPath;
let dir: string;

/** A command that counts its runs in a file and prints `key-<run>`. */
function countingCommand(ttlMs?: number) {
	const counter = join(dir, "runs");
	const script = `const fs=require("fs");const p=${JSON.stringify(counter)};const n=(fs.existsSync(p)?Number(fs.readFileSync(p,"utf8")):0)+1;fs.writeFileSync(p,String(n));process.stdout.write(" key-"+n+"\\n")`;
	return { spec: { command: node, args: ["-e", script], ...(ttlMs === undefined ? {} : { ttlMs }) }, counter };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "octocode-credential-command-"));
	clearCredentialCommandCache();
});

afterEach(() => {
	clearCredentialCommandCache();
	rmSync(dir, { recursive: true, force: true });
});

describe("runCredentialCommand", () => {
	it("returns trimmed stdout and passes arguments without a shell", async () => {
		const key = await runCredentialCommand({
			command: node,
			args: ["-e", "process.stdout.write(process.argv[1])", "$HOME;echo `x`"],
		});
		expect(key).toBe("$HOME;echo `x`");
	});

	it("reuses the key for ttlMs, runs again after forget, and never caches with ttlMs 0", async () => {
		const { spec, counter } = countingCommand();
		expect(await runCredentialCommand(spec)).toBe("key-1");
		expect(await runCredentialCommand(spec)).toBe("key-1");
		forgetCredentialCommand(spec);
		expect(await runCredentialCommand(spec)).toBe("key-2");
		expect(readFileSync(counter, "utf8")).toBe("2");

		const uncached = { ...spec, ttlMs: 0 };
		clearCredentialCommandCache();
		await runCredentialCommand(uncached);
		await runCredentialCommand(uncached);
		expect(readFileSync(counter, "utf8")).toBe("4");
	});

	it("expires a cached key after ttlMs", async () => {
		const { spec } = countingCommand(30);
		expect(await runCredentialCommand(spec)).toBe("key-1");
		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(await runCredentialCommand(spec)).toBe("key-2");
	});

	it("shares one run between concurrent callers", async () => {
		const { spec, counter } = countingCommand();
		const keys = await Promise.all([runCredentialCommand(spec), runCredentialCommand(spec)]);
		expect(keys).toEqual(["key-1", "key-1"]);
		expect(readFileSync(counter, "utf8")).toBe("1");
	});

	// The child runs 10 s, past the test timeout: only the 200 ms limit can end this test in time.
	it("fails a command that outlives timeoutMs", async () => {
		const run = runCredentialCommand({ command: node, args: ["-e", "setTimeout(() => {}, 10000)"], timeoutMs: 200 });
		await expect(run).rejects.toMatchObject({ failure: "timeout", message: expect.stringContaining("200 ms") });
	});

	it("names the exit status and the first stderr line, with credentials redacted and no stdout", async () => {
		const error = await runCredentialCommand({
			command: node,
			args: [
				"-e",
				'process.stdout.write("partial-stdout-value");console.error("vault: token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 expired");console.error("second line");process.exit(3)',
			],
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(CredentialCommandError);
		const { message, status } = error as CredentialCommandError;
		expect(status).toBe(3);
		expect(message).toContain("exited with status 3");
		expect(message).toContain("vault: token [redacted] expired");
		expect(message).not.toContain("sk-ant-api03");
		expect(message).not.toContain("second line");
		expect(message).not.toContain("partial-stdout-value");
	});

	it("hides a token in a format no rule knows, and keeps an ordinary cause readable", async () => {
		const failWith = (text: string) =>
			runCredentialCommand({
				command: node,
				args: ["-e", `console.error(${JSON.stringify(text)});process.exit(1)`],
			}).catch((caught: unknown) => (caught as Error).message);
		const unknown = await failWith("vault rejected zK9fQ2mX7vL4pR8sT1wY6bN3cD5 for this user");
		expect(unknown).toContain("vault rejected [redacted] for this user");
		expect(unknown).not.toContain("zK9fQ2mX7vL4");
		expect(
			await failWith("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain."),
		).toContain(
			"exited with status 1: security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
		);
		expect(await failWith("item not found at /usr/local/share/credentials/store")).toContain(
			"item not found at /usr/local/share/credentials/store",
		);
	});

	it("never shows part of a secret that the stderr cap cut", async () => {
		// Blank lines up to the 4096-character cap, then a key whose tail comes in a later chunk the capture drops.
		const script = [
			`process.stderr.write("\\n".repeat(4090) + "token sk-ant-api03-abc");`,
			`setTimeout(() => { process.stderr.write("defghijklmnopqrstuvwxyz0123456789\\n"); process.exit(2); }, 50);`,
		].join("");
		const error = await runCredentialCommand({ command: node, args: ["-e", script] }).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(CredentialCommandError);
		const { message } = error as CredentialCommandError;
		expect(message).toContain("exited with status 2");
		expect(message).toContain(": token");
		expect(message).not.toMatch(/sk-|api03/);
	});

	it("reports a missing program and empty output, and does not cache failures", async () => {
		await expect(runCredentialCommand({ command: join(dir, "no-such-program") })).rejects.toMatchObject({
			failure: "spawn",
			message: expect.stringContaining("program not found"),
		});
		const empty = { command: node, args: ["-e", ""] };
		await expect(runCredentialCommand(empty)).rejects.toMatchObject({ failure: "empty" });
		await expect(runCredentialCommand(empty)).rejects.toMatchObject({ failure: "empty" });
	});
});
