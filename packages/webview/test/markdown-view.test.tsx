/** @vitest-environment jsdom */
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { Markdown } from "../src/app/live/Markdown.tsx";

describe("Markdown view", () => {
	it("renders a plain one-line answer without source or copy controls", () => {
		render(<Markdown text="All tests pass" />);
		expect(screen.getByText("All tests pass")).toBeInTheDocument();
		expect(screen.queryByRole("button")).toBeNull();
	});

	it("renders headings and safe links, opening web links in a new tab and leaving other links inert", () => {
		const { container } = render(
			<Markdown
				text={"## Result\n\n[docs](https://example.com/a) and [bad](javascript:alert(1)) and [local](/api/x)"}
			/>,
		);
		expect(screen.getByRole("heading", { level: 2, name: "Result" })).toBeInTheDocument();
		const docs = screen.getByRole("link", { name: "docs" });
		expect(docs).toHaveAttribute("href", "https://example.com/a");
		expect(docs).toHaveAttribute("target", "_blank");
		expect(docs).toHaveAttribute("rel", "noopener noreferrer");
		expect(screen.queryByRole("link", { name: "bad" })).toBeNull();
		expect(screen.queryByRole("link", { name: "local" })).toBeNull();
		expect(screen.getByText("bad")).toBeInTheDocument();
		expect(container.querySelector("[href^='javascript']")).toBeNull();
	});

	it("drops raw HTML elements, event handlers and inline styles from the rendered output", () => {
		const { container } = render(
			<Markdown
				text={
					'# Title\n\n<img src="x" onerror="alert(1)"><script>alert(2)</script><div style="color:red" onclick="x()">kept text</div>'
				}
			/>,
		);
		const body = container.querySelector(".markdown-body")!;
		expect(body.querySelector("img, script, div, [onerror], [onclick], [style]")).toBeNull();
		expect(body.textContent).toContain("kept text");
		expect(body.textContent).not.toContain("alert(2)");
	});

	it("toggles between the rendered view and the literal source", async () => {
		const text = "# Heading\n\n*emphasis*";
		const { container } = render(<Markdown text={text} />);
		const toggle = screen.getByRole("button", { name: "View source" });
		expect(toggle).toHaveAttribute("aria-pressed", "false");
		await userEvent.click(toggle);
		expect(screen.getByRole("button", { name: "View Markdown" })).toHaveAttribute("aria-pressed", "true");
		expect(container.querySelector(".markdown-body")).toHaveAttribute("hidden");
		const source = container.querySelector("pre.markdown-source")!;
		expect(source).not.toHaveAttribute("hidden");
		expect(source.textContent).toBe(text);
	});

	it("labels fenced code with its language and line count, highlights known languages and toggles wrapping", async () => {
		const { container } = render(<Markdown text={"Code:\n\n```typescript\nconst a = 1;\nlet b = 2;\n```"} />);
		const toolbar = container.querySelector(".code-toolbar") as HTMLElement;
		expect(within(toolbar).getByText("typescript · 2 lines")).toBeInTheDocument();
		const code = container.querySelector("pre > code.language-typescript")!;
		expect(code.textContent).toBe("const a = 1;\nlet b = 2;\n");
		expect(code.querySelector("span.hljs-keyword")).not.toBeNull();
		const wrap = within(toolbar).getByRole("button", { name: "Wrap code" });
		await userEvent.click(wrap);
		expect(wrap).toHaveAttribute("aria-pressed", "true");
		expect(code.parentElement).toHaveClass("wrap-code");
	});

	it("labels an undeclared code language as text without highlighting", () => {
		const { container } = render(<Markdown text={"```\n<b>raw</b>\n```"} />);
		expect(screen.getByText("text · 1 line")).toBeInTheDocument();
		const code = container.querySelector("pre > code")!;
		expect(code.className).toBe("");
		expect(code.querySelector("b, span")).toBeNull();
		expect(code.textContent).toBe("<b>raw</b>\n");
	});

	it("copies the original Markdown source to the clipboard", async () => {
		const user = userEvent.setup();
		const text = "# Copy me\n\n- one";
		render(<Markdown text={text} />);
		await user.click(screen.getByRole("button", { name: "Copy Markdown" }));
		expect(screen.getByRole("button", { name: "Copied" })).toBeInTheDocument();
		expect(await navigator.clipboard.readText()).toBe(text);
	});
});
