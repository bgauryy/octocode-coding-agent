import type { State } from "@octocodeai/octocode-contracts/snapshot";
import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { PRIORITY_TITLES, STATE_TITLES } from "../model/backlog.ts";
import { ago, stamp } from "../model/format.ts";

export function cx(...names: (string | false | null | undefined)[]): string {
	return names.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant;
	size?: "sm" | "md";
	icon?: ReactNode;
	loading?: boolean;
	ref?: Ref<HTMLButtonElement>;
}
/**
 * Defaults to `type="button"` so a button never submits a form by accident. `loading` shows a spinner in place of the
 * icon, keeps the label (so the button's name does not change under the pointer), and blocks repeat activation.
 */
export function Button({
	variant = "secondary",
	size = "md",
	icon,
	loading = false,
	className,
	children,
	disabled,
	...props
}: ButtonProps) {
	return (
		<button
			type="button"
			className={cx("btn", `btn-${variant}`, `btn-${size}`, loading && "is-loading", className)}
			disabled={disabled || loading}
			aria-busy={loading || undefined}
			{...props}
		>
			{loading ? <Spinner /> : icon}
			{children}
		</button>
	);
}

/** Decorative: pair it with text or `aria-busy` that says what is loading. */
export function Spinner({ size = 14 }: { size?: number }) {
	return <span className="spinner" style={{ width: size, height: size }} aria-hidden="true" />;
}

/** Placeholder blocks shaped like the content that is loading; the wrapper announces what is loading. */
export function Skeleton({ label, children }: { label: string; children: ReactNode }) {
	return (
		<output className="skeleton" aria-label={label}>
			{children}
			<span className="visually-hidden">{label}…</span>
		</output>
	);
}
export function SkeletonLine({ width = "100%", height = 12 }: { width?: string; height?: number }) {
	return <span className="skeleton-line" style={{ width, height }} aria-hidden="true" />;
}

/** An icon-only button: the label is required and doubles as the tooltip. */
export function IconButton({ label, ...props }: Omit<ButtonProps, "children" | "aria-label"> & { label: string }) {
	return <Button variant="ghost" size="sm" className="btn-icon" aria-label={label} title={label} {...props} />;
}

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "tool" | "agent";
export function Badge({
	tone = "neutral",
	children,
	title,
	icon,
}: {
	tone?: BadgeTone;
	children: ReactNode;
	title?: string;
	/** A decorative shape before the label, such as a `StateMark`. */
	icon?: ReactNode;
}) {
	return (
		<span className={cx("badge", `tone-${tone}`)} title={title}>
			{icon}
			{children}
		</span>
	);
}

export function Kbd({ children }: { children: ReactNode }) {
	return <kbd className="kbd">{children}</kbd>;
}

export function Avatar({ name, label }: { name: string; label?: string }) {
	return (
		// oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- initials drawn as text, announced as one labelled image.
		<span className="avatar" role="img" aria-label={label ?? name} title={label ?? name}>
			{name.slice(0, 2).toUpperCase()}
		</span>
	);
}

/** Status shape and color together, so state reads without relying on color alone. */
export function StatusIcon({ state, size = 14 }: { state: State; size?: number }) {
	return (
		<svg
			className={cx("status-icon", `state-${state}`)}
			width={size}
			height={size}
			viewBox="0 0 14 14"
			role="img"
			aria-label={STATE_TITLES[state]}
		>
			{state === "backlog" ? (
				<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeDasharray="2.2 2" />
			) : state === "todo" ? (
				<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
			) : state === "ongoing" ? (
				<>
					<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
					<path d="M7 3.5a3.5 3.5 0 0 1 0 7Z" fill="currentColor" />
				</>
			) : (
				<>
					<circle cx="7" cy="7" r="6" fill="currentColor" />
					<path
						d="m4.5 7.2 1.8 1.8 3.4-3.6"
						fill="none"
						stroke="var(--surface)"
						strokeWidth="1.6"
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</>
			)}
		</svg>
	);
}

/** Urgent is a filled mark; other priorities are signal bars. */
export function PriorityIcon({ priority, size = 14 }: { priority: string; size?: number }) {
	const label = `Priority: ${PRIORITY_TITLES[priority] ?? priority}`;
	if (priority === "p0")
		return (
			<svg
				className="priority-icon priority-p0"
				width={size}
				height={size}
				viewBox="0 0 14 14"
				role="img"
				aria-label={label}
			>
				<rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
				<path d="M7 4v3.5M7 9.75v.01" stroke="var(--surface)" strokeWidth="1.75" strokeLinecap="round" />
			</svg>
		);
	const level = { p1: 3, p2: 2, p3: 1 }[priority] ?? 0;
	return (
		<svg
			className={cx("priority-icon", `priority-${priority}`)}
			width={size}
			height={size}
			viewBox="0 0 14 14"
			role="img"
			aria-label={label}
		>
			{[0, 1, 2].map((bar) => (
				<rect
					key={bar}
					x={1.5 + bar * 4}
					y={9 - bar * 3}
					width="3"
					height={4 + bar * 3}
					rx="1"
					fill="currentColor"
					opacity={bar < level ? 1 : 0.25}
				/>
			))}
		</svg>
	);
}

export function StatusLabel({ state }: { state: State }) {
	return (
		<span className={cx("status-label", `state-${state}`)}>
			<StatusIcon state={state} />
			{STATE_TITLES[state]}
		</span>
	);
}

/** Relative to the snapshot time, with the absolute time in the tooltip and `datetime`. */
export function RelativeTime({ at, now, prefix = "" }: { at: number; now: number; prefix?: string }) {
	return (
		<time dateTime={new Date(at).toISOString()} title={stamp(at)}>
			{prefix}
			{ago(now, at)}
		</time>
	);
}

export function EmptyState({
	icon,
	title,
	children,
	action,
}: {
	icon?: ReactNode;
	title: string;
	children?: ReactNode;
	action?: ReactNode;
}) {
	return (
		<div className="empty-state">
			{icon && <div className="empty-icon">{icon}</div>}
			<p className="empty-title">{title}</p>
			{children && <p className="empty-text">{children}</p>}
			{action}
		</div>
	);
}

export function Section({ title, count, children }: { title: string; count?: number; children: ReactNode }) {
	return (
		<section className="section">
			<h3 className="section-title">
				{title}
				{count !== undefined && <span className="count">{count}</span>}
			</h3>
			{children}
		</section>
	);
}
