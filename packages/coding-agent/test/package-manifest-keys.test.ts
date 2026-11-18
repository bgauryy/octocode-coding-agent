import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readPackageManifest } from "../src/core/package-manager/manifest.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function manifest(pkg: object): string {
	const dir = mkdtempSync(join(tmpdir(), "octocode-manifest-"));
	dirs.push(dir);
	const file = join(dir, "package.json");
	writeFileSync(file, JSON.stringify(pkg));
	return file;
}

describe("a package's resource manifest", () => {
	it("is the `octocode` key", () => {
		expect(readPackageManifest(manifest({ octocode: { skills: ["./skills"], themes: ["./t"] } }))).toEqual({
			skills: ["./skills"],
			themes: ["./t"],
		});
	});

	it("is null for a missing package.json and throws for a broken one", () => {
		const dir = mkdtempSync(join(tmpdir(), "octocode-manifest-"));
		dirs.push(dir);
		expect(readPackageManifest(join(dir, "package.json"))).toBeNull();
		const broken = join(dir, "broken.json");
		writeFileSync(broken, "{ not json");
		expect(() => readPackageManifest(broken)).toThrow(`Cannot read the package manifest ${broken}`);
	});

	it("ignores Pi's `pi` key, whose extensions never load here", () => {
		expect(readPackageManifest(manifest({ pi: { extensions: ["./entry.ts"], skills: ["./skills"] } }))).toBeNull();
	});
});
