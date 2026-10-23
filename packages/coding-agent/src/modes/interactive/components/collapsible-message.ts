import { Box, Container, MouseRegion } from "@octocodeai/octocode-tui";
import { theme } from "../theme/theme.ts";

/**
 * A message on the custom-message background that toggles between collapsed and expanded on a left click or
 * `setExpanded`. Subclasses fill the content and call `updateDisplay()` once their own fields are set.
 */
export abstract class CollapsibleMessageComponent extends Box {
	protected expanded = false;

	constructor(outputPad: number) {
		super(outputPad, 1, (t) => theme.bg("customMessageBg", t));
	}

	setExpanded(expanded: boolean): void {
		this.expanded = expanded;
		this.updateDisplay();
	}

	setOutputPad(outputPad: number): void {
		this.setPaddingX(outputPad);
	}

	override invalidate(): void {
		super.invalidate();
		this.updateDisplay();
	}

	/** Adds the collapsed or expanded children to `content`. */
	protected abstract renderContent(content: Container, expanded: boolean): void;

	protected updateDisplay(): void {
		this.clear();
		const content = new Container();
		this.renderContent(content, this.expanded);
		this.addChild(
			new MouseRegion(content, (event) => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
	}
}
