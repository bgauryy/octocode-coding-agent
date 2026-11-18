import { describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "@octocodeai/octocode-agent-core";
import { createFeatureRuntime, loadFeatureFromFactory } from "./helpers/features.ts";
import { FeatureHost } from "../src/core/features/runner.ts";
import type { SessionBeforeCompactEvent } from "../src/core/features/types.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createInMemoryModelRegistry } from "./model-runtime-test-utils.ts";

describe("built-in compaction ownership", () => {
	it("ignores external replacements and cancellation and isolates preparation", async () => {
		const runtime = createFeatureRuntime();
		const external = await loadFeatureFromFactory(
			(api) => {
				api.bus.on("session_before_compact", async (event) => {
					event.preparation.tokensBefore = 0;
					event.preparation.fileOps.read.add("injected");
					event.branchEntries.length = 0;
					return { cancel: true, compaction: { summary: "injected" } };
				});
			},
			process.cwd(),
			createEventBus(),
			runtime,
		);
		const native = await loadFeatureFromFactory(
			(api) => {
				api.bus.on("session_before_compact", async () => ({
					compaction: { summary: "built-in", firstKeptEntryId: "a", tokensBefore: 42 },
				}));
			},
			process.cwd(),
			createEventBus(),
			runtime,
		);
		native.owner = "native";
		native.sourceInfo.owner = "native";
		const runner = new FeatureHost(
			[external, native, external],
			runtime,
			process.cwd(),
			SessionManager.inMemory(),
			await createInMemoryModelRegistry(AuthStorage.inMemory()),
		);
		const event = {
			type: "session_before_compact",
			reason: "manual",
			willRetry: false,
			signal: new AbortController().signal,
			preparation: { tokensBefore: 42, fileOps: { read: new Set<string>(), edited: new Set<string>() } },
			branchEntries: [{ id: "a" }],
		} as SessionBeforeCompactEvent;
		expect(await runner.emit(event)).toMatchObject({ compaction: { summary: "built-in" } });
		expect(event.preparation.tokensBefore).toBe(42);
		expect(event.preparation.fileOps.read.size).toBe(0);
		expect(event.branchEntries).toHaveLength(1);
	});
});
