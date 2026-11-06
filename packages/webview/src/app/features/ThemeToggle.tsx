import type { Theme } from "../extension.ts";

const OPTIONS: readonly { value: Theme; label: string }[] = [
	{ value: "system", label: "System" },
	{ value: "light", label: "Light" },
	{ value: "dark", label: "Dark" },
];

/** Light, Dark or System (the operating system's choice). */
export function ThemeToggle({
	theme,
	onChange,
	problem,
}: {
	theme: Theme;
	onChange: (theme: Theme) => void;
	problem?: string;
}) {
	return (
		<div className="menu-row">
			<span id="theme-label">Theme</span>
			<fieldset className="segmented" aria-labelledby="theme-label">
				{OPTIONS.map(({ value, label }) => (
					<button key={value} type="button" aria-pressed={theme === value} onClick={() => onChange(value)}>
						{label}
					</button>
				))}
			</fieldset>
			{problem && (
				<span className="notify-problem" aria-live="polite">
					{problem}
				</span>
			)}
		</div>
	);
}
