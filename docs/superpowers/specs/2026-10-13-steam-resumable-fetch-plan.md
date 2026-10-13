# Steam 可恢复抓取实现计划

1. 在 `src/market/recipe-hunt.mjs` 为每个材料增加检查点读写：完成项恢复候选池并跳过网络请求；失败项保存错误、候选和英文名；继续时重新处理未完成项。
2. 在 `src/web/server.mjs` 增加内存检查点表、恢复 ID、搜索参数签名和 SSE 恢复元数据；任务取消或失败后保留可继续状态，成功后清理。
3. 在 `web/index.html` 增加“继续获取失败项”按钮，复用搜索连接逻辑，携带恢复 ID；普通开始搜索清空恢复状态，修改代理后可继续。
4. 在 `tests/test-search-tasks.mjs` 增加恢复流程测试，在 `tests/test-recipe-hunt.mjs` 增加成功项跳过和失败项重试测试。
5. 运行 `npm test`，修复回归并检查工作区无临时文件。
