import { describe, expect, it } from "vitest";
import { noticeText, styleNoticeWith } from "../src/theme/notice.ts";

const tag = (role: string, text: string) => (text ? `<${role}>${text}</${role}>` : "");
const styled = (text: string) => styleNoticeWith(text, tag);

describe("semantic notices", () => {
	const text = noticeText({
		title: "Skills",
		rows: [
			["folder", "~/.octocode/agent/skills"],
			["agent", "B926 by dizzy-eel"],
		],
		warnings: ["one skill failed to load"],
		hint: "/harness list skills shows each path",
	});

	it("lays a notice out as a title, aligned rows, warnings and a hint", () => {
		expect(text).toBe(
			"Skills:\n  folder  ~/.octocode/agent/skills\n  agent   B926 by dizzy-eel\n  ⚠ one skill failed to load\n→ /harness list skills shows each path",
		);
	});

	it("paints each part by its role", () => {
		const lines = styled(text).split("\n");
		expect(lines[0]).toBe("<title>Skills:</title>");
		expect(lines[1]).toContain("<label>folder</label>");
		expect(lines[1]).toContain("<path>~/.octocode/agent/skills</path>");
		expect(lines[2]).toContain("<id>B926</id>");
		expect(lines[3]).toBe("<warning>  ⚠ one skill failed to load</warning>");
		expect(lines[4]).toBe("<hint>→ /harness list skills shows each path</hint>");
	});

	it("keeps the words: removing the paint gives the text back", () => {
		for (const sample of [
			text,
			"Permission mode: workspace — it asks",
			"plain sentence with no structure",
			"Usage: /x [a|b]",
		])
			expect(styled(sample).replace(/<\/?[a-z]+>/g, "")).toBe(sample);
	});

	it("leaves text that carries escape codes, such as links, untouched", () => {
		const link = "see \x1b]8;;https://x.dev\x1b\\docs\x1b]8;;\x1b\\";
		expect(styled(link)).toBe(link);
	});

	it("marks usage lines as warnings", () => {
		expect(styled("Usage: /agents kill <id>")).toBe("<warning>Usage: /agents kill <id></warning>");
	});
});
