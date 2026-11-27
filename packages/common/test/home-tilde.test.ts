import { describe, expect, it } from "vitest";
import { homeTilde } from "../src/home-tilde.ts";

describe("homeTilde on Windows", () => {
	const home = "C:\\Users\\Me";

	it("writes the home folder as ~ and keeps the rest with its own separators", () => {
		expect(homeTilde("C:\\Users\\Me\\.octocode\\settings.json", home, "win32")).toBe("~\\.octocode\\settings.json");
		expect(homeTilde("C:\\Users\\Me/projects/a.ts", home, "win32")).toBe("~/projects/a.ts");
		expect(homeTilde("C:\\Users\\Me", home, "win32")).toBe("~");
		expect(homeTilde("C:\\Users\\Me\\", "C:\\Users\\Me\\", "win32")).toBe("~\\");
	});

	// The trust prompt's copy compared case-sensitively and only after `\`; the decided behaviour follows the file system.
	it("ignores letter case, as the file system does", () => {
		expect(homeTilde("c:\\users\\me\\notes.md", home, "win32")).toBe("~\\notes.md");
	});

	it("leaves a sibling with a longer name and paths elsewhere unchanged", () => {
		expect(homeTilde("C:\\Users\\Meg\\a.txt", home, "win32")).toBe("C:\\Users\\Meg\\a.txt");
		expect(homeTilde("D:\\work\\a.txt", home, "win32")).toBe("D:\\work\\a.txt");
	});
});

describe("homeTilde on POSIX systems", () => {
	const home = "/home/al";

	it("writes the home folder as ~ and keeps paths outside it", () => {
		expect(homeTilde("/home/al/.octocode/settings.json", home, "linux")).toBe("~/.octocode/settings.json");
		expect(homeTilde("/home/al", home, "darwin")).toBe("~");
		expect(homeTilde("/home/al/", "/home/al/", "linux")).toBe("~/");
		expect(homeTilde("/home/alice/a", home, "linux")).toBe("/home/alice/a");
		expect(homeTilde("/etc/hosts", home, "linux")).toBe("/etc/hosts");
	});

	it("is case-sensitive and does not treat a backslash as a separator", () => {
		expect(homeTilde("/Home/Al/a", home, "linux")).toBe("/Home/Al/a");
		expect(homeTilde("/home/al\\x", home, "linux")).toBe("/home/al\\x");
	});

	// The `tildePath` copy this replaced differed here; these are the decided behaviours.
	it("writes the home folder itself as ~, keeps a name starting with .. inside it, and does not normalize", () => {
		expect(homeTilde("/home/al", home, "linux")).toBe("~");
		expect(homeTilde("/home/al/..cache/x", home, "linux")).toBe("~/..cache/x");
		expect(homeTilde("/home/al/./a//b", home, "linux")).toBe("~/./a//b");
	});

	it("changes nothing when the home folder is unknown", () => {
		expect(homeTilde("/a/b", "", "linux")).toBe("/a/b");
		expect(homeTilde("/a/b", "/", "linux")).toBe("/a/b");
	});
});
