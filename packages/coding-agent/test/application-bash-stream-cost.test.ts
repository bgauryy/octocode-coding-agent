import { expect, it, vi } from "vitest";
import { ApplicationAssets } from "../src/core/application/assets.ts";
import { ApplicationActivities } from "../src/core/application/service/activities.ts";
import { createApplicationState } from "../src/core/application/state.ts";

it("streams long shell output into its asset in linear total work, with the same content and a new revision per delta", () => {
	const assets = new ApplicationAssets({ memory: true });
	const activities = new ApplicationActivities(assets, createApplicationState());
	const put = vi.spyOn(assets, "put");
	const read = vi.spyOn(assets, "get");
	const line = `${"y".repeat(1023)}\n`;
	const deltas = 2000;
	const revisions = new Set<string>();
	let latest;
	for (let i = 0; i < deltas; i++) {
		latest = activities.project({ type: "bash_execution_update", id: "one", delta: line });
		if (latest?.full?.revision) revisions.add(latest.full.revision);
	}
	const output = line.repeat(deltas);
	expect(latest?.text).toBe(output.slice(0, 4000));
	expect(assets.get(latest?.full?.id ?? "")?.data).toBe(output);
	// Every delta past the 4000-character preview publishes a new revision of the same asset.
	expect(revisions.size).toBe(deltas - 3);
	// Rewriting the whole output on every delta would move about deltas² / 2 KB (2 GB here); appending moves each byte once.
	const written = put.mock.calls.reduce((sum, [data]) => sum + data.length, 0);
	expect(written).toBeLessThan(2 * output.length);
	expect(read.mock.calls.length).toBeLessThan(10);
	assets.clear();
});
