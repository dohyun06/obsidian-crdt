import { statusLabel } from "../session/messages";
import type { SyncStatus } from "../session/status";

export class StatusBar {
  constructor(
    private readonly el: HTMLElement,
    onClick: () => void,
  ) {
    el.addClass("crdt-sync-status");
    el.addEventListener("click", onClick);
    this.render("stopped");
  }

  render(status: SyncStatus): void {
    this.el.setText(`CRDT: ${statusLabel(status)}`);
  }
}
