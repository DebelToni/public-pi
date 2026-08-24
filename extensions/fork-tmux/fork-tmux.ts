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
};

export type ForkSessionCopy = {
	createBranchedSession(leafId: string): string | undefined;
};

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

export function prepareForkSession(
	source: ForkSessionSource,
	openSession: (path: string, sessionDir: string) => ForkSessionCopy,
	fileExists: (path: string) => boolean,
) {
	const sourceFile = source.getSessionFile();
	const leafId = source.getLeafId();
	if (!sourceFile || !leafId || !fileExists(sourceFile)) {
		throw new Error("The current session is not saved yet. Wait for its first assistant response before forking it.");
	}
	const copy = openSession(sourceFile, source.getSessionDir());
	const forkFile = copy.createBranchedSession(leafId);
	if (!forkFile || !fileExists(forkFile)) throw new Error("Pi did not create the forked session file.");
	return { forkFile, cwd: source.getCwd() };
}
