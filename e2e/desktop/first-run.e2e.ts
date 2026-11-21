// First launch (spec c-1, c-6): real Electron on an empty temp userData, its cwd a
// temp dir holding a poisoned .env whose DATABASE_URL and key point elsewhere, and
// no env vars beyond the launcher's allowlist. The first window must show the empty
// watchlist on the per-launch loopback origin, the key and DB must land in userData
// (never at the .env's path), and an unpackaged launch must register nothing to
// start at login.
//
// The key is never printed: it is checked by decoded length and compared by hash.
// Where safeStorage has a real backend the key file is wrapped (06-remediate-security
// c-24), and the key is decrypted by the app's own safeStorage to check it.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { WRAPPED_PREFIX } from '../../src/desktop/alerts-key.ts';
import { LOGIN_LAUNCH_ARG, MARKER_FILE_NAME } from '../../src/desktop/login-item.ts';
import {
	DB_FILE_NAME,
	KEY_FILE_NAME,
	launchDesktop,
	makeTempDir,
	type DesktopApp
} from './launch.ts';

/** A test-only key that a leaked .env would supply: 32 bytes, not a secret. */
const POISONED_KEY = Buffer.from('poisoned-dotenv-alerts-key-01234').toString('base64');

const sha256 = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');

test('first launch on an empty userData', async () => {
	const userData = makeTempDir('first-run-userdata');
	const cwd = makeTempDir('first-run-cwd');
	const elsewhere = makeTempDir('first-run-elsewhere');
	const poisonedDb = join(elsewhere, 'poisoned.db');
	writeFileSync(
		join(cwd, '.env'),
		[
			`DATABASE_URL=file:${poisonedDb}`,
			`ALERTS_ENCRYPTION_KEY=${POISONED_KEY}`,
			'ORIGIN=http://evil.example',
			''
		].join('\n'),
		'utf8'
	);
	expect(readdirSync(userData)).toEqual([]);

	let desktop: DesktopApp | undefined;
	try {
		desktop = await launchDesktop({ userData, cwd });
		const { app, origin, port } = desktop;

		// No setup step: the first window is the empty watchlist on the live port.
		const page = await app.firstWindow({ timeout: 30_000 });
		await expect(page).toHaveURL(`http://127.0.0.1:${port}/`, { timeout: 30_000 });
		expect(origin).toBe(`http://127.0.0.1:${port}`);
		await expect(page.getByText('Nothing on your watchlist yet.')).toBeVisible({
			timeout: 30_000
		});

		// The key and DB were created in userData. Where safeStorage has a real backend
		// (the macOS mock keychain, Windows DPAPI, a Linux keyring) the key file is
		// wrapped by it; on Linux basic_text it is base64 of 32 bytes (c-24).
		const keyFile = join(userData, KEY_FILE_NAME);
		expect(existsSync(keyFile)).toBe(true);
		expect(existsSync(join(userData, DB_FILE_NAME))).toBe(true);
		const fileText = readFileSync(keyFile, 'utf8').trim();
		const storage = await app.evaluate(
			({ safeStorage }, platform) => ({
				available: safeStorage.isEncryptionAvailable(),
				backend: platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null
			}),
			process.platform
		);
		if (process.platform !== 'linux') expect(storage.available).toBe(true);
		const realBackend =
			storage.available &&
			(process.platform !== 'linux' ||
				/^(gnome_libsecret|kwallet\d*)$/.test(storage.backend ?? ''));
		expect(fileText.startsWith(WRAPPED_PREFIX), `wrapped on backend ${storage.backend}`).toBe(
			realBackend
		);
		const keyText = realBackend
			? await app.evaluate(
					({ safeStorage }, payload) => safeStorage.decryptString(Buffer.from(payload, 'base64')),
					fileText.slice(WRAPPED_PREFIX.length)
				)
			: fileText;
		expect(/^[A-Za-z0-9+/]{43}=$/.test(keyText), 'key is base64').toBe(true);
		expect(Buffer.from(keyText, 'base64').length).toBe(32);
		expect(sha256(keyText) === sha256(POISONED_KEY), 'key came from the .env').toBe(false);

		// Nothing followed the .env: its DB path is untouched and cwd holds only the .env.
		expect(existsSync(poisonedDb)).toBe(false);
		expect(readdirSync(elsewhere)).toEqual([]);
		expect(readdirSync(cwd)).toEqual(['.env']);

		// An unpackaged launch never registers start-at-login (decision login_start).
		expect(await app.evaluate(({ app }) => app.isPackaged)).toBe(false);
		if (process.platform === 'linux') {
			const autostart = join(desktop.env.XDG_CONFIG_HOME, 'autostart');
			expect(existsSync(autostart) ? readdirSync(autostart) : []).toEqual([]);
		} else {
			const openAtLogin = await app.evaluate(
				({ app }, { platform, arg }) =>
					app.getLoginItemSettings(platform === 'win32' ? { args: [arg] } : {}).openAtLogin,
				{ platform: process.platform, arg: LOGIN_LAUNCH_ARG }
			);
			expect(openAtLogin).toBe(false);
		}
		expect(existsSync(join(userData, MARKER_FILE_NAME))).toBe(false);
	} finally {
		await desktop?.close();
		for (const dir of [userData, cwd, elsewhere]) rmSync(dir, { recursive: true, force: true });
	}
});
