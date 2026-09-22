export function organizationMcpPrompt(request: { id: string; purpose: string }) {
  return `请使用已连接的 work_with_agent MCP 完成这次记忆整理。不要直接修改任务或记忆，也不要确认提议。

1. 调用 get_organization_request，requestId 为 ${request.id}。
2. 只根据返回的冻结来源和其中的整理约定生成建议。整理目的：${request.purpose}
3. 调用 submit_organization_result，organizationId 使用同一个请求 ID，提交 summary 和 commands。证据必须来自本次返回的 sources。没有值得保留的内容时 commands 用空数组。
4. 提交后只回报提议编号，保持待确认。`;
}
