import type { InputHTMLAttributes, ReactNode, Ref, SelectHTMLAttributes } from "react";
import { useId } from "react";
import { SearchIcon } from "./icons.tsx";
import { cx, Kbd } from "./primitives.tsx";

export function SearchField({
	label,
	shortcut,
	ref,
	className,
	...props
}: Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & {
	label: string;
	shortcut?: string;
	ref?: Ref<HTMLInputElement>;
}) {
	return (
		<div className={cx("search-field", className)}>
			<SearchIcon />
			<input ref={ref} type="search" aria-label={label} autoComplete="off" spellCheck={false} {...props} />
			{shortcut && !props.value && <Kbd>{shortcut}</Kbd>}
		</div>
	);
}

/** A compact filter: the empty option reads "<label>: all" so the current choice is always visible. */
export function FilterSelect({
	label,
	options,
	value,
	onChange,
}: {
	label: string;
	options: readonly (string | { value: string; label: string })[];
	value: string;
	onChange: (value: string) => void;
}) {
	return (
		<select
			className={cx("filter-select", value && "is-active")}
			aria-label={label}
			value={value}
			onChange={(event) => onChange(event.target.value)}
		>
			<option value="">{label}: all</option>
			{options.map((option) => {
				const { value: optionValue, label: optionLabel } =
					typeof option === "string" ? { value: option, label: option } : option;
				return (
					<option key={optionValue} value={optionValue}>
						{optionLabel}
					</option>
				);
			})}
		</select>
	);
}

/** A labelled form control; `hint` is linked with `aria-describedby`. */
export function Field({
	label,
	hint,
	children,
	className,
}: {
	label: string;
	hint?: string;
	className?: string;
	children: (props: { id: string; "aria-describedby"?: string }) => ReactNode;
}) {
	const id = useId();
	const hintId = hint ? `${id}-hint` : undefined;
	return (
		<div className={cx("field", className)}>
			<label htmlFor={id}>{label}</label>
			{children({ id, "aria-describedby": hintId })}
			{hint && (
				<p className="field-hint" id={hintId}>
					{hint}
				</p>
			)}
		</div>
	);
}

export function Select({
	options,
	...props
}: SelectHTMLAttributes<HTMLSelectElement> & { options: readonly (string | { value: string; label: string })[] }) {
	return (
		<select {...props}>
			{options.map((option) => {
				const { value, label } = typeof option === "string" ? { value: option, label: option } : option;
				return (
					<option key={value} value={value}>
						{label}
					</option>
				);
			})}
		</select>
	);
}

export function SegmentedControl<T extends string>({
	label,
	options,
	value,
	onChange,
	idPrefix,
}: {
	label: string;
	options: readonly { value: T; label: string; count?: number; icon?: ReactNode }[];
	value: T;
	onChange: (value: T) => void;
	idPrefix?: string;
}) {
	return (
		<fieldset className="segmented">
			<legend className="visually-hidden">{label}</legend>
			{options.map((option) => (
				<button
					key={option.value}
					id={idPrefix ? `${idPrefix}-${option.value}` : undefined}
					type="button"
					aria-pressed={option.value === value}
					onClick={() => onChange(option.value)}
				>
					{option.icon}
					{option.label}
					{option.count !== undefined && <span className="count">{option.count}</span>}
				</button>
			))}
		</fieldset>
	);
}
