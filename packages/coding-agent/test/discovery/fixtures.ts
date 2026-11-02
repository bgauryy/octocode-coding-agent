import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { vi } from "vitest";
import { getAgentDir } from "../../src/config.ts";
import { DefaultResourceLoader } from "../../src/core/resource-loader.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { setThemeJsonValidator } from "../../src/theme/theme.ts";
import { validateThemeJson } from "../../src/theme/theme-schema.ts";

setThemeJsonValidator(validateThemeJson);

/** An isolated user home with a project folder. Only HOME is set: an explicit OCTOCODE_HOME turns the Pi roots off. */
export interface Sandbox {
	home: string;
	cwd: string;
	/** The Octocode global directory, `<home>/.octocode/octocodecode`. */
	agentDir: string;
	/** Pi's `~/.pi/agent`. */
	piAgentDir: string;
	cleanup(): void;
}

export function createSandbox(): Sandbox {
	const home = mkdtempSync(join(tmpdir(), "octocode-discovery-"));
	const cwd = join(home, "project");
	mkdirSync(cwd, { recursive: true });
	vi.stubEnv("HOME", home);
	vi.stubEnv("USERPROFILE", home);
	vi.stubEnv("OCTOCODE_HOME", "");
	vi.stubEnv("OCTOCODE_CODING_AGENT_DIR", "");
	return {
		home,
		cwd,
		agentDir: getAgentDir(),
		piAgentDir: join(home, ".pi", "agent"),
		cleanup() {
			vi.unstubAllEnvs();
			rmSync(home, { recursive: true, force: true });
		},
	};
}

export function write(file: string, content: string): string {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
	return file;
}

export function skillFile(
	root: string,
	dirName: string,
	options: { name?: string; description?: string } = {},
): string {
	const name = options.name ?? dirName;
	return write(
		join(root, dirName, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${options.description ?? `Skill ${name}`}\n---\nBody of ${name}.\n`,
	);
}

export function promptFile(dir: string, name: string): string {
	return write(join(dir, `${name}.md`), `---\ndescription: Prompt ${name}\n---\nRun ${name}.\n`);
}

/** A valid theme file whose name is `name`, copied from the bundled dark theme. */
export function themeFile(dir: string, name: string): string {
	const base = JSON.parse(readFileSync(join(process.cwd(), "src", "theme", "dark.json"), "utf-8")) as { name: string };
	base.name = name;
	return write(join(dir, `${name}.json`), JSON.stringify(base));
}

export function createLoader(sandbox: Sandbox, projectTrusted: boolean): DefaultResourceLoader {
	return new DefaultResourceLoader({
		cwd: sandbox.cwd,
		agentDir: sandbox.agentDir,
		nativeFeatures: false,
		settingsManager: SettingsManager.create(sandbox.cwd, sandbox.agentDir, { projectTrusted }),
	});
}

/** Compare function for sorting strings in assertions. */
export const byText = (a: string, b: string): number => a.localeCompare(b);
