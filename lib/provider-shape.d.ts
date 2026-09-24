/**
 * Pure provider-id validation shared by the host half (Config / ProviderStore)
 * and the client settings page. Kept free of schemastery imports so the
 * client bundle (tsdown purity gate) can inline it.
 *
 * @module @huanlin/dsh-plugin-aigc-canvas/provider-shape
 */
/** Provider id pattern: lowercase letters, digits, hyphens; must start with a letter. */
export declare const PROVIDER_ID_PATTERN: RegExp;
/**
 * Validate a provider id.
 * @param id - candidate id (as typed into the settings page or passed to the store).
 * @returns an error message, or undefined when valid.
 */
export declare function validateProviderId(id: string): string | undefined;
