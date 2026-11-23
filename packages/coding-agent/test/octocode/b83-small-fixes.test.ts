import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChainQueue, openPrerequisites } from "../../src/octocode/subagents/chain.ts";
import { PrerequisiteGate } from "../../src/octocode/subagents/prerequisites.ts";
import { endRun } from "../../src/octocode/subagents/run-audit.ts";
import { readCatalog } from "../../src/core/model-catalog/index-store.ts";

describe("a foreground child's end", () => {
	it("reaches the prerequisite gate, so `after: agent:<id>` accepts it", () => {
		const gate = new PrerequisiteGate({
			item: () => "missing",
			lifecycle: () => () => undefined,
			follow: () => () => undefined,
		});
		const queue = new ChainQueue(gate, () => undefined);
		const finish = vi.fn();
		const runs = { team: { audit: { finish } }, chain: queue } as never;
		endRun(runs, "kid", { reason: "completed", outcome: "done" });
		expect(finish).toHaveBeenCalledOnce();
		const host = { item: () => ({ standing: "missing" as const, dependsOn: [] }), liveChild: () => false };
		expect(() => openPrerequisites(host, queue, ["agent:kid"], "self", [])).not.toThrow();
		expect(gate.ended("kid")).toMatchObject({ reason: "completed" });
	});
});

describe("readCatalog cache", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
	});
	it("notices a same-mtime rewrite of a different size", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "catalog-"));
		dirs.push(dir);
		const file = path.join(dir, "models-dev.json");
		const write = (fetchedAt: number, pad = "") => {
			fs.writeFileSync(file, JSON.stringify({ fetchedAt, models: {}, providers: [], pad }));
			fs.utimesSync(file, 1000, 1000);
		};
		write(1);
		expect(readCatalog(file)?.fetchedAt).toBe(1);
		write(2, "longer");
		expect(readCatalog(file)?.fetchedAt).toBe(2);
	});
});
