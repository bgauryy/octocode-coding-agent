import os from "node:os";
import { SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import octocode from "../../src/octocode/index.ts";
import { fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

let saved: NodeJS.ProcessEnv;
beforeEach(() => {
	saved = { ...process.env };
	process.env.OCTOCODE_HOME = tmp();
	delete process.env[SUBAGENT_ENV];
	vi.spyOn(os, "homedir").mockReturnValue(tmp());
});
afterEach(() => {
	vi.restoreAllMocks();
	process.env = saved;
});

/** `function@file` of the first stack frame in `src/` below the recorder: the code that subscribed. */
function registrationSite(): string {
	for (const line of (new Error("registration site").stack ?? "").split("\n").slice(2)) {
		const match = /at (?:(.*?) \()?(.*?):\d+:\d+\)?$/.exec(line.trim());
		const file = match?.[2] ?? "";
		const at = file.lastIndexOf("/src/");
		if (at === -1) continue;
		return `${match?.[1] ?? "<anonymous>"}@${file.slice(at + 5)}`;
	}
	return "?";
}

/**
 * Compose the native set and record, per event, the site of each subscription in dispatch order, and the order tools
 * are registered in (the prompt's tool order).
 */
async function composition(): Promise<{ events: Record<string, string[]>; tools: string[] }> {
	const fake = fakeHost();
	Object.assign(fake.api.session, { getName: () => undefined });
	const events: Record<string, string[]> = {};
	const on = fake.api.bus.on.bind(fake.api) as (name: string, handler: never) => void;
	(fake.api.bus as { on: typeof on }).on = (name, handler) => {
		(events[name] ??= []).push(registrationSite());
		on(name, handler);
	};
	await octocode(fake.api);
	const sorted = Object.fromEntries(Object.entries(events).sort(([a], [b]) => a.localeCompare(b)));
	return { events: sorted, tools: [...fake.tools.keys()] };
}

describe("native composition order", () => {
	it("subscribes and registers in the recorded order for a main session", async () => {
		await expect(`${JSON.stringify(await composition(), null, "\t")}\n`).toMatchFileSnapshot(
			"./__snapshots__/feature-order.main.json",
		);
	});

	it("subscribes and registers in the recorded order for a subagent", async () => {
		process.env[SUBAGENT_ENV] = "1";
		await expect(`${JSON.stringify(await composition(), null, "\t")}\n`).toMatchFileSnapshot(
			"./__snapshots__/feature-order.subagent.json",
		);
	});
});
