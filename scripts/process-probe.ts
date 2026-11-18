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
// On linux a holder counts only as an app process (linuxAppHolder): one the AppImage
// started (its APPIMAGE variable) whose /proc/<pid>/exe lies under the AppImage's mount
// (its APPDIR variable). The AppImage runtime and its FUSE daemon run the AppImage file
// itself and inherit APPIMAGE too, and can hold a listening socket the updater's spawn
// passed down from the old instance that nothing accept()s on: a port held only by them
// is no instance (CI 44283563089). That environment is not lasting: CI 44320066854's B
// (pid 10328) was alive and serving its own port, yet no instance, its /proc/<pid>/environ
// most likely overwritten by Chromium's process title. So a process whose environ no
// longer names the AppImage counts too when it shares a socket with the AppImage's
// runtime or FUSE daemon (linuxAppHolders): only the runtime's own launch chain inherits
// one. The runtime or daemon itself still never counts.
//
// After the Linux update's relaunch, B holds A's inherited socket as well as its own:
// servingPort picks the port B serves on with A's ports set aside, and refuses to guess
// between two. A failure names the port B announced in its output capture
// (announcedPorts) beside the one probed.
//
// When a step fails, the test records what the OS shows: on linux each holder's
// State and wchan (withProcState) and every process of the AppImage, listening or not
// (appImageProcesses), on win32 every instance row, one with no port included
// (describeInstances), and each update installer the test saw: whether it still runs
// or when it was first seen gone, and every process it started, grandchildren included
// (describeInstallerTree, over Get-CimInstance Win32_Process rows by ParentProcessId).
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

/** A ProcessId or ParentProcessId as Win32_Process gives it: 0 is the System Idle Process's. */
function nonNegativeInt(value: unknown, what: string): number {
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
		throw new Error(`${what}: not a non-negative integer: ${JSON.stringify(value)}`);
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
	/** Linux: /proc/<pid>/exe's target (parseProcExe). Absent where nobody read it. */
	exe?: string | null;
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

/** What /proc shows of one linux process; a field is null where it had exited or the OS withheld it. */
export type LinuxProc = {
	pid: number;
	/** /proc/<pid>/environ: NAME=value entries, NUL-separated. */
	environ: string | null;
	/** /proc/<pid>/exe's link target, as readlink gives it. */
	exe: string | null;
	/** /proc/<pid>/status. */
	status: string | null;
	/** /proc/<pid>/cmdline. */
	cmdline: string | null;
};

/** The value of `name` in /proc/<pid>/environ, or null when the process has no such variable. */
export function parseProcEnviron(environ: string, name: string): string | null {
	const entry = environ.split('\0').find((line) => line.startsWith(`${name}=`));
	return entry === undefined ? null : entry.slice(name.length + 1);
}

const DELETED = ' (deleted)';

/**
 * /proc/<pid>/exe's target without the ' (deleted)' the kernel appends once the file
 * was replaced (a renamed-over AppImage); null when empty.
 */
export function parseProcExe(link: string): string | null {
	const exe = link.endsWith(DELETED) ? link.slice(0, -DELETED.length) : link;
	return exe === '' ? null : exe;
}

/** True when `path` lies inside directory `dir` (never `dir` itself). */
function isUnder(path: string, dir: string): boolean {
	const prefix = dir.endsWith('/') ? dir : `${dir}/`;
	return prefix !== '/' && path.startsWith(prefix) && path.length > prefix.length;
}

/** `proc`'s executable and AppImage variables, null where /proc withheld them. */
function appImageFacts(proc: LinuxProc) {
	return {
		exe: proc.exe === null ? null : parseProcExe(proc.exe),
		appImage: proc.environ === null ? null : parseProcEnviron(proc.environ, 'APPIMAGE'),
		appDir: proc.environ === null ? null : parseProcEnviron(proc.environ, 'APPDIR')
	};
}

/** `proc` as a ProcessDetail: pid, ppid, cmdline and exe, null where /proc withheld them. */
export function linuxProcDetail(proc: LinuxProc): ProcessDetail {
	return {
		pid: proc.pid,
		ppid: proc.status === null ? null : parseProcStatusPpid(proc.status),
		cmdline: proc.cmdline === null ? null : parseProcCmdline(proc.cmdline),
		exe: proc.exe === null ? null : parseProcExe(proc.exe)
	};
}

/**
 * True when `proc` is a process of the app the AppImage at `appImage` started: its
 * APPIMAGE variable names that file and its executable lies under the mount its
 * APPDIR variable names (the Electron main and its helpers). The AppImage runtime and
 * its FUSE daemon, whose executable is the AppImage file itself, never are; nor is a
 * process whose executable /proc withheld.
 */
export function isAppImageApp(proc: LinuxProc, appImage: string): boolean {
	const facts = appImageFacts(proc);
	if (facts.appImage !== appImage || facts.exe === null || facts.exe === appImage) return false;
	return facts.appDir !== null && isUnder(facts.exe, facts.appDir);
}

/** `proc`'s detail when it is a process of the app at `appImage` (isAppImageApp), else null. */
export function linuxAppHolder(proc: LinuxProc, appImage: string): ProcessDetail | null {
	return isAppImageApp(proc, appImage) ? linuxProcDetail(proc) : null;
}

/**
 * The app's processes among `procs` (each listening pid's /proc entry), by pid, with
 * their detail. A process counts when isAppImageApp says so, or when it shares a
 * 127.0.0.1 listening socket (`listeners`) with a process running the AppImage file
 * itself (its runtime or FUSE daemon) and its environ names no other AppImage: the
 * socket came down the runtime's launch chain, whether or not /proc still shows the
 * variables the runtime set. A process whose executable /proc withheld, and the runtime
 * or daemon itself, never count.
 */
export function linuxAppHolders(
	procs: readonly LinuxProc[],
	listeners: ListenMap,
	appImage: string
): Map<number, ProcessDetail> {
	const runtimePorts = new Set(
		procs
			.filter((proc) => appImageFacts(proc).exe === appImage)
			.flatMap(({ pid }) => listeners.get(pid) ?? [])
	);
	const holders = new Map<number, ProcessDetail>();
	for (const proc of procs) {
		const facts = appImageFacts(proc);
		const inherited =
			facts.exe !== null &&
			facts.exe !== appImage &&
			(facts.appImage === null || facts.appImage === appImage) &&
			(listeners.get(proc.pid) ?? []).some((listenPort) => runtimePorts.has(listenPort));
		if (inherited || isAppImageApp(proc, appImage)) holders.set(proc.pid, linuxProcDetail(proc));
	}
	return holders;
}

/**
 * For a failed step's diagnosis: every process the AppImage at `appImage` started (its
 * APPIMAGE variable), runtime and FUSE daemon included, and every process whose
 * executable lies under one of those processes' mounts (APPDIR), whether it listens or
 * not; ascending by pid.
 */
export function appImageProcesses(procs: readonly LinuxProc[], appImage: string): ProcessDetail[] {
	const read = procs.map((proc) => ({ proc, ...appImageFacts(proc) }));
	const mounts = read
		.filter((fact) => fact.appImage === appImage)
		.flatMap(({ appDir }) => (appDir === null ? [] : [appDir]));
	return read
		.filter(
			({ appImage: started, exe }) =>
				started === appImage || (exe !== null && mounts.some((mount) => isUnder(exe, mount)))
		)
		.map(({ proc }) => linuxProcDetail(proc))
		.sort((a, b) => a.pid - b.pid);
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
 * One instance per 127.0.0.1 port held by a process `detail` accepts (null: not the
 * app's), its pid the main process among the port's accepted holders. A port held
 * only by processes `detail` rejects is no instance.
 */
export function instancesByPort(
	listeners: ListenMap,
	detail: (pid: number) => ProcessDetail | null
): { pid: number; port: number; processes: ProcessDetail[] }[] {
	const instances: { pid: number; port: number; processes: ProcessDetail[] }[] = [];
	for (const [listenPort, pids] of pidsByPort(listeners)) {
		const processes = pids.map(detail).filter((holder) => holder !== null);
		if (processes.length === 0) continue;
		instances.push({ pid: mainProcess(processes).pid, port: listenPort, processes });
	}
	return instances;
}

/**
 * One entry per holder: pid, ppid, executable, state and wait channel where they were
 * read (linuxProcDetail, withProcState), and cmdline, for the error or diagnosis that
 * names them.
 */
export function describeHolders(holders: readonly ProcessDetail[]): string {
	return holders
		.map(({ pid, ppid, cmdline, state, wchan, exe }) => {
			const args = cmdline === null ? '<cmdline unknown>' : JSON.stringify(cmdline);
			const proc = [
				exe === undefined ? '' : ` exe ${exe ?? 'unknown'}`,
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

/**
 * The port an instance serves on, from `candidates` (the 127.0.0.1 ports its processes
 * hold) less `excluded` (ports another process held first, e.g. the ones A listened on,
 * which B may have inherited): null while none is left. More than one left throws,
 * naming each, rather than guess.
 */
export function servingPort(
	candidates: readonly number[],
	excluded: readonly number[]
): number | null {
	const skip = new Set(excluded);
	const left = [...new Set(candidates)]
		.filter((listenPort) => !skip.has(listenPort))
		.sort((a, b) => a - b);
	if (left.length > 1) {
		const set = excluded.length === 0 ? 'none' : [...skip].join(', ');
		throw new Error(
			`more than one port could be the one served (excluded: ${set}): ${left.join(', ')}`
		);
	}
	return left[0] ?? null;
}

/** One row of Get-CimInstance Win32_Process; a field is null where the OS withheld it. */
export type WindowsProcess = {
	pid: number;
	/** ParentProcessId: the pid of its creator, who may since have exited (or whose pid was reused). */
	ppid: number | null;
	name: string | null;
	path: string | null;
	startTime: Date | null;
};

/** Get-CimInstance Win32_Process (ProcessId, ParentProcessId, Name, ExecutablePath, CreationDate) JSON. */
export function parseWin32Processes(json: string): WindowsProcess[] {
	return jsonRows(json, 'Win32_Process').map((row) => ({
		pid: nonNegativeInt(row.ProcessId, 'ProcessId'),
		ppid:
			row.ParentProcessId === null || row.ParentProcessId === undefined
				? null
				: nonNegativeInt(row.ParentProcessId, 'ParentProcessId'),
		name: optionalString(row.Name, 'Name'),
		path: optionalString(row.ExecutablePath, 'ExecutablePath'),
		startTime: parsePsDate(row.CreationDate)
	}));
}

/**
 * How far apart two readings of one process's start may be: Get-Process's StartTime and
 * Win32_Process's CreationDate are separate reads of it, each cut to whole milliseconds.
 */
const START_SKEW_MS = 1_000;

/** False only when both start times are known and the later one is more than START_SKEW_MS before the earlier. */
function startedNoEarlier(later: Date | null, earlier: Date | null): boolean {
	return later === null || earlier === null || later.getTime() >= earlier.getTime() - START_SKEW_MS;
}

/**
 * Every process descended from `root` by ParentProcessId, children before their own
 * children (pre-order, siblings by pid), with its depth below `root` (a child is 1).
 * Windows reuses pids and never rewrites a ParentProcessId, so a process that started
 * before its supposed parent (START_SKEW_MS aside) is an older process's child, not
 * this one's, and is left out with whatever hangs below it.
 */
export function processTree(
	processes: readonly WindowsProcess[],
	root: { pid: number; startTime: Date | null }
): { process: WindowsProcess; depth: number }[] {
	const tree: { process: WindowsProcess; depth: number }[] = [];
	const visited = new Set<number>([root.pid]);
	const walk = (parent: { pid: number; startTime: Date | null }, depth: number) => {
		const children = processes
			.filter(
				(child) => child.ppid === parent.pid && startedNoEarlier(child.startTime, parent.startTime)
			)
			.sort((a, b) => a.pid - b.pid);
		for (const child of children) {
			// A ParentProcessId cycle (pid reuse again) would otherwise never end.
			if (visited.has(child.pid)) continue;
			visited.add(child.pid);
			tree.push({ process: child, depth });
			walk(child, depth + 1);
		}
	};
	walk(root, 1);
	return tree;
}

/**
 * An update installer for a failed relaunch's diagnosis: its pid, start and path, then
 * 'still running at <readAt>' while `processes` (Win32_Process rows read at `readAt`)
 * hold it (same pid, same start within START_SKEW_MS), else 'exited by <goneAt>', the
 * time it was first seen gone (`readAt` when that was this read). Then one indented
 * line per process it started (processTree), an exited installer's orphans included:
 * pid, name, start and ppid.
 */
export function describeInstallerTree(
	installer: ProcessInfo,
	goneAt: Date | null,
	processes: readonly WindowsProcess[],
	readAt: Date
): string {
	const row = processes.find(
		({ pid, startTime }) =>
			pid === installer.pid &&
			startedNoEarlier(startTime, installer.startTime) &&
			startedNoEarlier(installer.startTime, startTime)
	);
	const startTime = installer.startTime ?? row?.startTime ?? null;
	const status =
		row === undefined
			? `exited by ${(goneAt ?? readAt).toISOString()}`
			: `still running at ${readAt.toISOString()}`;
	const head = `installer pid ${installer.pid} started ${startTime?.toISOString() ?? 'unknown'} ${installer.path ?? row?.path ?? '<path unknown>'}: ${status}`;
	const tree = processTree(processes, { pid: installer.pid, startTime });
	if (tree.length === 0) return `${head}\n  no descendant process`;
	const lines = tree.map(
		({ process, depth }) =>
			`${'  '.repeat(depth)}pid ${process.pid} ${process.name ?? '<name unknown>'} started ${process.startTime?.toISOString() ?? 'unknown'} (ppid ${process.ppid ?? 'unknown'})`
	);
	return [head, ...lines].join('\n');
}

// ---------------------------------------------------------------------------
// The Linux restart test's output capture (t-30). electron-updater starts the updated
// AppImage with stdio 'ignore', so what it printed and why it exited were never seen.
// A test-only env var (main.ts's OUTPUT_CAPTURE_ENV) names one file; every process of
// the app that finds it set (A, and through the hand-over B) appends JSON lines to it:
//
//   {"pid":N,"at":"<ISO>","kind":"start","ppid":N,"argv":[...]}
//   {"pid":N,"at":"<ISO>","kind":"stdout"|"stderr","text":"<one write>"}
//   {"pid":N,"at":"<ISO>","kind":"error","origin":"uncaughtException"|...,"text":"<stack>"}
//   {"pid":N,"at":"<ISO>","kind":"exit","code":N}
//
// A failed test attaches them per pid, oldest first. A pid with no exit record is kept
// and said to have none: still running, killed, or gone before Node's 'exit'.

/** One line of the output capture, or a line that is no record (kept for the reader). */
export type CaptureRecord =
	| { pid: number; at: Date | null; kind: 'start'; ppid: number | null; argv: string[] | null }
	| { pid: number; at: Date | null; kind: 'stdout' | 'stderr'; text: string }
	| { pid: number; at: Date | null; kind: 'error'; origin: string; text: string }
	| { pid: number; at: Date | null; kind: 'exit'; code: number | null }
	| { kind: 'unreadable'; line: string };

function captureDate(value: unknown): Date | null {
	if (typeof value !== 'string') return null;
	const date = new Date(value);
	return Number.isNaN(date.getTime()) ? null : date;
}

/** One capture line as a record; 'unreadable' for anything else. Never throws. */
function captureRecord(line: string): CaptureRecord {
	const unreadable: CaptureRecord = { kind: 'unreadable', line };
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return unreadable;
	}
	if (value === null || typeof value !== 'object' || Array.isArray(value)) return unreadable;
	const row = value as Row;
	if (typeof row.pid !== 'number' || !Number.isInteger(row.pid) || row.pid <= 0) return unreadable;
	const base = { pid: row.pid, at: captureDate(row.at) };
	switch (row.kind) {
		case 'start':
			return {
				...base,
				kind: 'start',
				ppid: typeof row.ppid === 'number' ? row.ppid : null,
				argv:
					Array.isArray(row.argv) && row.argv.every((arg) => typeof arg === 'string')
						? (row.argv as string[])
						: null
			};
		case 'stdout':
		case 'stderr':
			return typeof row.text === 'string'
				? { ...base, kind: row.kind, text: row.text }
				: unreadable;
		case 'error':
			return typeof row.text === 'string'
				? {
						...base,
						kind: 'error',
						origin: typeof row.origin === 'string' ? row.origin : 'unknown origin',
						text: row.text
					}
				: unreadable;
		case 'exit':
			return { ...base, kind: 'exit', code: typeof row.code === 'number' ? row.code : null };
		default:
			return unreadable;
	}
}

/**
 * The capture file's lines as records, in file order. Blank lines are skipped; a torn
 * or foreign line comes back 'unreadable' rather than fail the diagnosis.
 */
export function parseCaptureRecords(text: string): CaptureRecord[] {
	return text
		.split(/\r?\n/)
		.filter((line) => line.trim() !== '')
		.map(captureRecord);
}

const isoOrUnknown = (at: Date | null) => at?.toISOString() ?? '<time unknown>';

/** The lines of one write, `prefix`ed; a trailing newline adds no empty line. */
function prefixedLines(prefix: string, text: string): string[] {
	const lines = text.split(/\r?\n/);
	if (lines.length > 1 && lines.at(-1) === '') lines.pop();
	return lines.map((line) => `${prefix}${line}`);
}

/**
 * The capture for a failed test's attachment: one block per pid, oldest first (its
 * start record's time, else its earliest record's; unknown times last, then by pid),
 * so the newest process comes last. Each block opens with the pid's ppid, start and
 * argv, lists every write and error in file order, and ends with its exit code or a
 * line saying it has none. Unreadable lines follow, as they were.
 */
export function formatCaptureRecords(records: readonly CaptureRecord[]): string {
	const byPid = new Map<number, Exclude<CaptureRecord, { kind: 'unreadable' }>[]>();
	const unreadable: string[] = [];
	for (const record of records) {
		if (record.kind === 'unreadable') {
			unreadable.push(record.line);
			continue;
		}
		const list = byPid.get(record.pid) ?? [];
		list.push(record);
		byPid.set(record.pid, list);
	}
	const startOf = (list: readonly CaptureRecord[]): number | null => {
		const start = list.find((record) => record.kind === 'start');
		const times = (start !== undefined && start.at !== null ? [start] : list).flatMap((record) =>
			'at' in record && record.at !== null ? [record.at.getTime()] : []
		);
		return times.length === 0 ? null : Math.min(...times);
	};
	const pids = [...byPid.keys()].sort((a, b) => {
		const [ta, tb] = [startOf(byPid.get(a) ?? []), startOf(byPid.get(b) ?? [])];
		if (ta !== tb) {
			if (ta === null) return 1;
			if (tb === null) return -1;
			return ta - tb;
		}
		return a - b;
	});

	const blocks = pids.map((pid) => {
		const list = byPid.get(pid) ?? [];
		const lines: string[] = [];
		if (!list.some((record) => record.kind === 'start')) lines.push(`pid ${pid}: no start record`);
		for (const record of list) {
			const at = isoOrUnknown(record.at);
			switch (record.kind) {
				case 'start':
					lines.push(
						`pid ${pid} (ppid ${record.ppid ?? 'unknown'}) started ${at} argv ${record.argv === null ? '<unknown>' : JSON.stringify(record.argv)}`
					);
					break;
				case 'stdout':
				case 'stderr':
					lines.push(...prefixedLines(`  ${at} ${record.kind}| `, record.text));
					break;
				case 'error':
					lines.push(...prefixedLines(`  ${at} ${record.origin}| `, record.text));
					break;
				case 'exit':
					lines.push(`  ${at} exit code ${record.code ?? 'unknown'}`);
					break;
			}
		}
		if (!list.some((record) => record.kind === 'exit')) {
			lines.push(`  no exit record: still running, killed, or gone before Node's 'exit'`);
		}
		return lines.join('\n');
	});
	if (unreadable.length > 0) {
		blocks.push(['unreadable capture lines:', ...unreadable.map((line) => `  ${line}`)].join('\n'));
	}
	return blocks.length === 0 ? 'no capture record' : blocks.join('\n');
}

/**
 * Every port a process announced in a stdout write of the capture, as `portOf` reads
 * one (null: no announcement), in file order: what B said it serves on, set beside
 * the port the test probed when a step fails.
 */
export function announcedPorts(
	records: readonly CaptureRecord[],
	portOf: (text: string) => number | null
): { pid: number; port: number }[] {
	return records.flatMap((record) => {
		if (record.kind !== 'stdout') return [];
		const announced = portOf(record.text);
		return announced === null ? [] : [{ pid: record.pid, port: announced }];
	});
}

/**
 * Adds to `seen` every pid `listeners` shows holding one of `ports` (the 127.0.0.1
 * ports A listened on): read while the relaunch is awaited, it names a process that
 * held A's inherited socket only briefly.
 */
export function addPortHolders(
	seen: Map<number, Set<number>>,
	ports: readonly number[],
	listeners: ListenMap
): void {
	const byPort = pidsByPort(listeners);
	for (const listenPort of ports) {
		const holders = seen.get(listenPort) ?? new Set<number>();
		for (const pid of byPort.get(listenPort) ?? []) holders.add(pid);
		seen.set(listenPort, holders);
	}
}

/** One entry per port of `ports`: the pids `seen` holding it (ascending), or none. */
export function describePortHolders(
	ports: readonly number[],
	seen: ReadonlyMap<number, ReadonlySet<number>>
): string {
	return ports
		.map((listenPort) => {
			const pids = [...(seen.get(listenPort) ?? [])].sort((a, b) => a - b);
			return `${listenPort} held by ${pids.length === 0 ? 'no pid seen' : `pid ${pids.join(', ')}`}`;
		})
		.join('; ');
}
