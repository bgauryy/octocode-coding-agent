import { Component, type ReactNode } from "react";

interface Props {
	children: ReactNode;
	/** Names what failed to render, for the fallback text. */
	label: string;
}

/** Contains a render error to its subtree: one bad row shows a message in its place instead of unmounting the app. */
export class ErrorBoundary extends Component<Props, { error: Error | undefined }> {
	override state: { error: Error | undefined } = { error: undefined };

	static getDerivedStateFromError(error: unknown): { error: Error } {
		return { error: error instanceof Error ? error : new Error(String(error)) };
	}

	override render(): ReactNode {
		const { error } = this.state;
		if (!error) return this.props.children;
		return (
			<p role="alert" className="muted">
				{this.props.label} could not be displayed: {error.message}
			</p>
		);
	}
}
