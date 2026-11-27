import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { stripBom } from "@octocodeai/octocode-common/text";
import { stripJsonComments } from "@octocodeai/octocode-common/json";

/**
 * Fails a run that leaves transcript folders of its own temporary projects under the developer's real
 * `~/.octocode`, or that removes a provider from the developer's real `auth.json` or `models.json`. The run's isolation
 * (`vitest.tmp.global.ts`: temporary home, `VITEST_TEST_USER_HOME`, and the guard on the real agent database) and the
 * per-file setup files point HOME and OCTOCODE_HOME at temporary folders; this is the check that they did, for every
 * test and every child process a test starts.
 *
 * A running Octocode (often the one that started this suite) writes to the same folders, so only folders named after a
 * temporary directory count: a session folder is named after its working directory, and a test project lives in the
 * temporary directory. For the same reason a provider a running session adds, or a token it refreshes, is not a leak;
 * only a provider that disappears is.
 */
// From the user database: the run's isolation (`vitest.tmp.global.ts`) has moved HOME by the time this runs.
const realHome = userInfo().homedir;
const SESSION_FOLDERS = [
	join(realHome, ".octocode", "octocodecode", "agent", "sessions"),
	join(realHome, ".octocode", "octocodecode", "sessions"),
	join(realHome, ".octocode", "agent", "sessions"),
];
const CONFIG_DIRS = [
	join(realHome, ".octocode", "octocodecode"),
	join(realHome, ".octocode", "agent"),
	join(realHome, ".octocode"),
	join(realHome, ".pi", "agent"),
	join(realHome, ".pi"),
];
/** The provider ids a credential or provider file names: `auth.json` keys, `models.json` `providers` keys. */
const PROVIDER_FILES: Record<string, (parsed: Record<string, unknown>) => unknown> = {
	"auth.json": (parsed) => parsed,
	"models.json": (parsed) => parsed.providers,
};

function providerIds(file: string, pick: (parsed: Record<string, unknown>) => unknown): string[] | undefined {
	let content: string;
	try {
		content = readFileSync(file, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripJsonComments(stripBom(content)));
	} catch {
		throw new Error(`Could not verify provider IDs: ${file} contains invalid JSON.`);
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new Error(`Could not verify provider IDs: ${file} must contain an object.`);
	const providers = pick(parsed as Record<string, unknown>);
	if (providers === undefined) return [];
	if (!providers || typeof providers !== "object" || Array.isArray(providers))
		throw new Error(`Could not verify provider IDs: invalid provider map in ${file}.`);
	return Object.keys(providers);
}

function providerSnapshot(): Map<string, string[] | undefined> {
	const result = new Map<string, string[] | undefined>();
	for (const dir of CONFIG_DIRS) {
		for (const [name, pick] of Object.entries(PROVIDER_FILES))
			result.set(join(dir, name), providerIds(join(dir, name), pick));
	}
	return result;
}

function lostProviders(before: Map<string, string[] | undefined>): string[] {
	const lost: string[] = [];
	for (const [file, after] of providerSnapshot()) {
		const known = before.get(file);
		if (!known?.length) continue;
		const missing = known.filter((id) => !after?.includes(id));
		if (missing.length > 0) lost.push(`${file}: ${missing.join(", ")}`);
	}
	return lost;
}

const encode = (dir: string): string => dir.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-");

function temporaryProjectMarkers(): string[] {
	const bases = [tmpdir(), "/tmp", "/private/tmp"];
	const dirs = new Set(bases);
	for (const dir of bases) {
		try {
			dirs.add(realpathSync(dir));
		} catch {
			// A missing temporary directory has no folders to match.
		}
	}
	return [...dirs].map(encode).concat("octocode-test", "-vt-");
}

function snapshot(): Map<string, string[]> {
	const result = new Map<string, string[]>();
	for (const dir of SESSION_FOLDERS) result.set(dir, existsSync(dir) ? readdirSync(dir) : []);
	return result;
}

export default function setup(): () => void {
	const before = snapshot();
	const providersBefore = providerSnapshot();
	// vitest.tmp.global.ts has already pointed TMPDIR at this run's folder, so its encoded name is a marker too.
	const markers = temporaryProjectMarkers();
	return () => {
		const leaked: string[] = [];
		for (const [dir, names] of snapshot()) {
			const known = new Set(before.get(dir));
			for (const name of names) {
				if (!known.has(name) && markers.some((marker) => name.includes(marker))) leaked.push(join(dir, name));
			}
		}
		const lost = lostProviders(providersBefore);
		if (leaked.length > 0 || lost.length > 0) {
			// Vitest reports a teardown error but exits 0, so the exit code is set here.
			process.exitCode = 1;
			const parts = [
				...(leaked.length > 0 ? [`Tests wrote under the real home (${realHome}):`, ...leaked] : []),
				...(lost.length > 0
					? ["Providers disappeared from the real home's configuration (or a concurrent /logout):", ...lost]
					: []),
			];
			throw new Error(`${parts.join("\n")}\nIsolate HOME/OCTOCODE_HOME in the test.`);
		}
	};
}
