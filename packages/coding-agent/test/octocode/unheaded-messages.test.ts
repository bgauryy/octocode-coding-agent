import { describe, expect, it } from "vitest";
import { convertToLlm, userBashHeader } from "../../src/core/messages.ts";
import { renderSourceHeader, userSource } from "../../src/octocode/events/source.ts";
import { labelHttpVerdict } from "../../src/octocode/hooks/http-origin.ts";
import { hookContext } from "../../src/octocode/hooks/context-message.ts";

describe("messages sent to the model carry a source header", () => {
	it("stamps a user `!` command with the terminal header", () => {
		expect(userBashHeader()).toBe(renderSourceHeader(userSource("terminal")));
		const [message] = convertToLlm([
			{ role: "bashExecution", command: "ls", output: "a", exitCode: 0, cancelled: false, truncated: false, timestamp: 1 },
		]);
		const text = (message.content as Array<{ text: string }>)[0].text;
		expect(text.startsWith(`${userBashHeader()}\nRan \`ls\``)).toBe(true);
	});

	it("fences an HTTP hook's context once", () => {
		const verdict = labelHttpVerdict({ type: "http", url: "https://example.com/x" } as never, { context: "do it" });
		const text = hookContext("PreToolUse", verdict.context ?? "");
		expect(text.match(/<<<untrusted-/g)).toHaveLength(1);
		expect(text).toContain("External data from HTTP hook example.com");
		expect(text.startsWith("[src hook:")).toBe(true);
	});
});
