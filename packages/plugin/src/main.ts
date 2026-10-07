import { editorInfoField, MarkdownView, Notice, Plugin } from "obsidian";
import type { EditorView } from "@codemirror/view";
import { HocuspocusSyncer } from "./core/hocuspocusSyncer";
import type { SyncNotice } from "./core/notices";
import { EditorBridge } from "./editor/editorBridge";
import { openSyncDatabase } from "./obsidian/idb";
import { IdbDocPersistence } from "./obsidian/idbDocPersistence";
import { IdbStorage } from "./obsidian/idbStorage";
import { ObsidianVaultAdapter } from "./obsidian/vaultAdapter";
import { noticeMessage } from "./session/messages";
import { type SessionStorage, SyncSession } from "./session/syncSession";
import { CrdtSyncSettingTab } from "./settings/settingTab";
import { DEFAULT_SETTINGS, mergeSettings, type PluginSettings, resolveSessionConfig, type SessionConfig, userColor } from "./settings/settings";
import { MassDeleteModal } from "./ui/massDeleteModal";
import { StatusBar } from "./ui/statusBar";

export default class CrdtSyncPlugin extends Plugin {
  settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private session: SyncSession | null = null;
  private statusBar: StatusBar | null = null;
  private bridge: EditorBridge | null = null;
  private restarting: Promise<void> = Promise.resolve();

  async onload(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());
    this.statusBar = new StatusBar(this.addStatusBarItem());
    this.bridge = new EditorBridge({
      getSource: () => this.session?.editorSource ?? null,
      getUser: () => ({ name: this.settings.deviceName, ...userColor(this.settings.deviceName) }),
      fileOf: (state) => state.field(editorInfoField, false)?.file?.path ?? null,
      saveEditor: (view, path) => this.saveEditor(view, path),
      reportError: (error) => console.error("CRDT Sync: editor binding failed", error),
    });
    this.registerEditorExtension(this.bridge.extension());
    this.addSettingTab(new CrdtSyncSettingTab(this.app, this));
    this.addCommand({ id: "reconnect", name: "다시 연결", callback: () => void this.restartSession() });
    this.addCommand({ id: "pause", name: "동기화 일시정지", callback: () => this.session?.pause() });
    this.addCommand({ id: "resume", name: "동기화 재개", callback: () => this.session?.resume() });
    // Mobile apps suspend sockets in the background; reconnect as soon as the app is visible or online again.
    this.registerDomEvent(document, "visibilitychange", () => document.visibilityState === "visible" && this.session?.resume());
    this.registerDomEvent(window, "online", () => this.session?.resume());
    this.registerEvent(this.app.vault.on("rename", () => this.bridge?.rebindAll()));
    this.app.workspace.onLayoutReady(() => void this.restartSession());
  }

  async onunload(): Promise<void> {
    await this.stopSession();
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  restartSession(): Promise<void> {
    this.restarting = this.restarting.then(() => this.restart());
    return this.restarting;
  }

  private async restart(): Promise<void> {
    await this.stopSession();
    if (!this.settings.enabled) return this.statusBar?.render("stopped");
    const result = resolveSessionConfig(this.settings, (id) => this.app.secretStorage.getSecret(id));
    if (!result.ok) {
      this.statusBar?.render("error");
      new Notice(`CRDT Sync 설정을 확인하세요:\n${result.problems.join("\n")}`);
      return;
    }
    this.session = this.createSession(result.config);
    try {
      await this.session.start();
    } catch (error) {
      this.statusBar?.render("error");
      new Notice(`CRDT Sync를 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.bridge?.refreshAll();
  }

  private createSession(config: SessionConfig): SyncSession {
    const session: SyncSession = new SyncSession({
      config,
      vault: new ObsidianVaultAdapter(this.app.vault),
      openStorage: (cfg) => this.openStorage(cfg),
      createSyncer: (cfg, handlers) => new HocuspocusSyncer({ url: cfg.serverUrl, token: cfg.token, ...handlers }),
      isOpenInEditor: (path) => this.bridge?.isOpen(path) ?? false,
      excludedPrefixes: [`${this.app.vault.configDir}/`],
      onStatus: (status) => this.statusBar?.render(status),
      onNotice: (notice) => this.showNotice(notice, session),
    });
    return session;
  }

  private async openStorage(config: SessionConfig): Promise<SessionStorage> {
    const db = await openSyncDatabase(`crdt-sync/${this.app.vault.getName()}/${config.vaultId}`, indexedDB);
    const persistence = new IdbDocPersistence(db, { onError: (error) => console.error("CRDT Sync: saving local state failed", error) });
    return { storage: new IdbStorage(db), persistence, flush: () => persistence.flushAll(), close: () => db.close() };
  }

  private showNotice(notice: SyncNotice, session: SyncSession): void {
    if (this.settings.debugLogging) console.debug("CRDT Sync notice", notice.kind);
    new Notice(noticeMessage(notice));
    if (notice.kind !== "mass-delete-paused") return;
    new MassDeleteModal(this.app, notice.paths, { confirm: () => session.confirmDeletes(), restore: () => session.restoreDeletes() }).open();
  }

  private async stopSession(): Promise<void> {
    await this.bridge?.detachAll(); // needs the running engine for capture/notify
    const session = this.session;
    this.session = null;
    await session?.stop();
  }

  private async saveEditor(view: EditorView, path: string): Promise<void> {
    const info = view.state.field(editorInfoField, false);
    if (info instanceof MarkdownView && info.file?.path === path) await info.save();
  }
}
