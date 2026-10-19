import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const tuiRequire = createRequire(require.resolve("@earendil-works/pi-tui"));
export const { marked } = await import(tuiRequire.resolve("marked"));
export const plain = text => text;
export const theme = Object.fromEntries([
	"heading", "link", "linkUrl", "code", "codeBlock", "codeBlockBorder", "quote", "quoteBorder",
	"hr", "listBullet", "bold", "italic", "strikethrough", "underline",
].map(key => [key, plain]));
