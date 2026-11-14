import type { Menu, MenuItemConstructorOptions, Tray } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	createTray,
	DARWIN_ICON_FILE,
	DEFAULT_ICON_FILE,
	trayIconPath,
	TRAY_TOOLTIP,
	type AppTray,
	type TrayActions,
	type TrayDeps
} from './tray.ts';

// Compile-time only (pnpm check): the real Electron Tray and Menu must satisfy the
// structural deps main.ts passes in.
type RealDeps = { Tray: typeof Tray; Menu: typeof Menu; platform: NodeJS.Platform };
const realDepsFit = (deps: RealDeps): TrayDeps<Menu> => deps;
void realDepsFit;

const ASSETS_DIR = fileURLToPath(new URL('./assets', import.meta.url));
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

type FakeMenu = { template: MenuItemConstructorOptions[] };

class FakeTray implements AppTray<FakeMenu> {
	static instances: FakeTray[] = [];

	readonly image: string;
	readonly menus: FakeMenu[] = [];
	toolTip: string | null = null;

	constructor(image: string) {
		this.image = image;
		FakeTray.instances.push(this);
	}

	setToolTip(toolTip: string): void {
		this.toolTip = toolTip;
	}

	setContextMenu(menu: FakeMenu): void {
		this.menus.push(menu);
	}

	get menu(): MenuItemConstructorOptions[] {
		const last = this.menus.at(-1);
		if (!last) throw new Error('no context menu set');
		return last.template;
	}

	/** What Electron does on a click: flips a checkbox's own state, then calls its handler. */
	click(label: string): void {
		const item = this.menu.find((i) => i.label === label);
		if (!item) throw new Error(`no menu item ${label}`);
		if (item.type === 'checkbox') item.checked = !item.checked;
		const click = item.click as (() => void) | undefined;
		click?.();
	}
}

/** A login item backed by a fake OS registration. */
function fakeLoginItem(initial: boolean) {
	const os = { enabled: initial, failNext: false };
	return {
		os,
		isEnabled: vi.fn(() => os.enabled),
		setEnabled: vi.fn((enabled: boolean) => {
			if (os.failNext) {
				os.failNext = false;
				throw new Error('OS refused');
			}
			os.enabled = enabled;
		})
	};
}

function setup(opts: { platform?: NodeJS.Platform; loginEnabled?: boolean } = {}) {
	const loginItem = fakeLoginItem(opts.loginEnabled ?? true);
	const actions = {
		showWindow: vi.fn(),
		quitApp: vi.fn(),
		loginItem,
		iconDir: ASSETS_DIR
	} satisfies TrayActions;
	const deps: TrayDeps<FakeMenu> = {
		Tray: FakeTray,
		Menu: { buildFromTemplate: (template) => ({ template }) },
		platform: opts.platform ?? 'darwin'
	};
	const handle = createTray(deps, actions);
	const tray = FakeTray.instances.at(-1);
	if (!tray) throw new Error('no tray created');
	return { handle, tray, actions, loginItem };
}

const labels = (menu: MenuItemConstructorOptions[]) =>
	menu.filter((i) => i.type !== 'separator').map((i) => i.label);
const loginCheckbox = (tray: FakeTray) => tray.menu.find((i) => i.label === 'Start at login');

afterEach(() => {
	FakeTray.instances = [];
	vi.restoreAllMocks();
});

describe('tray menu', () => {
	it('lists exactly Open, Start at login, Quit in order', () => {
		const { tray } = setup();
		expect(labels(tray.menu)).toEqual(['Open', 'Start at login', 'Quit']);
		for (const item of tray.menu) {
			if (item.type !== 'separator') expect(item.label).toBeTruthy();
		}
	});

	it.each([true, false])(
		'shows Start at login as a checkbox checked=%s from the OS state',
		(enabled) => {
			const { tray, loginItem } = setup({ loginEnabled: enabled });
			const item = loginCheckbox(tray);
			expect(item?.type).toBe('checkbox');
			expect(item?.checked).toBe(enabled);
			expect(loginItem.isEnabled).toHaveBeenCalled();
		}
	);

	it('sets the tooltip and keeps the tray on the returned handle', () => {
		const { tray, handle } = setup();
		expect(tray.toolTip).toBe(TRAY_TOOLTIP);
		expect(handle.tray).toBe(tray);
		expect(FakeTray.instances).toHaveLength(1);
	});

	it('rebuildMenu re-reads the OS state', () => {
		const { tray, handle, loginItem } = setup({ loginEnabled: true });
		loginItem.os.enabled = false;
		handle.rebuildMenu();
		expect(loginCheckbox(tray)?.checked).toBe(false);
	});
});

describe('tray actions', () => {
	it('Open calls showWindow once and nothing else', () => {
		const { tray, actions, loginItem } = setup();
		tray.click('Open');
		expect(actions.showWindow).toHaveBeenCalledTimes(1);
		expect(actions.quitApp).not.toHaveBeenCalled();
		expect(loginItem.setEnabled).not.toHaveBeenCalled();
	});

	it('Quit calls quitApp once and nothing else', () => {
		const { tray, actions, loginItem } = setup();
		const menusBefore = tray.menus.length;
		tray.click('Quit');
		expect(actions.quitApp).toHaveBeenCalledTimes(1);
		expect(actions.showWindow).not.toHaveBeenCalled();
		expect(loginItem.setEnabled).not.toHaveBeenCalled();
		expect(tray.menus).toHaveLength(menusBefore);
	});
});

describe('Start at login toggle', () => {
	it.each([true, false])(
		'from %s calls setEnabled with the opposite and rebuilds from the OS',
		(initial) => {
			const { tray, loginItem } = setup({ loginEnabled: initial });
			const menusBefore = tray.menus.length;
			tray.click('Start at login');
			expect(loginItem.setEnabled).toHaveBeenCalledTimes(1);
			expect(loginItem.setEnabled).toHaveBeenCalledWith(!initial);
			expect(tray.menus).toHaveLength(menusBefore + 1);
			expect(loginCheckbox(tray)?.checked).toBe(!initial);
		}
	);

	it('rebuilds with the re-read OS state, not the clicked state', () => {
		const { tray, loginItem } = setup({ loginEnabled: true });
		// The OS call "succeeds" but the OS still reports enabled (e.g. a policy pin).
		loginItem.setEnabled.mockImplementationOnce(() => {});
		tray.click('Start at login');
		expect(loginCheckbox(tray)?.checked).toBe(true);
	});

	it('a throwing setEnabled leaves the checkbox showing the real OS state', () => {
		const { tray, loginItem } = setup({ loginEnabled: true });
		const error = vi.spyOn(console, 'error').mockImplementation(() => {});
		loginItem.os.failNext = true;
		expect(() => tray.click('Start at login')).not.toThrow();
		expect(loginItem.setEnabled).toHaveBeenCalledWith(false);
		expect(loginCheckbox(tray)?.checked).toBe(true);
		expect(error).toHaveBeenCalled();
	});

	it('toggles back and forth against the live state', () => {
		const { tray, loginItem } = setup({ loginEnabled: true });
		tray.click('Start at login');
		tray.click('Start at login');
		expect(loginItem.setEnabled.mock.calls).toEqual([[false], [true]]);
		expect(loginCheckbox(tray)?.checked).toBe(true);
	});
});

describe('tray icon', () => {
	it('uses the Template image on macOS', () => {
		const { tray } = setup({ platform: 'darwin' });
		expect(tray.image).toBe(join(ASSETS_DIR, 'tray-iconTemplate.png'));
	});

	it.each(['win32', 'linux'] as const)('uses the colour icon on %s', (platform) => {
		const { tray } = setup({ platform });
		expect(tray.image).toBe(join(ASSETS_DIR, 'tray-icon.png'));
	});

	it('resolves icons inside the injected iconDir', () => {
		expect(trayIconPath('darwin', '/app/root/assets')).toBe(
			join('/app/root/assets', DARWIN_ICON_FILE)
		);
		expect(trayIconPath('linux', '/app/root/assets')).toBe(
			join('/app/root/assets', DEFAULT_ICON_FILE)
		);
	});

	it.each([DARWIN_ICON_FILE, DEFAULT_ICON_FILE])(
		'%s exists under src/desktop/assets as a PNG',
		(file) => {
			const path = join(ASSETS_DIR, file);
			expect(existsSync(path)).toBe(true);
			expect(readFileSync(path).subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
		}
	);

	it('the macOS file name ends in Template.png, which macOS needs for a template image', () => {
		expect(DARWIN_ICON_FILE).toMatch(/Template\.png$/);
	});
});
