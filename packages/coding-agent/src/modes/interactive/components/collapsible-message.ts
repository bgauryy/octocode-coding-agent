import { Box, Container, MouseRegion, Spacer, type TUI } from "@octocodeai/octocode-tui";
import { surfaceFill } from "../../../theme/bands.ts";

/**
 * A message on the custom-message background that toggles between collapsed and expanded on a left click or
 * `setExpanded`. One blank row goes above the block and none below, so stacked blocks keep one blank row between them.
 * Subclasses fill the content and call `updateDisplay()` once their own fields are set.
 */
export abstract class CollapsibleMessageComponent extends Container {
	protected expanded = false;
	private readonly box: Box;
	private readonly ui?: Pick<TUI, "keepScrollbackOnCollapse">;

	constructor(outputPad: number, ui?: Pick<TUI, "keepScrollbackOnCollapse">) {
		super();
		this.ui = ui;
		this.box = new Box(outputPad, 0, (t) => surfaceFill("custom", t));
		this.addChild(new Spacer(1));
		this.addChild(this.box);
	}

	setExpanded(expanded: boolean): void {
		// A block that scrolled away stays in scrollback when it collapses; only the screen is repainted.
		if (this.expanded && !expanded) this.ui?.keepScrollbackOnCollapse?.();
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.box.setPaddingX(outputPad);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	/** Adds the collapsed or expanded children to `content`. */
	protected abstract renderContent(content: Container, expanded: boolean): void;

	protected updateDisplay(): void {
		this.box.clear();
		const content = new Container();
		this.renderContent(content, this.expanded);
		this.box.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	}
}
