# Obsidian CRDT Sync

Obsidian 노트를 여러 기기에서 충돌 없이 실시간으로 함께 편집하는 플러그인입니다 (Yjs + Hocuspocus).

- 설계: [docs/superpowers/specs/2026-10-07-obsidian-crdt-sync-design.md](docs/superpowers/specs/2026-10-07-obsidian-crdt-sync-design.md)
- 서버 배포: [deploy/README.md](deploy/README.md)
- 실제 Obsidian 검증 목록: [docs/manual-verification.md](docs/manual-verification.md)

## 개발

```bash
npm install
npm run check
npm run build -w @obsidian-crdt/plugin
npm run install-dev -w @obsidian-crdt/plugin -- "/path/to/test vault"
```

플러그인 ID는 `crdt-sync`이며 `<vault>/.obsidian/plugins/crdt-sync/`에 설치됩니다.
설치 후 Obsidian에서 커뮤니티 플러그인 → CRDT Sync를 켜고 설정에서 서버 주소, 볼트 ID, 토큰을 입력합니다.
토큰은 Obsidian 비밀 저장소에 보관되며 `data.json`에는 들어가지 않습니다.

명령 팔레트에서 쓸 수 있는 명령:

- **다시 연결**: 세션을 다시 시작합니다.
- **동기화 일시정지 / 동기화 재개**: 동기화를 잠시 멈추거나 다시 시작합니다.
- **삭제 확인 창 다시 열기**: 대량 삭제 확인 창을 닫았을 때 다시 엽니다 (상태 표시줄 클릭으로도 열 수 있습니다).

## 운영 가이드 (스펙 §8)

- 플러그인을 쓰는 모든 기기에서 **Obsidian Git의 auto-pull을 끈다.**
- git 커밋과 push는 **커밋 기기 한 대**에서만 한다.
- git 충돌이 나면 **작업 트리(CRDT) 버전을 우선**한다.
- 2MB가 넘는 `.md`, `.obsidian/`, `.trash/`, `.git/`은 동기화하지 않는다. 첨부파일(이미지, PDF)은 아직 동기화하지 않는다.
- 한꺼번에 많은 파일이 지워지면 동기화가 멈추고 확인 창이 뜬다.
