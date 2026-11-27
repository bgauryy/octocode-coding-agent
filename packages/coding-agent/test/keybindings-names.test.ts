import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";

describe("keybinding names", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	function createAgentDir(config: Record<string, unknown>): string {
		const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "octocode-keybindings-test-"));
		tempDirs.push(agentDir);
		fs.writeFileSync(path.join(agentDir, "keybindings.json"), `${JSON.stringify(config, null, 2)}\n`, "utf-8");
		return agentDir;
	}

	it("loads namespaced ids from keybindings.json", () => {
		const keybindings = KeybindingsManager.create(
			createAgentDir({ "tui.select.confirm": "enter", "app.interrupt": "ctrl+x" }),
		);

		expect(keybindings.getUserBindings()).toEqual({ "tui.select.confirm": "enter", "app.interrupt": "ctrl+x" });
		const effective = keybindings.getEffectiveConfig();
		expect(effective["tui.select.confirm"]).toBe("enter");
		expect(effective["app.interrupt"]).toBe("ctrl+x");
	});

	it("does not map the names used before the namespaced ids", () => {
		const keybindings = KeybindingsManager.create(createAgentDir({ expandTools: "ctrl+y", interrupt: "ctrl+x" }));

		const effective = keybindings.getEffectiveConfig();
		expect(JSON.stringify(effective["app.tools.expand"])).not.toContain("ctrl+y");
		expect(effective["app.interrupt"]).not.toBe("ctrl+x");
	});
});
