#!/usr/bin/env bash
# kind 叢集建立後不能再加 extraPortMappings，所以啟動一個小容器（只綁 127.0.0.1）把主機連接埠轉送到 NodePort。
# 流量照樣經 kube-proxy 與 NetworkPolicy，與甲方從外部連 NodePort／Ingress 相同；port-forward 則會繞過兩者。
#   ./expose.sh          啟動（已在執行就重建）
#   ./expose.sh down     停止並移除這個容器（只動本腳本建立的 ai-platform-k8s-expose）
# 對應：38180→Keycloak  38980→Gateway  38981→OHIF（Gateway 9081）  38982→網頁（Gateway 9082）  38943→模擬 PACS REST  38925→Mailpit
# 不想多一個容器時，也可以用 port-forward（會繞過 NetworkPolicy；Keycloak 的 KC_HOSTNAME 仍是 localhost:38180）：
#   kubectl -n ai-platform port-forward svc/apisix 38980:9080 38981:9081 & kubectl -n ai-platform port-forward svc/keycloak 38180:8080 &
set -euo pipefail
NAME=ai-platform-k8s-expose
TARGET="${TARGET:-ai-platform-control-plane}"     # 任何一個節點都可以（NodePort 在每個節點上都開）
MAP="${MAP:-38180:30880 38980:30980 38981:30981 38982:30982 38943:30943 38925:30925}"
IMAGE="${IMAGE:-python:3.12-slim}"
docker rm -f "$NAME" >/dev/null 2>&1 || true
[ "${1:-}" = "down" ] && { echo "已移除 $NAME"; exit 0; }
ports=(); for m in $MAP; do ports+=(-p "127.0.0.1:${m%%:*}:${m%%:*}"); done
docker run -d --name "$NAME" --restart unless-stopped --network kind --memory 64m \
  --label app.kubernetes.io/part-of=ai-platform -e TARGET="$TARGET" -e MAP="$MAP" "${ports[@]}" "$IMAGE" python -u -c '
import asyncio, os
async def pipe(r, w):
    try:
        while data := await r.read(65536):
            w.write(data); await w.drain()
    except (ConnectionError, OSError):
        pass
    finally:
        w.close()
def handler(port):
    async def handle(cr, cw):
        try:
            ur, uw = await asyncio.open_connection(os.environ["TARGET"], port)
        except OSError:
            cw.close(); return
        await asyncio.gather(pipe(cr, uw), pipe(ur, cw))
    return handle
async def main():
    servers = []
    for m in os.environ["MAP"].split():
        listen, node_port = (int(x) for x in m.split(":"))
        servers.append(await asyncio.start_server(handler(node_port), "0.0.0.0", listen))
        print(listen, "->", os.environ["TARGET"], node_port, flush=True)
    await asyncio.gather(*(s.serve_forever() for s in servers))
asyncio.run(main())
' >/dev/null
echo "已啟動 $NAME：$MAP（主機 127.0.0.1）"
