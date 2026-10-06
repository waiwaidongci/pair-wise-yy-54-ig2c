import type {
  AuditRecord,
  ChangeType,
  ClosureStage,
  DetourRoute,
  RivalSubmission,
  RoadRevision,
  Scheme,
  SegmentComment,
  SignUnit,
} from '../types'
import { IMPACT_MATRIX } from '../types'

/** 深拷贝（structuredClone 在 Node 18+ 与现代浏览器均可用） */
export function clone<T>(value: T): T {
  return structuredClone(value)
}

let sequence = 0
/** 生成操作号；同一业务动作重试时必须复用首次生成的号 */
export function nextOpId(prefix = 'OP'): string {
  sequence += 1
  const rand = Math.floor(Math.random() * 36 ** 4).toString(36).padStart(4, '0')
  return `${prefix}-${Date.now().toString(36)}-${sequence.toString(36)}-${rand}`
}

export interface StagePatch {
  name?: string
  start?: string
  end?: string
  lanes?: string
  route?: [number, number][]
}

export interface ReviseInput {
  stageIds: string[]
  /** 各阶段字段补丁（几何/时间/围挡/名称） */
  patches?: Record<string, StagePatch>
  detourIds?: string[]
  detourPatches?: Record<string, Partial<DetourRoute>>
  reason: string
  author: string
  at: string
}

export interface ReviseResult {
  scheme: Scheme
  record: AuditRecord
  revision: RoadRevision
  affectedUnits: SignUnit[]
  invalidated: SegmentComment[]
}

function inferStageChanges(patch: StagePatch | undefined): ChangeType[] {
  const changes: ChangeType[] = []
  if (patch && (patch.lanes !== undefined || patch.route !== undefined)) changes.push('围挡')
  if (patch && (patch.start !== undefined || patch.end !== undefined)) changes.push('时间')
  return changes
}

function summarize(units: SignUnit[], stages: ClosureStage[], detours: DetourRoute[], changes: ChangeType[]): string {
  const parts: string[] = []
  if (changes.includes('围挡')) parts.push(`围挡/几何（${stages.map((s) => s.id).join('、')}）`)
  if (changes.includes('时间')) parts.push(`施工时间（${stages.map((s) => s.id).join('、')}）`)
  if (changes.includes('绕行')) parts.push(`绕行路线（${detours.map((d) => d.id).join('、')}）`)
  if (!parts.length) parts.push('阶段文字信息')
  return `R 修订：${parts.join('；')}；受影响单位 ${units.length ? units.join('、') : '无'}，其余单位意见沿用`
}

/** 各单位实际关心的变更类型：跨修订沿用的意见只要本次变更落入其职责范围即失效 */
const UNIT_CONCERNS: Record<SignUnit, ChangeType[]> = {
  建设: ['围挡', '时间', '绕行'],
  交通: ['围挡', '绕行'],
  公交: ['时间', '绕行'],
  应急: ['围挡', '时间'],
}

/**
 * 规则 1+2：生成新道路修订并应用到方案。
 * 围挡/时间/绕行一变，仅受影响单位在受影响阶段上的意见失效重确认，其他单位沿用。
 * “受影响” = 影响矩阵命中，或（跨修订沿用的旧意见）其单位职责覆盖本次变更类型。
 */
export function applyRevision(prev: Scheme, input: ReviseInput): ReviseResult {
  const scheme = clone(prev)
  const revision = scheme.revision + 1
  const changes: ChangeType[] = []
  const stageIds = [...new Set(input.stageIds)].sort()
  const detourIds = [...new Set(input.detourIds ?? [])].sort()

  for (const id of stageIds) {
    for (const change of inferStageChanges(input.patches?.[id])) {
      if (!changes.includes(change)) changes.push(change)
    }
  }
  if (detourIds.length) changes.push('绕行')

  const stageSet = new Set(stageIds)
  const units = [...new Set(changes.flatMap((change) => IMPACT_MATRIX[change]))]
  const unitSet = new Set(units)

  // 1. 应用阶段补丁，受影响阶段统一锚定新修订；旧并发会签锁随旧修订失效
  for (const id of stageIds) {
    const stage = scheme.stages.find((item) => item.id === id)
    if (!stage) continue
    const patch = input.patches?.[id]
    if (patch) Object.assign(stage, patch)
    stage.baseRevision = revision
    stage.reconfirmed = false
    // 阶段已锚定新修订，不再是“旧数据未重确认”，失效原因以新修订号为准
    stage.legacyUnconfirmed = undefined
    stage.lock = undefined
    stage.rivals = []
  }

  // 2. 应用绕行补丁
  for (const id of detourIds) {
    const detour = scheme.detours.find((item) => item.id === id)
    const patch = input.detourPatches?.[id]
    if (!detour || !patch) continue
    Object.assign(detour, patch)
    detour.baseRevision = revision
  }

  // 3. 仅“受影响单位 × 受影响阶段”的有效意见失效；其他单位、其他阶段一律沿用
  //    受影响判定：
  //    a) 影响矩阵命中单位（与本修订同修订时的常规情形）；
  //    b) 意见锚定旧修订（baseRevision < revision），且本次变更类型属于该单位职责，
  //       例如 R1 公交意见在 R3 时间变更后不能继续沿用；交通不关心时间，意见沿用。
  //    已经处于失效态的意见保持原状，不重复标记。
  const invalidated: SegmentComment[] = []
  for (const comment of scheme.comments) {
    if (comment.validity !== '有效') continue
    if (!stageSet.has(comment.segmentId)) continue
    const inImpactMatrix = unitSet.has(comment.unit)
    const staleConcernHit =
      comment.baseRevision < revision &&
      changes.some((change) => UNIT_CONCERNS[comment.unit].includes(change))
    if (!(inImpactMatrix || staleConcernHit)) continue
    comment.validity = '失效待重确认'
    comment.invalidatedBy = { revision, change: changes[0] }
    invalidated.push(comment)
  }

  const touchedStages = scheme.stages.filter((s) => stageSet.has(s.id))
  const touchedDetours = scheme.detours.filter((d) => detourIds.includes(d.id))
  const roadRevision: RoadRevision = {
    revision,
    at: input.at,
    author: input.author,
    changes,
    reason: input.reason,
    stageIds,
    detourIds,
    summary: summarize(units, touchedStages, touchedDetours, changes),
  }
  scheme.revisions.unshift(roadRevision)
  scheme.revision = revision
  scheme.version += 1

  const invalidText = invalidated.length
    ? `；失效重确认 ${invalidated.map((c) => `${c.unit}·${c.author}(${c.segmentId})`).join('、')}`
    : '；无意见失效'
  const record: AuditRecord = {
    opId: nextOpId('RV'),
    type: '道路修订',
    at: input.at,
    detail: `R${revision}：${roadRevision.summary}${invalidText}；原因「${input.reason}」`,
    result: '成功',
    attempts: 1,
  }
  return { scheme, record, revision: roadRevision, affectedUnits: units, invalidated }
}

export interface SignoffInput {
  stageId: string
  unit: SignUnit
  author: string
  content: string
  condition?: string
  at: string
}

export interface SignoffResult {
  scheme: Scheme
  record: AuditRecord
  outcome: '占用' | '留场'
  lock?: ClosureStage['lock']
  rival?: RivalSubmission
}

/** 规则 3：同阶段两名会签人同时提交，先到者占用，后到者留现场文字和差异。 */
export function applySignoff(prev: Scheme, input: SignoffInput): SignoffResult {
  const scheme = clone(prev)
  const stage = scheme.stages.find((item) => item.id === input.stageId)
  if (!stage) throw new Error(`阶段 ${input.stageId} 不存在`)
  const opId = nextOpId('SG')

  // 后到者：锁不覆盖，现场文字 + 差异留痕
  if (stage.lock) {
    const rival = {
      unit: input.unit,
      author: input.author,
      at: input.at,
      opId,
      content: input.content,
      condition: input.condition,
      diffs: buildWinnerRivalDiffs(stage.lock, input),
    }
    stage.rivals = [...(stage.rivals ?? []), rival]
    const record: AuditRecord = {
      opId,
      type: '会签提交',
      at: input.at,
      detail: `${input.unit}·${input.author} 对 ${stage.id} 提交会签（后到）：先到者 ${stage.lock.unit}·${stage.lock.author} 已占用，现场文字与 ${rival.diffs.length} 项差异留痕，不覆盖原意见`,
      result: '成功',
      attempts: 1,
    }
    return { scheme, record, outcome: '留场', rival }
  }

  // 先到者占用
  const lock = {
    unit: input.unit,
    author: input.author,
    at: input.at,
    opId,
    content: input.content,
    condition: input.condition,
  }
  stage.lock = lock
  const comment: SegmentComment = {
    id: `CM-${Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0').toUpperCase()}`,
    segmentId: stage.id,
    unit: input.unit,
    author: input.author,
    content: input.content,
    condition: input.condition,
    status: '待处理',
    baseRevision: stage.baseRevision,
    validity: '有效',
  }
  scheme.comments.push(comment)
  const record: AuditRecord = {
    opId,
    type: '会签提交',
    at: input.at,
    detail: `${input.unit}·${input.author} 对 ${stage.id} 提交会签（先到）：占用本阶段 R${stage.baseRevision} 会签锁，生成意见 ${comment.id}`,
    result: '成功',
    attempts: 1,
  }
  return { scheme, record, outcome: '占用', lock }
}

/** 先到者 vs 后到者的逐字段差异 */
export function buildWinnerRivalDiffs(
  winner: { content: string; condition?: string },
  rival: { content: string; condition?: string },
): { field: string; winner: string; rival: string }[] {
  const diffs: { field: string; winner: string; rival: string }[] = []
  if (winner.content.trim() !== rival.content.trim()) {
    diffs.push({ field: '现场意见', winner: winner.content, rival: rival.content })
  }
  if ((winner.condition ?? '') !== (rival.condition ?? '')) {
    diffs.push({ field: '附加条件', winner: winner.condition ?? '无', rival: rival.condition ?? '无' })
  }
  return diffs
}

export interface ResolveInput {
  commentId: string
  status: SegmentComment['status']
  at: string
}

export function applyResolve(prev: Scheme, input: ResolveInput): { scheme: Scheme; record: AuditRecord } {
  const scheme = clone(prev)
  const comment = scheme.comments.find((item) => item.id === input.commentId)
  if (!comment) throw new Error(`意见 ${input.commentId} 不存在`)
  comment.status = input.status
  const record: AuditRecord = {
    opId: nextOpId('RS'),
    type: '意见处理',
    at: input.at,
    detail: `${comment.unit}·${comment.author} 的意见 ${comment.id}（${comment.segmentId} / R${comment.baseRevision}）处理为「${input.status}」`,
    result: '成功',
    attempts: 1,
  }
  return { scheme, record }
}

export interface ReconfirmInput {
  commentId: string
  unit: SignUnit
  author: string
  content: string
  condition?: string
  at: string
}

/** 失效意见重确认：原意见保留不覆盖，新意见锚定当前阶段修订；该单位在该阶段重确认后阶段可整体确认。 */
export function applyReconfirm(prev: Scheme, input: ReconfirmInput): { scheme: Scheme; record: AuditRecord; newComment: SegmentComment } {
  const scheme = clone(prev)
  const oldComment = scheme.comments.find((item) => item.id === input.commentId)
  if (!oldComment) throw new Error(`意见 ${input.commentId} 不存在`)
  const stage = scheme.stages.find((item) => item.id === oldComment.segmentId)
  if (!stage) throw new Error(`阶段 ${oldComment.segmentId} 不存在`)

  const newComment: SegmentComment = {
    id: `CM-${Math.floor(Math.random() * 36 ** 6).toString(36).padStart(6, '0').toUpperCase()}`,
    segmentId: oldComment.segmentId,
    unit: input.unit,
    author: input.author,
    content: input.content,
    condition: input.condition,
    status: '待处理',
    baseRevision: stage.baseRevision,
    validity: '有效',
  }
  scheme.comments.push(newComment)
  // 同单位在该阶段的失效旧意见全部标记为已重确认（原记录保留，不删除不覆盖）
  for (const c of scheme.comments) {
    if (c.segmentId === stage.id && c.unit === input.unit && c.validity === '失效待重确认') {
      c.validity = '已重确认'
    }
  }
  // 阶段上不再有任何失效意见，阶段才整体恢复确认
  const anyInvalid = scheme.comments.some((c) => c.segmentId === stage.id && c.validity === '失效待重确认')
  if (!anyInvalid) {
    stage.reconfirmed = true
    stage.legacyUnconfirmed = undefined
  }
  const record: AuditRecord = {
    opId: nextOpId('RC'),
    type: '意见重确认',
    at: input.at,
    detail: `${input.unit}·${input.author} 就 ${stage.id} 失效意见 ${oldComment.id}（R${oldComment.baseRevision}）在 R${stage.baseRevision} 上重确认，新意见 ${newComment.id}；原意见保留不覆盖`,
    result: '成功',
    attempts: 1,
  }
  return { scheme, record, newComment }
}

/* ------------------------------------------------------------------ */
/* 规则 6：旧数据缺少修订号 → 升级到初始版本 R1，未重确认阶段单列       */
/* ------------------------------------------------------------------ */

interface LegacyScheme {
  id?: unknown
  project?: unknown
  contractor?: unknown
  area?: unknown
  version?: unknown
  stages?: { id?: unknown; name?: unknown; start?: unknown; end?: unknown; lanes?: unknown; status?: unknown; route?: unknown }[]
  detours?: { id?: unknown; name?: unknown; distance?: unknown; extraMinutes?: unknown; coordinates?: unknown }[]
  comments?: { id?: unknown; segmentId?: unknown; unit?: unknown; author?: unknown; content?: unknown; condition?: unknown; status?: unknown }[]
}

function isLegacy(raw: unknown): raw is LegacyScheme {
  if (typeof raw !== 'object' || raw === null) return false
  const data = raw as Record<string, unknown>
  return Array.isArray(data.stages) && typeof data.revision !== 'number'
}

export function migrateLegacy(raw: unknown, fallback: Scheme, at: string): Scheme {
  if (!isLegacy(raw)) return clone(raw as Scheme)
  const data = raw as LegacyScheme
  const scheme: Scheme = clone(fallback)
  scheme.id = typeof data.id === 'string' ? data.id : fallback.id
  scheme.project = typeof data.project === 'string' ? data.project : fallback.project
  scheme.contractor = typeof data.contractor === 'string' ? data.contractor : fallback.contractor
  scheme.area = typeof data.area === 'string' ? data.area : fallback.area
  scheme.version = typeof data.version === 'number' ? data.version : 0
  scheme.revision = 1
  scheme.legacy = true
  scheme.stages = (data.stages ?? []).map((s) => ({
    id: String(s.id ?? ''),
    name: String(s.name ?? ''),
    start: String(s.start ?? ''),
    end: String(s.end ?? ''),
    lanes: String(s.lanes ?? ''),
    status: (s.status as ClosureStage['status']) ?? '待协商',
    route: Array.isArray(s.route) ? (s.route as [number, number][]) : [],
    baseRevision: 1,
    // 升级后一律视为“尚未在初始版本重确认”，进入公开通告单列清单
    reconfirmed: false,
    legacyUnconfirmed: true,
  }))
  scheme.detours = (data.detours ?? []).map((d) => ({
    id: String(d.id ?? ''),
    name: String(d.name ?? ''),
    distance: Number(d.distance ?? 0),
    extraMinutes: Number(d.extraMinutes ?? 0),
    coordinates: Array.isArray(d.coordinates) ? (d.coordinates as [number, number][]) : [],
    baseRevision: 1,
  }))
  scheme.comments = (data.comments ?? []).map((c) => ({
    id: String(c.id ?? ''),
    segmentId: String(c.segmentId ?? ''),
    unit: (c.unit as SignUnit) ?? '建设',
    author: String(c.author ?? ''),
    content: String(c.content ?? ''),
    condition: typeof c.condition === 'string' ? c.condition : undefined,
    status: (c.status as SegmentComment['status']) ?? '待处理',
    baseRevision: 1,
    validity: '失效待重确认' as const,
    fromLegacy: true,
  }))
  scheme.revisions = [
    {
      revision: 1,
      at,
      author: '系统迁移',
      changes: [],
      reason: '旧数据缺少修订号，统一升级到初始版本 R1，会签意见须在 R1 上重确认',
      stageIds: scheme.stages.map((s) => s.id),
      detourIds: scheme.detours.map((d) => d.id),
      summary: 'R1 初始版本（旧数据升级）：全部阶段等待重确认',
      migratedFromLegacy: true,
    },
  ]
  scheme.audit = [
    {
      opId: nextOpId('MG'),
      type: '道路修订',
      at,
      detail: `旧数据缺少修订号，升级为 R1 初始版本；${scheme.stages.length} 个阶段、${scheme.comments.length} 条会签意见需在 R1 上重确认，未重确认阶段单列`,
      result: '成功',
      attempts: 1,
    },
  ]
  return scheme
}

export { isLegacy }

/* ------------------------------------------------------------------ */
/* 公开通告：明确依据哪条道路修订，未重确认阶段单列                      */
/* ------------------------------------------------------------------ */

export interface NoticeBundle {
  text: string
  filename: string
}

export function buildNotice(scheme: Scheme): NoticeBundle {
  const head = scheme.revisions[0]
  const lines: string[] = []
  lines.push(`${scheme.project} 施工封路公开通告`)
  lines.push(`通告编号：${scheme.id}-NOTICE-R${scheme.revision}`)
  lines.push(`依据道路修订：R${scheme.revision}（${head?.at ?? ''} 由 ${head?.author} 发布）`)
  lines.push(`修订说明：${head?.summary ?? ''}`)
  lines.push(`范围：${scheme.area}`)
  lines.push('')
  lines.push('一、施工阶段（每条均锚定当前修订号，意见失效阶段不列入生效承诺）')
  for (const stage of scheme.stages) {
    const confirm = stage.reconfirmed
      ? `已按 R${stage.baseRevision} 重确认`
      : stage.legacyUnconfirmed
        ? `【未重确认 · 旧数据升级】R${stage.baseRevision}`
        : `【意见失效待重确认】R${stage.baseRevision}`
    const lock = stage.lock ? `；先到会签 ${stage.lock.unit}·${stage.lock.author}` : ''
    lines.push(`[R${stage.baseRevision}] ${stage.start} 至 ${stage.end}｜${stage.name}｜${stage.lanes}｜${confirm}${lock}`)
  }
  lines.push('')
  lines.push('二、绕行建议')
  for (const detour of scheme.detours) {
    lines.push(`[R${detour.baseRevision}] ${detour.name}，${detour.distance} km，增加约 ${detour.extraMinutes} 分钟`)
  }
  const unconfirmed = scheme.stages.filter((s) => !s.reconfirmed)
  lines.push('')
  lines.push('三、未重确认阶段单列（不作为本通告生效内容，重确认前以现场指挥为准）')
  if (!unconfirmed.length) {
    lines.push('无。全部阶段会签意见均已在当前修订上确认。')
  } else {
    for (const stage of unconfirmed) {
      const invalid = scheme.comments.filter((c) => c.segmentId === stage.id && c.validity === '失效待重确认')
      const units = [...new Set(invalid.map((c) => c.unit))].join('、') || '全部单位'
      lines.push(`${stage.id} ${stage.name}｜锚定 R${stage.baseRevision}｜待重确认单位：${units}`)
    }
  }
  lines.push('')
  lines.push(`本通告与施工阶段、会签意见绑定同一道路修订 R${scheme.revision}；修订后仅受影响单位意见失效重确认，其余沿用。`)
  return {
    text: lines.join('\n'),
    filename: `封路公开通告-${scheme.id}-R${scheme.revision}.txt`,
  }
}
