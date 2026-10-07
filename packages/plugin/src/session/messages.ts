import { MAX_SYNC_FILE_BYTES } from "@obsidian-crdt/shared";
import type { SyncNotice } from "../core/notices";
import type { SyncStatus } from "./status";

const MAX_LISTED_PATHS = 5;
const MAX_SYNC_FILE_MB = MAX_SYNC_FILE_BYTES / (1024 * 1024);

export function noticeMessage(notice: SyncNotice): string {
  switch (notice.kind) {
    case "waiting-for-first-sync":
      return "CRDT Sync: 첫 동기화는 서버 연결이 필요합니다. 연결을 기다리는 중입니다.";
    case "conflict-copy":
      return `CRDT Sync: ${notice.path}의 디스크 내용이 서버와 달라 ${notice.copyPath}에 따로 저장했습니다.`;
    case "file-too-large":
      return `CRDT Sync: ${notice.path}은(는) ${MAX_SYNC_FILE_MB}MB를 넘어 동기화하지 않습니다.`;
    case "mass-delete-paused": {
      const listed = notice.paths.slice(0, MAX_LISTED_PATHS).join(", ");
      return `CRDT Sync: 파일 ${notice.paths.length}개가 한꺼번에 삭제되어 동기화를 멈췄습니다 (${listed}). 확인 창에서 선택하세요.`;
    }
    case "task-failed":
      return `CRDT Sync: 작업 하나가 실패했습니다 — ${notice.message}`;
  }
}

const STATUS_LABELS: Record<SyncStatus, string> = {
  stopped: "꺼짐",
  starting: "시작 중",
  "waiting-first-sync": "첫 동기화 대기",
  connected: "동기화됨",
  offline: "오프라인",
  "auth-failed": "인증 실패",
  "deletes-paused": "삭제 확인 필요",
  error: "오류",
};

export function statusLabel(status: SyncStatus): string {
  return STATUS_LABELS[status];
}
