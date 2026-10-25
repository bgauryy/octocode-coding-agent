import type { ReactNode, SVGProps } from "react";

export type IconProps = Omit<SVGProps<SVGSVGElement>, "children"> & { size?: number };

/** Decorative by default: the control or text beside an icon names it. */
function Svg({ size = 16, children, ...props }: IconProps & { children: ReactNode }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 16 16"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.5}
			strokeLinecap="round"
			strokeLinejoin="round"
			aria-hidden="true"
			focusable="false"
			className="icon"
			{...props}
		>
			{children}
		</svg>
	);
}

export const SearchIcon = (props: IconProps) => (
	<Svg {...props}>
		<circle cx="7" cy="7" r="4.5" />
		<path d="m10.5 10.5 3 3" />
	</Svg>
);
export const PlusIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 3v10M3 8h10" />
	</Svg>
);
export const CloseIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="m4 4 8 8M12 4l-8 8" />
	</Svg>
);
export const SortIcon = ({ direction, ...props }: IconProps & { direction?: "asc" | "desc" }) => (
	<Svg {...props}>
		{direction === "asc" ? (
			<path d="M8 12V4M5 7l3-3 3 3" />
		) : direction === "desc" ? (
			<path d="M8 4v8M5 9l3 3 3-3" />
		) : (
			<path d="m5 6 3-3 3 3M5 10l3 3 3-3" opacity=".5" />
		)}
	</Svg>
);
export const CopyIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
		<path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
	</Svg>
);
export const CheckIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="m3.5 8.5 3 3 6-7" />
	</Svg>
);
export const BoardIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="2" y="2.5" width="3.5" height="11" rx="1" />
		<rect x="6.25" y="2.5" width="3.5" height="7" rx="1" />
		<rect x="10.5" y="2.5" width="3.5" height="9" rx="1" />
	</Svg>
);
export const TableIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="2" y="2.5" width="12" height="11" rx="1.5" />
		<path d="M2 6.5h12M2 10h12M6 6.5v7" />
	</Svg>
);
export const TreeIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M4 2.5v9a1.5 1.5 0 0 0 1.5 1.5H9M4 6.5h5" />
		<circle cx="11" cy="6.5" r="1.75" />
		<circle cx="11" cy="13" r="1.75" />
	</Svg>
);
export const AlertIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 2.5 14 13H2L8 2.5Z" />
		<path d="M8 6.5v3M8 11.25v.01" />
	</Svg>
);
export const AgentIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="3" y="5" width="10" height="8" rx="2" />
		<path d="M8 2.5V5M6 9h.01M10 9h.01" />
	</Svg>
);
export const PulseIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M1.5 8h3l2-4.5 3 9 2-4.5h3" />
	</Svg>
);
export const HistoryIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M2.5 8a5.5 5.5 0 1 0 1.6-3.9M2.5 2.5v2.5H5" />
		<path d="M8 5v3l2 1.5" />
	</Svg>
);
export const PauseIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M5.5 3.5v9M10.5 3.5v9" />
	</Svg>
);
export const PlayIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M5 3.5v9l7-4.5-7-4.5Z" />
	</Svg>
);
export const CommentIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v5.5A1.5 1.5 0 0 1 12 11H7l-3 2.5V11a1.5 1.5 0 0 1-1.5-1.5V4Z" />
	</Svg>
);
export const LinkIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M6.5 9.5 9.5 6.5M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1A2.5 2.5 0 0 1 4.5 9l1-1" />
	</Svg>
);
export const EditIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M10.5 2.5 13.5 5.5 6 13H3v-3l7.5-7.5Z" />
	</Svg>
);
export const StopIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="4" y="4" width="8" height="8" rx="1.5" />
	</Svg>
);
export const SendIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M2.5 8h9M8 4l4 4-4 4" />
	</Svg>
);
export const WrapIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M2.5 4h11M2.5 8h9a2 2 0 0 1 0 4H8m1.5-1.5L8 12l1.5 1.5M2.5 12H5" />
	</Svg>
);
export const CodeIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="m5.5 4.5-3.5 3.5 3.5 3.5M10.5 4.5l3.5 3.5-3.5 3.5" />
	</Svg>
);
export const TerminalIcon = (props: IconProps) => (
	<Svg {...props}>
		<rect x="1.75" y="2.5" width="12.5" height="11" rx="2" />
		<path d="m4.5 6.5 2 1.75-2 1.75M8.5 10.5h3" />
	</Svg>
);
export const FeedIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M3 4h10M3 8h10M3 12h6" />
	</Svg>
);
export const SparkIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 2.5v2.5M8 11v2.5M2.5 8H5M11 8h2.5M4.2 4.2l1.6 1.6M10.2 10.2l1.6 1.6M11.8 4.2l-1.6 1.6M5.8 10.2l-1.6 1.6" />
	</Svg>
);
export const ArrowDownIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M8 3v10M4 9l4 4 4-4" />
	</Svg>
);
export const DocIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M4 2.5h4.5L12 6v7a1.5 1.5 0 0 1-1.5 1.5h-6A1.5 1.5 0 0 1 3 13V4a1.5 1.5 0 0 1 1-1.5Z" />
		<path d="M8.5 2.5V6H12M5.5 9h5M5.5 11.5h3.5" />
	</Svg>
);
export const ResearchIcon = (props: IconProps) => (
	<Svg {...props}>
		<path d="M6.5 2.5v3.2L3.2 11.5a1.6 1.6 0 0 0 1.4 2.4h6.8a1.6 1.6 0 0 0 1.4-2.4L9.5 5.7V2.5" />
		<path d="M5.5 2.5h5M5 10.5h6" />
	</Svg>
);
