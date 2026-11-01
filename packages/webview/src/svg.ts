/// <reference lib="dom" />
import DOMPurify from "dompurify";

/**
 * A diagram's SVG as a sanitized fragment. Mermaid already runs at `securityLevel: "strict"`; this removes script, event
 * handlers and every link that leaves the page anyway, keeping the HTML labels Mermaid places inside `foreignObject`.
 */
export function sanitizeSvg(svg: string): DocumentFragment {
	const fragment = DOMPurify.sanitize(svg, {
		USE_PROFILES: { svg: true, svgFilters: true, html: true },
		ADD_TAGS: ["foreignObject"],
		ADD_ATTR: ["dominant-baseline"],
		HTML_INTEGRATION_POINTS: { foreignobject: true },
		FORBID_TAGS: ["a", "script", "iframe", "object", "embed", "link", "meta", "image"],
		RETURN_DOM_FRAGMENT: true,
	});
	for (const element of fragment.querySelectorAll("*"))
		// oxlint-disable-next-line unicorn/no-useless-spread -- the live attribute list shrinks while attributes are removed
		for (const attribute of [...element.attributes]) {
			const name = attribute.name.toLowerCase();
			const leaves = name === "src" || (name.endsWith("href") && !attribute.value.trim().startsWith("#"));
			if (name.startsWith("on") || leaves) element.removeAttribute(attribute.name);
		}
	return fragment;
}
