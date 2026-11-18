// Pins the process probe's parsers (spec c-5, c-6): ConvertTo-Json's single-object
// and empty outputs, PowerShell 5.1's /Date(ms)/ dates, and pid -> 127.0.0.1 port maps
// from `ss -Hltnp` and Get-NetTCPConnection, where another pid's or a wildcard
// listener must never be taken for the app's server. Then the instance count: one
// socket held by several processes is one instance (PR #12's `ss` line, two pids on
// port 35029), and only distinct ports make more than one. A failed step's diagnosis
// names each linux holder's state, wait channel and cmdline, and every win32 row, one
// with no port included. On linux only the app's own processes count: CI 44283563089's
// FUSE daemon, running the AppImage file itself, held a port alone and was no instance.
// A failed Windows relaunch names each update installer, still running or when it was
// seen gone, and every process it started: CI 44283563089's installer pid 7336 ran on
// past the relaunch budget, and what it was waiting on was never recorded.
// The Linux restart test's output capture (t-30): CI 44289826311's B started, never
// served and exited unseen, so each pid's start, argv, every write, uncaught error and
// exit code is read back and listed oldest pid first, a pid with no exit kept; and
// each of A's ports names every pid seen holding it. CI 44320066854's B (pid 10328) was
// alive and serving, yet no instance once its environ no longer named the AppImage: it
// counts by the socket it shares with the FUSE daemon. B's port is the one A never held,
// never a guess between two, and a failure names the port B announced.
import { describe, expect, it } from 'vitest';
import {
	addPortHolders,
	announcedPorts,
	appImageProcesses,
	describeHolders,
	describeInstallerTree,
	describeInstances,
	describePortHolders,
	formatCaptureRecords,
	instancesByPort,
	isAppImageApp,
	linuxAppHolder,
	linuxAppHolders,
	linuxProcDetail,
	mainProcess,
	parseCaptureRecords,
	parseNetTcpListeners,
	parseProcCmdline,
	parseProcEnviron,
	parseProcesses,
	parseProcExe,
	parseProcStatusPpid,
	parseProcStatusState,
	parseProcWchan,
	parsePsDate,
	parseSsListeners,
	parseWin32Processes,
	pidsByPort,
	processTree,
	servingInstance,
	servingPort,
	withProcState,
	type LinuxProc,
	type ProcessDetail,
	type WindowsProcess
} from './process-probe.ts';

const EXE = 'C:\\Users\\runneradmin\\AppData\\Local\\Programs\\price-check\\Price-Check.exe';

describe('parseProcesses', () => {
	it('reads a single Get-Process object (no array) as one process', () => {
		const json = JSON.stringify({ Id: 4242, Path: EXE, StartTime: '/Date(1731600000000)/' });
		expect(parseProcesses(json)).toEqual([
			{ pid: 4242, path: EXE, startTime: new Date(1731600000000) }
		]);
	});

	it('reads the escaped \\/Date(ms)\\/ Windows PowerShell writes as that instant', () => {
		const json = '{"Id":4242,"Path":"x","StartTime":"\\/Date(1731600000000)\\/"}';
		const [process] = parseProcesses(json);
		expect(process.startTime?.getTime()).toBe(1731600000000);
		expect(process.startTime?.toISOString()).toBe('2024-11-14T16:00:00.000Z');
	});

	it('reads an array, PowerShell 7 ISO dates and withheld fields', () => {
		const json = JSON.stringify([
			{ Id: 1, Path: EXE, StartTime: '2024-11-14T16:00:00.5+00:00' },
			{ Id: 2, Path: null, StartTime: null }
		]);
		expect(parseProcesses(json)).toEqual([
			{ pid: 1, path: EXE, startTime: new Date(1731600000500) },
			{ pid: 2, path: null, startTime: null }
		]);
	});

	it('reads Win32_Process rows (ProcessId, ExecutablePath, CreationDate)', () => {
		const json = JSON.stringify({
			ProcessId: 77,
			ExecutablePath: EXE,
			CreationDate: '/Date(1731600000000+0000)/'
		});
		expect(parseProcesses(json)).toEqual([
			{ pid: 77, path: EXE, startTime: new Date(1731600000000) }
		]);
	});

	it('reads a withheld (null, absent or blank) path as null', () => {
		const json = JSON.stringify([
			{ ProcessId: 4, ExecutablePath: null, CreationDate: null },
			{ Id: 5 },
			{ Id: 6, Path: '' }
		]);
		expect(parseProcesses(json)).toEqual([
			{ pid: 4, path: null, startTime: null },
			{ pid: 5, path: null, startTime: null },
			{ pid: 6, path: null, startTime: null }
		]);
	});

	it.each([
		['a number', '[4242]', '4242'],
		['null', '[null]', 'null'],
		['a string', '["4242"]', '"4242"'],
		['an array', '[[4242]]', '[4242]']
	])('names a row that is %s as no JSON object', (_case, json, row) => {
		expect(() => parseProcesses(json)).toThrow(
			`processes: expected a JSON object per row, got ${row}`
		);
	});

	it.each([
		['{"Id":"4242"}', 'process pid: not a positive integer: "4242"'],
		['{"Id":1.5}', 'process pid: not a positive integer: 1.5'],
		['{"Id":0}', 'process pid: not a positive integer: 0'],
		['{"Id":-1}', 'process pid: not a positive integer: -1'],
		['{"Path":"x"}', 'process pid: not a positive integer: undefined'],
		['{"Id":1,"Path":42}', 'process path: not a string: 42'],
		['{"Id":1,"StartTime":"yesterday"}', 'not a date: "yesterday"']
	])('names the bad field of %s', (json, message) => {
		expect(() => parseProcesses(json)).toThrow(message);
	});

	it('reads no output as no processes', () => {
		expect(parseProcesses('')).toEqual([]);
		expect(parseProcesses('  \r\n')).toEqual([]);
	});

	it.each([
		['a row without a pid', '{"Path":"x"}'],
		['a string pid', '{"Id":"4242"}'],
		['a non-object row', '[4242]'],
		['an unreadable date', '{"Id":1,"StartTime":"yesterday"}'],
		['not JSON', 'Get-Process : Cannot find a process']
	])('throws on %s', (_case, json) => {
		expect(() => parseProcesses(json)).toThrow();
	});
});

describe('parsePsDate', () => {
	it.each([
		['/Date(1731600000000)/', 1731600000000],
		['/Date(-1000)/', -1000],
		['/Date(1731600000000-0500)/', 1731600000000],
		[{ value: '/Date(1731600000000)/', DisplayHint: 2 }, 1731600000000]
	])('%j -> %d', (value, ms) => {
		expect(parsePsDate(value)?.getTime()).toBe(ms);
	});

	it('maps null and undefined to null', () => {
		expect(parsePsDate(null)).toBeNull();
		expect(parsePsDate(undefined)).toBeNull();
	});

	it.each(['/Date(1731600000000)/x', 'x/Date(1731600000000)/'])(
		'takes %j, /Date(ms)/ with more around it, for no date',
		(value) => {
			expect(() => parsePsDate(value)).toThrow(`not a date: ${JSON.stringify(value)}`);
		}
	);

	it('throws on a bare number, never reading it as epoch ms', () => {
		expect(() => parsePsDate(42)).toThrow('not a date: 42');
		expect(() => parsePsDate({ value: 42 })).toThrow('not a date: 42');
	});
});

describe('parseSsListeners', () => {
	const APP = 'LISTEN 0 511 127.0.0.1:40123 0.0.0.0:* users:(("price-check",pid=4242,fd=33))';

	it('maps the app line to pid 4242 -> 40123', () => {
		expect(parseSsListeners(APP)).toEqual(new Map([[4242, [40123]]]));
	});

	it('keeps other pids apart and never takes wildcard or non-loopback listeners', () => {
		const text = [
			APP,
			'LISTEN 0 4096 127.0.0.1:631 0.0.0.0:* users:(("cupsd",pid=900,fd=7))',
			'LISTEN 0 511 [::]:40124 [::]:* users:(("price-check",pid=4242,fd=34))',
			'LISTEN 0 511 0.0.0.0:40125 0.0.0.0:* users:(("price-check",pid=4242,fd=35))',
			'LISTEN 0 511 [::1]:40126 [::]:* users:(("price-check",pid=4242,fd=36))',
			'LISTEN 0 511 *:40127 *:* users:(("price-check",pid=4242,fd=37))',
			'LISTEN 0 511 127.0.0.10:40128 0.0.0.0:* users:(("price-check",pid=4242,fd=38))',
			'LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:* users:(("systemd-resolve",pid=500,fd=14))',
			''
		].join('\n');
		const map = parseSsListeners(text);
		expect(map.get(4242)).toEqual([40123]);
		expect(map.get(900)).toEqual([631]);
		expect(map.has(500)).toBe(false);
		expect([...map.keys()].sort((a, b) => a - b)).toEqual([900, 4242]);
	});

	it('takes every pid sharing a socket, and skips a line with no process (no -p rights)', () => {
		const text = [
			'LISTEN 0 511 127.0.0.1:5000 0.0.0.0:* users:(("a",pid=1,fd=3),("b",pid=2,fd=3))',
			'LISTEN 0 511 127.0.0.1:5001 0.0.0.0:*'
		].join('\n');
		expect(parseSsListeners(text)).toEqual(
			new Map([
				[1, [5000]],
				[2, [5000]]
			])
		);
	});

	it('lists each port of a pid once, ascending', () => {
		const text = [
			'LISTEN 0 511 127.0.0.1:9000 0.0.0.0:* users:(("x",pid=7,fd=3))',
			'LISTEN 0 511 127.0.0.1:8000 0.0.0.0:* users:(("x",pid=7,fd=4))',
			'LISTEN 0 511 127.0.0.1:8000 0.0.0.0:* users:(("x",pid=7,fd=4))'
		].join('\n');
		expect(parseSsListeners(text).get(7)).toEqual([8000, 9000]);
	});

	it('reads ss columns padded with runs of spaces, and indented lines', () => {
		const text = [
			'LISTEN 0      511        127.0.0.1:40123      0.0.0.0:*    users:(("price-check",pid=4242,fd=33))',
			'   LISTEN\t0 511 127.0.0.1:40200 0.0.0.0:* users:(("price-check",pid=4242,fd=34))  '
		].join('\n');
		expect(parseSsListeners(text)).toEqual(new Map([[4242, [40123, 40200]]]));
	});

	it('skips non-LISTEN, truncated and port-less lines', () => {
		const text = [
			'ESTAB 0 0 127.0.0.1:5000 127.0.0.1:6000 users:(("x",pid=3,fd=1))',
			'LISTEN 0 511',
			'LISTEN 0 511 127.0.0.1:70000',
			'LISTEN 0 511 127.0.0.1:* 0.0.0.0:* users:(("x",pid=4,fd=1))',
			'LISTEN 0 511 127.0.0.1:abc5 0.0.0.0:* users:(("x",pid=5,fd=1))',
			'LISTEN 0 511 127.0.0.1:5x 0.0.0.0:* users:(("x",pid=6,fd=1))'
		].join('\n');
		expect(parseSsListeners(text)).toEqual(new Map());
	});

	it('throws on a port out of TCP range, and on pid 0', () => {
		expect(parseSsListeners('LISTEN 0 511 127.0.0.1:65535 0.0.0.0:*')).toEqual(new Map());
		expect(() => parseSsListeners('LISTEN 0 511 127.0.0.1:65536 0.0.0.0:*')).toThrow(
			'ss port: not a TCP port: 65536'
		);
		expect(() =>
			parseSsListeners('LISTEN 0 511 127.0.0.1:5000 0.0.0.0:* users:(("x",pid=0,fd=3))')
		).toThrow('ss pid: not a positive integer: 0');
	});

	it('reads empty output as no listeners', () => {
		expect(parseSsListeners('')).toEqual(new Map());
	});
});

describe('parseNetTcpListeners', () => {
	const ROW = { LocalAddress: '127.0.0.1', LocalPort: 40123, OwningProcess: 4242, State: 2 };

	it('maps a single object (no array) to pid 4242 -> 40123', () => {
		expect(parseNetTcpListeners(JSON.stringify(ROW))).toEqual(new Map([[4242, [40123]]]));
	});

	it('keeps other pids apart and never takes 0.0.0.0, :: or a non-Listen row', () => {
		const json = JSON.stringify([
			ROW,
			{ ...ROW, OwningProcess: 999, LocalPort: 5357 },
			{ ...ROW, LocalAddress: '0.0.0.0', LocalPort: 40124 },
			{ ...ROW, LocalAddress: '::', LocalPort: 40125 },
			{ ...ROW, LocalAddress: '::1', LocalPort: 40126 },
			{ ...ROW, LocalPort: 40127, State: 5 },
			{ ...ROW, LocalPort: 40128, State: 'Established' }
		]);
		const map = parseNetTcpListeners(json);
		expect(map.get(4242)).toEqual([40123]);
		expect(map.get(999)).toEqual([5357]);
		expect(map.size).toBe(2);
	});

	it("accepts State 'Listen' (-EnumsAsStrings) and rows without State", () => {
		const json = JSON.stringify([
			{ ...ROW, State: 'Listen' },
			{ LocalAddress: '127.0.0.1', LocalPort: 40200, OwningProcess: 4242 }
		]);
		expect(parseNetTcpListeners(json).get(4242)).toEqual([40123, 40200]);
	});

	it('reads no output as no listeners and throws on a malformed row', () => {
		expect(parseNetTcpListeners('')).toEqual(new Map());
		expect(() => parseNetTcpListeners(JSON.stringify({ ...ROW, LocalPort: 'x' }))).toThrow(
			'LocalPort: not a positive integer: "x"'
		);
		expect(() => parseNetTcpListeners(JSON.stringify({ ...ROW, OwningProcess: 0 }))).toThrow(
			'OwningProcess: not a positive integer: 0'
		);
		expect(() => parseNetTcpListeners('[4242]')).toThrow(
			'Get-NetTCPConnection: expected a JSON object per row, got 4242'
		);
	});

	it('takes port 65535 and throws on 65536', () => {
		expect(parseNetTcpListeners(JSON.stringify({ ...ROW, LocalPort: 65535 }))).toEqual(
			new Map([[4242, [65535]]])
		);
		expect(() => parseNetTcpListeners(JSON.stringify({ ...ROW, LocalPort: 65536 }))).toThrow(
			'LocalPort: not a TCP port: 65536'
		);
	});
});

/** PR #12's Linux run: one socket on 35029, two pids in its users:(...) entry. */
const SHARED_SOCKET =
	'LISTEN 0 511 127.0.0.1:35029 0.0.0.0:* users:(("price-check",pid=9917,fd=40),("price-check",pid=9920,fd=40))';

const APPIMAGE = '/tmp/update-appimage-x/price-check.AppImage';
const MAIN: ProcessDetail = { pid: 9917, ppid: 9900, cmdline: [APPIMAGE] };
const HELPER: ProcessDetail = {
	pid: 9920,
	ppid: 9917,
	cmdline: [APPIMAGE, '--type=zygote', '--no-zygote-sandbox']
};

describe('pidsByPort', () => {
	it('reads the shared socket as one port held by both pids', () => {
		expect(pidsByPort(parseSsListeners(SHARED_SOCKET))).toEqual(new Map([[35029, [9917, 9920]]]));
	});

	it('keeps distinct ports apart, ports and pids ascending', () => {
		const text = [
			'LISTEN 0 511 127.0.0.1:41000 0.0.0.0:* users:(("b",pid=20,fd=3))',
			SHARED_SOCKET,
			'LISTEN 0 511 127.0.0.1:41000 0.0.0.0:* users:(("b",pid=12,fd=3))'
		].join('\n');
		const byPort = pidsByPort(parseSsListeners(text));
		expect([...byPort]).toEqual([
			[35029, [9917, 9920]],
			[41000, [12, 20]]
		]);
	});

	it('groups Get-NetTCPConnection rows by port too (one OwningProcess each)', () => {
		const row = { LocalAddress: '127.0.0.1', State: 2 };
		const json = JSON.stringify([
			{ ...row, LocalPort: 40123, OwningProcess: 4242 },
			{ ...row, LocalPort: 40200, OwningProcess: 4242 },
			{ ...row, LocalPort: 40123, OwningProcess: 4243 }
		]);
		expect([...pidsByPort(parseNetTcpListeners(json))]).toEqual([
			[40123, [4242, 4243]],
			[40200, [4242]]
		]);
	});

	it('lists a pid once under a port its map entry repeats', () => {
		expect(pidsByPort(new Map([[7, [80, 80]]]))).toEqual(new Map([[80, [7]]]));
	});

	it('reads no listeners as no ports', () => {
		expect(pidsByPort(new Map())).toEqual(new Map());
	});
});

describe('/proc readers', () => {
	it('reads PPid from /proc/<pid>/status', () => {
		const status =
			'Name:\tprice-check\nState:\tS (sleeping)\nTgid:\t9920\nPid:\t9920\nPPid:\t9917\nTracerPid:\t0\n';
		expect(parseProcStatusPpid(status)).toBe(9917);
		expect(parseProcStatusPpid('PPid:\t0\n')).toBe(0);
		expect(parseProcStatusPpid('Name:\tx\n')).toBeNull();
	});

	it('reads PPid with any whitespace around its value, and nothing else', () => {
		expect(parseProcStatusPpid('PPid:9917\n')).toBe(9917);
		expect(parseProcStatusPpid('PPid:  9917 \n')).toBe(9917);
		expect(parseProcStatusPpid('PPid:\t9917x\n')).toBeNull();
		expect(parseProcStatusPpid('PPid:\t12 34\n')).toBeNull();
		expect(parseProcStatusPpid('NSPPid:\t9917\n')).toBeNull();
	});

	it('splits /proc/<pid>/cmdline on NUL, without the trailing empty argument', () => {
		expect(parseProcCmdline(`${APPIMAGE}\0--type=zygote\0`)).toEqual([APPIMAGE, '--type=zygote']);
		expect(parseProcCmdline(`${APPIMAGE}\0`)).toEqual([APPIMAGE]);
		expect(parseProcCmdline('')).toEqual([]);
	});

	it('keeps the last argument when no NUL ends it', () => {
		expect(parseProcCmdline(`${APPIMAGE}\0--type=zygote`)).toEqual([APPIMAGE, '--type=zygote']);
	});
});

describe('mainProcess', () => {
	it('picks the holder that is no Chromium helper', () => {
		expect(mainProcess([HELPER, MAIN])).toBe(MAIN);
		expect(mainProcess([MAIN, HELPER])).toBe(MAIN);
	});

	it('knows a helper by --type= alone, even at a lower pid and with an outside parent', () => {
		const helper = { pid: 5, ppid: 1, cmdline: [APPIMAGE, '--type=renderer'] };
		const main = { pid: 9, ppid: 1, cmdline: [APPIMAGE, '--no-sandbox'] };
		expect(mainProcess([helper, main])).toBe(main);
		expect(mainProcess([main, helper])).toBe(main);
	});

	it('takes an unknown cmdline for no helper', () => {
		const unknown = { pid: 5, ppid: 1, cmdline: null };
		const main = { pid: 9, ppid: 1, cmdline: [APPIMAGE] };
		expect(mainProcess([main, unknown])).toBe(unknown);
	});

	it('then the holder whose parent holds no share of the socket', () => {
		const child = { pid: 9910, ppid: 9917, cmdline: [APPIMAGE] };
		expect(mainProcess([child, MAIN])).toBe(MAIN);
		expect(mainProcess([MAIN, child])).toBe(MAIN);
	});

	it('then the lowest pid, when nothing else tells them apart (win32, no details)', () => {
		const a = { pid: 30, ppid: null, cmdline: null };
		const b = { pid: 10, ppid: null, cmdline: null };
		expect(mainProcess([a, b])).toBe(b);
		expect(mainProcess([b, a])).toBe(b);
		expect(mainProcess([a])).toBe(a);
	});

	it('keeps the first of two details that rank alike (one pid listed twice)', () => {
		const first = { pid: 7, ppid: null, cmdline: null };
		const second = { pid: 7, ppid: null, cmdline: null };
		expect(mainProcess([first, second])).toBe(first);
	});

	it('throws on no holders', () => {
		expect(() => mainProcess([])).toThrow(/no process holds the socket/);
	});
});

describe('servingInstance', () => {
	const instance = (port: number | null, processes: ProcessDetail[]) => ({
		pid: processes[0].pid,
		port,
		processes
	});

	it('is null while nothing serves', () => {
		expect(servingInstance([])).toBeNull();
		expect(servingInstance([instance(null, [MAIN])])).toBeNull();
	});

	it('counts the shared socket as one instance', () => {
		const shared = instance(35029, [MAIN, HELPER]);
		expect(servingInstance([shared, instance(null, [{ pid: 5, ppid: 1, cmdline: [] }])])).toBe(
			shared
		);
		// The same port reported twice is still one instance.
		expect(servingInstance([shared, instance(35029, [HELPER])])).toBe(shared);
	});

	it('throws on two distinct ports, naming each holder with its ppid and cmdline', () => {
		const other: ProcessDetail = { pid: 10001, ppid: 1, cmdline: [APPIMAGE, '--flag'] };
		const run = () => servingInstance([instance(35029, [MAIN, HELPER]), instance(41000, [other])]);
		expect(run).toThrow(/^more than one instance is serving: /);
		expect(run).toThrow(
			`port 35029: pid 9917 (ppid 9900) ["${APPIMAGE}"]; pid 9920 (ppid 9917) ["${APPIMAGE}","--type=zygote","--no-zygote-sandbox"] | port 41000: pid 10001 (ppid 1) ["${APPIMAGE}","--flag"]`
		);
	});
});

describe('describeHolders', () => {
	it('marks what the OS withheld', () => {
		expect(describeHolders([{ pid: 7, ppid: null, cmdline: null }])).toBe(
			'pid 7 (ppid unknown) <cmdline unknown>'
		);
	});

	it("names a linux holder's state, wait channel and cmdline", () => {
		const hung = { ...MAIN, state: 'D (disk sleep)', wchan: 'fuse_wait_answer' };
		expect(describeHolders([hung, HELPER])).toBe(
			`pid 9917 (ppid 9900) state D (disk sleep) wchan fuse_wait_answer ["${APPIMAGE}"]; pid 9920 (ppid 9917) ["${APPIMAGE}","--type=zygote","--no-zygote-sandbox"]`
		);
	});

	it('marks a state or wait channel read but withheld as unknown', () => {
		expect(describeHolders([{ ...MAIN, state: null, wchan: null }])).toBe(
			`pid 9917 (ppid 9900) state unknown wchan unknown ["${APPIMAGE}"]`
		);
	});
});

describe('/proc state readers', () => {
	const STATUS =
		'Name:\tprice-check\nUmask:\t0022\nState:\tS (sleeping)\nPid:\t9917\nPPid:\t9900\n';

	it('reads State from /proc/<pid>/status', () => {
		expect(parseProcStatusState(STATUS)).toBe('S (sleeping)');
		expect(parseProcStatusState('State:  D (disk sleep) \n')).toBe('D (disk sleep)');
		expect(parseProcStatusState('Name:\tx\nPPid:\t1\n')).toBeNull();
		expect(parseProcStatusState('XState:\tR (running)\n')).toBeNull();
	});

	it('reads wchan trimmed, empty as null', () => {
		expect(parseProcWchan('do_epoll_wait')).toBe('do_epoll_wait');
		expect(parseProcWchan('0\n')).toBe('0');
		expect(parseProcWchan('')).toBeNull();
		expect(parseProcWchan(' \n')).toBeNull();
	});

	it("adds a holder's state and wchan, keeping its pid, ppid and cmdline", () => {
		const reads: string[] = [];
		const detail = withProcState(MAIN, (pid, file) => {
			reads.push(`${pid}/${file}`);
			return file === 'status' ? STATUS : 'futex_wait_queue\n';
		});
		expect(reads.sort()).toEqual(['9917/status', '9917/wchan']);
		expect(detail).toEqual({ ...MAIN, state: 'S (sleeping)', wchan: 'futex_wait_queue' });
		expect(describeHolders([detail])).toBe(
			`pid 9917 (ppid 9900) state S (sleeping) wchan futex_wait_queue ["${APPIMAGE}"]`
		);
	});

	it('reads a gone process as state and wchan null', () => {
		expect(withProcState(MAIN, () => null)).toEqual({ ...MAIN, state: null, wchan: null });
	});
});

describe('describeInstances', () => {
	const WIN = (pid: number): ProcessDetail => ({ pid, ppid: null, cmdline: null });

	it('lists every win32 row, one with no port included', () => {
		const text = describeInstances([
			{ pid: 4242, port: 40123, startTime: new Date(1731600000000), processes: [WIN(4242)] },
			{ pid: 4300, port: null, startTime: new Date(1731600005000), processes: [WIN(4300)] },
			{ pid: 4400, port: null, startTime: null, processes: [WIN(4400)] }
		]);
		expect(text.split('\n')).toEqual([
			'pid 4242 port 40123 started 2024-11-14T16:00:00.000Z: pid 4242 (ppid unknown) <cmdline unknown>',
			'pid 4300 port none started 2024-11-14T16:00:05.000Z: pid 4300 (ppid unknown) <cmdline unknown>',
			'pid 4400 port none started unknown: pid 4400 (ppid unknown) <cmdline unknown>'
		]);
	});

	it('names every holder of a linux instance with its state', () => {
		const hung = { ...MAIN, state: 'S (sleeping)', wchan: 'ep_poll' };
		expect(
			describeInstances([{ pid: 9917, port: 35029, startTime: null, processes: [hung, HELPER] }])
		).toBe(`pid 9917 port 35029 started unknown: ${describeHolders([hung, HELPER])}`);
	});

	it('says so when there is no instance at all', () => {
		expect(describeInstances([])).toBe('no instance');
	});
});

/** B's mount, which its runtime named in APPDIR, and A's, which the FUSE daemon inherited. */
const MOUNT = '/tmp/.mount_price-AbC123';
const MOUNT_A = '/tmp/.mount_price-XyZ789';

const environ = (vars: Record<string, string>) =>
	Object.entries(vars)
		.map(([name, value]) => `${name}=${value}\0`)
		.join('');

const proc = (
	pid: number,
	ppid: number,
	exe: string | null,
	vars: Record<string, string>,
	args: string[]
): LinuxProc => ({
	pid,
	environ: environ({ HOME: '/home/runner', ...vars }),
	exe,
	status: `Name:\tx\nState:\tS (sleeping)\nPid:\t${pid}\nPPid:\t${ppid}\n`,
	cmdline: args.map((arg) => `${arg}\0`).join('')
});

const APP_VARS = { APPIMAGE, APPDIR: MOUNT };
/** B's Electron main and its zygote, both run from the mount. */
const MAIN_PROC = proc(9917, 9900, `${MOUNT}/price-check`, APP_VARS, [APPIMAGE]);
const HELPER_PROC = proc(9920, 9917, `${MOUNT}/price-check`, APP_VARS, [
	APPIMAGE,
	'--type=zygote',
	'--no-zygote-sandbox'
]);
/** CI 44283563089's pid 10253: the AppImage's FUSE daemon, ppid 1, holding A's port alone. */
const DAEMON_PROC = proc(10253, 1, APPIMAGE, { APPIMAGE, APPDIR: MOUNT_A }, [APPIMAGE]);

describe('/proc environ and exe readers', () => {
	it('reads a variable from /proc/<pid>/environ, null when absent', () => {
		const text = environ({ APPIMAGE, APPDIR: MOUNT, EMPTY: '' });
		expect(parseProcEnviron(text, 'APPIMAGE')).toBe(APPIMAGE);
		expect(parseProcEnviron(text, 'APPDIR')).toBe(MOUNT);
		expect(parseProcEnviron(text, 'EMPTY')).toBe('');
		expect(parseProcEnviron(text, 'APP')).toBeNull();
		expect(parseProcEnviron('', 'APPIMAGE')).toBeNull();
	});

	it("reads /proc/<pid>/exe without the kernel's ' (deleted)', empty as null", () => {
		expect(parseProcExe(`${MOUNT}/price-check`)).toBe(`${MOUNT}/price-check`);
		expect(parseProcExe(`${APPIMAGE} (deleted)`)).toBe(APPIMAGE);
		expect(parseProcExe('')).toBeNull();
	});

	it("reads a process's pid, ppid, cmdline and exe, null where /proc withheld them", () => {
		expect(linuxProcDetail(DAEMON_PROC)).toEqual({
			pid: 10253,
			ppid: 1,
			cmdline: [APPIMAGE],
			exe: APPIMAGE
		});
		expect(
			linuxProcDetail({ pid: 5, environ: null, exe: null, status: null, cmdline: null })
		).toEqual({ pid: 5, ppid: null, cmdline: null, exe: null });
	});
});

describe('isAppImageApp', () => {
	it('keeps the Electron main and its helpers, run from the mount APPDIR names', () => {
		expect(isAppImageApp(MAIN_PROC, APPIMAGE)).toBe(true);
		expect(isAppImageApp(HELPER_PROC, APPIMAGE)).toBe(true);
		expect(linuxAppHolder(MAIN_PROC, APPIMAGE)).toEqual({
			pid: 9917,
			ppid: 9900,
			cmdline: [APPIMAGE],
			exe: `${MOUNT}/price-check`
		});
	});

	it('rejects the AppImage runtime or FUSE daemon, whose exe is the AppImage file', () => {
		expect(isAppImageApp(DAEMON_PROC, APPIMAGE)).toBe(false);
		expect(linuxAppHolder(DAEMON_PROC, APPIMAGE)).toBeNull();
		// The same, its APPDIR its own mount, and once its file was renamed over.
		const own = proc(10253, 1, APPIMAGE, APP_VARS, [APPIMAGE]);
		expect(isAppImageApp(own, APPIMAGE)).toBe(false);
		const replaced = proc(10253, 1, `${APPIMAGE} (deleted)`, APP_VARS, [APPIMAGE]);
		expect(isAppImageApp(replaced, APPIMAGE)).toBe(false);
	});

	it('rejects an exe outside the mount, or a mount whose name only starts the same', () => {
		expect(isAppImageApp(proc(1, 1, '/usr/bin/bash', APP_VARS, ['bash']), APPIMAGE)).toBe(false);
		expect(isAppImageApp(proc(1, 1, `${MOUNT}9/price-check`, APP_VARS, []), APPIMAGE)).toBe(false);
		expect(isAppImageApp(proc(1, 1, MOUNT, APP_VARS, []), APPIMAGE)).toBe(false);
		expect(
			isAppImageApp(
				proc(1, 1, `${MOUNT}/price-check`, { APPIMAGE, APPDIR: `${MOUNT}/` }, []),
				APPIMAGE
			)
		).toBe(true);
	});

	it("rejects another AppImage's process, and one with no APPDIR, exe or environ", () => {
		const other = { APPIMAGE: '/opt/other.AppImage', APPDIR: MOUNT };
		expect(isAppImageApp(proc(1, 1, `${MOUNT}/price-check`, other, []), APPIMAGE)).toBe(false);
		expect(isAppImageApp(proc(1, 1, `${MOUNT}/price-check`, { APPIMAGE }, []), APPIMAGE)).toBe(
			false
		);
		expect(isAppImageApp({ ...MAIN_PROC, exe: null }, APPIMAGE)).toBe(false);
		expect(isAppImageApp({ ...MAIN_PROC, environ: null }, APPIMAGE)).toBe(false);
	});
});

describe('instancesByPort (linux holders)', () => {
	const procs = new Map([MAIN_PROC, HELPER_PROC, DAEMON_PROC].map((p) => [p.pid, p]));
	const holder = (pid: number) => {
		const found = procs.get(pid);
		return found === undefined ? null : linuxAppHolder(found, APPIMAGE);
	};

	it("finds no instance on a port only the FUSE daemon holds (CI 44283563089's 41677)", () => {
		const ss = 'LISTEN 0 10 127.0.0.1:41677 0.0.0.0:* users:(("price-check.App",pid=10253,fd=7))';
		expect(instancesByPort(parseSsListeners(ss), holder)).toEqual([]);
	});

	it('finds the app on its own port beside the orphaned one, its holders the app only', () => {
		const ss = [
			'LISTEN 0 10 127.0.0.1:41677 0.0.0.0:* users:(("price-check.App",pid=10253,fd=7))',
			'LISTEN 0 511 127.0.0.1:35029 0.0.0.0:* users:(("price-check",pid=9917,fd=40),("price-check",pid=9920,fd=40),("price-check.App",pid=10253,fd=40))'
		].join('\n');
		const main = linuxAppHolder(MAIN_PROC, APPIMAGE);
		const helper = linuxAppHolder(HELPER_PROC, APPIMAGE);
		expect(instancesByPort(parseSsListeners(ss), holder)).toEqual([
			{ pid: 9917, port: 35029, processes: [main, helper] }
		]);
	});

	it("skips a port no holder of which is the app's, and keeps distinct app ports apart", () => {
		const ss = [
			'LISTEN 0 10 127.0.0.1:5000 0.0.0.0:* users:(("other",pid=777,fd=3))',
			'LISTEN 0 10 127.0.0.1:41000 0.0.0.0:* users:(("price-check",pid=9920,fd=9))',
			SHARED_SOCKET
		].join('\n');
		expect(
			instancesByPort(parseSsListeners(ss), holder).map(({ pid, port }) => ({ pid, port }))
		).toEqual([
			{ pid: 9917, port: 35029 },
			{ pid: 9920, port: 41000 }
		]);
	});
});

describe('linuxAppHolders', () => {
	/** CI 44320066854: A's port 37443, inherited by B's main and its FUSE daemon; B's own 38463. */
	const B_SS = [
		'LISTEN 0 10 127.0.0.1:37443 0.0.0.0:* users:(("price-check",pid=10328,fd=41),("price-check.App",pid=10331,fd=41))',
		'LISTEN 0 511 127.0.0.1:38463 0.0.0.0:* users:(("price-check",pid=10328,fd=52))'
	].join('\n');
	/** B's FUSE daemon: the AppImage file, A's variables inherited from before its runtime set B's. */
	const B_DAEMON = proc(10331, 1, APPIMAGE, { APPIMAGE, APPDIR: MOUNT_A }, [APPIMAGE]);
	/** B's Electron main once its environ was overwritten (Chromium's process title). */
	const B_MAIN: LinuxProc = {
		...proc(10328, 1, `${MOUNT}/price-check`, {}, [`${MOUNT}/price-check`]),
		environ: `${MOUNT}/price-check\0\0\0\0`
	};
	const instances = (procs: LinuxProc[], ss: string) => {
		const listeners = parseSsListeners(ss);
		const holders = linuxAppHolders(procs, listeners, APPIMAGE);
		return instancesByPort(listeners, (pid) => holders.get(pid) ?? null);
	};

	it("counts B's main by the socket it shares with the FUSE daemon, its environ overwritten", () => {
		const main = linuxProcDetail(B_MAIN);
		expect(instances([B_MAIN, B_DAEMON], B_SS)).toEqual([
			{ pid: 10328, port: 37443, processes: [main] },
			{ pid: 10328, port: 38463, processes: [main] }
		]);
	});

	it("counts it too when its environ still names the AppImage beside A's inherited APPDIR", () => {
		const inherited = proc(10328, 1, `${MOUNT}/price-check`, { APPIMAGE, APPDIR: MOUNT_A }, []);
		expect(isAppImageApp(inherited, APPIMAGE)).toBe(false);
		expect([
			...linuxAppHolders([inherited, B_DAEMON], parseSsListeners(B_SS), APPIMAGE).keys()
		]).toEqual([10328]);
	});

	it('never counts the runtime or FUSE daemon, alone on a port or sharing one', () => {
		const alone =
			'LISTEN 0 10 127.0.0.1:41677 0.0.0.0:* users:(("price-check.App",pid=10331,fd=7))';
		expect(instances([B_DAEMON], alone)).toEqual([]);
		const listeners = parseSsListeners(B_SS);
		expect(linuxAppHolders([B_MAIN, B_DAEMON], listeners, APPIMAGE).has(10331)).toBe(false);
		const replaced = proc(10331, 1, `${APPIMAGE} (deleted)`, {}, [APPIMAGE]);
		expect([...linuxAppHolders([B_MAIN, replaced], listeners, APPIMAGE).keys()]).toEqual([10328]);
	});

	it('rejects a sharer naming another AppImage or withheld, and a cleared environ that shares nothing', () => {
		const other = proc(10328, 1, `${MOUNT}/price-check`, { APPIMAGE: '/opt/o.AppImage' }, []);
		const withheld: LinuxProc = { ...B_MAIN, exe: null };
		const listeners = parseSsListeners(B_SS);
		expect(linuxAppHolders([other, B_DAEMON], listeners, APPIMAGE).size).toBe(0);
		expect(linuxAppHolders([withheld, B_DAEMON], listeners, APPIMAGE).size).toBe(0);
		// Its own port only, and no daemon holds a socket: nothing ties it to the AppImage.
		const own = 'LISTEN 0 511 127.0.0.1:38463 0.0.0.0:* users:(("price-check",pid=10328,fd=52))';
		expect(instances([B_MAIN, B_DAEMON], own)).toEqual([]);
	});

	it('still counts an app process its environ names, with no daemon sharing a socket', () => {
		expect(instances([MAIN_PROC, HELPER_PROC], SHARED_SOCKET)).toEqual([
			{
				pid: 9917,
				port: 35029,
				processes: [linuxProcDetail(MAIN_PROC), linuxProcDetail(HELPER_PROC)]
			}
		]);
	});
});

describe('appImageProcesses', () => {
	it('lists the runtime, FUSE daemon and app processes, listening or not, by pid', () => {
		const stray = proc(40, 1, '/usr/bin/sleep', { HOME: '/root' }, ['sleep', '60']);
		const otherImage = proc(
			41,
			1,
			'/opt/o/AppRun',
			{ APPIMAGE: '/opt/o.AppImage', APPDIR: '/opt/o' },
			[]
		);
		// A helper whose environment no longer names the AppImage, run from its mount.
		const cleared = proc(9930, 9917, `${MOUNT}/chrome_crashpad_handler`, {}, ['crashpad']);
		const withheld: LinuxProc = { pid: 3, environ: null, exe: null, status: null, cmdline: null };
		const found = appImageProcesses(
			[DAEMON_PROC, cleared, stray, HELPER_PROC, withheld, otherImage, MAIN_PROC],
			APPIMAGE
		);
		expect(found.map(({ pid }) => pid)).toEqual([9917, 9920, 9930, 10253]);
		expect(found.at(-1)).toEqual(linuxProcDetail(DAEMON_PROC));
	});

	it("lists a process under the daemon's inherited mount too, and none when nothing runs", () => {
		const fromA = proc(8000, 1, `${MOUNT_A}/price-check`, {}, []);
		expect(appImageProcesses([fromA, DAEMON_PROC], APPIMAGE).map(({ pid }) => pid)).toEqual([
			8000, 10253
		]);
		expect(appImageProcesses([], APPIMAGE)).toEqual([]);
	});

	it('names each with its exe, ppid, state and wait channel', () => {
		const [daemon] = appImageProcesses([DAEMON_PROC], APPIMAGE);
		const read = withProcState(daemon, (_pid, file) =>
			file === 'status' ? 'State:\tS (sleeping)\n' : 'fuse_dev_do_read'
		);
		expect(describeHolders([read])).toBe(
			`pid 10253 (ppid 1) exe ${APPIMAGE} state S (sleeping) wchan fuse_dev_do_read ["${APPIMAGE}"]`
		);
		expect(describeHolders([{ pid: 3, ppid: null, cmdline: null, exe: null }])).toBe(
			'pid 3 (ppid unknown) exe unknown <cmdline unknown>'
		);
	});
});

const INSTALLER_EXE = 'C:\\Users\\runneradmin\\AppData\\Local\\Temp\\price-check-0.1.6-win-x64.exe';
const INSTALLER_START = new Date('2026-11-17T10:23:48.000Z');
const INSTALLER = { pid: 7336, path: INSTALLER_EXE, startTime: INSTALLER_START };
const READ_AT = new Date('2026-11-17T10:26:51.000Z');

function win(
	pid: number,
	ppid: number | null,
	name: string | null,
	startTime: string | null
): WindowsProcess {
	return {
		pid,
		ppid,
		name,
		path: null,
		startTime: startTime === null ? null : new Date(startTime)
	};
}

// The installer, its uninstaller-copy child, that child's PowerShell, a stray process and
// one whose ParentProcessId names 7336 but which started before the installer: an older
// 7336's child (pid reuse), with a child of its own.
const INSTALLER_ROW = win(7336, 5000, 'price-check-0.1.6-win-x64.exe', '2026-11-17T10:23:48.000Z');
const CHILD = win(7400, 7336, 'Un_A.exe', '2026-11-17T10:23:50.000Z');
const GRANDCHILD = win(7500, 7400, 'powershell.exe', '2026-11-17T10:23:51.000Z');
const SECOND_CHILD = win(7450, 7336, 'conhost.exe', '2026-11-17T10:23:49.000Z');
const STRAY = win(9000, 1, 'svchost.exe', '2026-11-17T09:00:00.000Z');
const REUSED = win(6100, 7336, 'old-child.exe', '2026-11-17T08:00:00.000Z');
const REUSED_CHILD = win(6200, 6100, 'old-grandchild.exe', '2026-11-17T08:00:01.000Z');
const TREE = [STRAY, GRANDCHILD, REUSED_CHILD, INSTALLER_ROW, SECOND_CHILD, REUSED, CHILD];

describe('parseWin32Processes', () => {
	it('reads a single object, ParentProcessId, Name and the System Idle Process', () => {
		const one = JSON.stringify({
			ProcessId: 7336,
			ParentProcessId: 5000,
			Name: 'price-check-0.1.6-win-x64.exe',
			ExecutablePath: INSTALLER_EXE,
			CreationDate: '/Date(1731600000000)/'
		});
		expect(parseWin32Processes(one)).toEqual([
			{
				pid: 7336,
				ppid: 5000,
				name: 'price-check-0.1.6-win-x64.exe',
				path: INSTALLER_EXE,
				startTime: new Date(1731600000000)
			}
		]);
		const idle = JSON.stringify([
			{ ProcessId: 0, ParentProcessId: 0, Name: 'System Idle Process', CreationDate: null },
			{ ProcessId: 4, ParentProcessId: null, Name: '', ExecutablePath: null }
		]);
		expect(parseWin32Processes(idle)).toEqual([
			{ pid: 0, ppid: 0, name: 'System Idle Process', path: null, startTime: null },
			{ pid: 4, ppid: null, name: null, path: null, startTime: null }
		]);
		expect(parseWin32Processes('')).toEqual([]);
	});

	it('rejects a row whose pid is no integer', () => {
		expect(() => parseWin32Processes('{"ProcessId":"7336"}')).toThrow(/ProcessId/);
		expect(() => parseWin32Processes('{"ProcessId":1,"ParentProcessId":-1}')).toThrow(
			/ParentProcessId/
		);
	});
});

describe('processTree', () => {
	it('lists children and grandchildren by ParentProcessId, pre-order, siblings by pid', () => {
		expect(processTree(TREE, INSTALLER).map(({ process, depth }) => [process.pid, depth])).toEqual([
			[7400, 1],
			[7500, 2],
			[7450, 1]
		]);
	});

	it("leaves out a reused pid's older child and its subtree, and survives a cycle", () => {
		const pids = processTree(TREE, INSTALLER).map(({ process }) => process.pid);
		expect(pids).not.toContain(6100);
		expect(pids).not.toContain(6200);
		// Unknown start times cannot rule a child out.
		const loop = [win(1, 2, 'a', null), win(2, 1, 'b', null), win(3, 2, 'c', null)];
		expect(
			processTree(loop, { pid: 1, startTime: null }).map(({ process }) => process.pid)
		).toEqual([2, 3]);
		expect(processTree([STRAY], INSTALLER)).toEqual([]);
	});
});

describe('describeInstallerTree', () => {
	it("names a running installer as still running, with every descendant's pid and name", () => {
		const text = describeInstallerTree(INSTALLER, null, TREE, READ_AT);
		expect(text).toBe(
			[
				`installer pid 7336 started 2026-11-17T10:23:48.000Z ${INSTALLER_EXE}: still running at 2026-11-17T10:26:51.000Z`,
				'  pid 7400 Un_A.exe started 2026-11-17T10:23:50.000Z (ppid 7336)',
				'    pid 7500 powershell.exe started 2026-11-17T10:23:51.000Z (ppid 7400)',
				'  pid 7450 conhost.exe started 2026-11-17T10:23:49.000Z (ppid 7336)'
			].join('\n')
		);
		expect(text).not.toMatch(/exited/);
	});

	it('names it still running even when an earlier check had seen it gone', () => {
		const goneAt = new Date('2026-11-17T10:25:00.000Z');
		expect(describeInstallerTree(INSTALLER, goneAt, TREE, READ_AT).split('\n')[0]).toMatch(
			/: still running at 2026-11-17T10:26:51\.000Z$/
		);
	});

	it("names an exited installer's exit time, and lists the processes it left behind", () => {
		const goneAt = new Date('2026-11-17T10:25:30.000Z');
		const left = TREE.filter(({ pid }) => pid !== 7336);
		const text = describeInstallerTree(INSTALLER, goneAt, left, READ_AT);
		expect(text.split('\n')[0]).toBe(
			`installer pid 7336 started 2026-11-17T10:23:48.000Z ${INSTALLER_EXE}: exited by 2026-11-17T10:25:30.000Z`
		);
		expect(text).toContain('  pid 7400 Un_A.exe');
		expect(text).toContain('    pid 7500 powershell.exe');
		expect(text).not.toMatch(/still running/);
	});

	it('takes the read time as the exit time when this read first finds it gone', () => {
		const text = describeInstallerTree(INSTALLER, null, [STRAY], READ_AT);
		expect(text).toBe(
			`installer pid 7336 started 2026-11-17T10:23:48.000Z ${INSTALLER_EXE}: exited by 2026-11-17T10:26:51.000Z\n  no descendant process`
		);
	});

	it('takes a reused pid (a later start) as the installer gone', () => {
		const reused = win(7336, 1, 'notepad.exe', '2026-11-17T10:26:00.000Z');
		expect(describeInstallerTree(INSTALLER, null, [reused], READ_AT)).toMatch(
			/: exited by 2026-11-17T10:26:51\.000Z\n/
		);
	});
});

/** One capture line as main.ts writes it. */
const line = (fields: Record<string, unknown>) => JSON.stringify(fields);

const A_PID = 10140;
const B_PID = 10230;
const B_ARGV = ['/tmp/.mount_price-abc/price-check'];
/** A's records, then B's, interleaved in file order as two appending processes write them. */
const CAPTURE = [
	line({ pid: A_PID, at: '2026-11-18T09:00:00.000Z', kind: 'start', ppid: 9000, argv: ['/a'] }),
	line({ pid: A_PID, at: '2026-11-18T09:00:01.000Z', kind: 'stdout', text: 'A up\n' }),
	line({ pid: B_PID, at: '2026-11-18T09:03:00.000Z', kind: 'start', ppid: 10200, argv: B_ARGV }),
	line({ pid: A_PID, at: '2026-11-18T09:03:00.500Z', kind: 'exit', code: 0 }),
	line({
		pid: B_PID,
		at: '2026-11-18T09:03:01.000Z',
		kind: 'stderr',
		text: 'first line\nsecond line\n'
	}),
	line({
		pid: B_PID,
		at: '2026-11-18T09:03:02.000Z',
		kind: 'error',
		origin: 'uncaughtException',
		text: 'Error: boom\n    at main.js:1'
	}),
	line({ pid: B_PID, at: '2026-11-18T09:03:03.000Z', kind: 'exit', code: 7 })
].join('\n');

describe('parseCaptureRecords', () => {
	it('reads each kind of record with its pid and time', () => {
		const records = parseCaptureRecords(`${CAPTURE}\n`);
		expect(records).toHaveLength(7);
		expect(records[2]).toEqual({
			pid: B_PID,
			at: new Date('2026-11-18T09:03:00.000Z'),
			kind: 'start',
			ppid: 10200,
			argv: B_ARGV
		});
		expect(records[6]).toEqual({
			pid: B_PID,
			at: new Date('2026-11-18T09:03:03.000Z'),
			kind: 'exit',
			code: 7
		});
	});

	it('keeps a torn or foreign line as unreadable, skips blank ones, and never throws', () => {
		const text = ['{"pid":1,"kind":"std', '', 'plain text', line({ kind: 'exit', code: 1 })].join(
			'\n'
		);
		expect(parseCaptureRecords(text)).toEqual([
			{ kind: 'unreadable', line: '{"pid":1,"kind":"std' },
			{ kind: 'unreadable', line: 'plain text' },
			{ kind: 'unreadable', line: line({ kind: 'exit', code: 1 }) }
		]);
	});
});

describe('formatCaptureRecords', () => {
	const format = (text: string) => formatCaptureRecords(parseCaptureRecords(text));

	it("lists each pid's start, argv, every write line, error and exit code, oldest pid first", () => {
		expect(format(CAPTURE)).toBe(
			[
				`pid ${A_PID} (ppid 9000) started 2026-11-18T09:00:00.000Z argv ["/a"]`,
				'  2026-11-18T09:00:01.000Z stdout| A up',
				'  2026-11-18T09:03:00.500Z exit code 0',
				`pid ${B_PID} (ppid 10200) started 2026-11-18T09:03:00.000Z argv ${JSON.stringify(B_ARGV)}`,
				'  2026-11-18T09:03:01.000Z stderr| first line',
				'  2026-11-18T09:03:01.000Z stderr| second line',
				'  2026-11-18T09:03:02.000Z uncaughtException| Error: boom',
				'  2026-11-18T09:03:02.000Z uncaughtException|     at main.js:1',
				'  2026-11-18T09:03:03.000Z exit code 7'
			].join('\n')
		);
	});

	it('orders pids by start time, not by pid or file order', () => {
		const older = line({ pid: 900, at: '2026-11-18T08:00:00.000Z', kind: 'start', argv: [] });
		const newer = line({ pid: 100, at: '2026-11-18T09:00:00.000Z', kind: 'start', argv: [] });
		const pids = (text: string) => [...format(text).matchAll(/^pid (\d+)/gm)].map((m) => m[1]);
		expect(pids([newer, older].join('\n'))).toEqual(['900', '100']);
		// A pid with no start record is placed by its earliest record; an unknown time last.
		const noStart = line({ pid: 50, at: '2026-11-18T08:30:00.000Z', kind: 'stderr', text: 'x' });
		const noTime = line({ pid: 1, kind: 'stdout', text: 'y' });
		expect(pids([noTime, newer, noStart, older].join('\n'))).toEqual(['900', '50', '100', '1']);
	});

	it('keeps a pid with no exit record, and says it has none', () => {
		const text = format(
			[
				line({ pid: B_PID, at: '2026-11-18T09:03:00.000Z', kind: 'start', argv: B_ARGV }),
				line({ pid: B_PID, at: '2026-11-18T09:03:01.000Z', kind: 'stderr', text: 'waiting' })
			].join('\n')
		);
		expect(text).toMatch(new RegExp(`^pid ${B_PID} \\(ppid unknown\\) started`));
		expect(text).toContain('stderr| waiting');
		expect(text.split('\n').at(-1)).toMatch(/no exit record/);
	});

	it('names a pid with no start record, an exit with no code, and lists unreadable lines', () => {
		const text = format(
			[line({ pid: 7, at: '2026-11-18T09:00:00.000Z', kind: 'exit' }), 'garbage'].join('\n')
		);
		expect(text).toBe(
			[
				'pid 7: no start record',
				'  2026-11-18T09:00:00.000Z exit code unknown',
				'unreadable capture lines:',
				'  garbage'
			].join('\n')
		);
	});

	it('says so when there is no record at all', () => {
		expect(formatCaptureRecords([])).toBe('no capture record');
	});
});

describe('port holders of A', () => {
	it("collects every pid seen on each of A's ports across reads, and names them", () => {
		const seen = new Map<number, Set<number>>();
		const ports = [37257, 45413];
		addPortHolders(seen, ports, new Map([[10140, [37257, 45413]]]));
		addPortHolders(
			seen,
			ports,
			new Map([
				[10250, [45413]],
				[10251, [45413]],
				[777, [5000]]
			])
		);
		expect(describePortHolders(ports, seen)).toBe(
			'37257 held by pid 10140; 45413 held by pid 10140, 10250, 10251'
		);
		expect(describePortHolders([44125], seen)).toBe('44125 held by no pid seen');
	});
});

describe('servingPort', () => {
	/** CI 44320066854: A's ports before 'Restart to update', one of which B inherited. */
	const PORTS_A = [37257, 37443, 44125];

	it("picks the port A never held, never one of A's", () => {
		expect(servingPort([37443, 38463], PORTS_A)).toBe(38463);
		expect(servingPort([38463, 37443, 38463], PORTS_A)).toBe(38463);
		expect(servingPort([38463], [])).toBe(38463);
	});

	it("returns null while only A's ports, or none, are held", () => {
		expect(servingPort([37443], PORTS_A)).toBeNull();
		expect(servingPort([37443, 44125], PORTS_A)).toBeNull();
		expect(servingPort([], PORTS_A)).toBeNull();
	});

	it('refuses to guess between two ports A never held, naming both', () => {
		expect(() => servingPort([40000, 37443, 38463], PORTS_A)).toThrow(
			'more than one port could be the one served (excluded: 37257, 37443, 44125): 38463, 40000'
		);
		expect(() => servingPort([2, 1], [])).toThrow('(excluded: none): 1, 2');
	});
});

describe('announcedPorts', () => {
	const LISTENING_LINE = /^\[desktop\] listening on (http:\/\/127\.0\.0\.1:(\d+))\s*$/m;
	const portOf = (text: string) => {
		const match = LISTENING_LINE.exec(text);
		return match === null ? null : Number(match[2]);
	};

	it('names each port a stdout write announced, by pid, in file order', () => {
		const records = parseCaptureRecords(
			[
				line({
					pid: A_PID,
					kind: 'stdout',
					text: '[desktop] listening on http://127.0.0.1:37443\n'
				}),
				line({
					pid: B_PID,
					kind: 'stdout',
					text: '[updater] Update for version 0.1.6 is not available\n'
				}),
				// Not stdout: never an announcement, whatever it says.
				line({
					pid: B_PID,
					kind: 'stderr',
					text: '[desktop] listening on http://127.0.0.1:1111\n'
				}),
				line({
					pid: B_PID,
					kind: 'stdout',
					text: '[desktop] listening on http://127.0.0.1:38463\n'
				})
			].join('\n')
		);
		expect(announcedPorts(records, portOf)).toEqual([
			{ pid: A_PID, port: 37443 },
			{ pid: B_PID, port: 38463 }
		]);
		expect(announcedPorts([], portOf)).toEqual([]);
	});
});
