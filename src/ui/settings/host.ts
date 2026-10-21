/**
 * The settings tab is intentionally a thin view: it never owns state or talks to the network.
 * Everything it needs is provided by the plugin through this host port, which keeps the tab
 * testable/fakeable and keeps `main.ts` free of UI details.
 */

import type { App } from 'obsidian';
import type { DiagnosticsSnapshot } from '../../core/types';
import type { DeepPartial, PredictiveSettings } from '../../settings/schema';

export interface SettingsHost {
	getSettings(): PredictiveSettings;
	updateSettings(patch: DeepPartial<PredictiveSettings>): Promise<void>;
	getDiagnostics(): DiagnosticsSnapshot;
	rebuildIndex(): Promise<void>;
	clearCaches(): Promise<void>;
	/** M6: serialized writing profile, or an empty string when none exists. */
	exportProfile(): Promise<string>;
	/** M6: replace the stored profile with validated JSON. Rejects on invalid input. */
	importProfile(json: string): Promise<void>;
	/** M6: delete only the profile data. */
	clearProfile(): Promise<void>;
	getSemanticStatus(): { enabled: boolean; available: boolean; reason: string };
	/**
	 * Optional: send a minimal completion request with the current provider settings.
	 * Implemented by the plugin host; the settings tab renders the button disabled when absent.
	 */
	testConnection?(): Promise<{ ok: boolean; message: string }>;
}

/** Everything a settings section renderer needs; one object keeps helper signatures short. */
export interface SettingsSectionContext {
	app: App;
	host: SettingsHost;
	containerEl: HTMLElement;
	/** Re-render the whole tab after a change that affects other sections' visibility. */
	refresh: () => void;
}
