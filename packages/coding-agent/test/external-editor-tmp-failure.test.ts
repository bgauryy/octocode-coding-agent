import { afterEach, describe, expect, test, vi } from "vitest";
import { editInExternalEditor } from "../src/modes/interactive/external-editor.ts";

describe("external editor", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("an unusable temporary directory reports a failed edit instead of rejecting", async () => {
		if (process.platform === "win32") return;
		vi.stubEnv("TMPDIR", "/nonexistent-octocode-tmp/for-this-test");
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			await expect(editInExternalEditor({ command: "true", content: "draft" })).resolves.toEqual({
				status: "failed",
				error: expect.stringContaining("ENOENT"),
			});
		} finally {
			write.mockRestore();
		}
	});

	test("an editor command that cannot start reports why, while an unsuccessful exit carries no error", async () => {
		if (process.platform === "win32") return;
		const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			await expect(
				editInExternalEditor({ command: "octocode-no-such-editor-for-test", content: "draft" }),
			).resolves.toEqual({ status: "failed", error: expect.stringContaining("ENOENT") });
			await expect(editInExternalEditor({ command: "false", content: "draft" })).resolves.toEqual({
				status: "failed",
			});
		} finally {
			write.mockRestore();
		}
	});
});
