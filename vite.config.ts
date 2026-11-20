import { defineConfig } from 'vitest/config';
import { playwright } from '@vitest/browser-playwright';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			// SEC-05/SEC-15: a strict CSP. 'auto' puts a per-response nonce on SSR pages
			// (a hash on prerendered ones) for Kit's own inline scripts, so script-src
			// needs no 'unsafe-inline'. Svelte transitions and app.html's
			// style="display: contents" need inline styles. Product images come from
			// Amazon's CDN only. frame-ancestors 'none' pairs with the hook's
			// X-Frame-Options: DENY.
			csp: {
				mode: 'auto',
				directives: {
					'default-src': ['self'],
					'script-src': ['self'],
					'style-src': ['self', 'unsafe-inline'],
					'img-src': ['self', 'https://m.media-amazon.com'],
					'frame-ancestors': ['none'],
					'object-src': ['none'],
					'base-uri': ['self'],
					'form-action': ['self']
				}
			}
		})
	],
	// Never inline assets as data: URIs: img-src does not allow data:, so an inlined
	// favicon would be blocked.
	build: { assetsInlineLimit: 0 },
	test: {
		expect: { requireAssertions: true },
		// Windows CI disk I/O is slow: tests that migrate a fresh SQLite file took ~6s on
		// windows-2025 against the 5s default. Other platforms keep the default.
		...(process.platform === 'win32' ? { testTimeout: 30_000, hookTimeout: 30_000 } : {}),
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'client',
					browser: {
						enabled: true,
						provider: playwright(),
						instances: [{ browser: 'chromium', headless: true }]
					},
					include: ['src/**/*.svelte.{test,spec}.{js,ts}'],
					exclude: ['src/lib/server/**']
				}
			},

			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					include: ['src/**/*.{test,spec}.{js,ts}', 'scripts/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
