import { describe, expect, it } from "vitest";
import { openBacklog } from "../../src/octocode/backlog/context.ts";
import { registerBashTool } from "../../src/octocode/native/tools/bash/tool.ts";
import { BashJobs } from "../../src/octocode/files/bash-jobs.ts";
import { Subcommands } from "../../src/octocode/shared/commands.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

describe.runIf(process.platform !== "win32")("a background job without an item", () => {
	async function start(held: number) {
		const { api, tools } = fakeHost();
		const jobs = new BashJobs(tmp());
		registerBashTool(api, new Subcommands(), jobs, () => ({}));
		const ctx = fakeCtx({ cwd: tmp() });
		const { store, session } = openBacklog(ctx, { isSubagent: false });
		const refs: string[] = [];
		for (let at = 0; at < held; at++) {
			const item = store.add({
				title: `Work ${at}`,
				goal: "Expected",
				why: "Needed",
				state: "todo",
				createdBy: "user",
			});
			store.update(item.ref, { state: "ongoing" }, { id: session });
			refs.push(item.ref);
		}
		const result = await tools
			.get("bash")
			.execute("t", { command: "sleep 30", background: true, reason: "Run it." }, undefined, undefined, ctx);
		const job = (result.details as { job: string }).job;
		const row = jobs.running().find((entry) => entry.id === job);
		jobs.stop(job, "user");
		return { refs, result, item: row?.item };
	}

	it("serves the only ongoing item the session holds and names it", async () => {
		const { refs, result, item } = await start(1);
		expect(item).toBe(refs[0]);
		expect(result.details).toMatchObject({ item: refs[0] });
		expect(result.content[0].text).toContain(refs[0]);
	});

	it("stays unlinked with two ongoing items", async () => {
		const { result, item } = await start(2);
		expect(item).toBeUndefined();
		expect(result.details).not.toHaveProperty("item");
	});

	it("stays unlinked with none", async () => {
		expect((await start(0)).item).toBeUndefined();
	});
});
