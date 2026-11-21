import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import { ROOT, SIGNING_VARIABLES, builderConfig } from './package-desktop.ts';
import {
	SIGNING_DIR,
	parseSignArgs,
	runSignCli,
	signMac,
	signingPackagerFactory,
	type MacPackagerLike,
	type SignBuildOptions,
	type SignCliDeps,
	type SigningBuilder
} from './sign-mac.ts';

const SIGN_MAC = join(ROOT, 'scripts', 'sign-mac.ts');
const APP = 'dist-packaged/mac-universal/Price Check.app';

/** Every signing variable set; APPLE_API_KEY names a file the fake fileSize knows. */
function signingEnv(): NodeJS.ProcessEnv {
	return {
		CSC_LINK: 'csc-link-value',
		CSC_KEY_PASSWORD: 'csc-password-value',
		APPLE_API_KEY: '/keys/AuthKey.p8',
		APPLE_API_KEY_ID: 'KEYID',
		APPLE_API_ISSUER: 'issuer-uuid'
	};
}

function fakeDeps(overrides: Partial<SignCliDeps> = {}) {
	const build = vi.fn(async (options: SignBuildOptions) => {
		void options;
		return ['dist-packaged/price-check-0.2.1-mac-universal.dmg'];
	});
	const MacPackager = vi.fn(function () {
		return { sign: vi.fn(async () => true), packMacTargets: vi.fn(async () => undefined) };
	}) as unknown as SigningBuilder['MacPackager'];
	const loadBuilder = vi.fn((fromDir: string): SigningBuilder => {
		void fromDir;
		return { build, MacPackager };
	});
	const out: string[] = [];
	const err: string[] = [];
	const deps: SignCliDeps = {
		loadBuilder,
		env: signingEnv(),
		root: ROOT,
		isDirectory: (path) => path === resolve(ROOT, APP),
		fileSize: (path) => (path === '/keys/AuthKey.p8' ? 300 : null),
		stdout: (line) => out.push(line),
		stderr: (line) => err.push(line),
		...overrides
	};
	return { deps, build, loadBuilder, MacPackager, out, err };
}

describe('signing toolchain', () => {
	const signing = JSON.parse(readFileSync(join(SIGNING_DIR, 'package.json'), 'utf8')) as Record<
		string,
		unknown
	>;
	const root = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
		devDependencies: Record<string, string>;
	};

	it('holds electron-builder only, pinned to the root devDependency, with no scripts', () => {
		expect(signing.dependencies).toEqual({
			'electron-builder': root.devDependencies['electron-builder']
		});
		expect(root.devDependencies['electron-builder']).toMatch(/^\d+\.\d+\.\d+$/);
		for (const field of [
			'devDependencies',
			'optionalDependencies',
			'peerDependencies',
			'bundledDependencies',
			'scripts',
			'pnpm',
			'workspaces'
		]) {
			expect(signing, field).not.toHaveProperty(field);
		}
	});

	it('has its own lockfile whose only importer is electron-builder', () => {
		const lock = readFileSync(join(SIGNING_DIR, 'pnpm-lock.yaml'), 'utf8');
		const importers = /\nimporters:\n([\s\S]*?)\npackages:\n/.exec(lock)?.[1];
		expect(importers, 'importers section').toBeDefined();
		const version = root.devDependencies['electron-builder'];
		expect(importers!.trim().split('\n')).toEqual([
			'.:',
			'    dependencies:',
			'      electron-builder:',
			`        specifier: ${version}`,
			expect.stringMatching(new RegExp(`^        version: ${version.replace(/\./g, '\\.')}(\\(|$)`))
		]);
	});
});

/** The static imports of a module, with whether each is type-only. */
function staticImports(file: string): { specifier: string; typeOnly: boolean }[] {
	const source = ts.createSourceFile(
		file,
		readFileSync(file, 'utf8'),
		ts.ScriptTarget.Latest,
		true
	);
	const found: { specifier: string; typeOnly: boolean }[] = [];
	for (const node of source.statements) {
		if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
			found.push({
				specifier: node.moduleSpecifier.text,
				typeOnly: node.importClause?.isTypeOnly === true
			});
		} else if (
			ts.isExportDeclaration(node) &&
			node.moduleSpecifier &&
			ts.isStringLiteral(node.moduleSpecifier)
		) {
			found.push({ specifier: node.moduleSpecifier.text, typeOnly: node.isTypeOnly });
		}
	}
	return found;
}

describe('runs without the project install', () => {
	it('statically imports only node:*, relative files and types, all the way down', () => {
		const seen = new Set<string>();
		const violations: string[] = [];
		const visit = (file: string) => {
			if (seen.has(file)) return;
			seen.add(file);
			for (const { specifier, typeOnly } of staticImports(file)) {
				if (typeOnly || specifier.startsWith('node:')) continue;
				if (specifier.startsWith('./') || specifier.startsWith('../')) {
					visit(resolve(dirname(file), specifier));
					continue;
				}
				violations.push(`${file.slice(ROOT.length + 1)} imports ${specifier}`);
			}
		};
		visit(SIGN_MAC);
		expect([...seen].map((f) => f.slice(ROOT.length + 1)).sort()).toEqual([
			'scripts/package-desktop.ts',
			'scripts/sign-mac.ts',
			'src/desktop/app-id.ts'
		]);
		expect(violations).toEqual([]);
	});

	it("never calls packageDesktop or package-desktop's CLI (their builder import)", () => {
		const source = readFileSync(SIGN_MAC, 'utf8');
		expect(source).not.toMatch(/\bpackageDesktop\b/);
		expect(source).not.toMatch(/\brunCli\b/);
		expect(source).not.toMatch(/\bimport\s*\(/);
	});
});

describe('signMac', () => {
	it('builds the signed release from the prepackaged app with the signing toolchain', async () => {
		const { deps, build, loadBuilder, MacPackager } = fakeDeps();

		await signMac({ version: '0.2.1', app: APP }, deps);

		expect(loadBuilder).toHaveBeenCalledExactlyOnceWith(SIGNING_DIR);
		expect(build).toHaveBeenCalledOnce();
		const options = build.mock.calls[0][0];
		expect(options).toMatchObject({
			mac: [],
			prepackaged: resolve(ROOT, APP),
			publish: 'never',
			projectDir: ROOT
		});
		expect(options.config).toEqual(builderConfig({ version: '0.2.1', sign: true }));
		expect(typeof options.platformPackagerFactory).toBe('function');
		// The factory is built on the signing toolchain's MacPackager.
		options.platformPackagerFactory({}, { name: 'mac' });
		expect(MacPackager).toHaveBeenCalledOnce();
		expect(deps.env.CSC_IDENTITY_AUTO_DISCOVERY).toBe('true');
	});

	it('refuses missing signing variables, naming only the names', async () => {
		for (const name of SIGNING_VARIABLES) {
			const env = signingEnv();
			delete env[name];
			const { deps, build, loadBuilder, err } = fakeDeps({ env });

			expect(await runSignCli(['--version', '0.2.1', '--app', APP], deps), name).toBe(1);

			expect(build, name).not.toHaveBeenCalled();
			expect(loadBuilder, name).not.toHaveBeenCalled();
			expect(err, name).toHaveLength(1);
			expect(err[0], name).toContain(name);
			for (const value of Object.values(signingEnv())) {
				if (value !== undefined) expect(err[0], name).not.toContain(value);
			}
			for (const other of SIGNING_VARIABLES.filter((n) => n !== name)) {
				expect(err[0], `${name}: ${other}`).not.toMatch(new RegExp(`\\b${other}\\b(?! \\()`));
			}
		}
	});

	it('refuses an --app that is not an existing .app directory', async () => {
		for (const app of [
			'dist-packaged/missing.app',
			'dist-packaged/mac-universal',
			APP + '/Contents'
		]) {
			const { deps, build, loadBuilder, err } = fakeDeps();
			expect(await runSignCli(['--version', '0.2.1', '--app', app], deps), app).toBe(1);
			expect(build, app).not.toHaveBeenCalled();
			expect(loadBuilder, app).not.toHaveBeenCalled();
			expect(err[0], app).toContain('--app must be an existing .app directory');
		}
	});

	it('takes exactly --version and --app', () => {
		expect(parseSignArgs(['--version', '0.2.1', '--app', APP])).toEqual({
			version: '0.2.1',
			app: APP
		});
		expect(() => parseSignArgs(['--app', APP])).toThrow('--version');
		expect(() => parseSignArgs(['--version', '0.2.1'])).toThrow('--app');
		expect(() => parseSignArgs(['--version', '0.2.1', '--app', APP, '--sign'])).toThrow();
		expect(() => parseSignArgs(['--version', '0.2.1', '--app', APP, '--feed-url', 'x'])).toThrow();
	});

	it('reports a builder failure as exit 1', async () => {
		const { deps, err } = fakeDeps({
			loadBuilder: () => ({
				build: async () => {
					throw new Error('notarisation rejected');
				},
				MacPackager: vi.fn() as unknown as SigningBuilder['MacPackager']
			})
		});
		expect(await runSignCli(['--version', '0.2.1', '--app', APP], deps)).toBe(1);
		expect(err).toEqual(['sign:mac: notarisation rejected']);
	});
});

describe('signingPackagerFactory', () => {
	function fakePackager(signed: boolean) {
		const calls: string[] = [];
		class FakeMacPackager implements MacPackagerLike {
			constructor(readonly info: unknown) {}
			async sign(appPath: string) {
				calls.push(`sign ${appPath}`);
				return signed;
			}
			async packMacTargets(_o: string, _a: unknown, _t: unknown, prepackaged: string) {
				calls.push(`pack ${prepackaged}`);
				return undefined;
			}
		}
		return { FakeMacPackager, calls };
	}

	it('signs the prepackaged app before packing its targets', async () => {
		const { FakeMacPackager, calls } = fakePackager(true);
		const packager = signingPackagerFactory(FakeMacPackager)({ info: 1 }, { name: 'mac' });
		await packager.packMacTargets('out', 'universal', [], '/x/Price Check.app', {});
		expect(calls).toEqual(['sign /x/Price Check.app', 'pack /x/Price Check.app']);
	});

	it('never packs an app that sign() did not sign', async () => {
		const { FakeMacPackager, calls } = fakePackager(false);
		const packager = signingPackagerFactory(FakeMacPackager)({}, { name: 'mac' });
		await expect(
			packager.packMacTargets('out', 'universal', [], '/x/Price Check.app', {})
		).rejects.toThrow('signed nothing');
		expect(calls).toEqual(['sign /x/Price Check.app']);
	});

	it('refuses any platform but mac', () => {
		const { FakeMacPackager } = fakePackager(true);
		for (const name of ['windows', 'linux']) {
			expect(() => signingPackagerFactory(FakeMacPackager)({}, { name })).toThrow('macOS only');
		}
	});
});
