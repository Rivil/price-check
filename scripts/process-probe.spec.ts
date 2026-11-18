// Pins the process probe's parsers (spec c-5, c-6): ConvertTo-Json's single-object
// and empty outputs, PowerShell 5.1's /Date(ms)/ dates, and pid -> 127.0.0.1 port maps
// from `ss -Hltnp` and Get-NetTCPConnection, where another pid's or a wildcard
// listener must never be taken for the app's server. Then the instance count: one
// socket held by several processes is one instance (PR #12's `ss` line, two pids on
// port 35029), and only distinct ports make more than one.
import { describe, expect, it } from 'vitest';
import {
	describeHolders,
	mainProcess,
	parseNetTcpListeners,
	parseProcCmdline,
	parseProcesses,
	parseProcStatusPpid,
	parsePsDate,
	parseSsListeners,
	pidsByPort,
	servingInstance,
	type ProcessDetail
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
});
