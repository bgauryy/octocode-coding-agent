import { beforeAll, describe, expect, it } from "vitest";
import { READ_ONLY_ENV, SUBAGENT_ENV } from "@octocodeai/octocode-common/env";
import { recordShellMutation } from "../../src/octocode/files/bash/mutation.ts";
import { currentMutationRevision } from "../../src/octocode/files/feedback/revisions.ts";
import { readOnlyRoleRefusal } from "../../src/octocode/permission/read-only-role.ts";
import { shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { planReadOnly } from "../../src/octocode/permission/shell/plan-reads.ts";
import { tmp } from "./helpers.ts";

/**
 * `octocode` and `octocode-cli` in a shell are programs the guards do not model, whatever their subcommand: `octocode`
 * (the product, or another program by that name) starts a session of its own, and `octocode-cli` (the research CLI
 * agent shells put on PATH) runs tools the guards hold no knowledge of.
 */

beforeAll(shellParserReady);

const env = { [SUBAGENT_ENV]: "1", [READ_ONLY_ENV]: "1" };
const refusal = (command: string) => readOnlyRoleRefusal({ toolName: "bash", input: { command } }, tmp(), env);

const RUNS = [
	"octocode",
	"octocode --help",
	"octocode --version",
	"octocode some-subcommand '{}' --json",
	"./node_modules/.bin/octocode some-subcommand",
	"echo q | xargs octocode some-subcommand",
];

const CLI_RUNS = [
	"octocode-cli",
	"octocode-cli --help",
	"octocode-cli some-subcommand '{}' --json",
	"echo q | xargs octocode-cli some-subcommand",
];

describe("an `octocode` run in a shell", () => {
	it.each(RUNS)("is refused to a read-only role: %s", (command) => {
		expect(refusal(command)).toContain("`octocode`");
	});

	it.each(RUNS)("is blocked by plan mode: %s", (command) => {
		expect(planReadOnly(command)).toBe(false);
	});

	it("names the session of its own only for `octocode`", () => {
		expect(refusal("octocode --help")).toContain("session of its own");
		expect(refusal("octocode-cli --help")).not.toContain("session of its own");
	});

	it("leaves the read-only programs around it judged as before", () => {
		expect(refusal("rg octocode src | head -5")).toBeUndefined();
		expect(planReadOnly("rg octocode src | head -5")).toBe(true);
		expect(refusal("rg octocode-cli src | head -5")).toBeUndefined();
	});

	it.each(CLI_RUNS)("refuses the research CLI to a read-only role: %s", (command) => {
		expect(refusal(command)).toContain("`octocode-cli`");
	});

	it.each(CLI_RUNS)("blocks the research CLI in plan mode: %s", (command) => {
		expect(planReadOnly(command)).toBe(false);
	});

	it("makes a verification receipt stale, as any program the guard cannot read", async () => {
		const id = "octocode-program";
		const before = currentMutationRevision(id);
		await recordShellMutation("octocode some-subcommand '{}'", tmp(), id);
		expect(currentMutationRevision(id)).not.toBe(before);
	});
});
