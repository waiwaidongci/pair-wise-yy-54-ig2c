/**
 * 写入传输层：模拟远端持久化。
 * - failNext(n)：接下来的前 n 次写入失败（用于演示“写入失败后按原操作号重试”）
 * - 写入本身不做业务判断，业务侧负责用同一 opId 重试，保证审计记录不重复追加
 */
class WriteTransport {
  private failuresRemaining = 0
  /** 每次调用按操作号统计尝试次数，便于界面展示“第几次重试” */
  readonly attempts = new Map<string, number>()

  failNext(count = 1) {
    this.failuresRemaining += count
  }

  get armedFailures() {
    return this.failuresRemaining
  }

  async write(opId: string, _snapshot: string): Promise<{ ok: true; attempt: number }> {
    const attempt = (this.attempts.get(opId) ?? 0) + 1
    this.attempts.set(opId, attempt)
    // 模拟网络延迟
    await new Promise((resolve) => setTimeout(resolve, 120))
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1
      throw new Error(`网络抖动：${opId} 第 ${attempt} 次写入被服务端拒绝，请按原操作号重试`)
    }
    return { ok: true, attempt }
  }
}

export const writeTransport = new WriteTransport()
