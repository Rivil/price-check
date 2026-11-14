// Parsers for the packaged update test's process probe (spec c-5, c-6). After an
// update's relaunch the test finds the new app process by install path, checks it
// started after the old one exited, and reads which 127.0.0.1 port it serves on.
// The test runs the OS commands; these pure functions read their output:
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
