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
  private unloaded = false;
  /** True after the pause command; app visibility/online events must not undo the user's choice. */
  private userPaused = false;

  async onload(): Promise<void> {
    this.settings = mergeSettings(await this.loadData());
    this.statusBar = new StatusBar(this.addStatusBarItem(), () => this.reviewPausedDeletes());
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
    this.addCommand({ id: "pause", name: "동기화 일시정지", callback: () => this.setUserPaused(true) });
    this.addCommand({ id: "resume", name: "동기화 재개", callback: () => this.setUserPaused(false) });
    this.addCommand({ id: "review-paused-deletions", name: "삭제 확인 창 다시 열기", callback: () => this.reviewPausedDeletes() });
    // Mobile apps suspend sockets in the background; reconnect as soon as the app is visible or online again.
    this.registerDomEvent(document, "visibilitychange", () => document.visibilityState === "visible" && this.resumeUnlessPaused());
    this.registerDomEvent(window, "online", () => this.resumeUnlessPaused());
    this.registerEvent(this.app.vault.on("rename", () => this.bridge?.rebindAll()));
    this.app.workspace.onLayoutReady(() => void this.restartSession());
  }

  /** Obsidian does not await onunload, so the final flush on unload is best-effort. */
  async onunload(): Promise<void> {
    this.unloaded = true;
    this.restarting = this.restarting.catch(() => {}).then(() => this.stopSession());
    await this.restarting;
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  restartSession(): Promise<void> {
    this.restarting = this.restarting.catch(() => {}).then(() => this.restart());
    return this.restarting;
  }

  private setUserPaused(paused: boolean): void {
    this.userPaused = paused;
    if (paused) this.session?.pause();
    else this.session?.resume();
  }

  private resumeUnlessPaused(): void {
    if (!this.userPaused) this.session?.resume();
  }

  /** Auth failure arrives mid-session; stopping goes through the same chain so editors detach first. */
  private stopSessionThroughChain(): void {
    this.restarting = this.restarting.catch(() => {}).then(() => this.stopSession());
  }

  private reviewPausedDeletes(): void {
    const session = this.session;
    if (session && session.pausedDeletePaths.length > 0) this.openMassDeleteModal(session, [...session.pausedDeletePaths]);
  }

  private openMassDeleteModal(session: SyncSession, paths: string[]): void {
    const guarded = (act: (current: SyncSession) => Promise<void>) => async () => {
      if (this.session !== session) {
        new Notice("세션이 바뀌었습니다. 다시 열어 주세요.");
        return;
      }
      await act(session);
    };
    new MassDeleteModal(this.app, paths, {
      confirm: guarded((current) => current.confirmDeletes()),
      restore: guarded((current) => current.restoreDeletes()),
    }).open();
  }

  private async restart(): Promise<void> {
    try {
      await this.restartUnchecked();
    } catch (error) {
      console.error("CRDT Sync: restart failed", error);
      this.statusBar?.render("error");
      new Notice(`CRDT Sync를 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async restartUnchecked(): Promise<void> {
    await this.stopSession();
    if (this.unloaded) return;
    this.userPaused = false;
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
      console.error("CRDT Sync: session start failed", error);
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
      onAuthFailed: () => this.stopSessionThroughChain(),
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
    this.openMassDeleteModal(session, notice.paths);
  }

  private async stopSession(): Promise<void> {
    try {
      await this.bridge?.detachAll(); // needs the running engine for capture/notify
    } catch (error) {
      console.error("CRDT Sync: detaching editors failed", error);
      new Notice("편집기 저장에 실패했지만 동기화를 중지합니다.");
    } finally {
      const session = this.session;
      this.session = null;
      await session?.stop();
    }
  }

  private async saveEditor(view: EditorView, path: string): Promise<void> {
    const info = view.state.field(editorInfoField, false);
    if (info instanceof MarkdownView && info.file?.path === path) await info.save();
  }
}
