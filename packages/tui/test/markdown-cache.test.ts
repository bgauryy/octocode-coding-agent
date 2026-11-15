import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { it } from "node:test";

it("keeps bounded active Markdown caches across GC and releases completed or disposed caches", () => {
	execFileSync(
		process.execPath,
		["--expose-gc", fileURLToPath(new URL("./fixtures/markdown-cache-child.ts", import.meta.url))],
		{
			stdio: "pipe",
			timeout: 30_000,
		},
	);
});
