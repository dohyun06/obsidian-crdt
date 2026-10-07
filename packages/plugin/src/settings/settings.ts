import { isValidVaultId } from "@obsidian-crdt/shared";
import { assertSecureServerUrl, InsecureServerUrlError } from "../core/serverUrl";

export interface PluginSettings {
  enabled: boolean;
  serverUrl: string;
  vaultId: string;
  /** Id of the token in Obsidian's SecretStorage; the token itself never goes into data.json. */
  tokenSecretId: string;
  deviceName: string;
  debugLogging: boolean;
}

export const DEFAULT_SETTINGS: PluginSettings = {
  enabled: false,
  serverUrl: "",
  vaultId: "",
  tokenSecretId: "crdt-sync-token",
  deviceName: "Obsidian",
  debugLogging: false,
};

const SECRET_ID_PATTERN = /^[a-z0-9-]+$/;
const HUE_RANGE = 360;

export function isValidSecretId(id: string): boolean {
  return SECRET_ID_PATTERN.test(id);
}

export interface SessionConfig {
  serverUrl: string;
  vaultId: string;
  token: string;
  deviceName: string;
}

export type ConfigResult = { ok: true; config: SessionConfig } | { ok: false; problems: string[] };

function pick<K extends keyof PluginSettings>(raw: Record<string, unknown>, key: K): PluginSettings[K] {
  const value = raw[key];
  const picked = typeof value === typeof DEFAULT_SETTINGS[key] ? (value as PluginSettings[K]) : DEFAULT_SETTINGS[key];
  if (key === "deviceName" && typeof picked === "string" && picked.trim() === "") return DEFAULT_SETTINGS[key];
  return picked;
}

export function mergeSettings(raw: unknown): PluginSettings {
  if (typeof raw !== "object" || raw === null) return { ...DEFAULT_SETTINGS };
  const source = raw as Record<string, unknown>;
  const keys = Object.keys(DEFAULT_SETTINGS) as Array<keyof PluginSettings>;
  return Object.fromEntries(keys.map((key) => [key, pick(source, key)])) as unknown as PluginSettings;
}

export function resolveSessionConfig(settings: PluginSettings, getSecret: (id: string) => string | null): ConfigResult {
  const problems: string[] = [];
  try {
    assertSecureServerUrl(settings.serverUrl);
  } catch (error) {
    if (!(error instanceof InsecureServerUrlError)) throw error;
    problems.push("서버 주소는 wss://로 시작해야 합니다 (ws://는 localhost만 허용).");
  }
  if (!isValidVaultId(settings.vaultId)) problems.push("볼트 ID는 소문자, 숫자, -로 된 8~64자여야 합니다.");
  if (!isValidSecretId(settings.tokenSecretId)) {
    problems.push("토큰 비밀 ID는 소문자, 숫자, -만 쓸 수 있습니다.");
    if (problems.length > 0) return { ok: false, problems };
  }
  const secretValue = getSecret(settings.tokenSecretId);
  const token = secretValue?.trim() ?? null;
  if (!token) problems.push("토큰이 비밀 저장소에 없습니다. 설정에서 토큰을 입력하세요.");
  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, config: { serverUrl: settings.serverUrl, vaultId: settings.vaultId, token: token as string, deviceName: settings.deviceName } };
}

/** Deterministic cursor color per device name, so collaborators recognise each other across sessions. */
export function userColor(name: string): { color: string; colorLight: string } {
  let hash = 0;
  for (const char of name) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) | 0;
  const hue = Math.abs(hash) % HUE_RANGE;
  return { color: `hsl(${hue} 70% 45%)`, colorLight: `hsl(${hue} 70% 45% / 0.25)` };
}
