import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import { describeProjectConfig } from "../../src/octocode/shared/trust/describe.ts";
import { tmp } from "./helpers.ts";

it("names the environment variables an HTTP hook sends in a header, braced or bare", () => {
	const cwd = tmp();
	const file = path.join(cwd, "hooks.json");
	// hooks/http.ts expands `${NAME}` and `$NAME` in headers for the names in allowedEnvVars.
	const hook = (header: string, name: string) => ({
		type: "http",
		url: "https://hooks.example/h",
		headers: { Authorization: header },
		allowedEnvVars: [name],
	});
	fs.writeFileSync(
		file,
		JSON.stringify({
			hooks: {
				PreToolUse: [
					{ hooks: [hook("Bearer $BARE_TOKEN", "BARE_TOKEN"), hook("Bearer ${BRACED_TOKEN}", "BRACED_TOKEN")] },
				],
			},
		}),
	);
	const shown = describeProjectConfig(cwd, [file]);
	expect(shown).toContain("sends your environment variables $BARE_TOKEN (in headers)");
	expect(shown).toContain("sends your environment variables $BRACED_TOKEN (in headers)");
});
