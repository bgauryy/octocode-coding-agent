import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { getApplicationPort } from "../src/core/application/index.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { createHarness } from "./suite/harness.ts";

it("retains complete trusted shell output through completion and a JSON session restore", async () => {
	const harness = await createHarness();
	let service = getApplicationPort(harness.session);
	let outputPath: string | undefined;
	try {
		const original = `BEGIN ORIGINAL\n${"middle output\n".repeat(15000)}END ORIGINAL\n`;
		const result = await harness.session.executeBash("large output", undefined, {
			operations: {
				exec: async (_command, _cwd, { onData }) => {
					onData(Buffer.from(original));
					return { exitCode: 0 };
				},
			},
		});
		outputPath = result.fullOutputPath;
		expect(result.truncated).toBe(true);
		const stored = harness.session.messages.find((message) => message.role === "bashExecution")!;
		expect(stored).toMatchObject({ fullOutput: original });
		expect(JSON.stringify(convertToLlm([stored]))).not.toContain("BEGIN ORIGINAL");
		const output = service.history().messages.find((message) => message.role === "bashExecution")?.content?.[1];
		if (output?.type !== "text" || !output.full) throw new Error("Expected complete output asset");
		expect(service.readAsset(output.full.id)?.data).toBe(original);
		service.dispose();
		harness.session.agent.state.messages = JSON.parse(JSON.stringify(harness.session.messages));
		service = getApplicationPort(harness.session);
		const restored = service.history().messages.find((message) => message.role === "bashExecution")?.content?.[1];
		if (restored?.type !== "text" || !restored.full) throw new Error("Expected restored complete output asset");
		expect(service.readAsset(restored.full.id)?.data).toBe(original);
	} finally {
		service.dispose();
		harness.cleanup();
		if (outputPath) rmSync(outputPath, { force: true });
	}
});

it("does not grant imported output paths file-read authority and displays the unavailable full output", async () => {
	const harness = await createHarness();
	const directory = mkdtempSync(join(tmpdir(), "application-untrusted-output-"));
	const path = join(directory, "private.txt");
	writeFileSync(path, "PRIVATE FILE CONTENT");
	const service = getApplicationPort(harness.session);
	try {
		harness.session.recordBashResult("imported", {
			output: "tail",
			exitCode: 0,
			cancelled: false,
			truncated: true,
			fullOutputPath: path,
		});
		const message = service.history().messages.find((item) => item.role === "bashExecution")!;
		expect(message.content?.at(-1)).toMatchObject({ type: "unsupported", providerType: "shell-output-unavailable" });
		expect(JSON.stringify(message)).not.toContain("PRIVATE FILE CONTENT");
		expect(service.readAsset(path)).toBeUndefined();
		expect(harness.session.messages.find((item) => item.role === "bashExecution")).toMatchObject({
			fullOutputUnavailable: expect.any(String),
		});
	} finally {
		service.dispose();
		harness.cleanup();
		rmSync(directory, { recursive: true, force: true });
	}
});
