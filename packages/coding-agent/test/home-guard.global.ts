import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Fails a run that leaves transcript folders of its own temporary projects under the developer's real
 * `~/.octocode`, and gives the run its temporary home (`VITEST_TEST_USER_HOME`). The per-file setup files point HOME and
 * OCTOCODE_HOME at temporary folders; this is the check that they did, for every test and every child process a test
 * starts.
 *
 * A running Octocode (often the one that started this suite) writes to the same folders, so only folders named after a
 * temporary directory count: a session folder is named after its working directory, and a test project lives in the
 * temporary directory.
 */
const realHome = homedir();
const SESSION_FOLDERS = [
	join(realHome, ".octocode", "octocodecode", "sessions"),
	join(realHome, ".octocode", "agent", "sessions"),
];

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
	// One home for the run, beside the run's temporary directory rather than inside it: the folder trust gate ignores a
	// trusted subtree that contains the home folder, and tests trust the temporary directory.
	const userHome = mkdtempSync(join(dirname(tmpdir()), "octocode-test-userhome-"));
	process.env.VITEST_TEST_USER_HOME = userHome;
	// vitest.tmp.global.ts has already pointed TMPDIR at this run's folder, so its encoded name is a marker too.
	const markers = temporaryProjectMarkers();
	return () => {
		rmSync(userHome, { recursive: true, force: true, maxRetries: 3 });
		const leaked: string[] = [];
		for (const [dir, names] of snapshot()) {
			const known = new Set(before.get(dir));
			for (const name of names) {
				if (!known.has(name) && markers.some((marker) => name.includes(marker))) leaked.push(join(dir, name));
			}
		}
		if (leaked.length > 0) {
			// Vitest reports a teardown error but exits 0, so the exit code is set here.
			process.exitCode = 1;
			throw new Error(
				`Tests wrote under the real home (${realHome}); isolate HOME/OCTOCODE_HOME in the test:\n${leaked.join("\n")}`,
			);
		}
	};
}
