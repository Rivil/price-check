// A line reader for the GitHub workflow files the scripts/*.spec.ts pins read
// (ci-desktop, ci-packaged, release-workflow).
//
// No YAML library (same reason as scripts/workflow-policy.ts: no new supply-chain
// dependency). It knows only the shape this repo's workflows use: two-space indents,
// jobs at 2, job keys at 4, steps at 6 (`- `), step keys at 8. It throws when a job
// or the `on` key it is asked for is missing, so a renamed job fails a spec loudly
// instead of handing it an empty body.
// Runs under Node type stripping: erasable syntax only, no $app/* imports.

/** A parsed key: a scalar, a list (flow `[a, b]` or block `- a`), or a flat map. */
export type Value = string | string[] | Record<string, string>;

export type Step = {
	/** Position in the job's steps, from 0. */
	index: number;
	/** The step's lines, comments dropped. */
	lines: string[];
	/** A key's scalar value anywhere in the step (`with:` keys too), never inside `run:`. */
	get: (key: string) => string | undefined;
	/** The `run:` script's trimmed non-empty lines (one entry for an inline run). */
	run: string[];
};

export type Workflow = {
	lines: string[];
	/** The body of `jobs.<id>`: every line up to the next job or top-level key. */
	job: (id: string) => string[];
	/** A key directly under `jobs.<id>` (needs, permissions, runs-on, if…). */
	jobKey: (id: string, key: string) => Value | undefined;
	/** A top-level key (permissions, concurrency…). */
	top: (key: string) => Value | undefined;
	/** `on:` as event → filter → values, e.g. { push: { tags: ['v*'] } }. */
	triggers: () => Record<string, Record<string, string[]>>;
};

export function unquote(value: string): string {
	const v = value.trim();
	if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.at(-1) === v[0]) return v.slice(1, -1);
	return v;
}

const indentOf = (line: string) => line.length - line.trimStart().length;
const isComment = (line: string) => line.trim().startsWith('#');
const isSignificant = (line: string) => line.trim() !== '' && !isComment(line);
const stripComment = (text: string) => text.replace(/\s#.*/, '');
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** `key:` at exactly `indent`, the key optionally quoted; group 2 is the inline value. */
const keyLine = (key: string, indent: number) =>
	new RegExp(`^ {${indent}}(["']?)${escape(key)}\\1:(?:\\s(.*))?$`);

/** `key: value` → [key, value], unquoted, the value without a trailing comment. */
function pair(text: string): [string, string] | undefined {
	const i = text.indexOf(':');
	return i > 0 ? [unquote(text.slice(0, i)), unquote(stripComment(text.slice(i + 1)))] : undefined;
}

/** The lines after `start` that sit deeper than `indent` (blanks and comments kept). */
function childrenOf(lines: string[], start: number, indent: number): string[] {
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((l) => isSignificant(l) && indentOf(l) <= indent);
	return end < 0 ? rest : rest.slice(0, end);
}

/** A `key:` mapping at `indent` (a job's env, strategy…), as its child lines. */
export function block(body: string[], key: string, indent: number): string[] {
	const start = body.findIndex((l) => l === `${' '.repeat(indent)}${key}:`);
	return start < 0 ? [] : childrenOf(body, start, indent);
}

/** A flat `KEY: value` map, e.g. a job's env. Comment lines never match. */
export function map(blockLines: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const l of blockLines) {
		const m = /^\s+(\w+):(.*)/.exec(l);
		if (m) out[m[1]] = unquote(stripComment(m[2]));
	}
	return out;
}

/** Flow items: `[a, 'b']` → ['a', 'b']. */
const flowItems = (inner: string) => inner.split(',').map(unquote).filter(Boolean);

/** The value of `key:` at `indent` in `lines`, or undefined when the key is absent. */
export function value(lines: string[], key: string, indent: number): Value | undefined {
	const re = keyLine(key, indent);
	const at = lines.findIndex((l) => re.test(l));
	if (at < 0) return undefined;
	const inline = stripComment(re.exec(lines[at])![2] ?? '').trim();
	const children = childrenOf(lines, at, indent).filter(isSignificant);
	if (/^[|>]/.test(inline))
		return children.map((l) => l.trim()).join(inline[0] === '|' ? '\n' : ' ');
	if (inline.startsWith('[') && inline.endsWith(']')) return flowItems(inline.slice(1, -1));
	if (inline.startsWith('{') && inline.endsWith('}')) {
		const out: Record<string, string> = {};
		for (const item of flowItems(inline.slice(1, -1))) {
			const p = pair(item);
			if (p) out[p[0]] = p[1];
		}
		return out;
	}
	if (inline !== '') return unquote(inline);
	if (children.length === 0) return undefined;
	const childIndent = indentOf(children[0]);
	const direct = children.filter((l) => indentOf(l) === childIndent);
	if (direct[0].trimStart().startsWith('- '))
		return direct.map((l) => unquote(stripComment(l.trim().slice(2))));
	const out: Record<string, string> = {};
	for (const l of direct) {
		const p = pair(l);
		if (p) out[p[0]] = p[1];
	}
	return out;
}

const asList = (v: Value | undefined): string[] =>
	v === undefined ? [] : typeof v === 'string' ? [v] : Array.isArray(v) ? v : Object.keys(v);

/** The steps of a job, in order. `run` is the script's trimmed non-empty lines. */
export function steps(body: string[]): Step[] {
	const list = block(body, 'steps', 4).filter((l) => !isComment(l));
	const starts = list.flatMap((l, i) => (/^ {6}- /.test(l) ? [i] : []));
	return starts.map((s, index) => {
		const stepLines = list.slice(s, starts[index + 1] ?? list.length);
		const runAt = stepLines.findIndex((l) => /^ {6}(?:- | {2})run:/.test(l));
		let run: string[] = [];
		// Lines after runAt and before scriptEnd are the script, never step keys.
		let scriptEnd = runAt;
		if (runAt >= 0) {
			const line = stepLines[runAt];
			const inline = line.slice(line.indexOf('run:') + 4).trim();
			if (/^[|>]/.test(inline)) {
				const script = childrenOf(stepLines, runAt, 8);
				scriptEnd = runAt + 1 + script.length;
				run = script.map((l) => l.trim()).filter(Boolean);
			} else run = [unquote(inline)];
		}
		const keyed = stepLines.filter((_, i) => i <= runAt || i >= scriptEnd);
		const get = (key: string) => {
			const re = new RegExp(`^ {6,}(?:- )?${escape(key)}:\\s*(.*?)\\s*$`);
			const m = keyed.map((l) => re.exec(l)).find(Boolean);
			return m ? unquote(stripComment(m[1])) : undefined;
		};
		return { index, lines: stepLines, get, run };
	});
}

/**
 * A step script as its two OS branches. It must be exactly
 * `if [ "$RUNNER_OS" = "Linux" ]; then … else … fi`, so every OS takes one of them.
 */
export function branches(run: string[]): { linux: string[]; other: string[] } | null {
	const elseAt = run.indexOf('else');
	const ok =
		run[0] === 'if [ "$RUNNER_OS" = "Linux" ]; then' &&
		run.at(-1) === 'fi' &&
		elseAt !== -1 &&
		run.filter((l) => /^(if|else|elif|fi)\b/.test(l)).length === 3;
	return ok ? { linux: run.slice(1, elseAt), other: run.slice(elseAt + 1, -1) } : null;
}

/** Reads a workflow's text. `name` (e.g. 'ci.yml') goes into thrown errors. */
export function readWorkflow(text: string, name = 'workflow'): Workflow {
	const lines = text.split(/\r?\n/);

	function job(id: string): string[] {
		const jobsAt = lines.findIndex((l) => keyLine('jobs', 0).test(l));
		if (jobsAt < 0) throw new Error(`${name} has no jobs: key, so no job '${id}'`);
		const jobs = childrenOf(lines, jobsAt, 0);
		const re = keyLine(id, 2);
		const start = jobs.findIndex((l) => re.test(l) && stripComment(l).trim().endsWith(':'));
		if (start < 0) throw new Error(`${name} has no job '${id}'`);
		return childrenOf(jobs, start, 2);
	}

	function triggers(): Record<string, Record<string, string[]>> {
		const at = lines.findIndex((l) => keyLine('on', 0).test(l));
		if (at < 0) throw new Error(`${name} has no 'on' triggers`);
		const body = childrenOf(lines, at, 0).filter(isSignificant);
		const out: Record<string, Record<string, string[]>> = {};
		for (const event of asList(value(lines, 'on', 0))) {
			const filters: Record<string, string[]> = {};
			out[event] = filters;
			// A scalar or flow `on` has no body: its events get no filters.
			const eventAt = body.findIndex((l) => pair(l)?.[0] === event);
			if (eventAt < 0) continue;
			const eventLines = childrenOf(body, eventAt, indentOf(body[eventAt]));
			for (const l of eventLines) {
				// `- cron: x` items of a list-shaped event, or a filter directly under the event.
				const t = l.trim();
				const listed = t.startsWith('- ');
				const p = pair(listed ? t.slice(2) : t);
				if (p && listed) filters[p[0]] = [...(filters[p[0]] ?? []), p[1]];
				else if (p && indentOf(l) === indentOf(eventLines[0]))
					filters[p[0]] = asList(value(eventLines, p[0], indentOf(l)));
			}
		}
		return out;
	}

	return {
		lines,
		job,
		jobKey: (id, key) => value(job(id), key, 4),
		top: (key) => value(lines, key, 0),
		triggers
	};
}
