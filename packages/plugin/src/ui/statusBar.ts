import { statusLabel } from "../session/messages";
import type { SyncStatus } from "../session/status";

export class StatusBar {
  constructor(private readonly el: HTMLElement) {
    el.addClass("crdt-sync-status");
    this.render("stopped");
  }

  render(status: SyncStatus): void {
    this.el.setText(`CRDT: ${statusLabel(status)}`);
  }
}
