import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { modernLatexMarkdownTransformer } from "./transform.js";

export default function modernLatex(pi: ExtensionAPI) {
	pi.registerMarkdownTransformer(modernLatexMarkdownTransformer);
}

export { modernLatexMarkdownTransformer, transformExtendedArrows, transformModernLatex } from "./transform.js";
