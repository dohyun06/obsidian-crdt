import { INDEX_DOC_KEY } from "./constants";

const VAULT_ID_PATTERN = /^[a-z0-9-]{8,64}$/;
const FILE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ParsedDocName =
  | { kind: "index"; vaultId: string }
  | { kind: "file"; vaultId: string; fileId: string };

export class InvalidDocNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidDocNameError";
  }
}

export function isValidVaultId(value: string): boolean {
  return VAULT_ID_PATTERN.test(value);
}

export function isValidFileId(value: string): boolean {
  return FILE_ID_PATTERN.test(value);
}

export function buildIndexDocName(vaultId: string): string {
  if (!isValidVaultId(vaultId)) throw new InvalidDocNameError(`invalid vault id: ${vaultId}`);
  return `${vaultId}/${INDEX_DOC_KEY}`;
}

export function buildFileDocName(vaultId: string, fileId: string): string {
  if (!isValidVaultId(vaultId)) throw new InvalidDocNameError(`invalid vault id: ${vaultId}`);
  if (!isValidFileId(fileId)) throw new InvalidDocNameError(`invalid file id: ${fileId}`);
  return `${vaultId}/${fileId}`;
}

export function parseDocName(name: string): ParsedDocName | null {
  const parts = name.split("/");
  if (parts.length !== 2) return null;
  const [vaultId, key] = parts as [string, string];
  if (!isValidVaultId(vaultId)) return null;
  if (key === INDEX_DOC_KEY) return { kind: "index", vaultId };
  if (isValidFileId(key)) return { kind: "file", vaultId, fileId: key };
  return null;
}
