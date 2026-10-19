export type TmuxWindow = {
	sessionId: string;
	windowId: string;
	windowIndex: number;
};

export type ForkSessionSource = {
	getSessionFile(): string | undefined;
	getSessionDir(): string;
	getLeafId(): string | null;
	getCwd(): string;
	getEntry?(entryId: string): ForkMessageEntry | undefined;
};

export type ForkableUserMessage = {
	entryId: string;
	text: string;
	parentId: string | null;
};

type ForkMessageEntry = {
	type: string;
	id: string;
	parentId: string | null;
	message?: { role: string; content?: unknown };
};

export type ForkMessageSource = {
	getEntries(): ForkMessageEntry[];
};

export type ForkSessionCopy = {
	getEntry?(entryId: string): ForkMessageEntry | undefined;
	createBranchedSession(leafId: string): string | undefined;
};

export type RootForkCreator = (cwd: string, sessionDir: string, parentSession: string) => string | undefined;

export function parseTmuxWindow(value: string): TmuxWindow {
	const [sessionId, windowId, rawWindowIndex] = value.trim().split("|");
	const windowIndex = Number(rawWindowIndex);
	if (!/^\$\d+$/.test(sessionId ?? "") || !/^@\d+$/.test(windowId ?? "") || !Number.isInteger(windowIndex)) {
		throw new Error("tmux returned invalid window metadata");
	}
	return { sessionId, windowId, windowIndex };
}

export function shellQuote(value: string) {
	if (value.includes("\0")) throw new Error("The fork message contains an unsupported null byte.");
	return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function piLaunchCommand(piPath: string, sessionFile: string, promptFile: string) {
	return [
		"exec /usr/bin/env",
		"PI_SKIP_LOCAL_PATCH_CHECK=1",
		shellQuote(piPath),
		"--session",
		shellQuote(sessionFile),
		"--fork-tmux-prompt-file",
		shellQuote(promptFile),
	].join(" ");
}

export function parseTmuxWindowIds(value: string) {
	const ids = value.split("\n").map((line) => line.trim()).filter(Boolean);
	if (ids.some((id) => !/^@\d+$/.test(id))) throw new Error("tmux returned invalid window IDs");
	return new Set(ids);
}

export function insertionArguments(current: TmuxWindow, cwd: string, command: string) {
	return [
		"new-window",
		"-a",
		"-t",
		`${current.sessionId}:${current.windowId}`,
		"-c",
		cwd,
		"-n",
		"fork",
		"-P",
		"-F",
		"#{session_id}|#{window_id}|#{window_index}",
		command,
	];
}

export function getForkableUserMessages(source: ForkMessageSource): ForkableUserMessage[] {
	const result: ForkableUserMessage[] = [];
	for (const entry of source.getEntries()) {
		if (entry.type !== "message" || entry.message?.role !== "user") continue;
		const content = entry.message.content;
		const text = typeof content === "string"
			? content
			: Array.isArray(content)
				? content
					.filter((part): part is { type: "text"; text: string } => (
						typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text"
					))
					.map((part) => part.text)
					.join("")
				: "";
		if (text) result.push({ entryId: entry.id, text, parentId: entry.parentId });
	}
	return result;
}

export function prepareForkSession(
	source: ForkSessionSource,
	openSession: (path: string, sessionDir: string) => ForkSessionCopy,
	fileExists: (path: string) => boolean,
	options?: { selectedEntryId?: string; createRootFork?: RootForkCreator },
) {
	const sourceFile = source.getSessionFile();
	const leafId = source.getLeafId();
	if (!sourceFile || (!leafId && !options?.selectedEntryId)) {
		throw new Error("The current session is not saved yet. Wait for its first assistant response before forking it.");
	}
	let selectedText: string | undefined;
	if (options?.selectedEntryId && source.getEntry) {
		const selected = source.getEntry(options.selectedEntryId);
		if (!selected || selected.type !== "message" || selected.message?.role !== "user") {
			throw new Error("The selected user message is no longer available for forking.");
		}
		selectedText = getForkableUserMessages({ getEntries: () => [selected] })[0]?.text;
		if (!selectedText) throw new Error("The selected user message is empty.");
		if (!selected.parentId) {
			const forkFile = options.createRootFork?.(source.getCwd(), source.getSessionDir(), sourceFile);
			if (!forkFile || !fileExists(forkFile)) throw new Error("Pi did not create the forked session file.");
			return { forkFile, cwd: source.getCwd(), selectedText };
		}
	}
	if (!fileExists(sourceFile)) {
		throw new Error("The current session is not saved yet. Wait for its first assistant response before forking it.");
	}
	const copy = openSession(sourceFile, source.getSessionDir());
	let targetLeafId = leafId;
	if (options?.selectedEntryId) {
		const selected = copy.getEntry?.(options.selectedEntryId);
		if (!selected || selected.type !== "message" || selected.message?.role !== "user") {
			throw new Error("The selected user message is no longer available for forking.");
		}
		selectedText = getForkableUserMessages({ getEntries: () => [selected] })[0]?.text;
		if (!selectedText) throw new Error("The selected user message is empty.");
		targetLeafId = selected.parentId;
	}
	const forkFile = targetLeafId
		? copy.createBranchedSession(targetLeafId)
		: options?.createRootFork?.(source.getCwd(), source.getSessionDir(), sourceFile);
	if (!forkFile || !fileExists(forkFile)) throw new Error("Pi did not create the forked session file.");
	return { forkFile, cwd: source.getCwd(), selectedText };
}
