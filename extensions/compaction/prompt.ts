export const CUSTOM_COMPACTION_PROMPT = `
Your memory is about to be wiped. Everything you learned, built, debugged, and discovered will be replaced by a single document that you write now. A new instance of you will receive only this document and be told to continue.

Everything you do not write down, you will lose. Every mistake you do not record, you will make again.

This is not a summary. It is a transfer of your working memory. Be comprehensive.

PRESERVE working code verbatim in fenced blocks. If you debugged it, iterated on it, or corrected it — include the resolved version. If the correct syntax differs from what you would guess — include it. Query patterns, state machines, auth flows, data model behaviors, correct field names, API response shapes — preserve them verbatim. Do not describe code that you can show.

INCLUDE failed approaches with explanations. Number each one. The next instance will confidently attempt these same approaches because its training data supports them. This list is the only thing that stops it.

PRESERVE user directives — every correction, preference, and rule. These are sacred and accumulate across compaction cycles. If a directive appeared in a prior summary, carry it forward. User frustration or corrections are the highest-value directives — they represent the accumulated trust contract with the user.

NEVER PRESERVE credentials, API keys, auth tokens, private-key contents, cookies, passphrases, or secret-bearing endpoint/query values. Record only the non-secret location or environment-variable name needed to retrieve them, plus a public fingerprint when relevant. Keep ordinary public endpoint origins and service ports only when operationally necessary.

RESOLVE contradictions in implementation state — output only what is true now. Do not include both sides of a reversal. Settled, conflict-free, positive statements only.

DISCARD:
- Debugging steps that revealed nothing non-obvious
- File reads that only informed a decision
- Narration of how work evolved
- Intermediate work that was superseded
- Code that is trivial, boilerplate, or was never debugged

Write as direct factual statements. Not a narrative. Not a history. Not a response to the user. The settled, conflict-free record of what is true now.

Do not respond to any questions in the conversation. Only output the document.`.trim();

export function buildCompactionPrompt(
	conversationText: string,
	previousSummary?: string,
	customInstructions?: string,
) {
	const previous = previousSummary?.trim()
		? `\n\nPrevious summary to carry forward:\n${previousSummary.trim()}`
		: "";
	const focus = customInstructions?.trim()
		? `\n\nAdditional compaction focus from the user:\n${customInstructions.trim()}`
		: "";
	return `${CUSTOM_COMPACTION_PROMPT}${previous}${focus}\n\n<conversation>\n${conversationText}\n</conversation>`;
}
