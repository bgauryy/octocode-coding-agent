#!/usr/bin/env node
/**
 * Stage everything a compiled `octocode` binary reads next to itself (see `src/config.ts`: a Bun binary resolves its
 * package directory to the executable's folder). One owner for `build:binary` and `scripts/build-binaries.sh`.
 *
 * Usage: node scripts/stage-binary.mjs <output-dir> [--platform <darwin-arm64|linux-x64|windows-x64|...>]
 * Run after `yarn run build` in packages/coding-agent; the platform defaults to this machine.
 */
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stageCodingAgentSkills } from "./stage-coding-agent-skills.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(repoRoot, "packages", "coding-agent");

/** `darwin-arm64`, `linux-x64`, `windows-x64`, ... for this machine. */
export function currentPlatform() {
	return `${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`;
}

export function stageBinary(outDir, platform = currentPlatform()) {
	const from = (...parts) => join(packageDir, ...parts);
	const copy = (source, target) => {
		if (!existsSync(source)) throw new Error(`Missing ${source}; build packages/coding-agent first.`);
		cpSync(source, target, { recursive: true, dereference: true });
	};
	mkdirSync(outDir, { recursive: true });
	copy(from("package.json"), join(outDir, "package.json"));
	copy(from("README.md"), join(outDir, "README.md"));
	copy(from("dist", "licenses"), join(outDir, "licenses"));
	copy(from("dist", "bash-parser"), join(outDir, "bash-parser"));
	copy(
		join(repoRoot, "node_modules", "@silvia-odwyer", "photon-node", "photon_rs_bg.wasm"),
		join(outDir, "photon_rs_bg.wasm"),
	);
	mkdirSync(join(outDir, "theme"), { recursive: true });
	for (const file of readdirSync(from("dist", "theme")).filter((name) => name.endsWith(".json")))
		copy(from("dist", "theme", file), join(outDir, "theme", file));
	copy(from("dist", "modes", "interactive", "assets"), join(outDir, "assets"));
	// The whole folder: template.html, template.css, template.js and vendor/ are all read at export time.
	copy(from("dist", "core", "export-html"), join(outDir, "export-html"));
	copy(from("docs"), join(outDir, "docs"));
	copy(from("examples"), join(outDir, "examples"));
	copy(from("src", "octocode", "instructions", "roles"), join(outDir, "roles"));
	copy(from("src", "octocode", "native-skills"), join(outDir, "native-skills"));
	const skills = stageCodingAgentSkills(packageDir, join(outDir, "skills"));
	// The selected architecture's native terminal helpers.
	const native = platform.replace(/^windows-/, "win32-");
	const nativePath = join("native", native.split("-")[0], "prebuilds");
	copy(join(repoRoot, "packages", "tui", nativePath, native), join(outDir, nativePath, native));
	return { outDir, platform, skills: skills.skills.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [outDir, flag, value] = process.argv.slice(2);
	if (!outDir || (flag && flag !== "--platform")) {
		console.error("Usage: node scripts/stage-binary.mjs <output-dir> [--platform <platform>]");
		process.exit(1);
	}
	const staged = stageBinary(resolve(outDir), value ?? currentPlatform());
	console.log(`Staged binary assets for ${staged.platform} in ${staged.outDir} (${staged.skills} skills)`);
}
