import { Skeleton, SkeletonLine } from "../ui/primitives.tsx";

/** Columns of card outlines in the board's shape, shown until a live page receives its first snapshot. */
export function BoardSkeleton() {
	return (
		<Skeleton label="Loading board">
			<div className="board skeleton-board" aria-hidden="true">
				{[3, 2, 2, 1].map((cards, column) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative placeholders.
					<div key={column} className="column">
						<div className="column-title">
							<SkeletonLine width="40%" />
						</div>
						<div className="column-cards">
							{Array.from({ length: cards }, (_, card) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative placeholders.
								<div key={card} className="card skeleton-card">
									<SkeletonLine width="24%" height={10} />
									<SkeletonLine width="85%" height={14} />
									<SkeletonLine width="60%" height={10} />
								</div>
							))}
						</div>
					</div>
				))}
			</div>
		</Skeleton>
	);
}

/** A stack of card outlines, for feeds and lists. */
export function ListSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
	return (
		<Skeleton label={label}>
			<div className="skeleton-list" aria-hidden="true">
				{Array.from({ length: rows }, (_, row) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: fixed decorative placeholders.
					<div key={row} className="skeleton-card">
						<SkeletonLine width="18%" height={10} />
						<SkeletonLine width="70%" height={14} />
						<SkeletonLine width="92%" height={10} />
					</div>
				))}
			</div>
		</Skeleton>
	);
}
