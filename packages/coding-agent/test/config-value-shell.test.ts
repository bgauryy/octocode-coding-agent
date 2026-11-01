import { afterEach, describe, expect, it, vi } from "vitest";
import type * as ShellModule from "../src/utils/shell.ts";

const shellConfig = vi.hoisted(() => vi.fn(() => ({ shell: "/bin/sh", args: ["-c"] })));
vi.mock("../src/utils/shell.ts", async (importOriginal) => ({
	...(await importOriginal<typeof ShellModule>()),
	getShellConfig: shellConfig,
}));

import { clearConfigValueCache, resolveConfigValue } from "../src/core/config-value.ts";

const platform = process.platform;

afterEach(() => {
	Object.defineProperty(process, "platform", { value: platform });
	clearConfigValueCache();
});

describe("host config values", () => {
	it.skipIf(platform === "win32")("run !command values on Windows through the bash tool's shell", () => {
		Object.defineProperty(process, "platform", { value: "win32" });

		expect(resolveConfigValue("!echo host-shell")).toBe("host-shell");
		expect(shellConfig).toHaveBeenCalled();
	});
});
