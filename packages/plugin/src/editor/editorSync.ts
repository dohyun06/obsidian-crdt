import { Compartment, EditorState, Prec, StateEffect, StateField, type Extension, type Transaction } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { diffByCodePoint } from "../core/textDiff";

export interface EditorUser {
  name: string;
  color: string;
  colorLight: string;
}

export interface SyncTarget {
  path: string;
  text: Y.Text;
  awareness: Awareness | null;
  user: EditorUser;
}

/** Which vault file the editor state currently shows (Obsidian: editorInfoField's live `file` getter). */
export type FileOf = (state: EditorState) => string | null;

const syncCompartment = new Compartment();
const setBoundPath = StateEffect.define<string | null>();
const boundPathField = StateField.define<string | null>({
  create: () => null,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(setBoundPath)) return effect.value;
    return value;
  },
});
const undoManagers = new WeakMap<EditorView, Y.UndoManager>();
const boundAwareness = new WeakMap<EditorView, Awareness>();

function releaseBinding(view: EditorView): void {
  undoManagers.get(view)?.destroy();
  undoManagers.delete(view);
  boundAwareness.get(view)?.setLocalStateField("cursor", null);
  boundAwareness.delete(view);
}

/** Installed once per editor; empty until attachSync binds a Y.Text. */
export function editorSyncExtension(fileOf: FileOf): Extension {
  return [syncCompartment.of([]), boundPathField, fileSwitchGuard(fileOf)];
}

export function boundPathOf(state: EditorState): string | null {
  return state.field(boundPathField, false) ?? null;
}

export function attachSync(view: EditorView, target: SyncTarget): void {
  // CodeMirror reuses a ViewPlugin instance across reconfigures (it keeps the old Y.Text), so unbind first.
  detachSync(view);
  target.awareness?.setLocalStateField("user", target.user);
  if (target.awareness) boundAwareness.set(view, target.awareness);
  const undoManager = new Y.UndoManager(target.text);
  undoManagers.set(view, undoManager);
  // One transaction: align the editor to the Y.Text and install yCollab together, so the alignment is not
  // replayed into the Y.Text and no remote update can land in between.
  view.dispatch({
    changes: alignmentChanges(view.state.doc.toString(), target.text.toString()),
    effects: [
      syncCompartment.reconfigure([yCollab(target.text, target.awareness, { undoManager }), Prec.highest(keymap.of(yUndoManagerKeymap))]),
      setBoundPath.of(target.path),
    ],
  });
}

export function detachSync(view: EditorView): void {
  // A destroyed editor (pane closed) is no longer in the DOM and must not receive transactions.
  if (boundPathOf(view.state) !== null && view.dom.isConnected) view.dispatch({ effects: [syncCompartment.reconfigure([]), setBoundPath.of(null)] });
  releaseBinding(view);
}

/**
 * Spec §9 risk: Obsidian may reuse one editor for another file. When the shown file no longer matches the bound
 * path, the binding is removed in the same transaction, so yCollab never sees the new file's content.
 */
function fileSwitchGuard(fileOf: FileOf): Extension {
  return EditorState.transactionExtender.of((transaction: Transaction) => {
    const bound = transaction.startState.field(boundPathField, false) ?? null;
    // attach/detach transactions decide the binding themselves
    if (transaction.effects.some((effect) => effect.is(setBoundPath))) return null;
    if (bound === null || fileOf(transaction.startState) === bound) return null;
    return { effects: [syncCompartment.reconfigure([]), setBoundPath.of(null)] };
  });
}

/** Code-point-safe changes, in positions of `current`, that turn `current` into `next`. */
export function alignmentChanges(current: string, next: string): Array<{ from: number; to: number; insert: string }> {
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  let position = 0;
  for (const edit of diffByCodePoint(current, next)) {
    if (edit.op === "equal") position += edit.text.length;
    else if (edit.op === "delete") {
      changes.push({ from: position, to: position + edit.text.length, insert: "" });
      position += edit.text.length;
    } else changes.push({ from: position, to: position, insert: edit.text });
  }
  return changes;
}
