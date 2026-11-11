// Renders an error for a log line as its type and stack frames, never its message
// (decision error_log_content). Message text can carry anything, a saved ntfy topic
// or token included: DrizzleQueryError puts the query's params on a later line.

// One real frame: V8's forms, plus what Kit's fix_stack_trace rewrites them to before
// handleError runs, a relative path or a trailing " [path]" (route paths have brackets).
const FRAME = /^ {4}at .+(?::\d+:\d+\)?|\((?:<anonymous>|native|index \d+)\))(?: \[.+\])?$/;

/**
 * The stack's frames. The message is cut out by anchoring on the header, since a
 * line of it can look like a frame. The name is the stack's own, not error.name:
 * Node headers can read "TypeError [ERR_X]: msg".
 *
 * The frames end at the first line that isn't one, so nothing appended to a stack after
 * a line of its own ("Caused by: ...") is kept. A V8 frame form FRAME doesn't know ends
 * them too, which loses real frames but nothing else.
 *
 * Two classes stay out of reach: a message cut back on a line boundary after the stack
 * was read, or cleared on an error with an empty name, and frame-shaped text appended
 * straight after the frames. Each has the shape of a genuine stack, so a frame-shaped
 * line can't be told from a real frame.
 */
function frames(error: Error): string[] {
	const { stack } = error;
	if (typeof stack !== 'string') return [];
	const message = String(error.message);
	const [name] = stack.split(/: |\n/, 1);
	const header = message === '' ? name : `${name}: ${message}`;
	// A stale or rewritten header: the message can't be told from the frames, so keep none.
	if (!`${stack}\n`.startsWith(`${header}\n`)) return [];
	const lines = stack.slice(header.length + 1).split('\n');
	const end = lines.findIndex((line) => !FRAME.test(line));
	return end === -1 ? lines : lines.slice(0, end);
}

/**
 * The error's type, then its frames, one per line. The type is the constructor's
 * name because DrizzleQueryError never sets error.name. A thrown non-Error renders
 * as its typeof alone. Never throws: this runs inside handlers that must not fail,
 * and a throw from handleError makes Kit print the raw error.
 */
export function formatError(error: unknown): string {
	try {
		if (!(error instanceof Error)) return typeof error;
		return [error.constructor?.name || 'Error', ...frames(error)].join('\n');
	} catch {
		return 'unknown';
	}
}
