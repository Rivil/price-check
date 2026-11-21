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
import { startSmtpServer } from '../../src/lib/server/testing/smtp-server.ts';
import {
	DB_FILE_NAME,
	KEY_FILE_NAME,
	launchDesktop,
	makeTempDir,
	seedV015,
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

/** A test-only v0.1.5 key: 32 bytes, not a secret. */
const V015_KEY = Buffer.from('v015-raw-alerts-key-0123456789ab');
/** The seeded SMTP login: test-only, checked at the local test SMTP server. */
const V015_USER = 'e2e-migrate';
const V015_PASSWORD = 'e2e-migrate-not-a-secret';

/** Whether the app's safeStorage wraps keys here, and the key file's text. */
async function keyFileState(app: DesktopApp['app'], userData: string) {
	const storage = await app.evaluate(
		({ safeStorage }, platform) => ({
			available: safeStorage.isEncryptionAvailable(),
			backend: platform === 'linux' ? safeStorage.getSelectedStorageBackend() : null
		}),
		process.platform
	);
	const realBackend =
		storage.available &&
		(process.platform !== 'linux' || /^(gnome_libsecret|kwallet\d*)$/.test(storage.backend ?? ''));
	return {
		realBackend,
		backend: storage.backend,
		text: readFileSync(join(userData, KEY_FILE_NAME), 'utf8')
	};
}

test('v0.1.5 key migrates', async () => {
	const userData = makeTempDir('v015-userdata');
	const certs = makeTempDir('v015-ca');
	const smtp = await startSmtpServer({ transport: 'starttls', cert: 'trusted' });
	const caFile = join(certs, 'smtp-test-ca.pem');
	writeFileSync(caFile, smtp.ca, 'utf8');
	await seedV015(userData, V015_KEY, {
		host: smtp.host,
		port: String(smtp.port),
		username: V015_USER,
		password: V015_PASSWORD,
		from: 'alerts@migrate.e2e.invalid',
		to: 'me@migrate.e2e.invalid'
	});
	const seededFile = readFileSync(join(userData, KEY_FILE_NAME));

	let desktop: DesktopApp | undefined;
	try {
		desktop = await launchDesktop({ userData, caFile });
		const page = await desktop.app.firstWindow({ timeout: 30_000 });
		await expect(page).toHaveURL(`${desktop.origin}/`, { timeout: 30_000 });

		// The file form follows the backend the app reports (c-24, c-25).
		const first = await keyFileState(desktop.app, userData);
		// macOS (mock keychain) and Windows (DPAPI) always have a backend: never let
		// the raw branch below pass there.
		if (process.platform !== 'linux') expect(first.realBackend, 'real backend').toBe(true);
		if (first.realBackend) {
			expect(first.text.startsWith(WRAPPED_PREFIX), `wrapped on ${first.backend}`).toBe(true);
			const unwrapped = await desktop.app.evaluate(
				({ safeStorage }, payload) => safeStorage.decryptString(Buffer.from(payload, 'base64')),
				first.text.trim().slice(WRAPPED_PREFIX.length)
			);
			expect(sha256(unwrapped) === sha256(V015_KEY.toString('base64')), 'same key').toBe(true);
		} else {
			expect(readFileSync(join(userData, KEY_FILE_NAME)).equals(seededFile), 'raw kept').toBe(true);
		}

		// The channel sealed under the old key still opens, and its Send test
		// authenticates at the local server with the seeded password.
		await page.goto(`${desktop.origin}/account/alerts`);
		const card = page.getByTestId('channel-smtp');
		await expect(card.getByTestId('current-smtp')).toContainText(smtp.host);
		await expect(card.getByTestId('current-smtp')).not.toContainText('could not be read');
		await card.getByRole('button', { name: 'Send test' }).click();
		await expect.poll(() => smtp.messages.length, { timeout: 20_000 }).toBe(1);
		expect(smtp.auths).toContainEqual({ username: V015_USER, password: V015_PASSWORD });
		expect(smtp.messages[0].auth).toEqual({ username: V015_USER, password: V015_PASSWORD });
		await desktop.close();
		desktop = undefined;

		// A second launch on the migrated file opens the same channel and leaves the file be.
		const migratedFile = readFileSync(join(userData, KEY_FILE_NAME));
		desktop = await launchDesktop({ userData, caFile });
		const again = await desktop.app.firstWindow({ timeout: 30_000 });
		await expect(again).toHaveURL(`${desktop.origin}/`, { timeout: 30_000 });
		await again.goto(`${desktop.origin}/account/alerts`);
		const card2 = again.getByTestId('channel-smtp');
		await expect(card2.getByTestId('current-smtp')).toContainText(smtp.host);
		await expect(card2.getByTestId('current-smtp')).not.toContainText('could not be read');
		expect(readFileSync(join(userData, KEY_FILE_NAME)).equals(migratedFile), 'file unchanged').toBe(
			true
		);
	} finally {
		await desktop?.close();
		await smtp.close();
		for (const dir of [userData, certs]) rmSync(dir, { recursive: true, force: true });
	}
});
