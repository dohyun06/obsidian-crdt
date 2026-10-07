import { type App, Modal, Notice, Setting } from "obsidian";

export interface MassDeleteChoices {
  confirm(): Promise<void>;
  restore(): Promise<void>;
}

export class MassDeleteModal extends Modal {
  constructor(
    app: App,
    private readonly paths: string[],
    private readonly choices: MassDeleteChoices,
  ) {
    super(app);
  }

  onOpen(): void {
    this.setTitle(`파일 ${this.paths.length}개가 한꺼번에 삭제되었습니다`);
    this.contentEl.createEl("p", { text: "다른 기기에도 삭제를 반영할까요, 아니면 파일을 되살릴까요?" });
    const list = this.contentEl.createEl("ul", { cls: "crdt-sync-modal-list" });
    for (const path of this.paths) list.createEl("li", { text: path });
    new Setting(this.contentEl)
      .addButton((button) => button.setButtonText("되살리기").onClick(() => this.choose(this.choices.restore)))
      .addButton((button) => button.setButtonText("삭제 반영").setWarning().onClick(() => this.choose(this.choices.confirm)));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private choose(action: () => Promise<void>): void {
    this.close();
    action().catch((error) => {
      console.error("CRDT Sync: mass-delete decision failed", error);
      new Notice(`삭제 처리에 실패했습니다: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}
