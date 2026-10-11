# Academic Daily Digest 维护说明

本项目是个人学术期刊题录与阅读管理网站（journal digest and reading manager），采用原生 HTML/CSS/JavaScript，无前端构建步骤。本文说明当前实现与维护方法；版本、数据数量、模型可用性和运行状态以当次检查为准，旧交接材料不代表当前登录或执行结果。

源码：<https://github.com/Wakin-Leo/3701-lecy-forever>；线上：<https://wakin-leo.github.io/3701-lecy-forever/>。现有 GitHub Pages 使用 `main` 分支根目录发布；Sites 账户未登记此站点。

维护工具仅使用 Python 标准库，要求 Python 3.10 或以上；完整检查还需要 Node.js，快照需要 Git，远端状态检查需要已登录的 GitHub CLI（`gh`）。本次准备使用 Python 3.12、Node.js 25，无需安装前端依赖。工具的 `--report` 输出应放在仓库外，避免把本地检查和个人数据统计发布出去。

## 入口与数据流

| 路径 | 作用 |
| --- | --- |
| `index.html`、`styles.css`、`app.js` | 页面、阅读室主题、hash 路由、题录、搜索、翻译和个人操作 |
| `site-config.json` | 标题与进站口令哈希 |
| `journals.json` | 后台关注期刊清单 |
| `fetch.py` | OpenAlex 采集、PDF 补全、题录合并、向量生成、索引重建 |
| `embed_backfill.py` | 存量标题向量补全；会调用外部服务 |
| `.github/workflows/daily.yml` | 现配置北京时间每日 06:17 采集，也支持手动与指定文件变更触发 |
| `tools/check_project.py` | 语法与数据一致性检查，覆盖范围以报告为准 |
| `tools/status.py` | 只读检查本地 Git、GitHub Pages、每日任务和仓库密信名称；不读取密信值 |
| `tools/preview.py`、`tools/snapshot.py` | 隔离预览与本地恢复材料 |

页面路由为 `#home`、`#latest`、`#archive`、`#favs`、`#notes`、`#bean`、`#admin`。罐头模块含日志、纪念日与作品，按个人数据处理。

题录流为 `journals.json` → `fetch.py` → `data/<slug>/<year>.json` → `data/index.json` → 浏览器按需读取。`data/state.json` 记录回溯进度，不随意重置。题录字段包括 `doi`、`t`（标题）、`a`（作者数组）、`d`（发表日期）、`abs`、`oa`、`url`、`pdf`、`k`（关键词）。后台按 DOI 合并同一期刊同一年记录；缺少 DOI 或发表日期的记录不会进入分片。

最新页面默认近 90 天，每次再追溯 90 天；回溯按期刊、年份读取。后台最近更新窗口现为 10 天，与前端浏览窗口不同。缺失摘要或全文链接不能直接编造补齐。学科分类在 `app.js` 的 `JFIELD` 中硬编码，新期刊未映射时归入“其他”。

向量流为标题 → SiliconFlow `BAAI/bge-m3` → 单位归一化 → int8/Base64 → `data/emb/<slug>/<year>.json`。当前 1024 维，按 DOI 保存；换模型或编码须同步考虑后台、存量与前端。关键词搜索扫描所选期刊和年份，按日期最多显示 300 条；实际全范围含标题、摘要、关键词、刊名和学科名。语义检索搜索标题向量，现 cosine similarity 阈值 0.45，最多 50 条，不等同全文搜索。

个人数据从 `user/*.json` 读取，通过 GitHub Contents API 保存；划线同时生成 `notes/摘要笔记.md`。GitHub token、翻译配置、Key、筛选与标题译文缓存保存在浏览器 `localStorage`，进站状态保存在 `sessionStorage`。标题每批 10 条自动翻译并本地缓存；摘要点击后显示 EN/ZH，译文主要留在页面内存。已读延迟约 2 秒保存，点击 DOI/PDF 或翻译也可能标已读。

## 隔离预览与快照

在仓库根目录执行，参数以各工具 `--help` 为准：

```text
python tools/check_project.py
python tools/status.py
python tools/preview.py
python tools/preview.py --port 8766
python tools/snapshot.py
python tools/snapshot.py --output ../work/backups/before-change
```

预览默认 `127.0.0.1:8765`，只监听回环地址。它注入醒目标记并在本地模拟通过门屏；真实个人目录不提供给浏览器，个人内容使用合成数据。GitHub Contents 保存由本地模拟处理，写入当前标签页的 `sessionStorage`，不写磁盘或远端。关闭该会话后不要期待测试数据长期保存。

外部 fetch/API 被阻断；翻译和语义请求返回本地 403，不生成替代译文或模拟语义结果。预览覆盖页面、题录与个人操作的本地流程，不能证明真实翻译、语义服务或远端保存正常。运行后应确认允许路径、个人目录隔离与网络阻断实际生效；使用独立浏览器会话，不在预览源配置真实凭据。

正式代码有自动外部行为：配置翻译 Key 后打开题录页可能自动翻译标题；收藏页补全摘要后，有 GitHub token 时会自动回写。普通静态服务器配已配置凭据的浏览器不满足只读预览要求。

快照默认写入仓库同级的 `work/backups/`，可用 `--output` 指定仓库外目录。它生成现有 Git refs 可达历史的 bundle、工作树 ZIP 与哈希清单，并检查 bundle 和 ZIP 完整性。ZIP 包含 tracked 和未被忽略的 untracked 文件，可能含个人文件；不包含 ignored 文件，不单独保存暂存区不同于工作树的版本，也不等同 `.git` 原样备份。真实备份只用于本地恢复，排除公开发布。

## 每次维护流程

1. 检查 `git status --short --branch`、当前分支与 upstream，再 `git fetch origin`。后台采集与网页个人操作都可能新增远端提交；旧快照不能替代最新基线。
2. 保留用户未提交修改，按快照工具覆盖范围建立恢复点。工作区干净且无分歧时可 `git pull --ff-only`；存在本地维护提交时核对后 rebase 到实际 upstream，不假定分支名。
3. 围绕明确目标做窄范围修改。源码维护不要顺带改写 `user/`、`notes/`、上传资源或批量题录。HTML ID、DOI 关联、分片索引与向量格式是关键接口。
4. 运行检查工具并检查退出状态；隔离预览验证受影响流程及相关路由、题录读取、窄屏布局。个人功能使用合成数据。缺少 Node 或未覆盖项如实说明。
5. 查看 `git diff --stat` 和实际差异，按路径暂存；避免把个人文件、缓存或无关数据加入提交。推送前再次 fetch 并处理新增提交。
6. 根据当前任务授权完成提交、推送或发布。推送被拒绝时重新核对和 rebase，不用 force push 解决普通同步竞争。发布后检查实际版本与相关工作流；本地通过不代表线上已生效。

PowerShell 中 upstream 参数加引号：

```text
git rev-parse --abbrev-ref --symbolic-full-name '@{upstream}'
git rebase '@{upstream}'
```

冲突逐文件核对，保留远端最新题录和个人操作，不能一律选本地版本。无法确定时可 `git rebase --abort` 回到原状态，再说明具体冲突。

本机 CLI 认证须单独验证，例如 `gh auth status`；不要显示 token。接管时 GitHub connector 的管理与写权限已核实，但 CLI、Git 推送与 connector 不是同一认证状态，均会变化。必要认证只使用当前授权来源，不把历史登录当作证据。

本次已按用户明确授权恢复本机 `gh` 登录，并通过 `git push --dry-run` 验证写权限。Codex 受限进程可能无法读取 Windows 凭据库，并误报登录无效；此时应在可访问本机凭据库的执行环境重验，而不是直接覆盖登录。隔离预览的回环服务也需在浏览器能够连接的本机环境运行。

## 保护数据与回退

个人状态常整份写回。取得新 SHA 不等于已合并另一设备的新增内容；存储修复应读取最新状态、保留未知字段，再按明确规则合并。划线 JSON 与生成 Markdown 是顺序写入，不是事务；生成 Markdown 的手工改动可能被后续生成覆盖。

不要用全仓库 `reset --hard`、`git clean`、递归删除或旧数据快照处理局部问题。重建向量、重置采集进度或调整存储结构应在具体任务范围内说明成本与恢复方式后执行。`fetch.py` 和 `embed_backfill.py` 会联网并生成文件，向量调用可能收费，不是只读检查。

未提交错误按修改前差异或快照仅恢复目标文件，避免覆盖用户修改。已推送代码错误优先通过新的 revert 或局部修复提交恢复，保留后续数据和个人提交。混合代码/数据提交不能未经核对整笔 revert；数据错误先确定受影响分片，再修复。回退后重跑相关检查，已发布时核对线上版本。

不得输出或提交真实凭据、口令、个人邮箱、日志和私人备份；不要把个人内容放入新增测试夹具、截图或公开说明。私用不等于私密托管：前端口令和 `noindex` 都不构成服务端访问控制。

## 已观察、尚未修复

| 问题 | 当前证据与影响 |
| --- | --- |
| 静态个人文件的隐私边界 | 前端口令仅浏览器比对。接管时仓库公开，部分个人文件可不经网页口令读取；修改口令不能解决该边界。 |
| 搜索并发未真正限制为 6 | 两种搜索的 worker 内部 while 会立即安排全部分片请求，全历史查询可能产生大量请求。 |
| 语义结果未应用未读筛选 | 结果渲染未调用 `passesFilters()`，可能返回已读题录。 |
| 翻译先标已读 | 检查 Key 或翻译成功前调用 `setRead()`，缺配置或失败也可能标已读。 |
| 跨设备覆盖与划线同步 | 部分保存使用浏览器完整状态；划线 JSON/Markdown 非原子提交。 |
| 说明与实现不一致 | 搜索标签比实际匹配范围窄；顶部保留 30 天常量，实际浏览 90 天；README 未完整覆盖新增功能。 |

这些项目是维护候选项，未因接管自动修复。源码中的服务名称仅表示当前配置，价格、免费额度和可用性在实际调用前核实。
