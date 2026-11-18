import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { executeBashWithOperations } from "../src/core/bash-executor.ts";
import type { ToolContext } from "../src/core/features/types.ts";
import {
	type BashOperations,
	createBashTool,
	createBashToolDefinition,
	createLocalBashOperations,
} from "../src/core/tools/bash.ts";
import * as shellModule from "../src/utils/shell.ts";

const bashTool = createBashTool(process.cwd());

// Helper to extract text from content blocks
function getTextOutput(result: any): string {
	return (
		result.content
			?.filter((c: any) => c.type === "text")
			.map((c: any) => c.text)
			.join("\n") || ""
	);
}

/** The result text without its first line, the `[exit 0 · 1s · 3 lines · 12 B]` header. */
function bodyOf(result: any): string {
	return getTextOutput(result).replace(/^\[[^\n]*\]\n?/, "");
}

describe("Coding Agent Tools", () => {
	let testDir: string;

	beforeEach(() => {
		// Create a unique temporary directory for each test
		testDir = join(tmpdir(), `coding-agent-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		vi.restoreAllMocks();
		// Clean up test directory
		rmSync(testDir, { recursive: true, force: true });
	});

	describe("bash tool", () => {
		it("should execute simple commands", async () => {
			const result = await bashTool.execute("test-call-8", { command: "echo 'test output'" });

			expect(getTextOutput(result)).toContain("test output");
			expect(result.details).toMatchObject({ output: "test output\n", exitCode: 0 });
		});

		it("should report non-zero exit codes as error results with structured content", async () => {
			const result = await bashTool.execute("test-call-9", { command: "echo out; exit 3" });
			expect(result.isError).toBe(true);
			expect(getTextOutput(result)).toMatch(/^\[exit 3 · [\d.]+s · 1 line · 4 B\]\nout\n$/);
			expect(getTextOutput(result)).not.toContain("Command exited");
			expect(result.structuredContent).toEqual({
				output: "out\n",
				truncated: false,
				exit_code: 3,
				wall_time_seconds: expect.any(Number),
				total_lines: 1,
				total_bytes: 4,
			});

			const ok = await bashTool.execute("test-call-9b", { command: "echo fine" });
			expect(ok.isError).toBeUndefined();
			expect(ok.structuredContent).toMatchObject({ output: "fine\n", exit_code: 0 });

			const empty = await bashTool.execute("test-call-9c", { command: "true" });
			expect(getTextOutput(empty)).toMatch(/^\[exit 0 · [\d.]+s · no output\]$/);
			expect(empty.structuredContent).toMatchObject({ output: "", truncated: false, total_lines: 0, total_bytes: 0 });
		});

		it("should return up to 1 MiB of output in structured content", async () => {
			// 3000 lines exceed the model-facing 600 line limit but not 1 MiB.
			const medium = await bashTool.execute("test-call-9d", { command: "seq 1 3000" });
			expect(getTextOutput(medium)).toContain("lines elided");
			expect(getTextOutput(medium)).not.toContain("\n1500\n");
			expect(medium.structuredContent).toMatchObject({ total_lines: 3000, total_bytes: 13893 });
			expect(medium.details?.truncation?.truncated).toBe(true);
			const mediumOutput = medium.structuredContent as { output: string; truncated: boolean };
			expect(mediumOutput.truncated).toBe(false);
			expect(mediumOutput.output).toBe(`${Array.from({ length: 3000 }, (_, i) => i + 1).join("\n")}\n`);

			// About 2 MB: keeps the first and last 512 KiB around an omission marker.
			const large = await bashTool.execute("test-call-9e", { command: "seq 1 300000" });
			const largeOutput = large.structuredContent as {
				output: string;
				truncated: boolean;
				full_output_path?: string;
			};
			expect(largeOutput.truncated).toBe(true);
			expect(largeOutput.output.startsWith("1\n2\n3\n")).toBe(true);
			expect(largeOutput.output.endsWith("299999\n300000\n")).toBe(true);
			expect(largeOutput.output).toMatch(/\n\n\[\.\.\. \d+ bytes omitted \.\.\.\]\n\n/);
			expect(Buffer.byteLength(largeOutput.output)).toBeLessThan(1024 * 1024 + 100);
			expect(largeOutput.full_output_path).toBe(large.details?.fullOutputPath);
			expect(readFileSync(largeOutput.full_output_path!, "utf-8").endsWith("300000\n")).toBe(true);
		});

		it.skipIf(process.platform === "win32")(
			"should map signal-killed commands to 128 plus the signal number",
			async () => {
				const operations = createLocalBashOperations();
				for (const { signal, exitCode } of [
					{ signal: "KILL", exitCode: 137 },
					{ signal: "TERM", exitCode: 143 },
				]) {
					const result = await operations.exec(`kill -${signal} $$`, testDir, { onData: () => {} });
					expect(result.exitCode).toBe(exitCode);
				}
			},
		);

		it.skipIf(process.platform === "win32")(
			"should report signal-killed commands as errors while preserving partial output",
			async () => {
				for (const { signal, exitCode } of [
					{ signal: "KILL", exitCode: 137 },
					{ signal: "TERM", exitCode: 143 },
				]) {
					const result = await bashTool.execute(`test-call-signal-${signal}`, {
						command: `printf 'before-kill\\n'; kill -${signal} $$`,
					});
					expect(result.isError).toBe(true);
					expect(getTextOutput(result)).toMatch(
						new RegExp(`^\\[exit ${exitCode} · [\\d.]+s · 1 line · 12 B\\]\\nbefore-kill\\s*$`),
					);
				}
			},
		);

		it("should reject a null exit code from custom operations", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from("partial\n", "utf-8"));
					return { exitCode: null };
				},
			};
			const bash = createBashTool(testDir, { operations });

			await expect(bash.execute("test-call-null-exit", { command: "remote" })).rejects.toThrow(
				/^\[terminated \(no exit code\) · [\d.]+s · 1 line · 8 B\]\npartial\s*$/,
			);
		});

		it("should respect timeout", async () => {
			const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`;
			await expect(bashTool.execute("test-call-10", { command, timeout: 0.05 })).rejects.toThrow(/timed out/i);
		});

		it("should include full output path for truncated timeout and abort errors", async () => {
			for (const testCase of [
				{ error: "timeout:5", expected: "[timed out after 5s · 3,000 lines" },
				{ error: "aborted", expected: "[aborted · " },
			]) {
				const operations: BashOperations = {
					exec: async (_command, _cwd, { onData }) => {
						for (let i = 1; i <= 3000; i++) {
							onData(Buffer.from(`${i}\n`, "utf-8"));
						}
						throw new Error(testCase.error);
					},
				};
				const bash = createBashTool(testDir, { operations });

				let error: unknown;
				try {
					await bash.execute(`test-call-${testCase.error}`, { command: "chatty-fail" });
				} catch (err) {
					error = err;
				}

				expect(error).toBeInstanceOf(Error);
				const message = (error as Error).message;
				expect(message).toContain(testCase.expected);
				expect(message.split("\n")[0]).toMatch(/ · trimmed: first \d+ \+ last \d+ lines · full output: [^\]]+\]$/);
				expect(message).not.toContain("full output: undefined");
				const fullOutputPath = message.match(/full output: ([^\]\n]+)/)?.[1];
				expect(fullOutputPath).toBeDefined();
				expect(existsSync(fullOutputPath!)).toBe(true);
				const fullOutput = readFileSync(fullOutputPath!, "utf-8");
				expect(fullOutput).toContain("1\n2\n3");
				expect(fullOutput).toContain("2998\n2999\n3000");
			}
		});

		it("should throw error when cwd does not exist", async () => {
			const nonexistentCwd = "/this/directory/definitely/does/not/exist/12345";

			const bashToolWithBadCwd = createBashTool(nonexistentCwd);

			await expect(bashToolWithBadCwd.execute("test-call-11", { command: "echo test" })).rejects.toThrow(
				/Working directory does not exist/,
			);
		});

		it("should handle process spawn errors", async () => {
			vi.spyOn(shellModule, "getShellConfig").mockReturnValueOnce({
				shell: "/nonexistent-shell-path-xyz123",
				args: ["-c"],
			});

			const bashWithBadShell = createBashTool(testDir);

			await expect(bashWithBadShell.execute("test-call-12", { command: "echo test" })).rejects.toThrow(/ENOENT/);
		});

		it("should pass shellPath through to shell resolution", async () => {
			const getShellConfigSpy = vi.spyOn(shellModule, "getShellConfig");
			const bashWithCustomShell = createBashTool(testDir, {
				shellPath: "/custom/bash",
				operations: {
					exec: async () => ({ exitCode: 0 }),
				},
			});

			await bashWithCustomShell.execute("test-call-12b", { command: "echo test" });

			expect(getShellConfigSpy).not.toHaveBeenCalled();

			const ops = createLocalBashOperations({ shellPath: "/custom/bash" });
			await expect(
				ops.exec("echo test", testDir, {
					onData: () => {},
				}),
			).rejects.toThrow("Custom shell path not found: /custom/bash");
			expect(getShellConfigSpy).toHaveBeenCalledWith("/custom/bash");
		});

		it("should send commands over stdin when shell resolution requires it", async () => {
			vi.spyOn(shellModule, "getShellConfig").mockReturnValue({
				shell: process.execPath,
				args: [
					"-e",
					'let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (chunk) => { input += chunk; }); process.stdin.on("end", () => { process.stdout.write(input); });',
				],
				commandTransport: "stdin",
			});
			const chunks: Buffer[] = [];
			const ops = createLocalBashOperations({ shellPath: "C:\\Windows\\System32\\bash.exe" });
			const nameExpansion = "${name}";
			const countExpansion = "${count}";
			const iExpansion = "${i}";
			const command = `name='World'; echo "Hello, ${nameExpansion}!"; count=3; for i in $(seq 1 ${countExpansion}); do echo "Iteration ${iExpansion} of ${countExpansion}"; done`;

			const result = await ops.exec(command, testDir, {
				onData: (data) => chunks.push(data),
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8")).toBe(command);
		});

		it("should resolve legacy WSL bash.exe to stdin command transport", () => {
			if (process.platform === "win32") return;
			const originalCwd = process.cwd();
			const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
			const shellPath = "C:\\Windows\\System32\\bash.exe";
			writeFileSync(join(testDir, shellPath), "");
			try {
				process.chdir(testDir);
				Object.defineProperty(process, "platform", {
					configurable: true,
					value: "win32",
				});

				expect(shellModule.getShellConfig(shellPath)).toEqual({
					shell: shellPath,
					args: ["-s"],
					commandTransport: "stdin",
				});
			} finally {
				process.chdir(originalCwd);
				if (platformDescriptor) {
					Object.defineProperty(process, "platform", platformDescriptor);
				}
			}
		});

		it("should prepend command prefix when configured", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "export TEST_VAR=hello",
			});

			const result = await bashWithPrefix.execute("test-prefix-1", { command: "echo $TEST_VAR" });
			expect(bodyOf(result).trim()).toBe("hello");
		});

		it("should include output from both prefix and command", async () => {
			const bashWithPrefix = createBashTool(testDir, {
				commandPrefix: "echo prefix-output",
			});

			const result = await bashWithPrefix.execute("test-prefix-2", { command: "echo command-output" });
			expect(bodyOf(result).trim()).toBe("prefix-output\ncommand-output");
		});

		it("should work without command prefix", async () => {
			const bashWithoutPrefix = createBashTool(testDir, {});

			const result = await bashWithoutPrefix.execute("test-prefix-3", { command: "echo no-prefix" });
			expect(bodyOf(result).trim()).toBe("no-prefix");
		});

		it("should coalesce streaming updates for chatty output", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					for (let i = 0; i < 5000; i++) {
						onData(Buffer.from(`line ${i}\n`, "utf-8"));
					}
					return { exitCode: 0 };
				},
			};
			const updates: Array<{ content: Array<{ type: string; text?: string }>; details?: unknown }> = [];
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-chatty-updates", { command: "chatty" }, undefined, (update) =>
				updates.push(update),
			);

			expect(updates.length).toBeLessThan(25);
			expect(getTextOutput(result)).toContain("line 4999");
		});

		it("should not count a trailing newline as an extra truncated bash output line", async () => {
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					for (let i = 1; i <= 4000; i++) {
						onData(Buffer.from(`line-${String(i).padStart(4, "0")}\n`, "utf-8"));
					}
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-trailing-newline-line-count", { command: "many-lines" });
			const output = getTextOutput(result);

			expect(result.details?.truncation?.totalLines).toBe(4000);
			expect(result.details?.truncation?.outputLines).toBe(500);
			// The first 100 lines (20% of the 500 line budget) and the last 400 are shown; the 3500 between are elided.
			expect(result.details?.truncation).toMatchObject({ headLines: 100, tailLines: 400, elidedLines: 3500 });
			expect(output).toContain("line-0001");
			expect(output).toContain("line-0100");
			expect(output).not.toContain("line-0101");
			expect(output).not.toContain("line-3600");
			expect(output).toContain("line-3601");
			expect(output).toContain("line-4000");
			expect(output).toContain("\n[... 3500 lines elided]\n");
			expect(output.split("\n")[0]).toMatch(
				/^\[exit 0 · [\d.]+s · 4,000 lines · \d+ KB · trimmed: first 100 \+ last 400 lines · full output: \S+\]$/,
			);
			expect(output).not.toContain("4001");
		});

		it("should decode UTF-8 characters split across output chunks", async () => {
			const euro = Buffer.from("€\n", "utf-8");
			const operations: BashOperations = {
				exec: async (_command, _cwd, { onData }) => {
					onData(euro.subarray(0, 1));
					onData(euro.subarray(1));
					return { exitCode: 0 };
				},
			};
			const bash = createBashTool(testDir, { operations });

			const result = await bash.execute("test-call-split-utf8", { command: "split-utf8" });

			expect(bodyOf(result).trim()).toBe("€");
		});

		it("should expose local bash operations for extension reuse", async () => {
			const ops = createLocalBashOperations();
			const chunks: Buffer[] = [];

			const result = await ops.exec("echo $TEST_LOCAL_BASH_OPS", testDir, {
				onData: (data) => chunks.push(data),
				env: { ...process.env, TEST_LOCAL_BASH_OPS: "from-local-ops" },
			});

			expect(result.exitCode).toBe(0);
			expect(Buffer.concat(chunks).toString("utf-8").trim()).toBe("from-local-ops");
		});

		it("should preserve executeBash sanitization when using local bash operations", async () => {
			const result = await executeBashWithOperations(
				"printf '\\033[31mred\\033[0m\\r\\n'",
				process.cwd(),
				createLocalBashOperations(),
			);

			expect(result.exitCode).toBe(0);
			expect(result.output).toBe("red\n");
		});

		it("should leave terminal escape sequences out of the model's output, also when split across chunks", async () => {
			const bash = createBashTool(testDir);
			const result = await bash.execute("test-call-ansi", {
				command:
					"printf '\\033[94mblue\\033[0m \\033[?1049hscreen\\033]0;title\\007'; sleep 0.2; printf '\\033[3'; sleep 0.2; printf '1mred\\033[0m\\n'",
			});
			expect(bodyOf(result)).toBe("blue screenred\n");
			expect(result.structuredContent).toMatchObject({ output: expect.stringContaining("\u001b[94m") });
		});

		it("should show only the final state of a progress line redrawn with carriage returns", async () => {
			const bash = createBashTool(testDir);
			const result = await bash.execute("test-call-cr", {
				command: "printf '10%%\\r50%%\\r'; sleep 0.2; printf '100%%\\r\\ndone\\r\\n'",
			});
			expect(bodyOf(result)).toBe("100%\ndone\n");
			expect(result.structuredContent).toMatchObject({ output: "10%\r50%\r100%\r\ndone\r\n" });
		});

		it("should keep the first error and the final lines of long output", async () => {
			const bash = createBashTool(testDir);
			const result = await bash.execute("test-call-head-tail", {
				command: "echo 'error TS1005: first problem'; seq 1 5000; echo 'Found 1 error.'",
			});
			const output = getTextOutput(result);
			expect(bodyOf(result).startsWith("error TS1005: first problem\n1\n")).toBe(true);
			expect(output).toMatch(/\n\[\.\.\. \d+ lines elided\]\n/);
			expect(output).toContain("\n5000\nFound 1 error.");
			expect(output.split("\n")[0]).toMatch(/trimmed: first 100 \+ last 400 lines/);
			expect(result.details?.truncation).toMatchObject({ headLines: 100, totalLines: 5002 });
		});

		it("should persist full output when truncation happens by line count only", async () => {
			const bash = createBashTool(testDir);
			const result = await bash.execute("test-call-line-truncation", { command: "seq 3000" });
			const output = getTextOutput(result);
			const fullOutputPath = result.details?.fullOutputPath;

			expect(result.details?.truncation?.truncated).toBe(true);
			expect(result.details?.truncation?.truncatedBy).toBe("lines");
			expect(fullOutputPath).toBeDefined();
			expect(output.split("\n")[0]).toContain(`trimmed: first 100 + last 400 lines · full output: ${fullOutputPath}]`);

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});

		it("executeBash should persist full output when truncation happens by line count only", async () => {
			const result = await executeBashWithOperations("seq 3000", process.cwd(), createLocalBashOperations());
			const fullOutputPath = result.fullOutputPath;

			expect(result.truncated).toBe(true);
			expect(fullOutputPath).toBeDefined();

			for (let i = 0; i < 20 && (!fullOutputPath || !existsSync(fullOutputPath)); i++) {
				await new Promise((resolve) => setTimeout(resolve, 10));
			}

			expect(fullOutputPath).toBeDefined();
			expect(existsSync(fullOutputPath!)).toBe(true);
			const fullOutput = readFileSync(fullOutputPath!, "utf-8");
			expect(fullOutput).toContain("1\n2\n3");
			expect(fullOutput).toContain("2998\n2999\n3000");
		});
	});
});

function fakeCtx(cwd: string): ToolContext {
	return { cwd } as ToolContext;
}

describe("tool cwd resolution", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `coding-agent-cwd-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("bash uses ctx.cwd when provided", async () => {
		const tool = createBashToolDefinition("/", { exposeSessionEnvironment: false });
		const result = await tool.execute("test-bash-ctx-cwd", { command: "pwd" }, undefined, undefined, fakeCtx(testDir));
		const output = getTextOutput(result);
		expect(output).toContain(testDir);
	});
});
