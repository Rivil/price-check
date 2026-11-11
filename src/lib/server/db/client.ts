// No $app/* imports: this module is shared by the SvelteKit app, the test
// harness and the node CLI (t-4), so it must run under plain Node type stripping.
import { drizzle } from 'drizzle-orm/libsql';
import { createClient } from '@libsql/client';
import * as schema from './schema.ts';

export function createDb(url: string) {
	const client = createClient({ url });
	return drizzle(client, { schema });
}

export type Db = ReturnType<typeof createDb>;
