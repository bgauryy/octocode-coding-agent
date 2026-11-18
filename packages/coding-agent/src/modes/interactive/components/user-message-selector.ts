import { HintBar, keyText } from "../../../theme/theme-tui-helpers.ts";
import { Container, ListView, Spacer, Text, truncateToWidth } from "@octocodeai/octocode-tui";
import { theme } from "../../../theme/theme.ts";
import { DynamicBorder } from "../../../theme/dynamic-border.ts";
import { listRows, listTheme, syncEmpty, typeKeepingSelection } from "./list-kit.ts";
import { plainText } from "./styled-line.ts";

interface UserMessageItem {
	/** The entry id in the session. */
	id: string;
	text: string;
	timestamp?: string;
}

interface Row extends UserMessageItem {
	position: number;
}

/** The fork picker (/fork): earlier user messages, oldest first, the most recent highlighted, with search. */
export class UserMessageSelectorComponent extends Container {
	private readonly messageList: ListView<Row>;

	constructor(
		messages: UserMessageItem[],
		onSelect: (entryId: string) => void,
		onCancel: () => void,
		initialSelectedId?: string,
		rows?: number,
	) {
		super();
		const total = messages.length;
		this.messageList = new ListView<Row>({
			items: messages.map((message, index) => ({ ...message, position: index + 1 })),
			maxRows: listRows(rows, 12, 8),
			theme: listTheme(),
			clickConfirms: true,
			search: { text: (row) => plainText(row.text), placeholder: "type to search messages" },
			row: (row, { selected, width }) => {
				const text = truncateToWidth(plainText(row.text), width, "…");
				return [
					selected ? theme.fg("accent", theme.bold(text)) : theme.fg("text", text),
					theme.fg("muted", `Message ${row.position} of ${total}`),
				];
			},
		});
		const initial = initialSelectedId ? messages.findIndex((message) => message.id === initialSelectedId) : -1;
		this.messageList.setSelectedIndex(initial >= 0 ? initial : Math.max(0, total - 1));
		this.messageList.onSelect = (row) => onSelect(row.id);
		this.messageList.onCancel = onCancel;
		syncEmpty(this.messageList, "user messages");
		const handleInput = this.messageList.handleInput.bind(this.messageList);
		this.messageList.handleInput = (data) => {
			typeKeepingSelection(this.messageList, data, handleInput);
			syncEmpty(this.messageList, "user messages");
		};

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold(theme.fg("accent", "Fork from a message")), 1, 0));
		this.addChild(
			new Text(theme.fg("muted", "Copies the conversation up to the chosen message into a new session"), 1, 0),
		);
		this.addChild(new Spacer(1));
		this.addChild(this.messageList);
		this.addChild(new Spacer(1));
		this.addChild(
			new HintBar([
				[keyText("tui.select.confirm"), "fork", 1],
				[keyText("tui.select.cancel"), "cancel", 0],
			]),
		);
		this.addChild(new DynamicBorder());
	}

	/** The list the host focuses: it takes the keys. */
	getMessageList(): ListView<Row> {
		return this.messageList;
	}
}
