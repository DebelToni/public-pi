import { modernLatexMarkdownTransformer, transformModernLatex } from "./index.js";

let sink = 0;

function benchmark(name: string, iterations: number, fn: () => string) {
	for (let i = 0; i < Math.min(iterations, 1_000); i++) sink ^= fn().length;
	const start = Bun.nanoseconds();
	for (let i = 0; i < iterations; i++) sink ^= fn().length;
	const elapsed = Bun.nanoseconds() - start;
	const microseconds = elapsed / iterations / 1_000;
	console.log(`${name.padEnd(38)} ${microseconds.toFixed(3).padStart(10)} µs/op`);
}

const text = (bytes: number) => "ordinary Markdown sentence without math. ".repeat(Math.ceil(bytes / 37)).slice(0, bytes);
const noMatch1K = text(1_000);
const noMatch10K = text(10_000);
const noMatch50K = text(50_000);
const oneMatch20K = text(20_000) + "\n" + String.raw`$$x_d \xrightarrow{W_\downarrow} z_\ell$$`;
const oneMatch50K = noMatch50K + "\n" + String.raw`$$x_d \xrightarrow{W_\downarrow} z_\ell$$`;
const pathological = "\\".repeat(20_000) + " " + String.raw`$$A \xrightarrow{f} B$$`;
const malformed = "$$" + String.raw`\xrightarrow[`.repeat(5_000) + "$$";
const markedAdversarial = "<x".repeat(15_000) + String.raw`$$A \xrightarrow{f} B$$`;
const denseMath = Array.from({ length: 4 }, (_, i) => String.raw`$x_${i} \xrightarrow[f_${i}]{g_${i}} y_${i}$`).join(" ");
const finalContext = { messageType: "assistant" as const, isStreaming: false, availableWidth: 100 };
const streamingContext = { ...finalContext, isStreaming: true };

benchmark("identity baseline, 50 KB", 100_000, () => noMatch50K);
benchmark("final no match, 1 KB", 100_000, () => transformModernLatex(noMatch1K));
benchmark("final no match, 10 KB", 50_000, () => transformModernLatex(noMatch10K));
benchmark("final no match, 50 KB", 20_000, () => transformModernLatex(noMatch50K));
benchmark("streaming skipped, 50 KB + command", 100_000, () => modernLatexMarkdownTransformer(oneMatch50K, streamingContext));
benchmark("final one match at 20 KB end", 1_000, () => modernLatexMarkdownTransformer(oneMatch20K, finalContext));
benchmark("final 50 KB budget skip", 20_000, () => modernLatexMarkdownTransformer(oneMatch50K, finalContext));
benchmark("final 4 labeled arrows", 2_000, () => modernLatexMarkdownTransformer(denseMath, finalContext));
benchmark("final 20K-backslash adversarial", 5_000, () => modernLatexMarkdownTransformer(pathological, finalContext));
benchmark("final 5K malformed arrow groups", 5_000, () => modernLatexMarkdownTransformer(malformed, finalContext));
benchmark("final 30K Marked adversarial skip", 5_000, () => modernLatexMarkdownTransformer(markedAdversarial, finalContext));

if (sink === Number.MIN_SAFE_INTEGER) console.log(sink);
