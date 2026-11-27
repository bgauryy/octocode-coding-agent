/**
 * The MCP workspace's vendors port: other agents' config locations and the per-vendor switch (`toggles` key
 * `harness:<vendor>`). Unset keys take the vendor's default: Octocode, `.agents`, root `.mcp.json` and Pi on; Claude
 * Code, Codex and Cursor off until `/harness enable <vendor>`. A project key (from `.octocode/settings.json`) reaches only
 * that vendor's project files, so a committed file cannot switch on a user's global Claude servers.
 */

import { homedir } from "node:os";
import { errorMessage } from "@octocodeai/octocode-contracts/guards";
import { join } from "node:path";
import { vendorOn } from "../../core/discovery/vendors/switch.ts";
import { VENDOR_IDS, type VendorId } from "../../core/discovery/vendors/types.ts";
import { SettingsManager } from "../../core/settings-manager.ts";
import { parseConfigDocument } from "../../utils/config-document.ts";
import { claudeConfigDir, codexConfigDir } from "../../utils/host-config.ts";
import { repoKey } from "../../utils/git-repository.ts";
import type { McpHostPorts } from "../../../../mcp/src/api.ts";

const isVendorId = (id: string): id is VendorId => (VENDOR_IDS as readonly string[]).includes(id);

export const vendors: McpHostPorts["vendors"] = {
	home: () => homedir(),
	claudeJsonPath: () =>
		process.env.CLAUDE_CONFIG_DIR ? join(claudeConfigDir(), ".claude.json") : join(homedir(), ".claude.json"),
	codexHome: () => {
		try {
			return { dir: codexConfigDir() };
		} catch (error) {
			return { error: errorMessage(error) };
		}
	},
	repoRoot: (cwd) => repoKey(cwd).root,
	parseToml: (text) => parseConfigDocument(text, "config.toml"),
	vendorSwitch({ cwd, agentDir, projectTrusted }) {
		const manager = SettingsManager.create(cwd, agentDir, { projectTrusted });
		const [problem] = manager.drainErrors();
		if (problem)
			throw new Error(`Cannot read ${problem.path} to decide which harnesses are on: ${problem.error.message}`);
		const toggles = manager.getToggles();
		return (vendor, scope) => {
			if (!isVendorId(vendor)) throw new Error(`Unknown harness vendor "${vendor}"`);
			return vendorOn(vendor, toggles, scope === "project");
		};
	},
};
