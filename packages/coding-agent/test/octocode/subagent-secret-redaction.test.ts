import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type * as NativeConfig from "../../src/config.ts";
import { clearSecretValues, registerSecretValue } from "@octocodeai/octocode-common/sanitize";
import type { ChildProgress } from "../../src/octocode/subagents/events.ts";
import type { ChildNotices } from "../../src/octocode/subagents/notices.ts";
import { runSubagent, STARTUP_RETRY_ENV } from "../../src/octocode/subagents/process.ts";
import { tmp } from "./helpers.ts";

vi.mock("../../src/config.ts", async (original) => ({
	...(await original<typeof NativeConfig>()),
	getCliInvocation: () => ({ command: process.execPath, prefix: [process.argv[1]] }),
}));

/** Opaque on purpose: no pattern recognizes it, so only a registered value can be removed. */
const KEY = "synthetic0123456789abcdef0123456789";
const FIXTURE = path.join(path.dirname(new URL(import.meta.url).pathname), "subagent-secret-host.cjs");
const savedArgv = process.argv[1];
const savedEnv = { ...process.env };

beforeAll(() => {
	const root = tmp("octocode-secret-");
	process.env.OCTOCODE_HOME = path.join(root, "home");
	process.env.OCTOCODE_TEST_KEY = KEY;
	for (const name of ["OCTOCODE_SUBAGENT", "OCTOCODE_AGENT_ID", "OCTOCODE_PARENT_ID", STARTUP_RETRY_ENV])
		delete process.env[name];
	const bin = path.join(root, "bin");
	fs.mkdirSync(bin);
	fs.copyFileSync(FIXTURE, path.join(bin, "octocode"));
	process.argv[1] = path.join(bin, "octocode");
	registerSecretValue(KEY);
});

afterAll(() => {
	clearSecretValues();
	process.argv[1] = savedArgv!;
	process.env = savedEnv;
});

async function run(task: string, scratch: string) {
	const notices: ChildNotices[] = [];
	const onProgress = (update: ChildProgress) => {
		if (update.notices) notices.push(update.notices);
		return undefined;
	};
	const id = `a-${task.replace(/\W+/g, "-")}`;
	const result = await runSubagent({
		task,
		args: ["--session-dir", tmp(), "--session-id", id],
		cwd: tmp(),
		identity: { id, scratch },
		onProgress,
	}).then(
		(outcome) => ({ outcome, error: undefined as Error | undefined }),
		(error: Error) => ({ outcome: undefined, error }),
	);
	return { ...result, notices: notices.at(-1) };
}

const everyFile = (scratch: string) =>
	fs
		.readdirSync(scratch)
		.map((name) => fs.readFileSync(path.join(scratch, name), "utf8"))
		.join("\n");

describe("a credential in a child's failure", () => {
	it("is not in the error or in stderr.txt, even when it arrives split across two writes", async () => {
		const scratch = tmp();
		const { error } = await run("split stderr", scratch);
		const saved = fs.readFileSync(path.join(scratch, "stderr.txt"), "utf8");
		expect(error?.message).toContain("second echo [redacted] end");
		expect(saved).toContain("first echo [redacted]");
		expect(saved).toContain("second echo [redacted] end");
		expect(saved).toContain("diagnostic line 300 of the noisy child");
		for (const text of [error?.message ?? "", saved]) {
			expect(text).not.toContain(KEY);
			expect(text).not.toContain(KEY.slice(14));
		}
	});

	it("is not in a startup failure's reason or its saved stderr", async () => {
		const scratch = tmp();
		const { error } = await run("startup key", scratch);
		expect(error?.message).toMatch(
			/^Subagent failed \(startup\): exited with code 2 before its first model turn: Error: No API key/,
		);
		expect(error?.message).not.toContain(KEY);
		expect(everyFile(scratch)).not.toContain(KEY);
	});

	it("is not in the failed turn's error, the notices the parent sees, or notices.txt", async () => {
		const scratch = tmp();
		const { outcome, notices } = await run("failed turn", scratch);
		expect(outcome?.error).toBe("401 rejected [redacted]");
		expect(notices?.file).toBe(path.join(scratch, "notices.txt"));
		expect(JSON.stringify({ outcome, notices })).not.toContain(KEY);
		const saved = fs.readFileSync(path.join(scratch, "notices.txt"), "utf8");
		expect(saved).toContain("error: provider said: Incorrect API key provided: [redacted]");
		expect(everyFile(scratch)).not.toContain(KEY);
	});
});
