import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import { type BashExecutionMessage, convertToLlm } from "../src/core/messages.ts";
import type { BashOperations } from "../src/core/tools/bash.ts";
import { createHarness } from "./suite/harness.ts";

const printing = (text: string, exitCode: number | null = 0): BashOperations => ({
	exec: async (_command, _cwd, { onData }) => {
		onData(Buffer.from(text));
		return { exitCode };
	},
});

const seq = (count: number) => Array.from({ length: count }, (_, i) => `${i + 1}\n`).join("");

const textOf = (message: BashExecutionMessage): string => {
	const [converted] = convertToLlm([message]);
	const part = (converted?.content as { type: string; text: string }[] | undefined)?.[0];
	// The shape under test follows the source header line.
	return (part?.text ?? "").replace(/^\[src [^\n]*\n/, "");
};

it("gives a short result a header and leaves its output whole", async () => {
	const result = await executeBashWithOperations("echo", process.cwd(), printing("a\nb\nc\n"));
	expect(result).toMatchObject({ output: "a\nb\nc\n", exitCode: 0, truncated: false, totalLines: 3, totalBytes: 6 });
	expect(result.header).toMatch(/^\[exit 0 · \d+(\.\d)?s\]$/);
});

it("trims `seq 1 5000` to the bash tool's head and tail budget and says where the whole output is", async () => {
	const folder = mkdtempSync(join(tmpdir(), "user-shell-"));
	try {
		const result = await executeBashWithOperations("seq 1 5000", process.cwd(), printing(seq(5000)), {
			outputDir: folder,
		});
		expect(result.truncated).toBe(true);
		expect(result.header).toMatch(/^\[exit 0 · .*5,000 lines · .*trimmed: first 100 \+ last 400 lines · full output: /);
		expect(result.output.startsWith("1\n2\n")).toBe(true);
		expect(result.output.trimEnd().endsWith("\n4999\n5000")).toBe(true);
		expect(result.output).toMatch(/\[\.\.\. \d+ lines elided\]/);
		expect(result.output.split("\n").length).toBeLessThan(700);
		// The whole output moved into the folder and the header names it.
		expect(result.fullOutputPath?.startsWith(folder)).toBe(true);
		expect(existsSync(result.fullOutputPath!)).toBe(true);
		expect(readFileSync(result.fullOutputPath!, "utf8")).toBe(seq(5000));
	} finally {
		rmSync(folder, { recursive: true, force: true });
	}
});

it("keeps an error line from the elided middle", async () => {
	const text = `${seq(2000)}error TS2322: middle problem\n${seq(2000)}`;
	const result = await executeBashWithOperations("tsc", process.cwd(), printing(text, 1));
	expect(result.header).toMatch(/^\[exit 1 · .*\+ 1 matched/);
	expect(result.output).toMatch(/\d+: error TS2322: middle problem/);
});

it("shows a run of identical lines once", async () => {
	const result = await executeBashWithOperations("yes", process.cwd(), printing("same\n".repeat(3000)));
	expect(result.truncated).toBe(false);
	expect(result.output).toContain("[… repeated 3000×]");
});

it("respects the maxOutputBytes budget", async () => {
	const big = await executeBashWithOperations("seq", process.cwd(), printing(seq(500)));
	const small = await executeBashWithOperations("seq", process.cwd(), printing(seq(500)), {
		maxOutputBytes: 2048,
	});
	expect(big.truncated).toBe(false);
	expect(small.truncated).toBe(true);
	expect(Buffer.byteLength(small.output)).toBeLessThanOrEqual(2048);
	expect(small.header).toContain("trimmed:");
});

it("says when a command was cancelled or ended without an exit code", async () => {
	const killed = await executeBashWithOperations("x", process.cwd(), printing("partial\n", null));
	expect(killed.exitCode).toBeUndefined();
	expect(killed.header).toMatch(/^\[terminated \(no exit code\) · /);

	const controller = new AbortController();
	const cancelled = await executeBashWithOperations(
		"x",
		process.cwd(),
		{
			exec: async (_command, _cwd, { onData }) => {
				onData(Buffer.from("partial\n"));
				controller.abort();
				throw new Error("aborted");
			},
		},
		{ signal: controller.signal },
	);
	expect(cancelled).toMatchObject({ cancelled: true, exitCode: undefined, output: "partial\n" });
	expect(cancelled.header).toMatch(/^\[aborted · /);
});

it("streams chunks without colors and keeps carriage returns for the live view to fold", async () => {
	const chunks: string[] = [];
	await executeBashWithOperations("x", process.cwd(), printing("\u001b[31mred\u001b[0m\r\n10%\r20%\r30%"), {
		onChunk: (chunk) => chunks.push(chunk),
	});
	expect(chunks.join("")).toBe("red\r\n10%\r20%\r30%");
});

const base: BashExecutionMessage = {
	role: "bashExecution",
	command: "seq 1 5000",
	output: "1\n2\n",
	exitCode: 2,
	cancelled: false,
	truncated: true,
	fullOutputPath: "/tmp/full.log",
	timestamp: 1,
};

it("converts a message with a header to the bash tool's shape: header first, then the output", () => {
	const header = "[exit 2 · 1s · 5,000 lines · 24 KB · trimmed: first 1 + last 1 lines · full output: /tmp/full.log]";
	expect(textOf({ ...base, header })).toBe(`Ran \`seq 1 5000\`\n${header}\n\`\`\`\n1\n2\n\`\`\``);
	expect(textOf({ ...base, header, output: "" })).toBe(`Ran \`seq 1 5000\`\n${header}`);
});

it("converts a message recorded before headers existed as it always did", () => {
	expect(textOf(base)).toBe(
		"Ran `seq 1 5000`\n```\n1\n2\n\n```\n\nCommand exited with code 2\n\n[Output truncated. Full output: /tmp/full.log]",
	);
	expect(textOf({ ...base, output: "", truncated: false, exitCode: 0, cancelled: true })).toBe(
		"Ran `seq 1 5000`\n(no output)\n\n(command cancelled)",
	);
});

it("records the header for the model, honors the setting, and keeps !! output out of context", async () => {
	const harness = await createHarness({ settings: { bashOutputMaxBytes: 2048 } });
	try {
		const operations = printing(seq(3000));
		const shown = await harness.session.executeBash("seq 3000", undefined, { operations });
		expect(shown.truncated).toBe(true);
		expect(Buffer.byteLength(shown.output)).toBeLessThanOrEqual(2048);
		// The full output lives in the session's bash/ folder, like the bash tool's.
		expect(shown.fullOutputPath).toMatch(/[\\/]bash[\\/]octocode-bash-/);
		expect(shown.header).toContain("3,000 lines");

		await harness.session.executeBash("seq 3000 again", undefined, { operations, excludeFromContext: true });

		const messages = harness.session.messages.filter((m) => m.role === "bashExecution");
		expect(messages).toHaveLength(2);
		expect(messages[0]).toMatchObject({ header: shown.header, output: shown.output });
		expect(messages[1]).toMatchObject({ excludeFromContext: true });
		// The excluded one still shows its header to the user, but never reaches the model.
		expect(messages[1].header).toContain("trimmed:");
		const converted = convertToLlm(messages);
		expect(converted).toHaveLength(1);
		expect(JSON.stringify(converted)).toContain(shown.header!.slice(0, 7));
		expect(JSON.stringify(converted)).not.toContain("seq 3000 again");
	} finally {
		harness.cleanup();
	}
});
