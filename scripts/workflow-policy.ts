// pnpm ci:policy — supply-chain policy for .github/workflows (spec c-5).
//
// Rules:
// - Every `uses:` is a local `./path`, `owner/repo[/path]@<40 lowercase hex>`, or
//   `docker://image@sha256:<64 hex>`. Tags, branches and short SHAs are mutable.
// - Workflow-level `permissions:` is present and exactly `contents: read`.
// - Job-level `permissions:` is `{}`, `contents: read` or `contents: none`. The only
//   way past that is WRITE_SCOPE_ALLOWLIST: a listed workflow file may grant its
//   listed scopes `write`, at job level only (today: release.yml, contents).
// - A secret-bearing job (it names a SIGNING_SECRETS variable, reads secrets
//   dynamically, or takes an environment) runs only what an allowlist admits, so no
//   project install, build or test code runs beside the signing credentials (c-26,
//   decision signing_job_split): actions from SECRET_JOB_ACTIONS, bash, and run
//   commands that are plain shell (set, umask, export, echo, printf, base64, mkdir, rm,
//   test, true, false, exit), `tar -xf|-cf <file> [-C <dir>] [members]`, the p8 trap,
//   `pnpm install --dir signing --frozen-lockfile --ignore-scripts
//   [--ignore-workspace]` and `node scripts/sign-mac.ts …`. Anything else, including a
//   command substitution, a heredoc, a folded run or a command it cannot split, is a
//   violation. So is setting a LOADER_VARIABLES name (NODE_OPTIONS, PATH, DYLD_*…) by a
//   NAME=x word, export, printf -v or an env: key there or at workflow level, and any
//   mention of $GITHUB_ENV or $GITHUB_PATH in its runs: each would make an allowed
//   command load other code. A signing secret named outside any job is a violation
//   too: it cannot be confined to a job.
// - Any step that names a .p8 file first sets P8_TRAP, so the decoded key leaves
//   RUNNER_TEMP when the step exits, passed or failed, and names no .p8 but the one
//   the trap removes (c-15).
//
// No YAML library (no new supply-chain dependency): a line-based reader that fails
// closed. Any `permissions` or `uses` it cannot classify is a violation.
// Runs under Node type stripping: erasable syntax only, no $app/* imports.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Violation = { file: string; line: number; message: string };

/**
 * Workflow file name → scopes its jobs may grant `write`. Per file, not per job:
 * release.yml's publish job is the only one that may write (decision
 * release_pipeline), which scripts/release-workflow.spec.ts pins per job.
 */
export const WRITE_SCOPE_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {
	'release.yml': ['contents']
};

type Entry = { line: number; indent: number; text: string };
type Frame = { indent: number; key: string };

const SHA_REF = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(\/[^@\s]+)?@[0-9a-f]{40}$/;
const DOCKER_DIGEST = /^docker:\/\/[^@\s]+@sha256:[0-9a-f]{64}$/;
const KEY = /^([A-Za-z0-9_-]+)\s*:(?:\s+(.*))?$/;
const BLOCK_SCALAR = /:\s*[|>][-+0-9]*$/;
// A `permissions` / `uses` key anywhere on a line (block or flow style), so one the
// path walk did not classify is still caught.
const PERMISSIONS_KEY = /(^|[\s{,-])["']?permissions["']?\s*:/;
const USES_KEY = /(^|[\s{,-])["']?uses["']?\s*:/;

function stripComment(text: string): string {
	if (text.startsWith('#')) return '';
	return text.replace(/\s+#.*$/, '');
}

function unquote(value: string): string {
	const v = value.trim();
	if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) return v.slice(1, -1);
	return v;
}

/** Significant lines: no blanks, no comments, no block-scalar bodies (`run: |`). */
function entries(text: string): { list: Entry[]; tabs: number[] } {
	const list: Entry[] = [];
	const tabs: number[] = [];
	let scalarIndent = -1;
	text.split(/\r?\n/).forEach((raw, i) => {
		const line = i + 1;
		if (raw.trim() === '') return;
		const indent = raw.length - raw.trimStart().length;
		if (scalarIndent >= 0) {
			if (indent > scalarIndent) return;
			scalarIndent = -1;
		}
		if (/^\s*\t/.test(raw)) tabs.push(line);
		const content = stripComment(raw.trim());
		if (content === '') return;
		list.push({ line, indent, text: content });
		// The scalar's body is indented past its key, and for `- key: |` the key sits
		// after the dash: use the key's column, or the step's sibling keys get swallowed.
		if (BLOCK_SCALAR.test(content))
			scalarIndent = indent + (content.length - content.replace(/^-\s*/, '').length);
	});
	return { list, tabs };
}

/** Key path of every entry, e.g. ['jobs', 'build', 'steps', '-', 'with']. */
function withPaths(list: Entry[]): { entry: Entry; path: string[]; key: string | null }[] {
	const stack: Frame[] = [];
	return list.map((entry) => {
		while (stack.length && stack[stack.length - 1].indent >= entry.indent) stack.pop();
		const path = stack.map((f) => f.key);
		let text = entry.text;
		let indent = entry.indent;
		if (text === '-' || text.startsWith('- ')) {
			stack.push({ indent, key: '-' });
			path.push('-');
			text = text.slice(1).trimStart();
			indent += 2;
		}
		const m = KEY.exec(text);
		const key = m ? m[1] : null;
		if (key) stack.push({ indent, key });
		return { entry, path, key };
	});
}

/** `key: value` children of the block opened at `start`, or null if not a flat block. */
function children(
	list: Entry[],
	start: number
): { key: string; value: string; line: number }[] | null {
	const parent = list[start].indent;
	const out: { key: string; value: string; line: number }[] = [];
	let childIndent = -1;
	for (let i = start + 1; i < list.length && list[i].indent > parent; i++) {
		const e = list[i];
		if (childIndent < 0) childIndent = e.indent;
		const m = KEY.exec(e.text);
		if (e.indent !== childIndent || !m || m[2] === undefined) return null;
		out.push({ key: m[1], value: unquote(m[2]), line: e.line });
	}
	return out.length ? out : null;
}

function checkPermissions(
	file: string,
	list: Entry[],
	idx: number,
	level: 'workflow' | 'job',
	writable: readonly string[]
): Violation[] {
	const entry = list[idx];
	const at = (line: number, message: string): Violation => ({ file, line, message });
	const value = unquote(KEY.exec(entry.text.replace(/^-\s*/, ''))?.[2] ?? '');
	const where = level === 'workflow' ? 'workflow-level' : 'job-level';

	if (value !== '') {
		if (level === 'job' && value === '{}') return [];
		if (value === 'read-all' || value === 'write-all')
			return [at(entry.line, `${where} permissions: ${value} grants every scope`)];
		if (value.startsWith('{'))
			return [at(entry.line, `${where} flow-style permissions cannot be verified; use a block`)];
		return [at(entry.line, `${where} permissions: '${value}' is not an allowed form`)];
	}

	const kids = children(list, idx);
	if (!kids) return [at(entry.line, `${where} permissions block cannot be classified`)];

	if (level === 'workflow') {
		const bad = kids.filter((k) => !(k.key === 'contents' && k.value === 'read'));
		if (bad.length)
			return bad.map((k) =>
				at(
					k.line,
					`workflow-level permissions must be exactly contents: read, found ${k.key}: ${k.value}`
				)
			);
		if (kids.length === 1) return [];
		return [at(entry.line, 'workflow-level permissions must be exactly one contents: read')];
	}

	const out: Violation[] = [];
	for (const k of kids) {
		if (k.key === 'contents' && (k.value === 'read' || k.value === 'none')) continue;
		if (k.value === 'write' && writable.includes(k.key)) continue;
		out.push(at(k.line, `job-level permissions may not grant ${k.key}: ${k.value}`));
	}
	return out;
}

// ---------------------------------------------------------------- secret-bearing jobs

/** The release signing secrets (05-release decision release_secrets). */
export const SIGNING_SECRETS = [
	'CSC_LINK',
	'CSC_KEY_PASSWORD',
	'APPLE_API_KEY_P8_BASE64',
	'APPLE_API_KEY_ID',
	'APPLE_API_ISSUER'
] as const;

/** Actions a secret-bearing job may use: none of them runs project code. */
export const SECRET_JOB_ACTIONS: readonly string[] = [
	'actions/checkout',
	'actions/setup-node',
	'pnpm/action-setup',
	'actions/download-artifact',
	'actions/upload-artifact'
];

/** The cleanup every step that handles a .p8 key sets before touching it (c-15). */
export const P8_TRAP = `trap 'rm -f "$RUNNER_TEMP/AuthKey.p8"' EXIT`;
const P8_FILE = '$RUNNER_TEMP/AuthKey.p8';

const SECRET_NAME = new RegExp(`\\b(${SIGNING_SECRETS.join('|')})\\b`);
// secrets[…], toJSON(secrets) and `secrets: inherit` reach any secret by a computed name.
const DYNAMIC_SECRETS = /\bsecrets\s*\[|\(\s*secrets\s*\)|\bsecrets\s*:\s*inherit\b/;
const keyAnywhere = (key: string) => new RegExp(`(^|[\\s{,-])["']?${key}["']?\\s*:`);
const ENVIRONMENT_KEY = keyAnywhere('environment');
const RUN_KEY = keyAnywhere('run');
const SHELL_KEY = keyAnywhere('shell');
const P8_MENTION = /\.p8\b/i;
const P8_PATHS = /[^\s'"=<>|;&()]*\.p8\b/gi;

/**
 * Variables that change what node, bash or the dynamic loader loads (DYLD_* too). A
 * secret-bearing job never sets them, by any route, or an allowed command loads
 * other code beside the secrets: NODE_OPTIONS=--import=./x.ts node scripts/sign-mac.ts.
 */
export const LOADER_VARIABLES: readonly string[] = [
	'NODE_OPTIONS',
	'NODE_PATH',
	'NODE_EXTRA_CA_CERTS',
	'BASH_ENV',
	'ENV',
	'PATH',
	'LD_PRELOAD',
	'LD_LIBRARY_PATH'
];
const isLoaderVariable = (name: string) =>
	LOADER_VARIABLES.includes(name) || name.startsWith('DYLD_');
const setsLoader = (name: string) =>
	`may not set ${name}: it changes what node, bash or the loader loads`;
/** A loader variable as a YAML key, block or flow (an env: entry, wherever it sits). */
const LOADER_KEY = new RegExp(
	`(?:^|[\\s{,-])["']?(${LOADER_VARIABLES.join('|')}|DYLD_[A-Za-z0-9_]*)["']?\\s*:`
);
/** The runner files whose lines become later steps' environment and PATH. */
const RUNNER_ENV_FILES = /\bGITHUB_(ENV|PATH)\b/;
/** A shell assignment word, `NAME=` or `NAME+=`; group 1 is the name. */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/;

/** Commands a secret-bearing job may run with any arguments. */
const PLAIN_SHELL = new Set([
	'set',
	'umask',
	'export',
	'echo',
	'printf',
	'base64',
	'mkdir',
	'rm',
	'test',
	'[',
	'true',
	'false',
	'exit'
]);

type Pathed = { entry: Entry; path: string[]; key: string | null };
type ScriptLine = { line: number; text: string };
type Script = { style: 'inline' | 'literal' | 'folded'; escaped: boolean; lines: ScriptLine[] };

const valueOf = (entry: Entry) => KEY.exec(entry.text.replace(/^-\s*/, ''))?.[2] ?? '';
const isComment = (text: string) => text.trim().startsWith('#');

/** A step's `run:` script: its inline value, or its block scalar's body lines. */
function runScript(raw: string[], entry: Entry): Script {
	const bare = entry.text.replace(/^-\s*/, '');
	const value = (KEY.exec(bare)?.[2] ?? '').trim();
	if (!BLOCK_SCALAR.test(entry.text)) {
		// A double-quoted YAML value turns \n into a line break the shell then sees.
		const escaped = value.startsWith('"') && value.includes('\\');
		return { style: 'inline', escaped, lines: [{ line: entry.line, text: unquote(value) }] };
	}
	// Same rule as entries(): the body is indented past the key's column.
	const column = entry.indent + (entry.text.length - bare.length);
	const lines: ScriptLine[] = [];
	for (let i = entry.line; i < raw.length; i++) {
		if (raw[i].trim() === '') continue;
		if (raw[i].length - raw[i].trimStart().length <= column) break;
		lines.push({ line: i + 1, text: raw[i].trim() });
	}
	return { style: value.startsWith('>') ? 'folded' : 'literal', escaped: false, lines };
}

/** Joins backslash-continued lines (an odd run of trailing backslashes). */
function logicalLines(lines: ScriptLine[]): ScriptLine[] {
	const out: ScriptLine[] = [];
	let pending: ScriptLine | null = null;
	for (const l of lines) {
		const current: ScriptLine = pending
			? { line: pending.line, text: pending.text + l.text }
			: { ...l };
		const tail = /\\+$/.exec(current.text)?.[0].length ?? 0;
		if (tail % 2 === 1) pending = { line: current.line, text: current.text.slice(0, -1) };
		else {
			pending = null;
			out.push(current);
		}
	}
	// A continuation on the last line: keep the backslash, so the line cannot be split.
	if (pending) out.push({ line: pending.line, text: `${pending.text}\\` });
	return out;
}

/**
 * One shell line as its simple commands' words, quotes removed and redirections
 * dropped. Null when it cannot tell what runs: a command substitution, process
 * substitution, heredoc, unbalanced quote or dangling redirection.
 */
function shellCommands(line: string): string[][] | null {
	if (/\$\(|`|<\(|>\(|<</.test(line)) return null;
	const commands: string[][] = [];
	let words: string[] = [];
	let word: string | null = null;
	let target = false; // the next word is a redirection target, not an argument
	const endWord = () => {
		if (word === null) return;
		if (target) target = false;
		else words.push(word);
		word = null;
	};
	const endCommand = () => {
		endWord();
		if (words.length) commands.push(words);
		words = [];
	};
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (c === "'") {
			const end = line.indexOf("'", i + 1);
			if (end < 0) return null;
			word = (word ?? '') + line.slice(i + 1, end);
			i = end;
		} else if (c === '"') {
			let text = '';
			let j = i + 1;
			for (; j < line.length && line[j] !== '"'; j++) {
				// Inside double quotes a backslash escapes only $ ` " \.
				if (line[j] === '\\' && '$`"\\'.includes(line[j + 1] ?? '')) j++;
				text += line[j];
			}
			if (j >= line.length) return null;
			word = (word ?? '') + text;
			i = j;
		} else if (c === '\\') {
			if (i + 1 >= line.length) return null;
			word = (word ?? '') + line[++i];
		} else if (c === ' ' || c === '\t') {
			endWord();
		} else if (c === '#' && word === null) {
			break;
		} else if (c === ';' || c === '&' || c === '|') {
			if (target && word === null) return null;
			endCommand();
		} else if (c === '<' || c === '>') {
			// An all-digit word right before the operator is its fd (2>), not an argument.
			if (word !== null && /^\d+$/.test(word)) word = null;
			else endWord();
			if (target) return null;
			let j = i + 1;
			while (j < line.length && '<>|'.includes(line[j])) j++;
			if (line[j] === '&') {
				const fd = /^(\d+|-)/.exec(line.slice(j + 1));
				if (!fd) return null;
				j += 1 + fd[0].length;
			} else target = true;
			i = j - 1;
		} else {
			word = (word ?? '') + c;
		}
	}
	if (target && word === null) return null;
	endCommand();
	return commands;
}

const notFlag = (arg: string | undefined) => arg !== undefined && !arg.startsWith('-');

/**
 * The variable names a simple command assigns: its leading NAME=x words, `export`'s
 * NAME[=x] arguments and `printf -v NAME`.
 */
function assignedNames(words: string[]): string[] {
	const at = words.findIndex((w) => !ASSIGNMENT.test(w));
	const leading = (at < 0 ? words : words.slice(0, at)).map((w) => ASSIGNMENT.exec(w)![1]);
	if (at < 0) return leading;
	const [program, ...args] = words.slice(at);
	if (program === 'export')
		return [...leading, ...args.filter(notFlag).map((a) => a.split(/\+?=/)[0])];
	if (program === 'printf') {
		const v = args.findIndex((a) => a.startsWith('-v'));
		const name = v < 0 ? undefined : args[v] === '-v' ? args[v + 1] : args[v].slice(2);
		if (name !== undefined) return [...leading, name];
	}
	return leading;
}

/** Whether a secret-bearing job may run this simple command (leading NAME=x dropped). */
function allowedInSecretJob(words: string[]): boolean {
	const at = words.findIndex((w) => !ASSIGNMENT.test(w));
	if (at < 0) return true;
	const [program, ...args] = words.slice(at);
	if (PLAIN_SHELL.has(program)) return true;
	// A trap's action is a script run later: only the p8 cleanup.
	if (program === 'trap')
		return args.length === 2 && args[0] === `rm -f "${P8_FILE}"` && args[1] === 'EXIT';
	// No other option: tar's --to-command and --use-compress-program run programs.
	if (program === 'tar') {
		const [mode, archive, ...rest] = args;
		const withDir = rest[0] === '-C';
		const members = withDir ? rest.slice(2) : rest;
		return (
			(mode === '-xf' || mode === '-cf') &&
			notFlag(archive) &&
			(!withDir || notFlag(rest[1])) &&
			members.every(notFlag)
		);
	}
	if (program === 'pnpm') {
		if (args[0] !== 'install') return false;
		const seen = new Set<string>();
		for (let i = 1; i < args.length; i++) {
			const arg = args[i];
			if (arg === '--dir' && args[i + 1] === 'signing') {
				seen.add('--dir=signing');
				i++;
			} else if (
				['--dir=signing', '--frozen-lockfile', '--ignore-scripts', '--ignore-workspace'].includes(
					arg
				)
			) {
				seen.add(arg);
			} else return false;
		}
		return ['--dir=signing', '--frozen-lockfile', '--ignore-scripts'].every((f) => seen.has(f));
	}
	if (program === 'node') return args[0] === 'scripts/sign-mac.ts';
	return false;
}

/** Job id → its entries (header included) and the raw line range it spans. */
function jobRanges(
	pathed: Pathed[],
	rawLength: number
): { id: string; items: Pathed[]; first: number; last: number }[] {
	const out: { id: string; items: Pathed[]; first: number; last: number }[] = [];
	pathed.forEach((p, i) => {
		if (p.key === null || p.path.length !== 1 || p.path[0] !== 'jobs') return;
		let end = i + 1;
		while (end < pathed.length && pathed[end].path.length > 1) end++;
		out.push({
			id: p.key,
			items: pathed.slice(i, end),
			first: p.entry.line,
			last: end < pathed.length ? pathed[end].entry.line - 1 : rawLength
		});
	});
	return out;
}

/** Violations of the secret-bearing job allowlist (c-26). */
function checkSecretJobs(file: string, raw: string[], pathed: Pathed[]): Violation[] {
	const out: Violation[] = [];
	const at = (line: number, message: string): Violation => ({ file, line, message });
	const jobs = jobRanges(pathed, raw.length);
	const inJob = (line: number) => jobs.some((j) => line >= j.first && line <= j.last);

	raw.forEach((text, i) => {
		if (inJob(i + 1) || isComment(text)) return;
		if (SECRET_NAME.test(text) || DYNAMIC_SECRETS.test(text))
			out.push(at(i + 1, 'a signing secret outside a job cannot be confined to one job'));
	});

	const secretJobs = jobs.filter(
		(j) =>
			raw
				.slice(j.first - 1, j.last)
				.some((t) => !isComment(t) && (SECRET_NAME.test(t) || DYNAMIC_SECRETS.test(t))) ||
			j.items.some((p) => ENVIRONMENT_KEY.test(p.entry.text))
	);

	for (const job of secretJobs) {
		const where = `secret-bearing job '${job.id}'`;
		const header = job.items[0];
		if (valueOf(header.entry).trim() !== '')
			out.push(at(header.entry.line, `${where} in flow style cannot be classified`));
		for (const { entry, path, key } of job.items.slice(1)) {
			const last = path[path.length - 1];
			if (/\brun_install\b/.test(entry.text))
				out.push(at(entry.line, `${where} may not set run_install: it runs a root install`));
			const loader = LOADER_KEY.exec(entry.text)?.[1];
			if (loader !== undefined) out.push(at(entry.line, `${where} ${setsLoader(loader)}`));

			if (key === 'uses') {
				const ref = unquote(valueOf(entry));
				if (path.length === 2)
					out.push(at(entry.line, `${where} may not call a reusable workflow`));
				else if (!SECRET_JOB_ACTIONS.includes(ref.split('@')[0]))
					out.push(at(entry.line, `${where} may not use '${ref}'`));
			}

			if (key === 'shell') {
				if (unquote(valueOf(entry)) !== 'bash')
					out.push(at(entry.line, `${where} runs only under bash`));
			} else if (SHELL_KEY.test(entry.text)) {
				out.push(at(entry.line, `${where}: a shell the policy cannot classify`));
			}

			if (last === 'run' && path[path.length - 2] === '-') {
				out.push(at(entry.line, `${where}: a multi-line plain run cannot be classified`));
			} else if (key === 'run' && last === '-') {
				out.push(...checkSecretRun(file, where, entry.line, runScript(raw, entry)));
			} else if (key === 'run' && last === 'defaults' && valueOf(entry).trim() === '') {
				// Job-level defaults.run: a map, its shell checked above.
			} else if (RUN_KEY.test(entry.text)) {
				out.push(at(entry.line, `${where}: a run the policy cannot classify`));
			}
		}
	}

	// Workflow-level defaults.run.shell and env apply to every job, the secret-bearing
	// ones too.
	if (secretJobs.length > 0) {
		for (const { entry, path, key } of pathed) {
			if (path[0] === 'jobs' || inJob(entry.line)) continue;
			if (key === 'shell' ? unquote(valueOf(entry)) !== 'bash' : SHELL_KEY.test(entry.text))
				out.push(at(entry.line, 'a workflow with a secret-bearing job runs only under bash'));
			const loader = LOADER_KEY.exec(entry.text)?.[1];
			if (loader !== undefined)
				out.push(at(entry.line, `a workflow with a secret-bearing job ${setsLoader(loader)}`));
		}
	}
	return out;
}

/** Every command of one step's run in a secret-bearing job, against the allowlist. */
function checkSecretRun(file: string, where: string, runLine: number, script: Script): Violation[] {
	const at = (line: number, message: string): Violation => ({ file, line, message });
	// Folding joins lines into one command line: what runs is not what the lines say.
	if (script.style === 'folded')
		return [at(runLine, `${where}: a folded run (>) cannot be classified`)];
	if (script.escaped)
		return [at(runLine, `${where}: an escaped double-quoted run cannot be classified`)];
	const out: Violation[] = [];
	for (const { line, text } of logicalLines(script.lines)) {
		// Any mention, not just a parsed redirect: tee, cp and $VAR indirection write too.
		if (RUNNER_ENV_FILES.test(text))
			out.push(at(line, `${where} may not write $GITHUB_ENV or $GITHUB_PATH`));
		const commands = shellCommands(text);
		if (commands === null) {
			out.push(at(line, `${where}: cannot classify '${text}'`));
			continue;
		}
		for (const words of commands) {
			for (const name of assignedNames(words).filter(isLoaderVariable))
				out.push(at(line, `${where} ${setsLoader(name)}`));
			if (!allowedInSecretJob(words))
				out.push(at(line, `${where} may not run '${words.join(' ')}'`));
		}
	}
	return out;
}

/** Violations of the .p8 cleanup rule, in every step of every job (c-15). */
function checkP8Cleanup(file: string, raw: string[], pathed: Pathed[]): Violation[] {
	const out: Violation[] = [];
	const at = (line: number, message: string): Violation => ({ file, line, message });
	for (const { entry, path, key } of pathed) {
		if (key !== 'run' || path[path.length - 1] !== '-') continue;
		const lines = runScript(raw, entry).lines;
		const mentions = lines.filter((l) => P8_MENTION.test(l.text));
		if (mentions.length === 0) continue;
		const trap = lines.findIndex((l) => l.text === P8_TRAP);
		if (trap < 0)
			out.push(at(mentions[0].line, `a step that writes a .p8 key needs ${P8_TRAP} first`));
		else if (mentions[0] !== lines[trap])
			out.push(at(mentions[0].line, `${P8_TRAP} must come before the step's first .p8 use`));
		for (const l of mentions)
			for (const path of l.text.match(P8_PATHS) ?? [])
				if (path !== P8_FILE)
					out.push(at(l.line, `the .p8 cleanup trap removes ${P8_FILE} only, not ${path}`));
		lines.forEach((l, i) => {
			if (i > trap && trap >= 0 && /(^|[;&|]\s*)trap\b/.test(l.text))
				out.push(at(l.line, `a later trap replaces the .p8 cleanup`));
		});
	}
	return out;
}

/** Every policy violation in one workflow file. */
export function checkWorkflow(
	file: string,
	text: string,
	allowlist: Readonly<Record<string, readonly string[]>> = WRITE_SCOPE_ALLOWLIST
): Violation[] {
	const { list, tabs } = entries(text);
	const out: Violation[] = tabs.map((line) => ({
		file,
		line,
		message: 'tab indentation cannot be classified'
	}));
	const writable = allowlist[basename(file)] ?? [];
	let topPermissions = 0;
	const pathed = withPaths(list);

	pathed.forEach(({ entry, path, key }, idx) => {
		const at = (message: string): Violation => ({ file, line: entry.line, message });
		const bare = entry.text.replace(/^-\s*/, '');

		if (key === 'uses') {
			const ref = unquote(KEY.exec(bare)?.[2] ?? '');
			const ok = ref.startsWith('./') || SHA_REF.test(ref) || DOCKER_DIGEST.test(ref);
			if (!ok) out.push(at(`uses: '${ref}' is not pinned to a full commit SHA (or sha256 digest)`));
		} else if (USES_KEY.test(entry.text)) {
			out.push(at('uses reference cannot be classified'));
		}

		if (key === 'permissions' && path.length === 0) {
			topPermissions++;
			out.push(...checkPermissions(file, list, idx, 'workflow', []));
		} else if (
			key === 'permissions' &&
			path.length === 2 &&
			path[0] === 'jobs' &&
			path[1] !== '-'
		) {
			out.push(...checkPermissions(file, list, idx, 'job', writable));
		} else if (PERMISSIONS_KEY.test(entry.text)) {
			out.push(at('permissions in a place the policy cannot classify'));
		}
	});

	if (topPermissions === 0)
		out.push({
			file,
			line: 1,
			message: 'workflow-level permissions block is missing (need contents: read)'
		});
	if (topPermissions > 1)
		out.push({ file, line: 1, message: 'more than one workflow-level permissions block' });
	const raw = text.split(/\r?\n/);
	out.push(...checkSecretJobs(file, raw, pathed), ...checkP8Cleanup(file, raw, pathed));
	return out.sort((a, b) => a.line - b.line);
}

/** Checks every *.yml / *.yaml in `workflowDir`. Returns the process exit code. */
export function runPolicyCli(
	workflowDir: string,
	log: (line: string) => void = (line) => process.stderr.write(`${line}\n`),
	allowlist: Readonly<Record<string, readonly string[]>> = WRITE_SCOPE_ALLOWLIST
): number {
	let files: string[];
	try {
		files = readdirSync(workflowDir)
			.filter((name) => /\.ya?ml$/.test(name))
			.map((name) => join(workflowDir, name))
			.filter((path) => statSync(path).isFile())
			.sort();
	} catch {
		files = [];
	}
	if (files.length === 0) {
		log(`ci:policy: no workflow files in ${workflowDir}`);
		return 1;
	}
	const violations = files.flatMap((path) =>
		checkWorkflow(path, readFileSync(path, 'utf8'), allowlist)
	);
	for (const v of violations) log(`${v.file}:${v.line}: ${v.message}`);
	log(`ci:policy: ${files.length} workflow file(s), ${violations.length} violation(s)`);
	return violations.length ? 1 : 0;
}

// import.meta.main is missing on Node < 24.2; fall back to argv so the gate can
// never skip silently and exit 0.
const isEntry =
	import.meta.main ??
	(process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url));
if (isEntry) process.exit(runPolicyCli(process.argv[2] ?? '.github/workflows'));
