// pnpm ci:policy — supply-chain policy for .github/workflows (spec c-5).
//
// Rules:
// - Every `uses:` is a local `./path`, `owner/repo[/path]@<40 lowercase hex>`, or
//   `docker://image@sha256:<64 hex>`. Tags, branches and short SHAs are mutable.
// - Workflow-level `permissions:` is present and exactly `contents: read`.
// - Job-level `permissions:` is `{}`, `contents: read` or `contents: none`. The only
//   way past that is WRITE_SCOPE_ALLOWLIST: a listed workflow file may grant its
//   listed scopes `write`, at job level only.
//
// No YAML library (no new supply-chain dependency): a line-based reader that fails
// closed. Any `permissions` or `uses` it cannot classify is a violation.
// Runs under Node type stripping: erasable syntax only, no $app/* imports.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type Violation = { file: string; line: number; message: string };

/** Workflow file name → scopes its jobs may grant `write`. Empty: nothing may write. */
export const WRITE_SCOPE_ALLOWLIST: Readonly<Record<string, readonly string[]>> = {};

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

	withPaths(list).forEach(({ entry, path, key }, idx) => {
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
