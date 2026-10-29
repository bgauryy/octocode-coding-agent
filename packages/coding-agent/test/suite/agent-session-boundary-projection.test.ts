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

	async function branchCopiesDuringTurn(handlerCount: number, seen: unknown[] = []): Promise<number> {
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
		// The boundary preview is the only in-memory manager a plain turn creates.
		const inMemory = vi.spyOn(SessionManager, "inMemory");
		await harness.session.prompt("question");
		const copies = inMemory.mock.calls.length;
		inMemory.mockRestore();
		return copies;
	}

	it("copies the branch once per turn, however many handlers observe it", async () => {
		expect(await branchCopiesDuringTurn(1)).toBe(1);
		expect(await branchCopiesDuringTurn(3)).toBe(1);
	});

	it("shows every handler the same context", async () => {
		const seen: Array<{ contextMessages: unknown[]; llmMessages: unknown[]; canContinue: boolean }> = [];
		await branchCopiesDuringTurn(2, seen);
		expect(seen).toHaveLength(2);
		expect(seen[1]).toEqual(seen[0]);
		expect(JSON.stringify(seen[0].contextMessages)).toContain("answer");
	});
});
