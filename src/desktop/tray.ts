// The tray (spec c-5, c-6, c-9): Open brings the window back, Start at login toggles
// the OS registration, Quit ends the app. It is the way back to a closed window
// while the app keeps checking in the background.
//
// The menu is always built from live OS state: the Start at login checkbox reads
// loginItem.isEnabled() each time the menu is built, and every toggle rebuilds it.
// Electron flips a checkbox's own `checked` before its click handler runs, so a
// toggle whose OS call threw would otherwise keep showing the state that failed.
//
// The handle holds the Tray: a Tray that gets garbage-collected disappears from the
// menu bar / notification area.
//
// Runs in the Electron main bundle: Electron types via `import type` only; main.ts
// passes the real Tray and Menu. iconDir is injected because the bundle lives in
// dist-desktop/, not next to src/desktop/assets.
import type { MenuItemConstructorOptions } from 'electron';
import { join } from 'node:path';

export const TRAY_TOOLTIP = 'Price Check';
/** macOS treats a `…Template.png` file as a template image (tinted for light/dark menu bars). */
export const DARWIN_ICON_FILE = 'tray-iconTemplate.png';
export const DEFAULT_ICON_FILE = 'tray-icon.png';

/** The slice of Electron's Tray this module uses; M is the platform's menu type. */
export type AppTray<M> = {
	setToolTip(toolTip: string): void;
	setContextMenu(menu: M): void;
};

export type TrayDeps<M> = {
	Tray: new (image: string) => AppTray<M>;
	Menu: { buildFromTemplate(template: MenuItemConstructorOptions[]): M };
	platform: NodeJS.Platform;
};

/** The start-at-login controls the tray needs (login-item.ts provides them). */
export type TrayLoginItem = {
	isEnabled(): boolean;
	setEnabled(enabled: boolean): void;
};

export type TrayActions = {
	showWindow(): void;
	quitApp(): void;
	loginItem: TrayLoginItem;
	/** The directory holding the tray icon files (src/desktop/assets in the app root). */
	iconDir: string;
};

export type TrayHandle<M> = {
	readonly tray: AppTray<M>;
	/** Rebuilds the menu from the current OS state. */
	rebuildMenu(): void;
};

/** The icon file for this platform: the template image on macOS, the colour one elsewhere. */
export function trayIconPath(platform: NodeJS.Platform, iconDir: string): string {
	return join(iconDir, platform === 'darwin' ? DARWIN_ICON_FILE : DEFAULT_ICON_FILE);
}

/** The menu template, read from live OS state; `onToggleLogin` runs on a Start at login click. */
export function trayMenuTemplate(
	actions: TrayActions,
	onToggleLogin: () => void
): MenuItemConstructorOptions[] {
	return [
		{ label: 'Open', click: () => actions.showWindow() },
		{
			label: 'Start at login',
			type: 'checkbox',
			checked: actions.loginItem.isEnabled(),
			click: onToggleLogin
		},
		{ type: 'separator' },
		{ label: 'Quit', click: () => actions.quitApp() }
	];
}

/** Creates the tray icon with its menu and returns the handle that keeps it alive. */
export function createTray<M>(deps: TrayDeps<M>, actions: TrayActions): TrayHandle<M> {
	const tray = new deps.Tray(trayIconPath(deps.platform, actions.iconDir));
	tray.setToolTip(TRAY_TOOLTIP);

	const rebuildMenu = (): void => {
		tray.setContextMenu(deps.Menu.buildFromTemplate(trayMenuTemplate(actions, toggleLogin)));
	};

	function toggleLogin(): void {
		try {
			actions.loginItem.setEnabled(!actions.loginItem.isEnabled());
		} catch (error) {
			console.error('desktop tray: changing start at login failed', error);
		}
		rebuildMenu();
	}

	rebuildMenu();
	return { tray, rebuildMenu };
}
