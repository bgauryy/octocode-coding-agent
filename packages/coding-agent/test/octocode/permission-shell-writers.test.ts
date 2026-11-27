import { beforeAll, describe, expect, it } from "vitest";
import { shellMutation, shellParserReady } from "../../src/octocode/permission/shell/mutation.ts";
import { WRITER_PROGRAMS } from "../../src/octocode/permission/shell/writers.ts";

beforeAll(shellParserReady);

const effect = (command: string) => {
	const { writes, areas, opaque, uncertain } = shellMutation(command);
	return { writes, areas, opaque, uncertain };
};
/** Whether a read-only role or isolated tree sees any change in the command. */
const changes = (command: string): boolean => {
	const { writes, areas, opaque, uncertain } = effect(command);
	return writes.length > 0 || areas.length > 0 || opaque.length > 0 || uncertain;
};

/** Forms that write, with the paths they write. */
const WRITING: Array<[string, string[]]> = [
	["gzip f", ["f"]],
	["gzip -9 f g", ["f", "g"]],
	["gzip -k f g", ["f", "g"]],
	["gzip -- -f", ["-f"]],
	["gunzip f.gz", ["f.gz"]],
	["gunzip -S .z f", ["f"]],
	["gzip -d f.gz", ["f.gz"]],
	["bzip2 f", ["f"]],
	["bunzip2 f.bz2", ["f.bz2"]],
	["xz -T 4 f", ["f"]],
	["unxz f.xz", ["f.xz"]],
	["zstd f", ["f"]],
	["zstd f -o out.zst", ["f", "out.zst"]],
	["zstd --output=out.zst f", ["f", "out.zst"]],
	["unzstd f.zst", ["f.zst"]],
	["sponge f", ["f"]],
	["sponge -a f", ["f"]],
	["split f", ["x"]],
	["split -l 10 f out.", ["out."]],
	["csplit f 1", ["xx"]],
	["csplit -f part f 1", ["part"]],
	["shuf -o f a", ["f"]],
	["shuf --output=f a", ["f"]],
	["openssl enc -aes-256-cbc -in a -out b", ["b"]],
	["openssl req -new -keyout k.pem -out c.csr", ["k.pem", "c.csr"]],
	["openssl rand -out r 8", ["r"]],
	["less -o f a", ["f"]],
	["less -O f a", ["f"]],
	["less --log-file=f a", ["f"]],
	["xxd a b", ["b"]],
	["xxd -r -c 8 a b", ["b"]],
	["ditto a b", ["b"]],
	["zip x.zip a", ["x.zip"]],
	["zip -r x a", ["x", "x.zip"]],
	["zip --output-file=out.zip x.zip a", ["out.zip", "x.zip"]],
	["7z a x a", ["x", "x.7z"]],
	["7z a -tzip x.zip a", ["x.zip"]],
	["7za a x.7z a", ["x.7z"]],
	["7zr u x.7z a", ["x.7z"]],
	["7zz d x.7z a", ["x.7z"]],
	["ar r x.a y", ["x.a"]],
	["ar -rc x.a y", ["x.a"]],
	["ar rb m x.a y", ["x.a"]],
	["cpio -o -O x.cpio", ["x.cpio"]],
	["cpio -oF x.cpio", ["x.cpio"]],
	["strip f", ["f"]],
	["strip -o out f", ["out"]],
	["strip --output-file=out f", ["out"]],
	["script f", ["f"]],
	["script", ["typescript"]],
	["script -O out", ["out"]],
	["script -c make f", ["f"]],
	// BSD and macOS `-t` takes a number (the flush interval); util-linux's `-t` takes no separate value.
	["script -t 0 out.log make", ["out.log"]],
	["script -t out.log", ["out.log"]],
	["/usr/bin/gzip f", ["f"]],
	["sudo gzip f", ["f"]],
	["cd pkg && gzip f", ["./pkg/f"]],
];

/** Forms that only read or print. */
const READING = [
	"gzip -c f",
	"gzip -dc f.gz",
	"gzip -d -c f.gz",
	"gzip --stdout f",
	"gzip -l f.gz",
	"gzip -t f.gz",
	"gzip -",
	"gunzip -c f.gz",
	"bunzip2 -t f.bz2",
	"xz -l f.xz",
	"xz -dc f.xz",
	"unxz -c f.xz",
	"zstd -l f.zst",
	"zstd -c f",
	"zstd -dc f.zst",
	"zstd --version",
	"unzstd -c f.zst",
	"bzip2 -dc f.bz2",
	"gzip --help",
	"sponge",
	"zip -sf x.zip",
	"zip -h",
	"less f",
	"xxd f",
	"xxd -c 8 f",
	"shuf a",
	"split --help",
	"csplit --help",
	"7z l x.7z",
	"7z t x.7z",
	"7za l x.7z",
	"7zr t x.7z",
	"7zz l x.7z",
	"ar t x.a",
	"ar p x.a y",
	"strip --help",
	"strip -V",
	"script --version",
	"openssl version",
	"openssl dgst -sha256 f",
	"ditto",
	"cpio --help",
	"cpio -o",
	"cpio -t",
	"find . | cpio -ov",
];

/** The writer program a row runs: the first word `WRITER_PROGRAMS` names, a path's base name included. */
const programOf = (command: string): string | undefined =>
	command
		.split(/\s+/)
		.map((word) => word.split("/").at(-1)!)
		.find((word) => WRITER_PROGRAMS.has(word));

describe("programs that write without a redirection", () => {
	it("has a writing and a reading row for every program writers.ts models", () => {
		const missing = [...WRITER_PROGRAMS].flatMap((program) => [
			...(WRITING.some(([command]) => programOf(command) === program) ? [] : [`${program}: no writing row`]),
			...(READING.some((command) => programOf(command) === program) ? [] : [`${program}: no reading row`]),
		]);
		expect(missing).toEqual([]);
	});

	it.each(WRITING)("%s writes %j", (command, writes) => {
		expect(effect(command).writes).toEqual(writes);
	});

	it.each(["7z x a.7z", "7z x a.7z -oout", "7z e a.7z", "cpio -i", "ar x x.a", "ditto -x a.zip"])(
		"%s extracts into a directory",
		(command) => {
			expect(effect(command).areas.length).toBeGreaterThan(0);
		},
	);

	it("places an extraction where the command names it", () => {
		expect(effect("7z x a.7z -oout").areas).toEqual(["out"]);
	});

	it.each(["--output-dir-flat", "--output-dir-mirror"])("reads zstd %s as the directory it writes into", (option) => {
		const { writes, areas } = effect(`zstd -r ${option} out src`);
		expect(areas).toEqual(["out"]);
		expect(writes).not.toContain("out");
	});

	it("does not resolve an operand that is an expansion", () => {
		expect(effect("gzip $F").uncertain).toBe(true);
	});

	it("reads the program behind an input runner as a writer", () => {
		expect(changes("ls | xargs gzip")).toBe(true);
	});

	it.each(READING)("%s stays a read", (command) => {
		expect(changes(command)).toBe(false);
	});

	it("does not change what an unknown program is", () => {
		expect(changes("someprogram f g")).toBe(false);
	});
});
