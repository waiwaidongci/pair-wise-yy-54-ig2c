import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type {
  AuditRecord,
  ClosureStage,
  FailedOp,
  Scheme,
  SegmentComment,
  SignUnit,
} from '../types'
import {
  applyReconfirm,
  applyResolve,
  applyRevision,
  applySignoff,
  buildNotice,
  clone,
  migrateLegacy,
  type ReviseInput,
  type SignoffInput,
} from '../core/revision'
import { writeTransport } from '../core/transport'

/** v1 键：旧版应用写入的数据缺少 revision 字段，读取时走迁移升级 */
const LEGACY_STORAGE_KEY = 'yy54-road-scheme-v1'
const STORAGE_KEY = 'yy54-road-scheme-v2'
const now = () => new Date().toLocaleString('zh-CN', { hour12: false })

/* ------------------------------------------------------------------ */
/* 演示数据一：旧版格式（无 revision / baseRevision），用于演示升级 R1  */
/* ------------------------------------------------------------------ */

const legacySeed = {
  id: 'RC-2026-0918', project: '云河路快速化改造', contractor: '市政建设集团第三工程处', area: '云河路 / 江海大道', version: 7,
  stages: [
    { id: 'ST-01', name: '第一阶段 · 东半幅围挡', start: '2026-10-08', end: '2026-10-22', lanes: '双向 4 车道收窄为 2 车道', status: '条件通过', route: [[121.470, 31.228], [121.482, 31.231], [121.496, 31.235]] },
    { id: 'ST-02', name: '第二阶段 · 路口夜间施工', start: '2026-10-23', end: '2026-11-05', lanes: '22:00–05:00 全封闭', status: '待协商', route: [[121.496, 31.235], [121.508, 31.238], [121.516, 31.242]] },
    { id: 'ST-03', name: '第三阶段 · 西半幅恢复', start: '2026-11-06', end: '2026-11-18', lanes: '西侧公交专用道临时占用', status: '退回', route: [[121.452, 31.224], [121.462, 31.226], [121.470, 31.228]] },
  ],
  detours: [
    { id: 'DR-01', name: '江海大道—滨河路绕行', distance: 4.8, extraMinutes: 11, coordinates: [[121.470, 31.228], [121.478, 31.214], [121.502, 31.218], [121.516, 31.242]] },
    { id: 'DR-02', name: '云河路辅道保通', distance: 2.3, extraMinutes: 6, coordinates: [[121.452, 31.224], [121.462, 31.219], [121.496, 31.235]] },
  ],
  comments: [
    { id: 'CM-41', segmentId: 'ST-01', unit: '公交', author: '顾敏', content: '17 路、806 路临时站点与云河路站距离 680 米，超过老年乘客可接受步行距离。', condition: '需在江海大道口增设临时站并配置导乘人员。', status: '待处理' },
    { id: 'CM-42', segmentId: 'ST-02', unit: '应急', author: '夏川', content: '夜间全封闭期间，区域急救中心南门通道被切断。', condition: '保留 4 米应急通道，路口导改每 15 分钟巡查一次。', status: '已接受' },
    { id: 'CM-43', segmentId: 'ST-03', unit: '交通', author: '郑航', content: '公交专用道占用导致高峰小时延误增加 19 分钟，超过方案阈值。', condition: '缩减围挡 1.5 米并调整信号配时。', status: '已退回' },
  ],
}

/* ------------------------------------------------------------------ */
/* 迁移完成后的“形态模板”：新字段齐全；migrateLegacy 只借用其骨架       */
/* ------------------------------------------------------------------ */

function freshShape(): Scheme {
  return {
    id: legacySeed.id, project: legacySeed.project, contractor: legacySeed.contractor, area: legacySeed.area,
    version: 0, revision: 1, stages: [], detours: [], comments: [], revisions: [], audit: [], legacy: false,
  }
}

/* ------------------------------------------------------------------ */
/* 演示数据二：升级后继续修订到 R2 的状态（用于直接体验全部规则）        */
/* ------------------------------------------------------------------ */

function demoSeed(): Scheme {
  const scheme = migrateLegacy(legacySeed, freshShape(), '2026-10-06 09:00:00')
  scheme.legacy = false
  scheme.version = 9
  scheme.revision = 2

  const r1Stages = clone(scheme.stages)

  // R1：交通、公交在 ST-01 完成重确认（公交顾敏、交通郑航）
  const st01 = scheme.stages.find((s) => s.id === 'ST-01')!
  st01.reconfirmed = true
  st01.legacyUnconfirmed = undefined
  // ST-02、ST-03 保持“未重确认”单列

  const cm41 = scheme.comments.find((c) => c.id === 'CM-41')!
  cm41.validity = '已重确认'

  // R1 重确认产生的新意见
  scheme.comments.push({
    id: 'CM-51', segmentId: 'ST-01', unit: '公交', author: '顾敏',
    content: 'R1 复核：江海大道口临时站已落位，导乘人员排班确认，老年乘客步行距离 320 米可接受。',
    condition: '早晚高峰各配置 1 名导乘，持续至东半幅围挡拆除。', status: '已接受', baseRevision: 1, validity: '有效',
  })

  // R2：ST-01 围挡（lanes）调整 → 仅交通、应急失效；公交 CM-51 沿用
  st01.lanes = '双向 4 车道收窄为 2 车道，夜间 22:00 后再收窄 1 车道预留管线作业'
  st01.baseRevision = 2
  st01.reconfirmed = false
  for (const c of scheme.comments) {
    if (c.segmentId === 'ST-01' && (c.unit === '交通' || c.unit === '应急') && c.validity === '有效') {
      c.validity = '失效待重确认'
      c.invalidatedBy = { revision: 2, change: '围挡' }
    }
  }
  // 交通郑航 R2 重新会签（先到者占用），生成的待处理意见
  scheme.comments.push({
    id: 'CM-53', segmentId: 'ST-01', unit: '交通', author: '郑航',
    content: 'R2 会签：夜间再收窄一车道需将信号周期压缩 12 秒，并在江海大道口保留 3.5 米应急通道。',
    condition: '21:45 前置警示桩，次日 05:20 恢复。', status: '待处理', baseRevision: 2, validity: '有效',
  })
  st01.lock = {
    unit: '交通', author: '郑航', at: '2026-10-06 10:31:00', opId: 'SG-seed-lock',
    content: '夜间再收窄一车道需将信号周期压缩 12 秒，并在江海大道口保留 3.5 米应急通道。',
    condition: '21:45 前置警示桩，次日 05:20 恢复。',
  }
  // 应急夏川几乎同时提交（后到者留场）
  st01.rivals = [{
    unit: '应急', author: '夏川', at: '2026-10-06 10:31:40', opId: 'SG-seed-rival',
    content: '夜间再收窄一车道后急救车通行宽度不足 4 米，南门方向必须改为对向借道。',
    condition: '安排专职引导员与救护车一键直连对讲。',
    diffs: [
      { field: '现场意见', winner: st01.lock.content, rival: '夜间再收窄一车道后急救车通行宽度不足 4 米，南门方向必须改为对向借道。' },
      { field: '附加条件', winner: st01.lock.condition ?? '无', rival: '安排专职引导员与救护车一键直连对讲。' },
    ],
  }]

  scheme.detours.forEach((d) => (d.baseRevision = 1))
  scheme.revisions = [
    {
      revision: 2, at: '2026-10-06 10:20:00', author: '建设组 · 项目工程师',
      changes: ['围挡'], reason: '燃气管线夜间作业需要东半幅夜间再收窄一条车道',
      stageIds: ['ST-01'], detourIds: [],
      summary: 'R 修订：围挡/几何（ST-01）；受影响单位 交通、应急，其余单位意见沿用',
    },
    {
      revision: 1, at: '2026-10-06 09:00:00', author: '系统迁移', changes: [],
      reason: '旧数据缺少修订号，统一升级到初始版本 R1，会签意见须在 R1 上重确认',
      stageIds: r1Stages.map((s) => s.id), detourIds: scheme.detours.map((d) => d.id),
      summary: 'R1 初始版本（旧数据升级）：ST-02、ST-03 等待重确认', migratedFromLegacy: true,
    },
  ]
  scheme.audit = [
    { opId: 'MG-seed', type: '道路修订', at: '2026-10-06 09:00:00', detail: `旧数据缺少修订号，升级为 R1 初始版本；3 个阶段、3 条会签意见需在 R1 上重确认，未重确认阶段单列`, result: '成功', attempts: 1 },
    { opId: 'RV-seed-r1c', type: '意见重确认', at: '2026-10-06 09:40:00', detail: `公交·顾敏 就 ST-01 失效意见 CM-41（R1）在 R1 上重确认，新意见 CM-51；原意见保留不覆盖`, result: '成功', attempts: 1 },
    { opId: 'RV-seed-r2', type: '道路修订', at: '2026-10-06 10:20:00', detail: `R2：围挡/几何（ST-01）；受影响单位 交通、应急（失效重确认），公交意见沿用；原因「燃气管线夜间作业需要东半幅夜间再收窄一条车道」`, result: '成功', attempts: 1 },
    { opId: 'SG-seed-lock', type: '会签提交', at: '2026-10-06 10:31:00', detail: `交通·郑航 对 ST-01 提交会签（先到）：占用本阶段 R2 会签锁，生成意见 CM-53`, result: '成功', attempts: 1 },
    { opId: 'SG-seed-rival', type: '会签提交', at: '2026-10-06 10:31:40', detail: `应急·夏川 对 ST-01 提交会签（后到）：先到者 交通·郑航 已占用，现场文字与 2 项差异留痕，不覆盖原意见`, result: '成功', attempts: 1 },
  ]
  return scheme
}

/* ------------------------------------------------------------------ */
/* 引擎：业务变更 → 写入（失败按原操作号重试）→ 审计只追加一次          */
/* ------------------------------------------------------------------ */

class SchemeEngine {
  draft: Scheme
  undoStack: Scheme[] = []
  failed: FailedOp | null = null
  private flushing = false

  constructor(initial: Scheme) {
    this.draft = initial
  }

  /**
   * 执行一个业务动作。
   * 审计记录在写入“之前”就随业务快照一起落草案：
   *   - 写入失败：草案内存保留，failed 登记原操作号；不落 localStorage
   *   - 按原操作号重试成功：同一条审计记录的 attempts 更新，绝不追加第二条
   */
  async execute(
    mutate: (base: Scheme) => { next: Scheme; record: AuditRecord; opId: string },
  ): Promise<{ ok: true; record: AuditRecord } | { ok: false; error: string; failed: FailedOp }> {
    const base = clone(this.draft)
    try {
      const { next, record, opId } = mutate(base)
      // 幂等保护：同操作号已有处理记录，绝不重复追加（重复触发直接返回成功）
      if (next.audit.some((item) => item.opId === opId)) {
        this.draft = next
        return { ok: true, record: next.audit.find((item) => item.opId === opId)! }
      }
      // 审计记录随业务快照一次性写入草案；写入失败时它也只存在内存中，等待同号重试
      next.audit.unshift(record)
      this.draft = next
      try {
        const { attempt } = await writeTransport.write(opId, JSON.stringify(next))
        record.attempts = attempt
        record.result = '成功'
        this.failed = null
        // 写入成功后才把撤销点入栈，避免撤掉一个待重试的失败动作
        this.undoStack.push(base)
        if (this.undoStack.length > 20) this.undoStack.shift()
        persist(next)
        return { ok: true, record }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        this.failed = { opId, type: record.type, at: record.at, attempts: writeTransport.attempts.get(opId) ?? 1, error: message }
        return { ok: false, error: message, failed: this.failed }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { ok: false, error: message, failed: { opId: 'ERROR', type: '道路修订', at: now(), attempts: 0, error: message } }
    }
  }

  /** 规则 4：写入失败后按原操作号重试；处理记录不重复追加（仅刷新 attempts/结果） */
  async retry(): Promise<{ ok: boolean; error?: string }> {
    const pending = this.failed
    if (!pending || this.flushing) return { ok: true }
    this.flushing = true
    try {
      const opId = pending.opId
      await writeTransport.write(opId, JSON.stringify(this.draft))
      const record = this.draft.audit.find((item) => item.opId === opId)
      if (record) {
        record.attempts = writeTransport.attempts.get(opId) ?? record.attempts
        record.result = '成功'
      }
      this.failed = null
      persist(this.draft)
      return { ok: true }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (this.failed) {
        this.failed.attempts = writeTransport.attempts.get(this.failed.opId) ?? this.failed.attempts
        this.failed.error = message
      }
      return { ok: false, error: message }
    } finally {
      this.flushing = false
    }
  }
}

/* ------------------------------------------------------------------ */
/* 持久化与加载（含旧数据升级）                                          */
/* ------------------------------------------------------------------ */

function persist(scheme: Scheme) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scheme))
  } catch {
    // 配额异常等由调用方按失败处理；演示环境不触发
  }
}

function loadInitial(): { scheme: Scheme; migrated: boolean } {
  try {
    // 1. 新格式缓存
    const rawV2 = localStorage.getItem(STORAGE_KEY)
    if (rawV2) {
      try {
        return { scheme: migrateLegacy(JSON.parse(rawV2), freshShape(), now()), migrated: false }
      } catch {
        /* 落到演示种子 */
      }
    }
    // 2. 旧版缓存（缺修订号）→ 升级 R1
    const rawV1 = localStorage.getItem(LEGACY_STORAGE_KEY)
    if (rawV1) {
      try {
        const parsed = JSON.parse(rawV1)
        const migratedScheme = migrateLegacy(parsed, freshShape(), now())
        persist(migratedScheme)
        return { scheme: migratedScheme, migrated: true }
      } catch {
        /* 落到演示种子 */
      }
    }
  } catch {
    /* 无 localStorage（SSR/测试）→ 落到演示种子 */
  }
  // 3. 首次进入：载入升级后已修订到 R2 的演示数据（想看自动升级过程可点“载入旧数据”）
  return { scheme: demoSeed(), migrated: false }
}

export type DispatchResult = { ok: true; record?: AuditRecord } | { ok: false; error: string }

export const useSchemeStore = defineStore('scheme', () => {
  const initial = loadInitial()
  const engine = new SchemeEngine(initial.scheme)
  const migrated = ref(initial.migrated || Boolean(initial.scheme.legacy))
  const bump = ref(0)
  /** 强制 computed 跟随引擎草案（引擎类本身非响应式，动作完成后 tick） */
  function tick() { bump.value += 1 }

  const scheme = computed<Scheme>(() => {
    void bump.value
    return engine.draft
  })
  const failedOp = computed<FailedOp | null>(() => {
    void bump.value
    return engine.failed
  })
  const writing = ref(false)

  const selectedStageId = ref('ST-01')
  const selectedCommentId = ref(scheme.value.comments[0]?.id ?? '')
  const drawing = ref(false)
  const draftRoute = ref<[number, number][]>([])

  const selectedStage = computed<ClosureStage | undefined>(() => {
    void bump.value
    return engine.draft.stages.find((item) => item.id === selectedStageId.value)
  })
  const selectedComment = computed<SegmentComment | undefined>(() => {
    void bump.value
    return engine.draft.comments.find((item) => item.id === selectedCommentId.value)
  })
  const conflicts = computed(() => {
    void bump.value
    return [
      ...(engine.draft.stages.some((stage) => stage.id === 'ST-02') ? [{ id: 'CF-01', level: '高' as const, segmentId: 'ST-02', title: '相邻雨污分流工程时间重叠', detail: '10 月 26–30 日江海大道东段同步占用慢车道，建议错峰 4 天。' }] : []),
      { id: 'CF-02', level: '高' as const, segmentId: 'ST-02', title: '救护通道中断风险', detail: '夜间全封闭将切断区域急救中心南门，必须保留 4 米应急通道。' },
      { id: 'CF-03', level: '中' as const, segmentId: 'ST-01', title: '公交站点覆盖缺口', detail: '17 路与 806 路临时站距现状站 680 米，已超过 500 米阈值。' },
      { id: 'CF-04', level: '中' as const, segmentId: 'ST-03', title: '绕行延误超阈值', detail: '高峰绕行新增 19 分钟，超过方案设定的 15 分钟阈值。' },
    ]
  })
  const dirty = computed(() => {
    void bump.value
    return engine.undoStack.length > 0
  })
  /** 规则 6：未重确认阶段（旧数据升级或修订失效），公开通告单列 */
  const unconfirmedStages = computed(() => {
    void bump.value
    return engine.draft.stages.filter((stage) => !stage.reconfirmed)
  })
  const invalidComments = computed(() => {
    void bump.value
    return engine.draft.comments.filter((c) => c.validity === '失效待重确认')
  })

  /* ---- 规则 1+2：道路修订（围挡/时间/绕行） ---- */
  async function revise(input: Omit<ReviseInput, 'at'> & { at?: string }): Promise<DispatchResult> {
    writing.value = true
    const result = await engine.execute((base) => {
      const out = applyRevision(base, { ...input, at: input.at ?? now() })
      return { next: out.scheme, record: out.record, opId: out.record.opId }
    })
    writing.value = false
    tick()
    return result.ok ? { ok: true, record: result.record } : { ok: false, error: result.error }
  }

  /* ---- 规则 3：会签提交（先到占用 / 后到留场） ---- */
  async function submitSignoff(input: Omit<SignoffInput, 'at'>): Promise<DispatchResult & { outcome?: '占用' | '留场' }> {
    writing.value = true
    let outcome: '占用' | '留场' | undefined
    const result = await engine.execute((base) => {
      const out = applySignoff(base, { ...input, at: now() })
      outcome = out.outcome
      return { next: out.scheme, record: out.record, opId: out.record.opId }
    })
    writing.value = false
    tick()
    if (result.ok) return { ok: true, record: result.record, outcome }
    return { ok: false, error: result.error }
  }

  async function resolveComment(id: string, status: SegmentComment['status']): Promise<DispatchResult> {
    writing.value = true
    const result = await engine.execute((base) => {
      const out = applyResolve(base, { commentId: id, status, at: now() })
      return { next: out.scheme, record: out.record, opId: out.record.opId }
    })
    writing.value = false
    tick()
    return result.ok ? { ok: true, record: result.record } : { ok: false, error: result.error }
  }

  /** 规则 2：失效意见在当前修订上重确认（原意见保留，新增有效意见） */
  async function reconfirmComment(
    id: string,
    payload: { unit: SignUnit; author: string; content: string; condition?: string },
  ): Promise<DispatchResult> {
    writing.value = true
    const result = await engine.execute((base) => {
      const out = applyReconfirm(base, { commentId: id, ...payload, at: now() })
      return { next: out.scheme, record: out.record, opId: out.record.opId }
    })
    writing.value = false
    tick()
    return result.ok ? { ok: true, record: result.record } : { ok: false, error: result.error }
  }

  /* ---- 规则 4：按原操作号重试 ---- */
  async function retryFailed(): Promise<DispatchResult> {
    writing.value = true
    const result = await engine.retry()
    writing.value = false
    tick()
    return result.ok ? { ok: true } : { ok: false, error: result.error ?? '重试失败' }
  }

  function armFailures(count = 1) {
    writeTransport.failNext(count)
  }

  function undo() {
    const previous = engine.undoStack.pop()
    if (previous) {
      engine.draft = previous
      persist(previous)
      tick()
    }
  }

  /* ---- 地图绘制：完成后由界面走“围挡修订”正式提交，这里仅收集草稿点 ---- */
  function startDraw() { drawing.value = true; draftRoute.value = [] }
  function addPoint(point: [number, number]) { if (drawing.value) draftRoute.value.push(point) }
  function cancelDraw() { drawing.value = false; draftRoute.value = [] }

  /* ---- 公开通告：绑定同一修订号，未重确认阶段单列 ---- */
  function exportNotice() {
    const bundle = buildNotice(engine.draft)
    const blob = new Blob([bundle.text], { type: 'text/plain;charset=utf-8' })
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = bundle.filename
    link.click()
    URL.revokeObjectURL(link.href)
  }

  /** 演示：重置为内置旧数据并重新走一次升级 */
  function resetToLegacyDemo() {
    localStorage.removeItem(STORAGE_KEY)
    localStorage.removeItem(LEGACY_STORAGE_KEY)
    const upgraded = migrateLegacy(legacySeed, freshShape(), now())
    engine.draft = upgraded
    engine.undoStack = []
    engine.failed = null
    migrated.value = true
    persist(upgraded)
    tick()
  }

  /** 演示：载入升级后已修订到 R2 的数据 */
  function loadDemoSeed() {
    const seeded = demoSeed()
    engine.draft = seeded
    engine.undoStack = []
    engine.failed = null
    migrated.value = false
    persist(seeded)
    tick()
  }

  return {
    scheme, failedOp, writing, migrated,
    selectedStageId, selectedCommentId, selectedStage, selectedComment,
    drawing, draftRoute, conflicts, dirty, unconfirmedStages, invalidComments,
    revise, submitSignoff, resolveComment, reconfirmComment, retryFailed, armFailures,
    undo, startDraw, addPoint, cancelDraw, exportNotice,
    resetToLegacyDemo, loadDemoSeed,
    // 供自检测试直接拿引擎/种子
    _engine: engine,
  }
})
