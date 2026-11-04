import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ApplicationAssets } from "../src/core/application/assets.ts";
import { getApplicationPort } from "../src/core/application/index.ts";
import { normalizeApplicationMessage } from "../src/core/application/normalize.ts";
import { convertToLlm } from "../src/core/messages.ts";
import { createHarness } from "./suite/harness.ts";

it("retains complete trusted shell output through completion and a JSON session restore", async () => {
	const harness = await createHarness();
	let service = getApplicationPort(harness.session);
	let outputPath: string | undefined;
	try {
		const original = `BEGIN ORIGINAL\n${Array.from({ length: 15000 }, (_, i) => `middle output ${i}\n`).join("")}END ORIGINAL\n`;
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
		// The record names the spill; it holds no copy for the JSONL, the database mirror and memory to carry.
		expect(stored).toMatchObject({ fullOutputPath: outputPath });
		expect(stored).not.toHaveProperty("fullOutput");
		expect(JSON.stringify(harness.sessionManager.getEntries()).length).toBeLessThan(original.length / 2);
		const modelText = JSON.stringify(convertToLlm([stored]));
		expect(modelText).not.toContain("middle output 7500");
		expect(modelText).toContain("trimmed: first");
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

it("still shows the full output an older session recorded, and names the file when this process cannot read it", () => {
	const assets = new ApplicationAssets({ memory: true });
	const shown = (source: object) =>
		normalizeApplicationMessage(
			{ role: "bashExecution", command: "c", output: "tail", truncated: true, ...source },
			"m",
			assets,
		);
	expect(shown({ fullOutput: "whole output" }).content?.[1]).toMatchObject({ text: "whole output" });
	const elsewhere = shown({ fullOutputPath: "/saved/by/an/earlier/process.log" });
	expect(elsewhere.content?.[1]).toMatchObject({ text: "tail" });
	expect(elsewhere.content?.at(-1)).toMatchObject({
		providerType: "shell-output-unavailable",
		text: expect.stringContaining("/saved/by/an/earlier/process.log"),
	});
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
