import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { findImageReferences } from "./image-paths.mjs";

test("paths, spaces, uppercase suffixes, tilde and explicit relative grammar with whole spans", () => {
	const cases = [
		["/tmp/example-image.jpg", undefined],
		["~/images/short-id.jpg", undefined], ["./assets/a.PNG", undefined], ["../a.JPEG", undefined], ["assets/a.webp", undefined],
		['"/tmp/my photo.JPG"', "/tmp/my photo.JPG"], ["'~/images/my photo.heic'", "~/images/my photo.heic"],
		["<../my photo.HEIF>", "../my photo.HEIF"], ["`./my photo.gif`", "./my photo.gif"],
		["![camera](<~/images/my photo.jpg>)", "~/images/my photo.jpg"],
		["[photo](./assets/my photo.webp)", "./assets/my photo.webp"],
		['![camera](<./assets/a (1).png> "title")', "./assets/a (1).png"],
		[String.raw`![camera](./a\(1\).png)`, "./a(1).png"], ["![old](photo.png)", "photo.png"],
		['![camera [nested alt]](<./a ((1)).png> "title (nested)")', "./a ((1)).png"],
		["![camera](./a((1)).png)", "./a((1)).png"],
		['"my photo.png"', "my photo.png"], ["./x.avif", undefined], ["./x.bmp", undefined], ["./x.tiff", undefined], ["./x.svg", undefined], ["./x.ico", undefined],
	];
	for (const [reference, expected] of cases) {
		const text = `🖼 Inspect ${reference}, please.`, start = text.indexOf(reference);
		assert.deepEqual(findImageReferences(text), [{ path: expected ?? reference, start, end: start + reference.length }], text);
	}
});

test("URL suffixes and prose never become local references", () => {
	for (const text of [
		"https://host/a.jpg", "http://host/a(b)/image.PNG", "https://host/a.jpg?next=/tmp/b.png", "https://host/![suffix](/tmp/a.jpg)",
		"data:image/png;base64,abcd/a.png", "//host/a.jpg", "file:///tmp/a.png",
		"![remote](https://host/a.jpg)", "[remote](https://host/a(b)/x.jpg)", '<https://host/a.jpg>',
		'"https://host/a (1).jpg"', "a.jpg is a file suffix", "The .PNG format is useful", "prefix:/tmp/a.png",
		"/tmp/a.jpg.backup", "assets/a.png?query=1", "foo=/tmp/a.png", "a.png/another.txt",
	]) assert.deepEqual(findImageReferences(text), [], text);
});

test("dedup preserves first full span and path spelling; source text is untouched", () => {
	const text = 'Look "~/images/a.jpg" then ~/images/a.jpg and ![again](<~/images/a.jpg>)\r\n./a.JPG';
	const before = text;
	assert.deepEqual(findImageReferences(text), [
		{ path: "~/images/a.jpg", start: 5, end: 21 },
		{ path: "./a.JPG", start: text.indexOf("./a.JPG"), end: text.length },
	]);
	assert.equal(text, before);
});

test("module runs in a browser-like realm without Node APIs", async () => {
	const source = readFileSync(new URL("./image-paths.mjs", import.meta.url), "utf8");
	assert.doesNotMatch(source, /\b(?:import|process|Buffer|require)\b/);
	// A fresh ESM data URL verifies the actual named export, not a Node wrapper.
	const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
	const context = vm.createContext({});
	vm.runInContext(source.replace("export function", "function") + '\nresult = findImageReferences("~/images/a.png")', context);
	assert.equal(JSON.stringify(context.result), JSON.stringify(module.findImageReferences("~/images/a.png")));
});
