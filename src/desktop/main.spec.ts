// Pins main.ts's test-only output capture (05-release t-30, c-5). electron-updater
// starts the updated AppImage with stdio 'ignore', so the packaged update test reads
// what it printed and how it ended from a file PRICE_CHECK_E2E_OUTPUT_CAPTURE names.
// The variable is taken out of process.env before the server's env is built from it,
// and put back only for the hand-over to the installer, so the version an update
// starts captures too. What the capture writes must parse with the reader the test
// uses (scripts/process-probe.ts), and an unset variable must leave the updater as is.
//
// main.ts value-imports Electron and starts the app at module load, so Electron,
// electron-updater and runDesktop are mocked: the import builds nothing real.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { parseCaptureRecords } from '../../scripts/process-probe.ts';
import type { LifecycleUpdates } from './lifecycle.ts';
import type { CaptureProcess } from './main.ts';

vi.mock('electron', () => {
	const fake = {};
	return {
		app: {
			getPath: () => '/tmp/price-check-main-spec',
			getVersion: () => '0.0.0',
			isPackaged: false
		},
		autoUpdater: fake,
		BrowserWindow: fake,
		dialog: { showErrorBox: () => {} },
		Menu: fake,
		Notification: fake,
		powerMonitor: fake,
		shell: fake,
		Tray: fake
	};
});
vi.mock('electron-updater', () => ({ default: {} }));
vi.mock('./lifecycle.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('./lifecycle.ts')>()),
	runDesktop: () => new Promise(() => {})
}));

const { OUTPUT_CAPTURE_ENV, startOutputCapture, takeOutputCaptureFile, withCaptureHandOver } =
	await import('./main.ts');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const mainSource = readFileSync(join(HERE, 'main.ts'), 'utf8');

const FILE = '/tmp/capture/output-capture.jsonl';
const AT = new Date('2026-11-18T09:00:00.000Z');

type Listener = (...args: never[]) => void;

/** A process slice whose streams record what reached them, and its listeners by event. */
function fakeProcess() {
	const written = { stdout: [] as unknown[][], stderr: [] as unknown[][] };
	const listeners = new Map<string, Listener>();
	const proc: CaptureProcess = {
		pid: 4242,
		ppid: 4200,
		argv: ['/tmp/.mount_price/price-check', '--flag'],
		stdout: {
			write: (...args) => {
				written.stdout.push(args);
				return true;
			}
		},
		stderr: {
			write: (...args) => {
				written.stderr.push(args);
				return false;
			}
		},
		on(event: string, listener: Listener) {
			listeners.set(event, listener);
			return proc;
		}
	};
	return { proc, written, listeners };
}

/** startOutputCapture over a fake process, its appended lines kept in order. */
function captured() {
	const fake = fakeProcess();
	const lines: string[] = [];
	startOutputCapture(
		FILE,
		fake.proc,
		(file, line) => {
			expect(file).toBe(FILE);
			lines.push(line);
		},
		() => AT
	);
	return { ...fake, lines };
}

describe('takeOutputCaptureFile', () => {
	it('returns the absolute file the variable names and removes it from the env', () => {
		const env: NodeJS.ProcessEnv = { [OUTPUT_CAPTURE_ENV]: FILE, PATH: '/usr/bin' };
		expect(takeOutputCaptureFile(env)).toBe(FILE);
		expect(env).toEqual({ PATH: '/usr/bin' });
	});

	it('takes a relative or empty value as no file, and still removes it', () => {
		for (const value of ['capture.jsonl', '']) {
			const env: NodeJS.ProcessEnv = { [OUTPUT_CAPTURE_ENV]: value };
			expect(takeOutputCaptureFile(env), value).toBeNull();
			expect(OUTPUT_CAPTURE_ENV in env).toBe(false);
		}
	});

	it('is null when the variable is unset', () => {
		expect(takeOutputCaptureFile({})).toBeNull();
	});
});

describe('startOutputCapture', () => {
	it('appends the start, each write, an uncaught error and the exit, each one JSON line', () => {
		const { proc, lines, listeners } = captured();
		proc.stdout.write('[desktop] listening on http://127.0.0.1:4000\n');
		proc.stderr.write(new TextEncoder().encode('lost the lock\n'));
		const error = new Error('boom');
		(listeners.get('uncaughtExceptionMonitor') as (e: Error, o: string) => void)(
			error,
			'unhandledRejection'
		);
		(listeners.get('exit') as (code: number) => void)(3);

		expect(lines.every((line) => line.endsWith('\n') && !line.slice(0, -1).includes('\n'))).toBe(
			true
		);
		expect(parseCaptureRecords(lines.join(''))).toEqual([
			{ pid: 4242, at: AT, kind: 'start', ppid: 4200, argv: proc.argv },
			{
				pid: 4242,
				at: AT,
				kind: 'stdout',
				text: '[desktop] listening on http://127.0.0.1:4000\n'
			},
			{ pid: 4242, at: AT, kind: 'stderr', text: 'lost the lock\n' },
			{ pid: 4242, at: AT, kind: 'error', origin: 'unhandledRejection', text: error.stack },
			{ pid: 4242, at: AT, kind: 'exit', code: 3 }
		]);
	});

	it('still writes every chunk through, with its arguments and result', () => {
		const { proc, written } = captured();
		const done = () => {};
		expect(proc.stdout.write('out', 'utf8', done)).toBe(true);
		const bytes = new Uint8Array([104, 105]);
		expect(proc.stderr.write(bytes)).toBe(false);
		expect(written.stdout).toEqual([['out', 'utf8', done]]);
		expect(written.stderr).toEqual([[bytes]]);
	});

	it('watches uncaught errors only through the monitor, never as a handler', () => {
		const { listeners } = captured();
		expect([...listeners.keys()].sort()).toEqual(['exit', 'uncaughtExceptionMonitor']);
	});

	it('never throws when the append fails, and the writes still go through', () => {
		const { proc, written } = fakeProcess();
		expect(() =>
			startOutputCapture(FILE, proc, () => {
				throw new Error('ENOENT');
			})
		).not.toThrow();
		expect(proc.stdout.write('still printed')).toBe(true);
		expect(written.stdout).toEqual([['still printed']]);
	});
});

describe('withCaptureHandOver', () => {
	it('passes the updater as is when there is no capture file', () => {
		const given: LifecycleUpdates = { pending: () => true, installOnExit: () => true };
		const env: NodeJS.ProcessEnv = {};
		expect(withCaptureHandOver(given, null, env)).toBe(given);
		expect(env).toEqual({});
	});

	it('puts the variable back into the env before handing over to the installer', () => {
		const env: NodeJS.ProcessEnv = {};
		/** The variable as the installer's spawn would read it, at each hand-over. */
		const seen: (string | undefined)[] = [];
		const installOnExit = vi.fn<LifecycleUpdates['installOnExit']>(() => {
			seen.push(env[OUTPUT_CAPTURE_ENV]);
			return false;
		});
		const wrapped = withCaptureHandOver({ pending: () => true, installOnExit }, FILE, env);
		expect(wrapped.pending()).toBe(true);
		expect(env[OUTPUT_CAPTURE_ENV]).toBeUndefined();
		expect(wrapped.installOnExit('restart')).toBe(false);
		expect(installOnExit).toHaveBeenCalledWith('restart');
		expect(seen).toEqual([FILE]);
	});
});

describe('main.ts wiring of the capture', () => {
	it('takes the capture file from process.env and starts it before anything else runs', () => {
		const take = mainSource.indexOf('takeOutputCaptureFile(process.env)');
		const start = mainSource.indexOf('startOutputCapture(outputCapture, process)');
		expect(take).toBeGreaterThan(-1);
		expect(start).toBeGreaterThan(take);
		for (const later of ['desktopPaths(', 'createLoginItem(', 'createUpdater(', 'runDesktop(']) {
			expect(mainSource.indexOf(later), later).toBeGreaterThan(start);
		}
	});

	it('hands runDesktop the updater through withCaptureHandOver, with the same env', () => {
		expect(mainSource).toMatch(
			/updates:\s*withCaptureHandOver\(\s*updater,\s*outputCapture,\s*process\.env\s*\)/
		);
	});

	it('names the same variable as the packaged update test', () => {
		const launcher = readFileSync(join(ROOT, 'e2e', 'packaged', 'launch-packaged.ts'), 'utf8');
		expect(launcher).toContain(`export const OUTPUT_CAPTURE_ENV = '${OUTPUT_CAPTURE_ENV}';`);
	});
});
