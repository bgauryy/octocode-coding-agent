import { Skeleton, SkeletonLine } from "../ui/primitives.tsx";

export function ConfigSkeleton() {
	return (
		<Skeleton label="Loading settings">
			<div className="skeleton-list" aria-hidden="true">
				{[0, 1, 2].map((row) => (
					<div key={row} className="skeleton-card">
						<SkeletonLine width="30%" height={14} />
						<SkeletonLine width="55%" height={10} />
					</div>
				))}
			</div>
		</Skeleton>
	);
}
