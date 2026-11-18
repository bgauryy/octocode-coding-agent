import { Box, Container, MouseRegion, Spacer } from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";

/**
 * A message on the custom-message background that toggles between collapsed and expanded on a left click or
 * `setExpanded`. One blank row goes above the block and none below, so stacked blocks keep one blank row between them.
 * Subclasses fill the content and call `updateDisplay()` once their own fields are set.
 */
export abstract class CollapsibleMessageComponent extends Container {
	protected expanded = false;
	private readonly box: Box;

	constructor(outputPad: number) {
		super();
		this.box = new Box(outputPad, 0, (t) => theme.bg("customMessageBg", t));
		this.addChild(new Spacer(1));
		this.addChild(this.box);
	}

	setExpanded(expanded: boolean): void {
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
