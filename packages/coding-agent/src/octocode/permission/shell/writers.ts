import { optionValues } from "./destinations.ts";

type Word = string | undefined;

/**
 * What programs that write without a `-o`-style destination in the usual place change, for `shell/mutation.ts`: the
 * compressors that replace their operand, `sponge`, `split`, `csplit`, `shuf -o`, `openssl -out`, `less -o`, `xxd`
 * and `ditto`'s output operand, the archive writers (`zip`, `7z`, `ar`, `cpio`) and `strip`/`script`. Each is read
 * from the program's own option grammar; a form that only reads or prints (`gzip -c`, `zip -sf`, `less f`) writes
 * nothing. An `undefined` word is an expansion the parse could not resolve, and stays one in `writes`.
 */
export interface WriterEffect {
	writes: Word[];
	/** Directories changed without naming files (an extraction into where the command runs). */
	areas: Word[];
	/** Short description for a change with no named path. */
	opaque?: string;
}

const COMPRESSORS = new Set(["gzip", "gunzip", "bzip2", "bunzip2", "xz", "unxz", "zstd", "unzstd"]);
const SEVEN_ZIP = new Set(["7z", "7za", "7zr", "7zz"]);

/** The programs `writerEffect` reads, for `program-forms.ts`'s word writers. */
export const WRITER_PROGRAMS: ReadonlySet<string> = new Set([
	...COMPRESSORS,
	...SEVEN_ZIP,
	"sponge",
	"split",
	"csplit",
	"shuf",
	"openssl",
	"less",
	"xxd",
	"ditto",
	"zip",
	"ar",
	"cpio",
	"strip",
	"script",
]);

/** The words before `--`. */
const options = (words: Word[]): Word[] => {
	const end = words.indexOf("--");
	return end < 0 ? words : words.slice(0, end);
};

/** Whether a short option letter is in a cluster (`-dc`, `-kc9`), or a long option (or its `--name=`) is given. */
const given = (words: Word[], letters: string, ...long: string[]): boolean => {
	const cluster = new RegExp(`^-[a-zA-Z0-9]*[${letters}]`);
	return options(words).some(
		(word) =>
			word !== undefined &&
			(long.some((name) => word === name || word.startsWith(`${name}=`)) ||
				(letters !== "" && !word.startsWith("--") && cluster.test(word))),
	);
};

/** The operands of `words`, past options and the values of the options in `valued` (`xz -T 4 f` is `f`); `-` is a stream. */
function operandsWithout(words: Word[], valued: readonly string[] = []): Word[] {
	const found: Word[] = [];
	let flags = true;
	for (let at = 0; at < words.length; at++) {
		const word = words[at];
		if (flags && word === "--") flags = false;
		else if (flags && word !== undefined && valued.includes(word)) at++;
		else if (!flags || word === undefined || !word.startsWith("-")) found.push(word);
	}
	return found.filter((word) => word !== "-");
}

/** `zip x` and `7z a x` add their extension to a name that has none: both names are written. */
const archiveNames = (file: Word, extension: string): Word[] =>
	file === undefined || /\.[^/.]+$/.test(file) ? [file] : [file, `${file}${extension}`];

function compressor(name: string, rest: Word[]): WriterEffect {
	// Printing, listing, testing and `-c` (stdout) leave the operands as they are.
	if (given(rest, "clthVL", "--stdout", "--to-stdout", "--list", "--test", "--help", "--version", "--license"))
		return { writes: [], areas: [] };
	const zstd = name.endsWith("zstd");
	// zstd's `--output-dir-flat d` and `--output-dir-mirror d` write each output under `d`.
	const outputDirs = ["--output-dir-flat", "--output-dir-mirror"];
	const valued = name.includes("zip") && !name.includes("bzip") ? ["-S", "--suffix"] : ["-S", "-T", "-M"];
	if (!zstd) return { writes: operandsWithout(rest, valued), areas: [] };
	const output = optionValues(rest, "o", ["--output"]);
	return {
		writes: [...operandsWithout(rest, [...valued, ...outputDirs]), ...output],
		areas: optionValues(rest, "", outputDirs),
	};
}

function splitter(name: string, rest: Word[]): WriterEffect {
	if (given(rest, "", "--help", "--version")) return { writes: [], areas: [] };
	if (name === "csplit") {
		const prefix = optionValues(rest, "f", ["--prefix"]);
		return { writes: prefix.length > 0 ? prefix : ["xx"], areas: [] };
	}
	const operands = operandsWithout(rest, ["-l", "-b", "-n", "-a", "-C", "-t", "-N"]);
	return { writes: [operands[1] ?? "x"], areas: [] };
}

function archiver(name: string, rest: Word[]): WriterEffect {
	const none = { writes: [], areas: [] };
	if (name === "zip") {
		if (given(rest, "hLv", "--help", "--version", "--license", "--show-files") || rest.includes("-sf")) return none;
		const out = optionValues(rest, "", ["--output-file"]).concat(optionValues(rest, "O"));
		const archive = operandsWithout(rest, ["-b", "-n", "-t", "-tt", "-P", "-O", "-U", "-Z", "--output-file"])[0];
		return { writes: [...out, ...archiveNames(archive, ".zip")], areas: [] };
	}
	if (SEVEN_ZIP.has(name)) {
		const [command, archive] = operandsWithout(rest);
		if (["a", "u", "d", "rn"].includes(command ?? "")) return { writes: archiveNames(archive, ".7z"), areas: [] };
		// 7z's `-o<dir>` is attached; `x` and `e` extract into it, or where the command runs.
		if (["x", "e"].includes(command ?? "")) {
			const dirs = rest.filter((word) => word?.startsWith("-o")).map((word) => word!.slice(2));
			return { writes: [], areas: dirs.length > 0 ? dirs : ["."] };
		}
		return none;
	}
	if (name === "cpio") {
		const files = optionValues(rest, "OF", ["--file"]);
		if (given(rest, "o", "--create"))
			// Without -O or -F the archive goes to standard output, whose redirect is classified on its own.
			return files.length > 0 ? { writes: files, areas: [] } : none;
		if (given(rest, "i", "--extract")) return { writes: [], areas: ["."] };
		if (given(rest, "p", "--pass-through")) return { writes: operandsWithout(rest).slice(-1), areas: [] };
		return none;
	}
	// ar: `ar r x.a y`, `ar -rc x.a y`; the operation is the first word, its modifiers `a`, `b` and `i` name a member first.
	const [first, ...others] = rest;
	const letters = first?.replace(/^-/, "") ?? "";
	if (first === undefined || !/^[a-zA-Z]+$/.test(letters)) return none;
	const operation = letters.split("").find((letter) => "dmpqrstx".includes(letter));
	const members = operandsWithout(others);
	if (operation !== undefined && "dmqrs".includes(operation))
		return { writes: [members[/[abi]/.test(letters) ? 1 : 0]], areas: [] };
	return operation === "x" ? { writes: [], areas: ["."] } : none;
}

/**
 * What `name` run with `rest` (its words after the name) writes, or undefined for a program this does not model. An empty
 * effect is a form that only reads. `/dev/null` is no write.
 */
export function writerEffect(name: string, rest: Word[]): WriterEffect | undefined {
	if (!WRITER_PROGRAMS.has(name)) return undefined;
	const effect = effectOf(name, rest);
	return { ...effect, writes: effect.writes.filter((file) => file !== "/dev/null") };
}

function effectOf(name: string, rest: Word[]): WriterEffect {
	const none: WriterEffect = { writes: [], areas: [] };
	if (COMPRESSORS.has(name)) return compressor(name, rest);
	switch (name) {
		case "sponge":
			return { writes: operandsWithout(rest), areas: [] };
		case "split":
		case "csplit":
			return splitter(name, rest);
		case "shuf":
			return { writes: optionValues(rest, "o", ["--output"]), areas: [] };
		case "less":
			return { writes: optionValues(rest, "oO", ["--log-file", "--LOG-FILE"]), areas: [] };
		case "openssl": {
			// Its options are single-dash words (`-out f`, `-keyout f`).
			const outputs = new Set(["-out", "-keyout", "-outfile", "-writerand"]);
			const writes = options(rest).flatMap((word, at) =>
				word !== undefined && outputs.has(word) ? [rest[at + 1]] : [],
			);
			return { writes, areas: [] };
		}
		case "xxd": {
			if (given(rest, "", "--help", "--version")) return none;
			// The second operand is the output file; `-c`, `-g`, `-l`, `-s`, `-o` and `-n` take a value.
			return { writes: operandsWithout(rest, ["-c", "-g", "-l", "-s", "-o", "-n", "-R"]).slice(1, 2), areas: [] };
		}
		case "ditto": {
			const operands = operandsWithout(rest);
			if (operands.length >= 2) return { writes: operands.slice(-1), areas: [] };
			// `ditto -x archive` extracts into where it runs.
			return given(rest, "x") && operands.length === 1 ? { writes: [], areas: ["."] } : none;
		}
		case "strip": {
			if (given(rest, "V", "--help", "--version")) return none;
			const output = optionValues(rest, "o", ["--output-file"]);
			const valued = ["-K", "-N", "-R", "-O", "-I", "-F", "-o", "--output-file"];
			return { writes: output.length > 0 ? output : operandsWithout(rest, valued), areas: [] };
		}
		case "script": {
			if (given(rest, "V", "--help", "--version")) return none;
			// `script f` logs to `f` (`typescript` when none is named); util-linux's `-I`, `-O`, `-B` and `-T` name logs too.
			const logs = optionValues(rest, "IOBT", []);
			// BSD and macOS `-t` takes a number (`script -t 0 f cmd`); util-linux's `-t` takes no separate value.
			const bsdTime = (word: Word, at: number) => rest[at - 1] === "-t" && /^\d+(?:\.\d+)?$/.test(word ?? "");
			const words = rest.filter((word, at) => !bsdTime(word, at));
			const operands = operandsWithout(words, ["-c", "-E", "-m", "-o", "-I", "-O", "-B", "-T"]);
			return {
				writes: [...logs, ...(operands.length > 0 ? operands.slice(0, 1) : logs.length > 0 ? [] : ["typescript"])],
				areas: [],
			};
		}
		default:
			return archiver(name, rest);
	}
}
