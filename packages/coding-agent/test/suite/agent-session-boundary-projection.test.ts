import { fauxAssistantMessage } from "@octocodeai/octocode-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("turn_end boundary projection", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function branchCopiesDuringTurn(
		handlerCount: number,
		seen: unknown[] = [],
	): Promise<{ copies: number; previews: number }> {
		const harness = await createHarness({
			extensionFactories: [
				(api) => {
					for (let index = 0; index < handlerCount; index++) {
						api.on("turn_end", (event) => {
							seen.push(event.context);
							return undefined;
						});
					}
				},
			],
		});
		harnesses.push(harness);
		harness.setResponses([fauxAssistantMessage("answer")]);
		// The boundary preview extends the kept projection; a copy of the branch into an in-memory manager is only its
		// fallback.
		const inMemory = vi.spyOn(SessionManager, "inMemory");
		const preview = vi.spyOn(SessionManager.prototype, "previewProjection");
		await harness.session.prompt("question");
		const result = { copies: inMemory.mock.calls.length, previews: preview.mock.calls.length };
		inMemory.mockRestore();
		preview.mockRestore();
		return result;
	}

	it("previews once per turn without copying the branch, however many handlers observe it", async () => {
		expect(await branchCopiesDuringTurn(1)).toEqual({ copies: 0, previews: 1 });
		expect(await branchCopiesDuringTurn(3)).toEqual({ copies: 0, previews: 1 });
	});

	it("shows every handler the same context", async () => {
		const seen: Array<{ contextMessages: unknown[]; llmMessages: unknown[]; canContinue: boolean }> = [];
		await branchCopiesDuringTurn(2, seen);
		expect(seen).toHaveLength(2);
		expect(seen[1]).toEqual(seen[0]);
		expect(JSON.stringify(seen[0].contextMessages)).toContain("answer");
	});
});
