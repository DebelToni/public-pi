import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
	entryRefKey,
	entryRefsEqual,
	readFlattenLineage,
	type ValidatedFlattenLineage,
} from "../lib/flatten-session-lineage.js";
import { SessionStoreClient, type EntryRef } from "../lib/session-store-client.js";

export const MAX_LINEAGE_DEPTH = 64;

export type LineageSource = {
	path: string;
	depth: number;
	leaf?: string | null;
	leafRef?: EntryRef;
	compactionRef?: EntryRef;
	firstKeptRef?: EntryRef | null;
	sessionId?: string;
	suppress: ReadonlySet<string>;
	via?: ValidatedFlattenLineage;
};

function canonical(path: string) {
	return realpathSync.native(resolve(path));
}

function validateSnapshot(lineage: ValidatedFlattenLineage) {
	const stats = statSync(lineage.sourcePath, { bigint: true });
	const expected = lineage.data.source.snapshot;
	if (!stats.isFile() || String(stats.dev) !== expected.dev || String(stats.ino) !== expected.ino
		|| String(stats.size) !== expected.size || String(stats.mtimeNs) !== expected.mtimeNs) {
		throw new Error(`Flatten ancestor identity changed: ${lineage.sourcePath}`);
	}
}

export function nextLineageSource(current: LineageSource): LineageSource | undefined {
	const lineage = readFlattenLineage(current.path);
	if (!lineage) return undefined;
	validateSnapshot(lineage);
	return {
		path: canonical(lineage.sourcePath),
		depth: current.depth + 1,
		leaf: lineage.data.source.leaf.id,
		leafRef: lineage.data.source.leaf,
		compactionRef: lineage.data.source.compaction,
		firstKeptRef: lineage.data.source.firstKept,
		sessionId: lineage.data.source.sessionId,
		suppress: new Set(lineage.data.copiedSourceEntries.map(entryRefKey)),
		via: lineage,
	};
}

async function validateExactEntry(
	client: SessionStoreClient,
	source: LineageSource,
	ref: EntryRef,
	label: string,
	signal?: AbortSignal,
) {
	if (!ref.id) throw new Error(`Flatten ancestor ${label} has no entry ID.`);
	const response = await client.read({
		path: source.path,
		entry: ref.id,
		entryByteStart: ref.byteStart,
		leaf: source.leaf ?? undefined,
		leafByteStart: source.leafRef?.byteStart,
		before: 0,
		after: 0,
		limit: 1,
		maxChars: 1000,
	}, signal);
	if (!entryRefsEqual(response.entries[0]?.entryRef, ref)) {
		throw new Error(`Flatten ancestor ${label} locator validation failed: ${source.path}`);
	}
}

export async function validateLineageBoundary(client: SessionStoreClient, source: LineageSource, signal?: AbortSignal) {
	if (!source.leafRef || !source.compactionRef || !source.sessionId || !source.leaf) {
		throw new Error("Lineage ancestor lacks exact boundary locators.");
	}
	const response = await client.read({
		path: source.path,
		leaf: source.leaf,
		leafByteStart: source.leafRef.byteStart,
		before: 0,
		after: 0,
		limit: 1,
		maxChars: 1000,
	}, signal);
	if (response.id !== source.sessionId || !entryRefsEqual(response.leafRef, source.leafRef)) {
		throw new Error(`Flatten ancestor leaf validation failed: ${source.path}`);
	}
	await validateExactEntry(client, source, source.compactionRef, "compaction", signal);
	if (source.firstKeptRef) await validateExactEntry(client, source, source.firstKeptRef, "first-kept entry", signal);
	return response;
}

export function exactMatchKey(ref: EntryRef | undefined) {
	if (!ref) throw new Error("Lineage search returned evidence without an exact source locator.");
	return entryRefKey(ref);
}
