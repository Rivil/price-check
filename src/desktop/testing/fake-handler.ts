// Stand-in for adapter-node's build/handler.js in server.spec: like the real module it
// reads its environment at top level, so the spec can prove loadAdapterHandler sets
// process.env and the cwd, and publishes the notifier the server's startup looks for,
// BEFORE importing it. Import it only through loadAdapterHandler: a static import
// would record the spec's own env and cwd.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readNotifier } from '#lib/server/notify-bridge.ts';

export const recorded = {
	protocolHeader: process.env.PROTOCOL_HEADER ?? null,
	cwd: process.cwd(),
	notifierPublished: readNotifier() !== undefined
};

/** Answers every request with the values recorded at import time, as JSON. */
export function handler(_req: IncomingMessage, res: ServerResponse): void {
	res.setHeader('content-type', 'application/json');
	res.end(JSON.stringify(recorded));
}
