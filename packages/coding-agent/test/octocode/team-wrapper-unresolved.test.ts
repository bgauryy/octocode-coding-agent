import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsedShell } from "../../src/octocode/permission/shell/commands.ts";
import { reservationTargets, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { readOnlyCommand } from "../../src/octocode/permission/shell/read-only.ts";
import { Team } from "../../src/octocode/team/session.ts";
import { registerCollab } from "../../src/octocode/native/tools/coordinate/tool.ts";
import { fakeCtx, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

/**
 * A wrapper whose command the parse cannot find (`timeout $T …`, `watch '…'`) hides the program it runs. The reservation
 * gate wired as `index.ts` wires it must refuse such a line while a peer holds a reservation, instead of seeing no program,
 * no inline code and no write.
 */
describe("reservation gate: a wrapper line with no resolvable command", () => {
	const stops: Array<() => Promise<unknown>> = [];
	beforeEach(() => {
		vi.stubEnv("NODE_OPTIONS", "");
		vi.stubEnv("BASH_ENV", "");
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		for (const stop of stops.splice(0)) await stop();
	});

	async function member(db: string, cwd: string) {
		const fake = fakeHost();
		const team = new Team(fake.api, { OCTOCODE_AGENT_DB: db });
		const { reservationGate } = registerCollab(fake.api, team, {
			shellCommands: parsedShell,
			shellReadOnly: readOnlyCommand,
			shellWrites: (command) => shellParserReady().then(() => reservationTargets(command)),
		});
		const ctx = fakeCtx({ cwd });
		await fake.emit("session_start", {}, ctx);
		stops.push(() => fake.emit("session_shutdown", {}, ctx));
		const lock = (paths: string[]) =>
			fake.tools.get("coordinate").execute("c", { action: "lock", paths, reason: "auth" }, undefined, undefined, ctx);
		const gate = (command: string) => reservationGate({ toolName: "bash", input: { command } } as never, ctx);
		return { team, lock, gate };
	}

	it.each([
		[`timeout $T python3 -c "open('src/a.ts','w')"`, "timeout"],
		[`timeout "$T" sh -c 'echo x > src/a.ts'`, "sh"],
		["timeout $T cp b.ts src/a.ts", "timeout"],
		[`watch -n1 "python3 -c 'open(\\"src/a.ts\\")'"`, "watch"],
	])("refuses %j while a peer holds a reservation", async (command, name) => {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		expect(await peer.gate(command)).toBeUndefined();
		await owner.lock(["src/a.ts"]);
		const refused = await peer.gate(command);
		expect(refused, command).toMatchObject({
			block: true,
			reason: expect.stringContaining(`reserved by ${owner.team.id}`),
		});
		expect(refused?.reason).toContain(`runs ${name} on inline code`);
		expect(await owner.gate(command)).toBeUndefined();
	});

	it("names a reader given a computed word, and arithmetic on an unknown value, without calling them inline code", async () => {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		// `sort`, not `rg`: a line of readers with no write form now runs with a computed word (RFC core-tools B4).
		expect(await peer.gate('for id in a b; do rg -l "$id" .; done')).toBeUndefined();
		expect(await peer.gate('for id in a b; do sort "$id" x; done')).toBeUndefined(); // plain loop words are known
		const reader = await peer.gate('for id in $(ls); do sort "$id" x; done');
		expect(reader?.reason).toContain('(`sort`). Why: `sort` is given `"$id"`');
		expect(reader?.reason).not.toContain("inline code");
		// Arithmetic alone writes nothing the gate could check, so it runs; beside an unresolved wrapper, the refusal names the wrapper.
		expect(await peer.gate("echo $(( $(cat n)-S ))")).toBeUndefined();
		const arithmetic = await peer.gate('echo $(( $(cat n)-S )); timeout "$T" make build');
		expect(arithmetic).toMatchObject({ block: true });
		expect(arithmetic?.reason).not.toContain("names a variable whose value the line does not show");
		expect(arithmetic?.reason).not.toContain("inline code");
		// A number the line computes is not code.
		expect(await peer.gate('S=$(date +%s); sleep 0; echo "$(( $(date +%s)-S ))s"')).toBeUndefined();
		expect(await peer.gate("N=$(ls | wc -l); echo $((N+1))")).toBeUndefined();
	});

	it("still runs a wrapper line whose command it resolves", async () => {
		const db = path.join(tmp(), "team.sqlite");
		const cwd = tmp();
		const owner = await member(db, cwd);
		const peer = await member(db, cwd);
		await owner.lock(["src/a.ts"]);
		expect(await peer.gate("timeout 60 make build")).toBeUndefined();
		expect(await peer.gate("timeout 60 cp b.ts src/a.ts")).toMatchObject({ block: true });
	});
});
