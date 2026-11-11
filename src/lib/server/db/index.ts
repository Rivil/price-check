import { DATABASE_URL } from '$app/env/private';
import { createDb } from './client.ts';

if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');

export const db = createDb(DATABASE_URL);
