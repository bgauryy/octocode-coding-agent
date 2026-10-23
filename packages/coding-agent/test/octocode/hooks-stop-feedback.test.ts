import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { registerHooks } from "../../src/octocode/hooks/register.ts";
import { fakeCtx, fakePi } from "./fake-pi.ts";
import { tmp } from "./helpers.ts";
afterEach(() => vi.unstubAllEnvs());

it("continues Claude Stop feedback under the existing cap and lets termination win", async () => {
	const home = tmp();
	vi.stubEnv("OCTOCODE_HOME", tmp());
	const file = path.join(home, ".claude/settings.json");
	fs.mkdirSync(path.dirname(file));
	const feedback = {
		type: "command",
		command: 'echo \'{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"Run the checks"}}\'',
	};
	const write = (terminate = false) =>
		fs.writeFileSync(
			file,
			JSON.stringify({
				hooks: {
					Stop: [
						{ hooks: [feedback, ...(terminate ? [{ type: "command", command: "echo '{\"continue\":false}'" }] : [])] },
					],
				},
			}),
		);
	write();
	const fake = fakePi();
	const ctx = fakeCtx({ cwd: tmp(), hasUI: false });
	registerHooks(fake.pi, { OCTOCODE_HOOKS: "1", OCTOCODE_HOOKS_COMPAT: "1" }, home);
	await fake.fire("session_start", { reason: "startup" }, ctx);
	const event = { outcome: "completed", entries: [], context: { llmMessages: [] } };
	for (let i = 0; i < 8; i++) {
		const results = await fake.emit("agent_before_settle", event, ctx);
		expect(results).toContainEqual(
			expect.objectContaining({
				continue: true,
				entries: [expect.objectContaining({ content: "Stop hook feedback:\nRun the checks" })],
			}),
		);
	}
	expect((await fake.emit("agent_before_settle", event, ctx)).every((value) => value === undefined)).toBe(true);
	write(true);
	await fake.fire("session_start", { reason: "reload" }, ctx);
	await fake.fire("before_agent_start", {}, ctx);
	expect((await fake.emit("agent_before_settle", event, ctx)).every((value) => value === undefined)).toBe(true);
});
