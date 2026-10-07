import { type App, type Plugin, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import type { PluginSettings } from "./settings";

export interface SettingsHost {
  settings: PluginSettings;
  saveSettings(): Promise<void>;
  restartSession(): Promise<void>;
}

export class CrdtSyncSettingTab extends PluginSettingTab {
  constructor(
    app: App,
    private readonly host: SettingsHost & Plugin,
  ) {
    super(app, host);
  }

  display(): void {
    const { containerEl } = this;
    const settings = this.host.settings;
    const save = async (change: Partial<PluginSettings>) => {
      Object.assign(settings, change);
      await this.host.saveSettings();
    };
    containerEl.empty();
    new Setting(containerEl).setName("동기화 켜기").addToggle((toggle) =>
      toggle.setValue(settings.enabled).onChange(async (enabled) => {
        await save({ enabled });
        await this.host.restartSession();
      }),
    );
    new Setting(containerEl).setName("서버 주소").setDesc("wss://로 시작하는 주소").addText((text) =>
      text.setPlaceholder("wss://sync.example.com").setValue(settings.serverUrl).onChange((serverUrl) => save({ serverUrl: serverUrl.trim() })),
    );
    new Setting(containerEl).setName("볼트 ID").setDesc("서버에서 토큰을 만들 때 쓴 ID").addText((text) =>
      text.setValue(settings.vaultId).onChange((vaultId) => save({ vaultId: vaultId.trim() })),
    );
    new Setting(containerEl)
      .setName("토큰")
      .setDesc("Obsidian 비밀 저장소에 보관됩니다. data.json에는 저장되지 않습니다.")
      .addComponent((el) => new SecretComponent(this.app, el).setValue(settings.tokenSecretId).onChange((tokenSecretId) => save({ tokenSecretId })));
    new Setting(containerEl).setName("기기 이름").setDesc("다른 기기에서 커서 옆에 표시됩니다").addText((text) =>
      text.setValue(settings.deviceName).onChange((deviceName) => save({ deviceName: deviceName.trim() || "Obsidian" })),
    );
    new Setting(containerEl).setName("디버그 로그").addToggle((toggle) =>
      toggle.setValue(settings.debugLogging).onChange((debugLogging) => save({ debugLogging })),
    );
    new Setting(containerEl).addButton((button) => button.setButtonText("적용하고 다시 연결").setCta().onClick(() => void this.host.restartSession()));
  }
}
