import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { declareToolEffect } from "../../src/octocode/permission/tool-effects.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * A reservation holds against every tool that declares the files it writes, not only `file` and `bash`: Pi's
 * single-file `write` and `edit` (as an extension registers them) and a native tool whose declared effect names its changes.
 */
describe("the reservation gate for write tools other than file and bash, while a peer holds src/a.ts", () => {
	const stops: Array<() => Promise<unknown>> = [];
	afterEach(async () => {
		for (const stop of stops.splice(0)) await stop();
	});

	async function member(db: string, cwd: string) {
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: db });
		const { reservationGate } = registerCollab(fake.api, team);
		const ctx = fakeCtx({ cwd });
		await fake.emit("session_start", {}, ctx);
		stops.push(() => fake.emit("session_shutdown", {}, ctx));
		const lock = (paths: string[]) =>
			fake.tools.get("coordinate").execute("c", { action: "lock", paths, reason: "auth" }, undefined, undefined, ctx);
		const gate = (toolName: string, input: Record<string, unknown>) =>
			reservationGate({ toolName, toolCallId: "t1", input } as never, ctx);
		return { team, lock, gate };
	}

	async function peerOfHolder() {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		return { owner, peer };
	}

	it.each([
		["write", { path: "src/a.ts", content: "x" }],
		["edit", { path: "src/a.ts", edits: [{ oldText: "a", newText: "b" }] }],
	])("refuses an extension's %s of the reserved path", async (toolName, input) => {
		const { owner, peer } = await peerOfHolder();
		const refusal = await peer.gate(toolName, input);
		expect(refusal).toMatchObject({ block: true });
		expect(refusal?.reason).toContain(`reserved by ${owner.team.id}`);
		expect(refusal?.reason).toContain("src/a.ts");
		// Outside every reservation it runs.
		expect(await peer.gate(toolName, { ...input, path: "src/b.ts" })).toBeUndefined();
	});

	it("refuses a native tool whose declared effect changes the reserved path", async () => {
		declareToolEffect({
			name: "renamer",
			effect: {
				kind: "write",
				changes: (input) =>
					[input.from, input.to].flatMap((file) =>
						typeof file === "string" ? [{ path: file, type: "write" as const }] : [],
					),
			},
		});
		const { peer } = await peerOfHolder();
		expect(await peer.gate("renamer", { from: "src/z.ts", to: "src/a.ts" })).toMatchObject({ block: true });
		expect(await peer.gate("renamer", { from: "src/y.ts", to: "src/z.ts" })).toBeUndefined();
	});

	it("lets the holder itself write its reserved path", async () => {
		const { owner } = await peerOfHolder();
		expect(await owner.gate("write", { path: "src/a.ts", content: "x" })).toBeUndefined();
	});
});
