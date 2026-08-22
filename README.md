# Obsidian SiYuan Web Sync

手动将 Obsidian 笔记同步到思源笔记（SiYuan）。

## 功能

- 手动同步当前打开的 Markdown 笔记（命令面板或左侧 Ribbon 图标）。
- 手动全量同步整个库中的所有 Markdown 笔记。
- 保持 Obsidian 相对路径结构（如 `projects/alpha/plan.md` 同步为思源中的 `/projects/alpha/plan.md`）。
- 支持中文、空格、特殊字符文件名。
- 支持本地图片、wiki 链接图片（`![[img.png]]`）和 base64 内联图片，自动上传为思源资产并改写链接。
- 增量同步：笔记内容和引用图片未变化时跳过，不重复上传、不重建文档。
- 可选：目标笔记本不存在时自动创建。
- 可选：全量同步时删除思源中已不存在的文档（默认关闭，谨慎开启）。

## 安装

1. 将本目录复制到 Obsidian 插件目录：
   `你的库/.obsidian/plugins/obsidian-siyuanweb/`
2. 确保目录下包含 `main.js` 和 `manifest.json`。
3. 在 Obsidian 设置中启用 `SiYuan Sync` 插件。

## 配置

在插件设置中填写：

- `SiYuan API URL`：思源内核 API 地址，例如 `http://your-siyuan-host:6806`。
- `API token`：思源中的 API Token（设置 -> 关于 -> API Token）。
- `Target notebook`：目标笔记本，刷新后从列表中选择。
- `Create missing notebook`：自动创建 `obsidian` 笔记本。
- `Remove missing notes`：全量同步时删除思源端多余的文档。

注意：网页访问码（Access Auth Code）不是 API Token，API 鉴权只认 API Token。

## 同步行为

思源 3.1.x 没有文档级更新 API。插件采用「删除后重建」策略：

- 目标文档已存在：先删除再创建。
- 目标文档不存在：直接创建。
- 增量判断：本地指纹（正文 + 引用图片的 mtime/size）与上次一致且思源端文档存在时跳过。
- 同步是单向的（Obsidian -> SiYuan），不读取思源内容回写。

## 开发

```bash
npm install
npm run build
```

产物为 `main.js`，配合 `manifest.json` 使用。

