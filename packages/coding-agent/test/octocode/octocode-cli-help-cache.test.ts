import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { tmp } from "./helpers.ts";

/** The CLI the resolver finds: none until the test builds one, as while a linked `octocode` build rewrites its output. */
const cli = vi.hoisted(() => ({ current: undefined as { bin: string; version: string } | undefined }));
vi.mock("../../src/octocode/cli/resolve.ts", async (original) => ({
	...(await original<Record<string, unknown>>()),
	resolveOctocodeCli: () => cli.current,
}));
const { completeCliArgs } = await import("../../src/octocode/cli/help.ts");

describe("/octocode completions while the CLI does not resolve", () => {
	it("looks the help up again once the CLI resolves: a missing CLI is not remembered for the process", () => {
		expect(completeCliArgs("au")).toBeNull();
		expect(completeCliArgs("auth lo")).toBeNull();
		const bin = path.join(tmp("octocode-cli-help-"), "octocode.js");
		fs.writeFileSync(
			bin,
			'process.stdout.write(process.argv.includes("auth") ? "Commands:\\n  login  Sign in\\n  logout  Sign out\\n" : "Commands:\\n  auth  Manage the sign-in\\n");\n',
		);
		cli.current = { bin, version: "1.0.0" };
		expect(completeCliArgs("au")?.map((item) => item.value)).toEqual(["auth"]);
		expect(completeCliArgs("auth lo")?.map((item) => item.value)).toEqual(["auth login", "auth logout"]);
	});
});
