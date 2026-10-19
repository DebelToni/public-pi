export interface ImageReference {
	/** Unwrapped/unescaped spelling, not filesystem-resolved. */
	path: string;
	/** JS UTF-16 string index, inclusive. */
	start: number;
	/** JS UTF-16 string index, exclusive. */
	end: number;
}
export function findImageReferences(text: string): ImageReference[];
