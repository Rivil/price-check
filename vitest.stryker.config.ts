// Vitest config for Stryker mutation runs (stryker.config.json → vitest.configFile).
// Stryker's vitest runner executes every project in the config it is given and has
// no project filter, so mutation runs get the node 'server' project alone: the
// browser 'client' project would start Chromium for every mutant and covers no
// server .ts. Derived from vite.config.ts so the two cannot drift apart.
import { defineConfig } from 'vitest/config';
import base from './vite.config.ts';

const server = base.test?.projects?.find(
	(project) => typeof project === 'object' && 'test' in project && project.test?.name === 'server'
);
if (!server) throw new Error("vite.config.ts has no 'server' vitest project");

export default defineConfig({ ...base, test: { ...base.test, projects: [server] } });
