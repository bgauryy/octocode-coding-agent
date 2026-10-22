import { cpSync, existsSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Copy the already-packaged public collection, including references, scripts and assets. */
export function stageCodingAgentSkills(packageDir) {
	const require = createRequire(join(packageDir, "package.json"));
	const source = join(dirname(require.resolve("octocode/package.json")), "skills");
	const names = readdirSync(source).filter((name) => existsSync(join(source, name, "SKILL.md")));
	if (names.length === 0) throw new Error(`The installed Octocode research package has no skills: ${source}`);
	const target = join(packageDir, "dist", "skills");
	rmSync(target, { recursive: true, force: true });
	cpSync(source, target, { recursive: true, dereference: true });
	return { source, target, skills: names.sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/coding-agent");
	const staged = stageCodingAgentSkills(packageDir);
	console.log(`Staged ${staged.skills.length} public Octocode skills for the standalone distribution`);
}
