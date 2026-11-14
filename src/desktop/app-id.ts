// The app's one ID (spec c-6, decision app_user_model_id). Windows routes toasts by
// AppUserModelId and silently drops one whose ID has no matching Start Menu
// shortcut, which only the 05 installer creates. So a packaged Windows run sets
// APP_ID, and an unpackaged one (pnpm dev, the e2e suite) uses process.execPath,
// which Windows resolves on its own. macOS and Linux take no AppUserModelId.
//
// No imports at all: 05's electron-builder config reads APP_ID from this file for its
// appId, so 04 and 05 cannot drift apart.

export const APP_ID = 'io.github.rivil.price-check';

export type AppUserModelIdInput = {
	platform: NodeJS.Platform;
	/** Electron's app.isPackaged. */
	isPackaged: boolean;
	/** process.execPath. */
	execPath: string;
};

/** The ID for app.setAppUserModelId, or null where none is set (macOS, Linux). */
export function appUserModelIdFor({
	platform,
	isPackaged,
	execPath
}: AppUserModelIdInput): string | null {
	if (platform !== 'win32') return null;
	return isPackaged ? APP_ID : execPath;
}
