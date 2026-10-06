import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type {
  ChangeTrigger, ClosureStage, DetourRoute, OnSiteText, ProcessingRecord, PublicNotice,
  RecordAction, RecordResult, RoadRevision, Scheme, SegmentComment, Unit,
} from '../types'

const STORAGE_KEY = 'yy54-road-scheme-v1'

const seed: Scheme = {
  id: 'RC-2026-0918', project: '云河路快速化改造', contractor: '市政建设集团第三工程处', area: '云河路 / 江海大道', version: 7,
  stages: [
    { id: 'ST-01', name: '第一阶段 · 东半幅围挡', start: '2026-10-08', end: '2026-10-22', lanes: '双向 4 车道收窄为 2 车道', status: '条件通过', route: [[121.470,31.228],[121.482,31.231],[121.496,31.235]] },
    { id: 'ST-02', name: '第二阶段 · 路口夜间施工', start: '2026-10-23', end: '2026-11-05', lanes: '22:00–05:00 全封闭', status: '待协商', route: [[121.496,31.235],[121.508,31.238],[121.516,31.242]] },
    { id: 'ST-03', name: '第三阶段 · 西半幅恢复', start: '2026-11-06', end: '2026-11-18', lanes: '西侧公交专用道临时占用', status: '退回', route: [[121.452,31.224],[121.462,31.226],[121.470,31.228]] },
  ],
  detours: [
    { id: 'DR-01', name: '江海大道—滨河路绕行', distance: 4.8, extraMinutes: 11, coordinates: [[121.470,31.228],[121.478,31.214],[121.502,31.218],[121.516,31.242]] },
    { id: 'DR-02', name: '云河路辅道保通', distance: 2.3, extraMinutes: 6, coordinates: [[121.452,31.224],[121.462,31.219],[121.496,31.235]] },
  ],
  comments: [
    { id: 'CM-41', segmentId: 'ST-01', unit: '公交', author: '顾敏', content: '17 路、806 路临时站点与云河路站距离 680 米，超过老年乘客可接受步行距离。', condition: '需在江海大道口增设临时站并配置导乘人员。', status: '待处理', revisionId: '', confirmStatus: '有效' },
    { id: 'CM-42', segmentId: 'ST-02', unit: '应急', author: '夏川', content: '夜间全封闭期间，区域急救中心南门通道被切断。', condition: '保留 4 米应急通道，路口导改每 15 分钟巡查一次。', status: '已接受', revisionId: '', confirmStatus: '有效' },
    { id: 'CM-43', segmentId: 'ST-03', unit: '交通', author: '郑航', content: '公交专用道占用导致高峰小时延误增加 19 分钟，超过方案阈值。', condition: '缩减围挡 1.5 米并调整信号配时。', status: '已退回', revisionId: '', confirmStatus: '有效' },
  ],
  revisions: [],
  currentRevisionId: '',
  processingRecords: [],
  onSiteTexts: [],
  occupancy: {},
}

/** 变更类型 → 受影响、需要重确认意见的单位 */
const TRIGGER_UNITS: Record<ChangeTrigger, Unit[]> = {
  initial: [],
  geometry: ['建设', '交通'],
  fencing: ['建设', '交通', '公交'],
  time: ['交通', '应急'],
  detour: ['交通', '公交'],
}

function genId(prefix: string) { return `${prefix}-${Math.random().toString(36).slice(2, 8).toUpperCase()}` }
function genOperationId() { return `OP-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}` }
function now() { return new Date().toISOString() }

export interface CountersignPayload {
  stageId: string
  unit: Unit
  author: string
  content: string
  condition?: string
  operationId?: string
  /** 模拟写入失败，用于验证按原操作号重试 */
  simulateFailure?: boolean
}

export interface CountersignResult {
  ok: boolean
  occupied: boolean
  operationId: string
  commentId?: string
  by?: { unit: Unit; author: string }
}

export const useSchemeStore = defineStore('scheme', () => {
  const scheme = ref<Scheme>(structuredClone(seed))
  const selectedStageId = ref('ST-01')
  const selectedCommentId = ref('CM-41')
  const drawing = ref(false)
  const draftRoute = ref<[number, number][]>([])
  const history = ref<string[]>([])

  const selectedStage = computed(() => scheme.value.stages.find((item) => item.id === selectedStageId.value))
  const selectedComment = computed(() => scheme.value.comments.find((item) => item.id === selectedCommentId.value))

  const currentRevision = computed(() => scheme.value.revisions.find((item) => item.id === scheme.value.currentRevisionId))
  const currentRevisionId = computed(() => scheme.value.currentRevisionId)

  /** 未重确认阶段：存在需重确认意见的阶段，单列 */
  const unreconfirmedStages = computed(() =>
    scheme.value.stages.filter((stage) =>
      scheme.value.comments.some((comment) => comment.segmentId === stage.id && comment.confirmStatus === '需重确认'),
    ),
  )
  const unreconfirmedComments = computed(() => scheme.value.comments.filter((comment) => comment.confirmStatus === '需重确认'))

  const conflicts = computed(() => [
    ...(scheme.value.stages.some((stage) => stage.id === 'ST-02') ? [{ id: 'CF-01', level: '高', segmentId: 'ST-02', title: '相邻雨污分流工程时间重叠', detail: '10 月 26–30 日江海大道东段同步占用慢车道，建议错峰 4 天。' }] : []),
    { id: 'CF-02', level: '高', segmentId: 'ST-02', title: '救护通道中断风险', detail: '夜间全封闭将切断区域急救中心南门，必须保留 4 米应急通道。' },
    { id: 'CF-03', level: '中', segmentId: 'ST-01', title: '公交站点覆盖缺口', detail: '17 路与 806 路临时站距现状站 680 米，已超过 500 米阈值。' },
    { id: 'CF-04', level: '中', segmentId: 'ST-03', title: '绕行延误超阈值', detail: '高峰绕行新增 19 分钟，超过方案设定的 15 分钟阈值。' },
  ])
  const dirty = computed(() => history.value.length > 0)

  function persist() { localStorage.setItem(STORAGE_KEY, JSON.stringify(scheme.value)) }
  function restore() {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      try { scheme.value = JSON.parse(raw) } catch { /* 保留 seed */ }
    }
  }
  function commit() { history.value.push(JSON.stringify(scheme.value)); persist() }

  /** 按操作号幂等追加处理记录：同一操作号只保留一条，不重复追加 */
  function appendProcessingRecord(record: ProcessingRecord) {
    const list = scheme.value.processingRecords
    const idx = list.findIndex((item) => item.operationId === record.operationId)
    if (idx >= 0) list[idx] = record
    else list.push(record)
  }

  function buildNotice(revisionId: string, revisionNumber: number): PublicNotice {
    const stages = scheme.value.stages.map((stage) => ({ id: stage.id, name: stage.name, start: stage.start, end: stage.end, lanes: stage.lanes }))
    const detours = scheme.value.detours.map((route) => ({ id: route.id, name: route.name, extraMinutes: route.extraMinutes }))
    const issuedAt = now()
    const text = [
      `${scheme.value.project} 施工封路公开通告`,
      `范围：${scheme.value.area}`,
      `道路修订：REV-${String(revisionNumber).padStart(3, '0')}（修订号 ${revisionId}）`,
      `签发时间：${issuedAt}`,
      '',
      '施工阶段：',
      ...stages.map((stage) => `${stage.start} 至 ${stage.end}｜${stage.name}｜${stage.lanes}`),
      '',
      '绕行建议：',
      ...detours.map((route) => `${route.name}，增加约 ${route.extraMinutes} 分钟`),
      '',
      '本通告由建设、交通、公交、应急单位联合确认，施工阶段、会签意见与公开通告依据同一条道路修订签发。',
    ].join('\n')
    return { revisionId, revisionNumber, project: scheme.value.project, area: scheme.value.area, issuedAt, stages, detours, text }
  }

  function revisionLabel(trigger: ChangeTrigger, stageId?: string): string {
    const stage = stageId ? scheme.value.stages.find((item) => item.id === stageId) : undefined
    const name = stage ? stage.name : '方案'
    switch (trigger) {
      case 'geometry': return `${name} · 封路几何调整`
      case 'fencing': return `${name} · 围挡方案调整`
      case 'time': return `${name} · 施工时间调整`
      case 'detour': return `${name} · 绕行路线调整`
      default: return '初始版本'
    }
  }

  /**
   * 生成新的道路修订：把施工阶段、会签意见、公开通告绑到同一条修订。
   * 受影响单位的意见置为「需重确认」，其他单位意见沿用（有效）。
   */
  function createRevision(trigger: ChangeTrigger, stageId?: string): RoadRevision {
    const prev = currentRevision.value
    const number = prev ? prev.number + 1 : 1
    const revId = `REV-${String(number).padStart(3, '0')}`
    const affectedUnits = TRIGGER_UNITS[trigger]
    const revision: RoadRevision = {
      id: revId, number, label: revisionLabel(trigger, stageId), createdAt: now(),
      basedOn: prev?.id ?? null, trigger, affectedUnits,
      stageIds: scheme.value.stages.map((stage) => stage.id),
      commentIds: scheme.value.comments.map((comment) => comment.id),
      notice: buildNotice(revId, number),
    }
    scheme.value.revisions.push(revision)
    scheme.value.currentRevisionId = revId
    for (const comment of scheme.value.comments) {
      const affected = affectedUnits.includes(comment.unit) && (!stageId || comment.segmentId === stageId)
      comment.revisionId = revId
      comment.confirmStatus = affected ? '需重确认' : '有效'
    }
    if (stageId) delete scheme.value.occupancy[stageId]
    appendProcessingRecord({
      operationId: genOperationId(), revisionId: revId, stageId: stageId ?? '',
      unit: '建设', author: '系统', action: '修订生成', result: '成功', at: now(),
      detail: `${revision.label}；受影响单位：${affectedUnits.length ? affectedUnits.join('、') : '无'}`,
    })
    persist()
    return revision
  }

  /** 旧数据缺少修订号 → 升级到初始版本，并把所有意见绑定到该修订 */
  function migrate() {
    if (scheme.value.revisions.length > 0 && scheme.value.currentRevisionId) return
    const revId = 'REV-001'
    const notice = buildNotice(revId, 1)
    scheme.value.revisions = [{
      id: revId, number: 1, label: '初始版本', createdAt: now(),
      basedOn: null, trigger: 'initial', affectedUnits: [],
      stageIds: scheme.value.stages.map((stage) => stage.id),
      commentIds: scheme.value.comments.map((comment) => comment.id),
      notice,
    }]
    scheme.value.currentRevisionId = revId
    scheme.value.processingRecords = []
    scheme.value.onSiteTexts = []
    scheme.value.occupancy = {}
    for (const comment of scheme.value.comments) {
      comment.revisionId = revId
      comment.confirmStatus = '有效'
    }
    appendProcessingRecord({
      operationId: genOperationId(), revisionId: revId, stageId: '',
      unit: '建设', author: '系统', action: '修订生成', result: '成功', at: now(),
      detail: '旧数据升级到初始版本，施工阶段、会签意见与公开通告绑定到同一条道路修订',
    })
    persist()
  }

  function startDraw() { drawing.value = true; draftRoute.value = [] }
  function addPoint(point: [number, number]) { if (drawing.value) draftRoute.value.push(point) }
  function finishDraw() {
    if (draftRoute.value.length >= 2) {
      const stage = selectedStage.value
      if (stage) {
        const changed = JSON.stringify(stage.route) !== JSON.stringify(draftRoute.value)
        commit()
        stage.route = [...draftRoute.value]
        stage.status = '待协商'
        scheme.value.version += 1
        if (changed) createRevision('geometry', stage.id)
        persist()
      }
    }
    drawing.value = false
    draftRoute.value = []
  }

  function updateStage(patch: Partial<ClosureStage>) {
    const stage = selectedStage.value
    if (!stage) return
    const trigger: ChangeTrigger | null =
      patch.lanes !== undefined && patch.lanes !== stage.lanes ? 'fencing'
      : (patch.start !== undefined && patch.start !== stage.start) || (patch.end !== undefined && patch.end !== stage.end) ? 'time'
      : null
    commit()
    Object.assign(stage, patch)
    stage.status = '待协商'
    scheme.value.version += 1
    if (trigger) createRevision(trigger, stage.id)
    persist()
  }

  function updateDetour(id: string, patch: Partial<DetourRoute>) {
    const route = scheme.value.detours.find((item) => item.id === id)
    if (!route) return
    commit()
    Object.assign(route, patch)
    scheme.value.version += 1
    createRevision('detour')
    persist()
  }

  function resolveComment(id: string, status: SegmentComment['status']) {
    const comment = scheme.value.comments.find((item) => item.id === id)
    if (!comment) return
    commit()
    comment.status = status
    scheme.value.version += 1
    persist()
  }

  /** 对需重确认的意见进行重确认，绑定到当前修订 */
  function reconfirm(commentId: string, operationId?: string) {
    const comment = scheme.value.comments.find((item) => item.id === commentId)
    if (!comment) return
    const opId = operationId || genOperationId()
    const rev = currentRevision.value
    comment.confirmStatus = '已重确认'
    comment.confirmedAt = now()
    appendProcessingRecord({
      operationId: opId, revisionId: rev?.id ?? comment.revisionId, stageId: comment.segmentId,
      unit: comment.unit, author: comment.author, action: '重确认', result: '成功', at: now(),
      detail: '意见已重确认并绑定当前修订',
    })
    persist()
  }

  function computeOnSiteDiff(later: CountersignPayload, occupied: SegmentComment | undefined): string {
    if (!occupied) return '阶段尚未被占用，无对应版本可比较'
    const diffs: string[] = []
    if (later.content !== occupied.content) diffs.push('意见内容不同')
    if ((later.condition ?? '') !== (occupied.condition ?? '')) diffs.push('附加条件不同')
    if (later.unit !== occupied.unit) diffs.push(`单位不同（${occupied.unit} → ${later.unit}）`)
    if (later.author !== occupied.author) diffs.push(`提交人不同（${occupied.author} → ${later.author}）`)
    return diffs.length ? diffs.join('；') : '内容一致，仅提交人不同'
  }

  /**
   * 会签提交：两名会签人同时提交同一阶段时，先到者占用并写入，
   * 后到者保留现场文字与差异。写入失败按原操作号重试，处理记录不重复追加。
   */
  function submitCountersign(payload: CountersignPayload): CountersignResult {
    const operationId = payload.operationId || genOperationId()
    const rev = currentRevision.value
    if (!rev) return { ok: false, occupied: false, operationId }

    if (payload.simulateFailure) {
      appendProcessingRecord({
        operationId, revisionId: rev.id, stageId: payload.stageId,
        unit: payload.unit, author: payload.author, action: '会签提交',
        result: '失败', at: now(), detail: '模拟写入失败，等待按原操作号重试',
      })
      return { ok: false, occupied: false, operationId }
    }

    const existing = scheme.value.occupancy[payload.stageId]

    // 同一操作号重试：不重复写入，返回已有结果
    if (existing && existing.operationId === operationId) {
      appendProcessingRecord({
        operationId, revisionId: rev.id, stageId: payload.stageId,
        unit: payload.unit, author: payload.author, action: '会签提交',
        result: '重试', at: now(), detail: '按原操作号重试，不重复写入',
      })
      persist()
      return { ok: true, occupied: true, operationId, commentId: existing.commentId }
    }

    // 后到者：已被其他操作占用 → 保留现场文字与差异
    if (existing) {
      const occupiedComment = scheme.value.comments.find((item) => item.id === existing.commentId)
      const onSite: OnSiteText = {
        id: genId('OST'), operationId, revisionId: rev.id, stageId: payload.stageId,
        unit: payload.unit, author: payload.author, content: payload.content,
        condition: payload.condition, diff: computeOnSiteDiff(payload, occupiedComment), at: now(),
      }
      scheme.value.onSiteTexts.push(onSite)
      appendProcessingRecord({
        operationId, revisionId: rev.id, stageId: payload.stageId,
        unit: payload.unit, author: payload.author, action: '现场文字',
        result: '占用', at: now(), detail: `阶段已被 ${existing.author}（${existing.unit}）先到占用，保留现场文字与差异`,
      })
      persist()
      return { ok: true, occupied: false, operationId, by: { unit: existing.unit, author: existing.author } }
    }

    // 先到者：占用并写入意见
    const commentId = genId('CM')
    const comment: SegmentComment = {
      id: commentId, segmentId: payload.stageId, unit: payload.unit, author: payload.author,
      content: payload.content, condition: payload.condition, status: '待处理',
      revisionId: rev.id, confirmStatus: '有效', confirmedAt: now(),
    }
    scheme.value.comments.push(comment)
    scheme.value.occupancy[payload.stageId] = {
      operationId, revisionId: rev.id, unit: payload.unit, author: payload.author, commentId, at: now(),
    }
    appendProcessingRecord({
      operationId, revisionId: rev.id, stageId: payload.stageId,
      unit: payload.unit, author: payload.author, action: '会签提交',
      result: '成功', at: now(), detail: '先到占用，意见写入并绑定当前修订',
    })
    persist()
    return { ok: true, occupied: true, operationId, commentId }
  }

  function undo() {
    const previous = history.value.pop()
    if (previous) { scheme.value = JSON.parse(previous); persist() }
  }

  function revisionLabelOf(revisionId: string): string {
    return scheme.value.revisions.find((item) => item.id === revisionId)?.label ?? revisionId
  }

  watch(selectedStageId, () => {})
  restore()
  migrate()

  return {
    scheme, selectedStageId, selectedCommentId, selectedStage, selectedComment,
    drawing, draftRoute, conflicts, dirty,
    currentRevision, currentRevisionId, unreconfirmedStages, unreconfirmedComments,
    startDraw, addPoint, finishDraw, updateStage, updateDetour,
    resolveComment, reconfirm, submitCountersign, undo, revisionLabelOf,
  }
})
