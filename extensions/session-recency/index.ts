import { SessionManager } from "@earendil-works/pi-coding-agent";
import { realpathSync } from "node:fs";

function canonicalPath(path: string | undefined) {
	if (!path) return undefined;
	try {
		return realpathSync.native(path);
	} catch {
		return path;
	}
}

function bubbleParentModifiedByNewestDescendant<T extends { path: string; parentSessionPath?: string; modified: Date }>(sessions: T[]) {
	const byPath = new Map<string, T>();
	const children = new Map<string, T[]>();
	for (const session of sessions) {
		byPath.set(canonicalPath(session.path) ?? session.path, session);
	}
	for (const session of sessions) {
		const parent = canonicalPath(session.parentSessionPath);
		if (!parent || !byPath.has(parent)) continue;
		const list = children.get(parent) ?? [];
		list.push(session);
		children.set(parent, list);
	}
	const seen = new Set<string>();
	function newest(session: T): number {
		const key = canonicalPath(session.path) ?? session.path;
		if (seen.has(key)) return session.modified.getTime();
		seen.add(key);
		let max = session.modified.getTime();
		for (const child of children.get(key) ?? []) max = Math.max(max, newest(child));
		if (max > session.modified.getTime()) session.modified = new Date(max);
		return max;
	}
	for (const session of sessions) newest(session);
	return sessions;
}

export default function () {
	const manager = SessionManager as any;
	if (manager.__piCustomSessionRecency) return;
	manager.__piCustomSessionRecency = true;

	const originalList = manager.list.bind(manager);
	manager.list = async (...args: any[]) => bubbleParentModifiedByNewestDescendant(await originalList(...args));

	const originalListAll = manager.listAll.bind(manager);
	manager.listAll = async (...args: any[]) => bubbleParentModifiedByNewestDescendant(await originalListAll(...args));
}
