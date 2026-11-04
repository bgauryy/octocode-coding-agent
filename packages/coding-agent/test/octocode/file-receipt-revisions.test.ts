import fs from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import type { ExtensionToolContext } from "../../src/core/features/index.ts";
import { currentMutationRevision } from "../../src/octocode/files/feedback/revisions.ts";
import type { MutationReceipt } from "../../src/octocode/files/render.ts";
import { registerFileTool } from "../../src/octocode/files/tool.ts";
import { FileGuard } from "../../src/octocode/files/tool/guard.ts";
import { fakeCtx, fakePermission, fakeHost } from "./fake-host.ts";
import { tmp } from "./helpers.ts";

it("gives each committed query of a batch its own receipt revision and reports only the outcomes", async () => {
	const cwd = fs.realpathSync(tmp());
	const file = path.join(cwd, "source.ts");
	fs.writeFileSync(file, "const x = 1;\n");
	const ctx = fakeCtx({ cwd }) as unknown as ExtensionToolContext;
	const guard = new FileGuard();
	guard.record(file);
	const fake = fakeHost();
	registerFileTool(fake.api, guard, fakePermission());
	const before = currentMutationRevision(ctx.sessionManager.getSessionId());
	const result = await fake.tools.get("file")!.execute(
		"batch",
		{
			queries: [
				{ type: "write", path: file, reason: "first", content: "const x = 2;\n" },
				{ type: "write", path: file, reason: "second", content: "const x = 3;\n" },
			],
		},
		undefined,
		undefined,
		ctx,
	);
	expect(result.details.receipts).toHaveLength(2);
	expect(result.details.receipts.map((receipt: MutationReceipt) => receipt.revision)).toEqual([before + 1, before + 2]);
	expect(Object.keys(result.details).sort()).toEqual(["outcomes", "receipts"]);
	expect(fs.readFileSync(file, "utf8")).toBe("const x = 3;\n");
});
