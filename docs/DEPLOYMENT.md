# 部署说明

## 环境要求

- Node.js 18 或更高版本
- 能提供 HTTPS 的反向代理，例如 Nginx、OpenResty 或 Caddy
- 对 `data/` 和 `uploads/` 具有写权限的持久磁盘

项目没有第三方 npm 运行时依赖，不需要执行 `npm install`。

## 环境变量

| 变量 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `ADMIN_PASSWORD` | 是 | 无 | 配置中心密码；未设置时无法登录 |
| `ADMIN_USER` | 否 | `admin` | 配置中心用户名 |
| `ADMIN_SESSION_SECRET` | 推荐 | 由密码派生 | 会话签名密钥，应与密码不同 |
| `PORT` | 否 | `3000` | HTTP 监听端口 |
| `PICKUP_DATA_DIR` | 否 | `./data` | 数据库目录，可指向持久磁盘 |
| `PICKUP_UPLOAD_DIR` | 否 | `./uploads` | 上传目录，可指向持久磁盘 |

`.env.example` 只是变量清单，当前服务不会自动读取 `.env` 文件。请使用系统环境变量、进程管理器或容器平台注入配置。

## 启动

Windows PowerShell：

```powershell
$env:ADMIN_PASSWORD = "使用高强度密码"
$env:ADMIN_SESSION_SECRET = "使用另一段随机字符串"
$env:PORT = "3000"
npm start
```

Linux：

```bash
ADMIN_PASSWORD='使用高强度密码' \
ADMIN_SESSION_SECRET='使用另一段随机字符串' \
PORT=3000 \
npm start
```

建议使用 systemd、PM2 或容器编排平台保持进程运行。反向代理可以从 [deploy/nginx.conf.example](../deploy/nginx.conf.example) 开始配置。

## 持久化与备份

- `data/store.json` 保存商品、卡密、兑换记录和下载令牌；设置了 `PICKUP_DATA_DIR` 时使用对应目录。
- `uploads/` 保存配置中心上传的库存文件；设置了 `PICKUP_UPLOAD_DIR` 时使用对应目录。
- 两者必须一起备份，恢复时也应作为同一个时间点的数据集恢复。

不要把这两个目录直接提交到 GitHub，也不要在多个服务实例间共享同一个普通文件系统数据库。当前实现适合单实例部署；多实例部署需要把数据层迁移到支持事务的数据库和对象存储。

## 升级

1. 备份 `data/` 和 `uploads/`。
2. 拉取新版本代码。
3. 运行 `npm run check`。
4. 重启服务并验证兑换、查找和配置中心登录。
