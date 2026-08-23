# Obsidian SiYuan Web Sync

手动将 Obsidian 笔记同步到思源笔记（SiYuan）。

## 功能

- 手动同步当前打开的 Markdown 笔记（命令面板或左侧 Ribbon 图标）。
- 手动全量同步整个库中的所有 Markdown 笔记。
- 保持 Obsidian 相对路径结构（如 `projects/alpha/plan.md` 同步为思源中的 `/projects/alpha/plan`，文件夹文档会被复用，不会重复创建）。
- 支持中文、空格、特殊字符文件名。
- 支持本地图片、wiki 链接图片（`![[img.png]]`）、base64 内联图片，以及 http(s) 外链图片（如下载语雀 CDN），自动上传为思源资产并改写链接。
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
- `Local folder`：要同步的库内目录，留空则同步整个库。可点「Fill from active note」填入当前笔记所在目录。
- `SiYuan directory`：思源笔记本内的目标路径，留空则按库内相对路径创建。
- `Target notebook`：目标笔记本的**名称或 ID**，直接填写即可。每个 Obsidian 仓库各自保存一份设置，换仓库就会用该仓库自己的笔记本。下面的列表只是可选的辅助填写。
- `Create missing notebook`：自动创建 `obsidian` 笔记本。
- `Remove missing notes`：全量同步时删除思源端多余的文档。

注意：网页访问码（Access Auth Code）不是 API Token，API 鉴权只认 API Token。

## 同步行为

同步按「本地文件树 ↔ 思源文档树」对齐：

- 本地 `folder/note.md` 对应思源 `/folder/note`（标题不含 `.md`）。
- 父文件夹在思源里也是文档；同一路径只保留一份，已有重复目录会合并到最早的那份并把子文档移过去。
- 已存在的笔记按文档 ID 更新内容，不会再走 `createDocWithMd` 全路径创建（那会在 web 端再长出一套同名目录）。
- 增量判断：本地指纹（正文 + 引用图片的 mtime/size）与上次一致且思源端文档存在时跳过。
- 同步是单向的（Obsidian -> SiYuan），不读取思源内容回写。

## 开发

```bash
npm install
npm run build
```

产物为 `main.js`，配合 `manifest.json` 使用。

