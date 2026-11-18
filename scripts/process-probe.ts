// Parsers for the packaged update test's process probe (spec c-5, c-6). After an
// update's relaunch the test finds the new app process by install path, checks it
// started after the old one exited, and reads which 127.0.0.1 port it serves on.
// The test runs the OS commands; these pure functions read their output and decide
// which process is the instance serving a port:
//
//   win32: Get-Process | Select-Object Id,Path,StartTime | ConvertTo-Json
//          (or Get-CimInstance Win32_Process ... ProcessId,ExecutablePath,CreationDate)
//          Get-NetTCPConnection -State Listen | Select-Object LocalAddress,LocalPort,
//            OwningProcess,State | ConvertTo-Json
//   linux: ss -Hltnp
//
// ConvertTo-Json emits a bare object, not an array, for a single result, and nothing
// at all for none. Windows PowerShell 5.1 writes dates as \/Date(<ms>)\/, PowerShell 7
// as ISO 8601 strings. Only 127.0.0.1 listeners count: the app's server binds there,
// and a 0.0.0.0 or [::] listener belongs to something else.
//
// One listening socket is one instance, however many processes hold it: `ss` lists
// every process sharing a socket in one users:(...) entry, so pids are grouped by port
// (pidsByPort) and the instance's main process picked from them (mainProcess, by
// /proc/<pid>/status and cmdline on linux). servingInstance throws only when more than
// one distinct port is served, naming each holder's pid, ppid and cmdline.
//
// When a step fails, the test records what the OS shows: on linux each holder's
// State and wchan (withProcState), on win32 every instance row, one with no port
// included (describeInstances).
//
// Node built-ins only.

export type ProcessInfo = {
	pid: number;
	/** The executable's full path; null when the OS withheld it. */
	path: string | null;
	/** null when the OS withheld it. */
	startTime: Date | null;
};

/** pid -> the 127.0.0.1 TCP ports it listens on, ascending. */
export type ListenMap = Map<number, number[]>;

const LOOPBACK = '127.0.0.1';

/** /Date(<ms>)/ with an optional DateTimeOffset suffix, as ConvertTo-Json writes it. */
const MS_DATE = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/;

/** NetTCPState Listen, as a number (default) or with -EnumsAsStrings. */
const LISTEN_STATES: readonly unknown[] = [2, 'Listen'];

type Row = Record<string, unknown>;

/** ConvertTo-Json output as rows: '' -> [], one object -> [it], an array as is. */
function jsonRows(json: string, what: string): Row[] {
	const text = json.trim();
	if (text === '') return [];
	const value: unknown = JSON.parse(text);
	const rows = Array.isArray(value) ? value : [value];
	for (const row of rows) {
		if (row === null || typeof row !== 'object' || Array.isArray(row)) {
			throw new Error(`${what}: expected a JSON object per row, got ${JSON.stringify(row)}`);
		}
	}
	return rows as Row[];
}

function positiveInt(value: unknown, what: string): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
		throw new Error(`${what}: not a positive integer: ${JSON.stringify(value)}`);
	}
	return value;
}

function port(value: unknown, what: string): number {
	const n = positiveInt(value, what);
	if (n > 65535) throw new Error(`${what}: not a TCP port: ${n}`);
	return n;
}

/** A ConvertTo-Json date (string, /Date(ms)/, or 5.1's {value: ...} wrapper) or null. */
export function parsePsDate(value: unknown): Date | null {
	if (value === null || value === undefined) return null;
	if (typeof value === 'object' && !Array.isArray(value) && 'value' in value) {
		return parsePsDate((value as { value: unknown }).value);
	}
	if (typeof value !== 'string') throw new Error(`not a date: ${JSON.stringify(value)}`);
	const ms = MS_DATE.exec(value);
	const date = ms === null ? new Date(value) : new Date(Number(ms[1]));
	if (Number.isNaN(date.getTime())) throw new Error(`not a date: ${JSON.stringify(value)}`);
	return date;
}

function optionalString(value: unknown, what: string): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== 'string') throw new Error(`${what}: not a string: ${JSON.stringify(value)}`);
	return value === '' ? null : value;
}

/** Get-Process (Id, Path, StartTime) or Win32_Process (ProcessId, ExecutablePath, CreationDate) JSON. */
export function parseProcesses(json: string): ProcessInfo[] {
	return jsonRows(json, 'processes').map((row) => ({
		pid: positiveInt(row.Id ?? row.ProcessId, 'process pid'),
		path: optionalString(row.Path ?? row.ExecutablePath, 'process path'),
		startTime: parsePsDate(row.StartTime ?? row.CreationDate)
	}));
}

function add(map: ListenMap, pid: number, listenPort: number): void {
	const ports = map.get(pid) ?? [];
	if (!ports.includes(listenPort)) {
		ports.push(listenPort);
		ports.sort((a, b) => a - b);
	}
	map.set(pid, ports);
}

/** `ss -Hltnp` output: LISTEN lines on 127.0.0.1, each owning pid from users:((...)). */
export function parseSsListeners(text: string): ListenMap {
	const map: ListenMap = new Map();
	for (const line of text.split(/\r?\n/)) {
		const fields = line.trim().split(/\s+/);
		if (fields.length < 5 || fields[0] !== 'LISTEN') continue;
		const local = fields[3];
		const colon = local.lastIndexOf(':');
		if (colon === -1 || local.slice(0, colon) !== LOOPBACK) continue;
		const portText = local.slice(colon + 1);
		if (!/^\d+$/.test(portText)) continue;
		const listenPort = port(Number(portText), 'ss port');
		const users = fields.slice(5).join(' ');
		for (const match of users.matchAll(/\bpid=(\d+)\b/g)) {
			add(map, positiveInt(Number(match[1]), 'ss pid'), listenPort);
		}
	}
	return map;
}

/** Get-NetTCPConnection -State Listen JSON: 127.0.0.1 rows by OwningProcess. */
export function parseNetTcpListeners(json: string): ListenMap {
	const map: ListenMap = new Map();
	for (const row of jsonRows(json, 'Get-NetTCPConnection')) {
		if (row.State !== undefined && !LISTEN_STATES.includes(row.State)) continue;
		if (row.LocalAddress !== LOOPBACK) continue;
		add(map, positiveInt(row.OwningProcess, 'OwningProcess'), port(row.LocalPort, 'LocalPort'));
	}
	return map;
}

/** pid -> its 127.0.0.1 ports, inverted: port -> the pids holding it, both ascending. */
export function pidsByPort(map: ListenMap): Map<number, number[]> {
	const byPort = new Map<number, number[]>();
	for (const [pid, ports] of map) {
		for (const listenPort of ports) {
			const pids = byPort.get(listenPort) ?? [];
			if (!pids.includes(pid)) pids.push(pid);
			byPort.set(listenPort, pids);
		}
	}
	for (const pids of byPort.values()) pids.sort((a, b) => a - b);
	return new Map([...byPort].sort(([a], [b]) => a - b));
}

/** What the OS told about a process; null fields where it withheld them or it had exited. */
export type ProcessDetail = {
	pid: number;
	ppid: number | null;
	/** Its arguments, the executable first. */
	cmdline: string[] | null;
	/**
	 * Linux, for a failure's diagnosis only (withProcState): /proc/<pid>/status's State,
	 * e.g. 'S (sleeping)'. Absent where nobody read it, null where the OS withheld it.
	 */
	state?: string | null;
	/** Linux, as state: /proc/<pid>/wchan, the kernel function it waits in ('0': none). */
	wchan?: string | null;
};

/** The PPid line of /proc/<pid>/status, or null when there is none. */
export function parseProcStatusPpid(status: string): number | null {
	const match = /^PPid:\s*(\d+)\s*$/m.exec(status);
	return match === null ? null : Number(match[1]);
}

/** The State line of /proc/<pid>/status (e.g. 'D (disk sleep)'), or null when there is none. */
export function parseProcStatusState(status: string): string | null {
	const match = /^State:[ \t]*(\S.*?)[ \t]*$/m.exec(status);
	return match === null ? null : match[1];
}

/** /proc/<pid>/wchan, trimmed; null when empty. */
export function parseProcWchan(raw: string): string | null {
	const wchan = raw.trim();
	return wchan === '' ? null : wchan;
}

/**
 * `detail` with its state and wait channel, read through `read` (the contents of
 * /proc/<pid>/<file>, or null when the process is gone). Linux only: for the
 * diagnosis of a failed step, never for picking a process.
 */
export function withProcState(
	detail: ProcessDetail,
	read: (pid: number, file: 'status' | 'wchan') => string | null
): ProcessDetail {
	const status = read(detail.pid, 'status');
	const wchan = read(detail.pid, 'wchan');
	return {
		...detail,
		state: status === null ? null : parseProcStatusState(status),
		wchan: wchan === null ? null : parseProcWchan(wchan)
	};
}

/** /proc/<pid>/cmdline: NUL-separated arguments; empty for a zombie or kernel thread. */
export function parseProcCmdline(raw: string): string[] {
	const args = raw.split('\0');
	if (args.at(-1) === '') args.pop();
	return args;
}

/** A Chromium helper (renderer, GPU, zygote, utility): its cmdline carries --type=. */
function isHelper(detail: ProcessDetail): boolean {
	return detail.cmdline?.some((arg) => arg.startsWith('--type=')) ?? false;
}

/**
 * The main process among those holding one socket: not a Chromium helper, then not a
 * child of another holder (a child that inherited the socket), then the lowest pid.
 */
export function mainProcess(holders: readonly ProcessDetail[]): ProcessDetail {
	if (holders.length === 0) throw new Error('mainProcess: no process holds the socket');
	const pids = new Set(holders.map(({ pid }) => pid));
	const rank = (detail: ProcessDetail): number[] => [
		isHelper(detail) ? 1 : 0,
		detail.ppid !== null && pids.has(detail.ppid) ? 1 : 0,
		detail.pid
	];
	const before = (a: number[], b: number[]) => {
		for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
		return false;
	};
	return holders.reduce((best, detail) => (before(rank(detail), rank(best)) ? detail : best));
}

/**
 * One entry per holder: pid, ppid, state and wait channel where they were read
 * (withProcState), and cmdline, for the error or diagnosis that names them.
 */
export function describeHolders(holders: readonly ProcessDetail[]): string {
	return holders
		.map(({ pid, ppid, cmdline, state, wchan }) => {
			const args = cmdline === null ? '<cmdline unknown>' : JSON.stringify(cmdline);
			const proc = [
				state === undefined ? '' : ` state ${state ?? 'unknown'}`,
				wchan === undefined ? '' : ` wchan ${wchan ?? 'unknown'}`
			].join('');
			return `pid ${pid} (ppid ${ppid ?? 'unknown'})${proc} ${args}`;
		})
		.join('; ');
}

/**
 * One line per instance, a serving one or not (win32 lists a process with no port
 * too): its pid, port, start time and holders, for a failed step's diagnosis.
 */
export function describeInstances(
	instances: readonly {
		pid: number;
		port: number | null;
		startTime: Date | null;
		processes: readonly ProcessDetail[];
	}[]
): string {
	if (instances.length === 0) return 'no instance';
	return instances
		.map(
			({ pid, port, startTime, processes }) =>
				`pid ${pid} port ${port ?? 'none'} started ${startTime?.toISOString() ?? 'unknown'}: ${describeHolders(processes)}`
		)
		.join('\n');
}

/**
 * The instance serving on 127.0.0.1, or null while none is. Instances on one port are
 * one instance (the first is returned); more than one distinct port throws, naming
 * every holder of each.
 */
export function servingInstance<
	T extends { port: number | null; processes: readonly ProcessDetail[] }
>(instances: readonly T[]): T | null {
	const serving = instances.filter((instance) => instance.port !== null);
	const ports = new Set(serving.map(({ port }) => port));
	if (ports.size > 1) {
		const detail = serving
			.map(({ port, processes }) => `port ${port}: ${describeHolders(processes)}`)
			.join(' | ');
		throw new Error(`more than one instance is serving: ${detail}`);
	}
	return serving[0] ?? null;
}
