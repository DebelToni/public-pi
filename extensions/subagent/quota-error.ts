// Match provider failures, never successful assistant text or tool output.
export function isQuotaError(value: unknown): boolean {
	return typeof value === "string" && /(?:usage[ _-]?limit|rate[ _-]?limit|quota|too many requests|out of (?:credits|budget)|credit balance (?:is )?too low|insufficient (?:credits|balance)|available balance)/i.test(value);
}
