import type { Vault } from "obsidian";
import type { ObsidianVaultLike } from "./vaultAdapter";

/** Compile-time proof that Obsidian's real Vault satisfies the adapter's structural subset. */
export type VaultIsVaultLike = Vault extends ObsidianVaultLike ? true : never;
const check: VaultIsVaultLike = true;
void check;
