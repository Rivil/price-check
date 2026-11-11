import type { RequestHandler } from './$types';
import { db } from '#lib/server/db/index.ts';
import { healthResponse } from '#lib/server/health.ts';

export const GET: RequestHandler = () => healthResponse(db);
