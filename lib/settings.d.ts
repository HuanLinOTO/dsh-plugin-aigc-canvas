/**
 * settings.ts — host-side bridge between the entry's profile-owned Config
 * and the plugin's provider store, plus the one-time legacy import.
 *
 * dsh 0.1.7-rc.1 (`DSH-0.1.7-J1-04`) removed the namespace-registration API:
 * a plugin declares a Cordis `Config` (see `config.ts`, `providers` marked
 * `.volatile()`) and only declares the presentation policy for its own page.
 * The bridge exposes:
 *
 *   - `source()`: the raw committed provider list, read from the live
 *     volatile reference on every call, so the tools and RPC surface always
 *     serve the latest accepted value (including edits written by other
 *     surfaces through the settings service).
 *   - `persist(providers)`: commits a replacement list through the settings
 *     service, which writes it into the active profile's `cordis.patch.yml`
 *     under the entry id `dsh-aigc-canvas` and updates the live reference
 *     in place.
 *   - `writable`: whether a settings provider is mounted.
 *
 * On first mount the legacy persistence file of pre-0.1.11 versions
 * (`~/.dsh/aigc-canvas/providers.json`) is imported once (the file is
 * renamed before the import, so a partial import never repeats) and left
 * behind as `providers.json.imported`.
 *
 * @module @huanlin/dsh-plugin-aigc-canvas/settings
 */
import type { AigcEntryConfig, AigcProvider } from './config.js';
import type { AigcSettingsForms, Context } from './context-types.js';
/** Profile entry id under which the provider list persists (`cordis.patch.yml`). */
export declare const SETTINGS_NAMESPACE = "dsh-aigc-canvas";
/** Default legacy persistence path (pre-0.1.11 custom file). */
export declare const LEGACY_PROVIDERS_JSON: string;
/** Minimal logger face (cordis `ctx.logger`). */
interface AigcLogger {
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
}
/** Read/write face the provider store consumes. */
export interface AigcSettingsBridge {
    /** The raw committed provider list, read from the entry's live volatile config. */
    source(): readonly AigcProvider[];
    /**
     * Commit a replacement provider list to the profile entry config.
     * No-op without a mounted settings provider (headless assemblies).
     */
    persist(providers: readonly AigcProvider[]): Promise<void>;
    /** Whether a settings provider is mounted (false in headless assemblies). */
    readonly writable: boolean;
}
/**
 * Declare the plugin's settings presentation policy and return the bridge.
 *
 * `auto: false` suppresses the schema-generated page: this plugin ships its
 * own editor as the bundle row's `plugins.row.config` entry on the Plugins
 * page.
 *
 * @param ctx - host context.
 * @param entry - the entry's volatile Cordis config.
 * @param options - optional overrides (legacy import path, attach callback).
 * @param options.legacyPath - path of the legacy providers file to import once.
 * @param options.onReady - invoked when the settings provider is mounted (before the legacy import settles).
 * @returns the bridge the provider store consumes.
 */
export declare function installAigcSettings(ctx: Context, entry: AigcEntryConfig | undefined, options?: {
    legacyPath?: string;
    onReady?: () => void;
}): AigcSettingsBridge;
/**
 * Import the legacy `providers.json` once: rename the file first (so a
 * partial import never repeats), then commit the parsed list into the
 * profile entry config. Failures are logged, never thrown.
 *
 * @param path - the legacy file path.
 * @param settings - the mounted settings service.
 * @param logger - the host logger.
 */
export declare function importLegacyProviders(path: string, settings: AigcSettingsForms, logger: AigcLogger): Promise<void>;
export {};
