# 行程排期台账 · 部署说明

给部署同事看的操作手册。整个服务**零依赖**：不用 `npm install`，只需要 Node.js。

---

## ⚡ 5 分钟部署清单

- [ ] 服务器装 Node 18+：`node -v`
- [ ] 把本文件夹上传到 `/opt/itinerary`
- [ ] 启动：`node server.js`，浏览器打开 `http://服务器IP:3000`
- [ ] 注册第一个账号 → 随便改一格 → 刷新看是否保存
- [ ] 配域名 + HTTPS 反代（第 5 节）★ 这一步必须做
- [ ] 配 systemd 常驻（第 4 节），重启服务器能自动拉起
- [ ] 团队内部使用建议设 `ALLOW_REGISTER=0`，关掉公开注册
- [ ] 加一条每日异地备份（第 7 节）

> 除了 HTTPS，其余都是复制粘贴命令。卡住了先看第 12 节自检。

---

## 1. 是什么

一个单文件前端 + 一个 Node 后端：

```
浏览器 ──HTTPS──> 你的服务器
                   ├─ /            → index.html（整个应用，含界面和逻辑）
                   └─ /api/*       → server.js（登录、云端存储、协作权限）
                                    └─ data/db.json（全部数据）
```

- 前端就是 `index.html` 一个文件，后端就是 `server.js` 一个文件。
- 数据全部落在 `data/db.json`，没有外部数据库、没有 Redis、没有消息队列。

---

## 2. 运行要求

| 项目 | 要求 |
|---|---|
| Node.js | **18 或以上**（推荐 20 LTS） |
| 端口 | 一个可用端口，默认 3000 |
| 磁盘 | 数据很小，几百份表也只有几十 MB |
| 系统 | Linux / macOS 均可，Windows 也能跑 |

不需要：数据库、Docker、编译工具链。

---

## 3. 首次启动

```bash
# 1. 把整个 deploy 目录传到服务器，例如 /opt/itinerary
cd /opt/itinerary

# 2. 直接跑（前台，测试用）
node server.js
# → 行程排期台账已启动: http://0.0.0.0:3000

# 3. 浏览器打开 http://服务器IP:3000
#    第一次进去会看到登录页，点「没有账号？注册」建第一个账号
```

第一次启动会自动生成：

```
data/db.json      全部数据（用户、表、成员、邀请）
data/secret       令牌签名密钥（勿删，删了所有人要重新登录）
data/backups/     每日自动备份，保留 14 份
```

---

## 4. 常驻运行

### 方式 A：systemd（推荐）

`/etc/systemd/system/itinerary.service`：

```ini
[Unit]
Description=Itinerary Collab
After=network.target

[Service]
Type=simple
User=www-data
WorkingDirectory=/opt/itinerary
ExecStart=/usr/bin/node /opt/itinerary/server.js
Restart=always
RestartSec=3
Environment=PORT=3000
Environment=DATA_DIR=/opt/itinerary/data
# 生产环境建议显式指定，保证重启后令牌不失效
# Environment=APP_SECRET=换成32位以上随机串

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now itinerary
sudo systemctl status itinerary
journalctl -u itinerary -f       # 看日志
```

### 方式 B：pm2

```bash
npm i -g pm2
pm2 start server.js --name itinerary
pm2 save && pm2 startup
```

---

## 5. 反向代理 + HTTPS

**必须是 HTTPS**，否则浏览器会拦截登录、同事之间也无法安全传输。

### Caddy（最省事，自动签证书）

```caddyfile
trip.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### Nginx

```nginx
server {
    listen 443 ssl http2;
    server_name trip.example.com;

    ssl_certificate     /etc/letsencrypt/live/trip.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/trip.example.com/privkey.pem;

    client_max_body_size 8m;          # 要大于 MAX_DOC_MB

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> ⚠️ 应用必须挂在**域名根路径**（`https://trip.example.com/`）。
> 放在子路径（`/trip/`）下会找不到 `/api/*`，需要改前端里的接口前缀。

---

## 6. 配置项

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `PORT` | 3000 | 监听端口 |
| `DATA_DIR` | `./data` | 数据目录 |
| `APP_SECRET` | 自动生成 | 令牌签名密钥，多实例必须一致 |
| `MAX_DOC_MB` | 4 | 单份表大小上限 |
| `ALLOW_REGISTER` | 1 | 设为 `0` 关闭公开注册，只能被邀请加入（团队内部建议关掉） |

---

## 7. 备份与恢复

**自动**：每天第一次写入时会把 `db.json` 复制到 `data/backups/db-YYYY-MM-DD.json`，保留最近 14 份。

**手动**（建议同时做异地备份）：

```bash
# 备份
tar czf /backup/itinerary-$(date +%F).tar.gz -C /opt/itinerary data/

# 恢复
systemctl stop itinerary
tar xzf /backup/itinerary-2026-10-23.tar.gz -C /opt/itinerary
systemctl start itinerary
```

`data/secret` 也要一起备份——丢了它，所有人需要重新登录（数据本身不丢）。

---

## 8. 升级

```bash
# 1. 备份
tar czf /backup/itinerary-$(date +%F).tar.gz -C /opt/itinerary data/

# 2. 替换文件（只换这两个，data/ 不要动）
#    index.html   ← 新版前端
#    server.js    ← 新版后端（如果后端没改可不换）

# 3. 重启
systemctl restart itinerary
```

数据库文件格式向后兼容，直接覆盖文件即可。

---

## 9. 日常运维

| 场景 | 做法 |
|---|---|
| 忘记密码 | 目前没有自助重置。用 SQLite 改不方便，**直接删掉 `data/db.json` 里该用户后重建**，或临时把 `ALLOW_REGISTER=1` 让他用新邮箱注册，再把旧表通过「邀请」给他。建议：重要账号密码存团队密码库 |
| 关闭公开注册 | `ALLOW_REGISTER=0` 后重启，之后只能由已有成员邀请加入 |
| 看有多少人 | `jq '.users \| length' data/db.json` |
| 看有多少表 | `jq '.docs \| length' data/db.json` |
| 清理某人的表 | 前端删除即可（软删除，数据还在文件里） |
| 磁盘满了 | 主要看 `data/backups/`，旧备份可删 |

---

## 10. 安全清单

- [x] 密码用 scrypt 加盐哈希存储，明文不落盘
- [x] 令牌 HMAC-SHA256 签名，30 天过期，密钥不写进代码
- [x] 所有表接口都校验「登录 + 成员身份」，前端绕不过去
- [x] 保存带版本号，冲突时拒绝覆盖（409）
- [x] 登录失败限流（同 IP 10 分钟 20 次）
- [x] 请求体大小限制，防超大请求
- [x] 静态文件做了目录穿越防护
- [ ] **HTTPS 要你自己配**（第 5 节），这是最关键的一条
- [ ] 防火墙只放 80/443，别把 3000 直接暴露到公网

---

## 11. 数据格式（排查问题时用）

`data/db.json`：

```json
{
  "users":   [{"id":"u_xxx","email":"a@b.com","pwd":"salt:hash","created_at":1761000000000}],
  "docs":    [{"id":"doc_xxx","title":"香港游学团","data":{...},"version":7,
               "owner_id":"u_xxx","updated_at":1761000000000,"updated_by":"u_xxx","deleted":0}],
  "members": [{"doc_id":"doc_xxx","user_id":"u_yyy","role":"editor","joined_at":1761000000000}],
  "invites": [{"code":"a1b2c3d4e5","doc_id":"doc_xxx","expires_at":1761600000000}]
}
```

- `docs.data` 是前端整张表的 JSON（行、列、纪律、名单都在里面），后端**不解析**，原样存取。
- 删除是软删除（`deleted:1`），需要彻底清理可以手动从数组里移除。

---

## 12. 快速自检

```bash
curl -s https://trip.example.com/api/health
# {"ok":true,"app":"itinerary","api":1,"register":true,"time":...}
```

返回这个就说明服务和反向代理都通了。
