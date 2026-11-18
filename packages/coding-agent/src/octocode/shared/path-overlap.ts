const norm = (path: string) => path.replace(/^\.\//, "").replace(/\/+$/, "");

/** The entries of `a` that overlap an entry of `b`: equal, or one inside the other (prefix both ways). */
export function sharedPaths(a: readonly string[], b: readonly string[]): string[] {
	const shared = new Set<string>();
	for (const left of a.map(norm).filter(Boolean))
		for (const right of b.map(norm).filter(Boolean))
			if (left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`))
				shared.add(left.length >= right.length ? left : right);
	return [...shared];
}
