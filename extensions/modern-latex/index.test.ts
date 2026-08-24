import { describe, expect, test } from "bun:test";
import modernLatex, {
	modernLatexMarkdownTransformer,
	transformExtendedArrows,
	transformModernLatex,
} from "./index.js";
import { Markdown, renderLatex } from "@earendil-works/pi-tui";

const finalContext = {
	messageType: "assistant" as const,
	isStreaming: false,
	availableWidth: 100,
};

describe("extended-arrow rewriting", () => {
	test("rewrites the Kimi LatentMoE example into Pi-supported commands", () => {
		const source = String.raw`x_d \xrightarrow{W_\downarrow} z_\ell \xrightarrow{\text{routed experts}} z'_\ell \xrightarrow{W_\uparrow} y_d`;
		const expected = String.raw`x_d \overset{W_\downarrow}{\longrightarrow} z_\ell \overset{\text{routed experts}}{\longrightarrow} z'_\ell \overset{W_\uparrow}{\longrightarrow} y_d`;
		expect(transformExtendedArrows(source)).toBe(expected);
		expect(renderLatex(source, { display: true })).toBeUndefined();
		expect(renderLatex(expected, { display: true })).toContain("→");
	});

	test("supports optional lower labels, nested groups, and the extended arrow family", () => {
		expect(transformExtendedArrows(String.raw`A \xrightarrow[under_{i}]{over^{2}} B`)).toBe(
			String.raw`A \overset{over^{2}}{\underset{under_{i}}{\longrightarrow}} B`,
		);
		expect(transformExtendedArrows(String.raw`A \xleftarrow{f} B \xmapsto{g} C`)).toBe(
			String.raw`A \overset{f}{\longleftarrow} B \overset{g}{\longmapsto} C`,
		);
		expect(transformExtendedArrows(String.raw`A \xRightarrow{f} B \xhookrightarrow{g} C`)).toBe(
			String.raw`A \overset{f}{\Longrightarrow} B \overset{g}{\hookrightarrow} C`,
		);
	});

	test("leaves escaped, malformed, and longer command names unchanged", () => {
		const cases = [
			String.raw`\\xrightarrow{f}`,
			String.raw`\xrightarrow`,
			String.raw`\xrightarrow[below]{unterminated`,
			String.raw`\xrightarrowcustom{f}`,
		];
		for (const source of cases) expect(transformExtendedArrows(source)).toBe(source);
	});
});

describe("Markdown boundaries", () => {
	test("rewrites inline and display math with either delimiter", () => {
		const source = [
			String.raw`Inline $A \xrightarrow{f} B$ and \(C \xleftarrow{g} D\).`,
			String.raw`\[E \xRightarrow{h} F\]`,
			String.raw`$$G \xmapsto{k} H$$`,
		].join("\n");
		const transformed = transformModernLatex(source);
		expect(transformed).not.toContain("\\xrightarrow{");
		expect(transformed).not.toContain("\\xleftarrow{");
		expect(transformed).not.toContain("\\xRightarrow{");
		expect(transformed).not.toContain("\\xmapsto{");
		expect(transformed.match(/\\overset/g)).toHaveLength(4);
	});

	test("does not alter prose, inline code, or fenced code", () => {
		const source = [
			String.raw`The literal command \xrightarrow{f} stays unchanged.`,
			"Use `\\xrightarrow{f}` in LaTeX.",
			"```latex",
			String.raw`A \xrightarrow{f} B`,
			"```",
			String.raw`But $A \xrightarrow{f} B$ is upgraded.`,
		].join("\n");
		const transformed = transformModernLatex(source);
		expect(transformed.split("\\xrightarrow{f}")).toHaveLength(4);
		expect(transformed).toContain(String.raw`$A \overset{f}{\longrightarrow} B$`);
	});

	test("protects indented code and fences nested in blockquotes and lists", () => {
		const source = [
			String.raw`    $$A \xrightarrow{indented} B$$`,
			"> ````latex",
			String.raw`> $$A \xrightarrow{quoted} B$$`,
			"> ```",
			String.raw`> $$A \xrightarrow{still-quoted} B$$`,
			"> ````",
			"- ~~~latex",
			String.raw`  $$A \xrightarrow{listed} B$$`,
			"  ~~~",
			String.raw`Outside: $A \xrightarrow{upgraded} B$.`,
		].join("\n");
		const transformed = transformModernLatex(source);
		expect(transformed.match(/\\xrightarrow/g)).toHaveLength(4);
		expect(transformed).toContain(String.raw`$A \overset{upgraded}{\longrightarrow} B$`);
	});

	test("protects list-indented code and does not treat list items as fence closers", () => {
		const source = [
			String.raw`-     $$A \xrightarrow{list-code} B$$`,
			"````latex",
			"- `````",
			String.raw`$$A \xrightarrow{still-code} B$$`,
			"````",
			String.raw`Outside: $A \xrightarrow{upgraded} B$.`,
		].join("\n");
		const transformed = transformModernLatex(source);
		expect(transformed.match(/\\xrightarrow/g)).toHaveLength(2);
		expect(transformed).toContain(String.raw`$A \overset{upgraded}{\longrightarrow} B$`);
	});

	test("protects pre, code, script, style, textarea, and HTML comments", () => {
		const protectedRegions = [
			String.raw`<pre><code>$$A \xrightarrow{pre} B$$</code></pre>`,
			String.raw`<script>const x = "$$A \xrightarrow{script} B$$";</script>`,
			String.raw`<style>/* $$A \xrightarrow{style} B$$ */</style>`,
			String.raw`<textarea>$$A \xrightarrow{textarea} B$$</textarea>`,
			String.raw`<!-- $$A \xrightarrow{comment} B$$ -->`,
		];
		const source = [...protectedRegions, String.raw`$A \xrightarrow{upgraded} B$`].join("\n");
		const transformed = transformModernLatex(source);
		for (const region of protectedRegions) expect(transformed).toContain(region);
		expect(transformed).toContain(String.raw`$A \overset{upgraded}{\longrightarrow} B$`);
	});

	test("protects links, raw HTML blocks and attributes, CDATA, and frontmatter", () => {
		const protectedRegions = [
			String.raw`[link](https://e.test/$A\xrightarrow{url}B$)`,
			String.raw`<a href="$A \xrightarrow{attribute} B$">link</a>`,
			String.raw`<div>$$A \xrightarrow{html} B$$</div>`,
			String.raw`<![CDATA[$$A \xrightarrow{cdata} B$$]]>`,
		];
		const frontmatter = ["---", String.raw`formula: "$A \xrightarrow{yaml} B$"`, "---", ""].join("\n");
		const source = frontmatter + [...protectedRegions, "", String.raw`$A \xrightarrow{upgraded} B$`].join("\n");
		const transformed = transformModernLatex(source);
		expect(transformed).toStartWith(frontmatter);
		for (const region of protectedRegions) expect(transformed).toContain(region);
		expect(transformed).toContain(String.raw`$A \overset{upgraded}{\longrightarrow} B$`);
	});

	test("still upgrades math beside protected inline content and in unaffected list items", () => {
		const source = [
			"A [link](https://e.test/$A\\xrightarrow{url}B$), `code`, and $A \\xrightarrow{paragraph} B$.",
			"",
			"- `$$A \\xrightarrow{code} B$$`",
			String.raw`- $A \xrightarrow{list} B$`,
		].join("\n");
		const transformed = transformModernLatex(source);
		expect(transformed).toContain(String.raw`https://e.test/$A\xrightarrow{url}B$`);
		expect(transformed).toContain("`$$A \\xrightarrow{code} B$$`");
		expect(transformed).toContain(String.raw`\overset{paragraph}{\longrightarrow}`);
		expect(transformed).toContain(String.raw`\overset{list}{\longrightarrow}`);
	});

	test("escaped and unmatched backticks do not suppress later math", () => {
		const escaped = "Literal \\` followed by $A \\xrightarrow{f} B$.";
		const unmatched = "Unmatched ` followed by $A \\xrightarrow{g} B$.";
		expect(transformModernLatex(escaped)).toContain(String.raw`\overset{f}{\longrightarrow}`);
		expect(transformModernLatex(unmatched)).toContain(String.raw`\overset{g}{\longrightarrow}`);
	});

	test("bounds adversarial input, remains idempotent, and preserves no-match messages", () => {
		const noMatch = "ordinary Markdown without modern math";
		expect(transformModernLatex(noMatch)).toBe(noMatch);
		const once = transformModernLatex(String.raw`$$A \xrightarrow{f} B$$`);
		expect(transformModernLatex(once)).toBe(once);
		const pathological = "\\".repeat(20_000) + String.raw` $$A \xrightarrow{f} B$$`;
		expect(transformModernLatex(pathological)).toBe(pathological);
		const malformed = "$$" + String.raw`\xrightarrow[`.repeat(5_000) + "$$";
		expect(transformModernLatex(malformed)).toBe(malformed);
		const unmatchedBrackets = String.raw`\[A \xrightarrow{f} B `.repeat(5_000);
		expect(transformModernLatex(unmatchedBrackets)).toBe(unmatchedBrackets);
		const unmatchedParens = String.raw`\(A \xrightarrow{f} B `.repeat(5_000);
		expect(transformModernLatex(unmatchedParens)).toBe(unmatchedParens);
		const nestedQuotes = ">".repeat(8_000) + String.raw` $A \xrightarrow{f} B$`;
		expect(transformModernLatex(nestedQuotes)).toBe(nestedQuotes);
		const pathologicalLines = "--\n".repeat(8_000) + String.raw`$A \xrightarrow{f} B$`;
		expect(transformModernLatex(pathologicalLines)).toBe(pathologicalLines);
	});
});

describe("extension policy and rendering", () => {
	test("skips assistant streaming and thinking, then transforms the final message", () => {
		const source = String.raw`$$A \xrightarrow{f} B$$`;
		expect(modernLatexMarkdownTransformer(source, { ...finalContext, isStreaming: true })).toBe(source);
		expect(modernLatexMarkdownTransformer(source, { ...finalContext, messageType: "assistant-thinking" })).toBe(source);
		expect(modernLatexMarkdownTransformer(source, finalContext)).not.toBe(source);
	});

	test("registers exactly one Markdown transformer", () => {
		const transformers: unknown[] = [];
		modernLatex({ registerMarkdownTransformer: (transformer: unknown) => transformers.push(transformer) } as never);
		expect(transformers).toEqual([modernLatexMarkdownTransformer]);
	});

	test("uses Pi's Markdown cache and does not cause extra transform passes", () => {
		let calls = 0;
		const markdown = new Markdown(
			String.raw`$$A \xrightarrow{f} B$$`,
			0,
			0,
			{} as never,
			undefined,
			{
				transform: (source: string, availableWidth: number) => {
					calls++;
					return modernLatexMarkdownTransformer(source, { ...finalContext, availableWidth });
				},
			},
		);

		const first = markdown.render(80);
		const second = markdown.render(80);
		expect(second).toBe(first);
		expect(calls).toBe(1);
		expect(first.join("\n")).toContain("→");
		expect(first.join("\n")).not.toContain("xrightarrow");

		markdown.render(100);
		expect(calls).toBe(2);
	});
});
