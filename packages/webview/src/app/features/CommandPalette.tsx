import { type ComponentType, type ReactNode, useId, useMemo, useRef, useState } from "react";
import { useModal } from "../hooks.ts";
import type { BacklogIndex } from "../model/backlog.ts";
import type { IconProps } from "../ui/icons.tsx";
import { SearchIcon } from "../ui/icons.tsx";
import { cx, Kbd, StatusIcon } from "../ui/primitives.tsx";

export interface PaletteCommand {
	id: string;
	label: string;
	group: "Actions" | "Views" | "Items";
	hint?: string;
	icon?: ReactNode;
	keywords?: string;
	run: () => void;
}

const LIMIT = 50;

/** Ranks prefix matches on the label above substring matches anywhere; an empty query lists actions and views first. */
export function rankCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return commands.slice(0, LIMIT);
	const scored: { command: PaletteCommand; score: number }[] = [];
	for (const command of commands) {
		const label = command.label.toLowerCase();
		const haystack = `${label} ${command.hint?.toLowerCase() ?? ""} ${command.keywords?.toLowerCase() ?? ""}`;
		const score = label.startsWith(needle)
			? 0
			: command.hint?.toLowerCase().startsWith(needle)
				? 1
				: haystack.includes(needle)
					? 2
					: -1;
		if (score >= 0) scored.push({ command, score });
	}
	return scored
		.sort((a, b) => a.score - b.score)
		.slice(0, LIMIT)
		.map((entry) => entry.command);
}

export function buildCommands(
	index: BacklogIndex,
	views: readonly { name: string; label: string; Icon: ComponentType<IconProps> }[],
	go: (hash: string) => void,
	actions: readonly PaletteCommand[],
): PaletteCommand[] {
	return [
		...actions,
		...views.map((view) => ({
			id: `view:${view.name}`,
			label: `Go to ${view.label}`,
			group: "Views" as const,
			icon: <view.Icon />,
			run: () => go(`#${view.name}`),
		})),
		...[...index.items]
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map((it) => ({
				id: `item:${it.ref}`,
				label: it.title,
				hint: it.ref,
				group: "Items" as const,
				keywords: it.tags.join(" "),
				icon: <StatusIcon state={it.state} />,
				run: () => go(`#${it.ref}`),
			})),
	];
}

/** A modal combobox: arrows move the active option, Enter runs it, Escape closes. */
export function CommandPalette({ commands, onClose }: { commands: readonly PaletteCommand[]; onClose: () => void }) {
	const dialog = useRef<HTMLDialogElement>(null);
	const input = useRef<HTMLInputElement>(null);
	const listId = useId();
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const results = useMemo(() => rankCommands(commands, query), [commands, query]);
	useModal(dialog, onClose, () => input.current);
	const current = results[Math.min(active, results.length - 1)];

	function run(command: PaletteCommand | undefined) {
		if (!command) return;
		onClose();
		command.run();
	}
	function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
		const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
		if (move && results.length) {
			event.preventDefault();
			setActive((value) => (Math.min(value, results.length - 1) + move + results.length) % results.length);
		} else if (event.key === "Enter") {
			event.preventDefault();
			run(current);
		}
	}

	return (
		<>
			<div className="backdrop palette-backdrop" aria-hidden="true" onMouseDown={onClose} />
			<dialog open ref={dialog} className="palette" aria-modal="true" aria-label="Command palette" tabIndex={-1}>
				<div className="palette-input">
					<SearchIcon />
					<input
						ref={input}
						role="combobox"
						aria-expanded="true"
						aria-controls={listId}
						aria-autocomplete="list"
						aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
						aria-label="Search commands and items"
						placeholder="Search items, views and actions…"
						value={query}
						onChange={(event) => {
							setQuery(event.target.value);
							setActive(0);
						}}
						onKeyDown={onKeyDown}
						autoComplete="off"
						spellCheck={false}
					/>
					<Kbd>Esc</Kbd>
				</div>
				{/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- a combobox popup of rich options; a native select cannot hold icons or follow aria-activedescendant. */}
				<div className="palette-list" id={listId} role="listbox" aria-label="Results">
					{results.map((command, position) => {
						const header = position === 0 || results[position - 1].group !== command.group ? command.group : null;
						const selected = command === current;
						return (
							<div key={command.id} role="presentation">
								{header && (
									<div className="palette-group" role="presentation">
										{header}
									</div>
								)}
								{/* oxlint-disable-next-line jsx-a11y/click-events-have-key-events -- options are chosen from the combobox input with arrows and Enter. */}
								<div
									id={`${listId}-${command.id}`}
									// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- an option of the custom listbox above.
									role="option"
									tabIndex={-1}
									aria-selected={selected}
									className={cx("palette-option", selected && "is-active")}
									onMouseMove={() => setActive(results.indexOf(command))}
									onClick={() => run(command)}
								>
									<span className="palette-icon">{command.icon}</span>
									<span className="palette-label">{command.label}</span>
									{command.hint && <span className="palette-hint">{command.hint}</span>}
								</div>
							</div>
						);
					})}
					{!results.length && <p className="palette-empty">No results for “{query}”</p>}
				</div>
				<div className="palette-footer" aria-hidden="true">
					<span>
						<Kbd>↑</Kbd>
						<Kbd>↓</Kbd> navigate
					</span>
					<span>
						<Kbd>↵</Kbd> open
					</span>
					<span>
						<Kbd>/</Kbd> search view
					</span>
				</div>
			</dialog>
		</>
	);
}
