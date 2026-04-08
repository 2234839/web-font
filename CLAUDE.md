pnpm dev 可以同时启动前后端，并且都会修改代码后自动重载
- pnpm docker_push  发布当前项目的docker镜像
## 浏览器测试（vite-plugin-pilot）
已安装。`npx pilot run '代码'` 执行 JS（返回结果+日志+快照）、`npx pilot page` 页面状态
`npx pilot help` 查看pilot所有功能
常用：`__pilot_clickByText("文本")` 点击、`__pilot_typeByPlaceholder("提示文字", "值")` 输入、`__pilot_waitFor("文本")` 等待、`__pilot_findByText("文本")` 查找。snapshot 中 `#N` 是元素索引。
多 tab 时用 `npx pilot status` 查看实例列表，`npx pilot run '代码' instance:前缀` 指定目标实例（支持 ID 前缀模糊匹配）。
