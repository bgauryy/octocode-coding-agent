import { DEFAULT_EVENT_TYPES } from "./protocol.ts";
import { API_COMMAND_FLAGS } from "./args.ts";

export function completeApi(words: string[], instanceIds: readonly string[] = []): string[] {
	const prefix = words.at(-1) ?? "";
	const previous = words.at(-2);
	const command = words[0];
	const filter = (values: readonly string[]) =>
		values.filter((value) => value.startsWith(prefix) && !/[\r\n\t]/.test(value));
	if (words.length <= 1)
		return filter(["list", "status", "send", "watch", "events", "abort", "external", "completion"]);
	if (command === "completion") return words.length === 2 ? filter(["bash", "zsh", "fish"]) : [];
	if (words.slice(1, -1).includes("--")) return [];
	if (previous === "--to") return filter(instanceIds);
	if (["--from", "--key", "--session", "--timeout", "--since", "--limit"].includes(previous ?? "")) return [];
	if (command === "send" && previous === "--mode") return filter(["steer", "followUp"]);
	if (command === "watch" && previous === "--types") {
		const start = prefix.slice(0, prefix.lastIndexOf(",") + 1);
		return filter([...DEFAULT_EVENT_TYPES, "message.delta"].map((value) => start + value));
	}
	const flags = Object.hasOwn(API_COMMAND_FLAGS, command) ? API_COMMAND_FLAGS[command] : [];
	return filter(flags.map((flag) => `--${flag}`));
}
