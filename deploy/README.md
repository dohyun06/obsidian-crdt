# 동기화 서버 배포 (Oracle Free Tier VM)

## 1. 준비
- VM에 Docker와 Docker Compose 플러그인 설치
- 도메인(또는 DDNS)의 A 레코드를 VM 공인 IP로 지정
- OCI 콘솔 → VCN → Security List에 TCP 80, 443 인그레스 허용
- Ubuntu 이미지는 iptables가 기본으로 막고 있으므로 열어준다:

```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80 -j ACCEPT
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443 -j ACCEPT
sudo netfilter-persistent save
```

## 2. 실행
```bash
cd deploy
cp .env.example .env   # SYNC_DOMAIN 수정
docker compose up -d --build
```

## 3. 토큰 발급 (볼트마다)
```bash
docker compose exec sync-server node packages/server/dist/token.js token create my-vault-01
```
출력된 `token:` 값은 한 번만 표시된다. 플러그인 설정에 바로 입력한다.

폐기와 목록:
```bash
docker compose exec sync-server node packages/server/dist/token.js token list
docker compose exec sync-server node packages/server/dist/token.js token revoke <tokenId>
```

## 4. 백업
문서와 토큰 해시는 `sync-data` 볼륨의 `/app/data/sync.db`에 있다.
```bash
docker compose exec sync-server node -e "require('node:sqlite')" && \
docker run --rm -v deploy_sync-data:/data -v "$PWD":/backup busybox tar czf /backup/sync-data.tgz -C /data .
```

## 5. 보안 메모
- Hocuspocus는 compose 내부 네트워크에만 열려 있고, 외부는 Caddy(80/443)만 노출된다.
- 로그에는 토큰과 노트 내용이 남지 않는다.
