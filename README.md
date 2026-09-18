# 取件站

一个无第三方运行时依赖的数字商品卡密取件站。支持单个或批量兑换、已兑换内容查找、库存文件下载，以及带登录认证的配置中心。

## 功能

- 商品池、卡密池和文件库存管理
- 单个或批量兑换与查找
- 批量打包下载 ZIP
- 卡密一次性核销和兑换记录归档
- 浏览器本地演示模式
- Node.js 多用户服务端模式

## 快速开始

需要 Node.js 18 或更高版本。

```powershell
$env:ADMIN_PASSWORD = "请替换为强密码"
$env:ADMIN_SESSION_SECRET = "请替换为独立的随机字符串"
npm start
```

Linux 或 macOS：

```bash
ADMIN_PASSWORD='请替换为强密码' \
ADMIN_SESSION_SECRET='请替换为独立的随机字符串' \
npm start
```

启动后访问：

- 取件页面：<http://127.0.0.1:3000/>
- 配置中心：<http://127.0.0.1:3000/admin.html>

默认管理员用户名为 `admin`，可通过 `ADMIN_USER` 修改。完整部署步骤见 [部署说明](docs/DEPLOYMENT.md)。

## 本地演示

直接打开 `index.html` 和 `admin.html` 可以体验浏览器本地模式，数据保存在当前浏览器中。此模式仅适合演示，不支持多用户共享，也不应作为正式部署方式。

首次打开时，页面读取 `config.js` 中的示例商品。示例兑换码为 `DEMO-2026`。

## 项目结构

```text
.
|-- index.html           # 用户取件页面
|-- admin-login.html     # 配置中心登录页
|-- admin.html           # 配置中心
|-- config.js            # 首次启动的示例数据
|-- server.js            # Node.js HTTP 服务
|-- products/            # 可公开提交的示例商品
|-- data/                # 运行数据库，不提交到 Git
|-- uploads/             # 后台上传文件，不提交到 Git
|-- deploy/              # 部署配置示例
`-- docs/                # 使用和部署文档
```

## 配置中心操作

1. 新建或选择商品池。
2. 添加卡密，或用内置生成器批量生成卡密。
3. 上传库存文件；每次成功兑换会按顺序分配一件库存。
4. 在已使用记录中查找、下载或清理兑换记录。

卡密和库存彼此独立，可以分别补充。删除已使用记录后，用户将无法再通过原卡密找回对应文件。

## 数据与安全

- `data/store.json` 包含卡密、兑换记录和下载令牌。
- `uploads/` 包含实际交付文件。
- 这两个目录已被 `.gitignore` 排除，但生产环境仍需定期备份。
- 不要提交 `.env`、真实卡密、真实库存或服务器证书。
- 正式环境应通过 HTTPS 反向代理访问，并为管理员密码和会话密钥使用不同的高强度随机值。

发现安全问题时请不要公开提交 Issue，处理方式见 [SECURITY.md](SECURITY.md)。

## 开发检查

```bash
npm run check
npm test
```

## 参与贡献

提交改动前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

本项目使用 [MIT License](LICENSE)。

