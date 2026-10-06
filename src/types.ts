export type StageStatus = '待协商' | '条件通过' | '已批准' | '退回'
export type SignUnit = '建设' | '交通' | '公交' | '应急'
export type ChangeType = '围挡' | '时间' | '绕行'
export type CommentState = '待处理' | '已接受' | '已退回'
/** 会签意见状态：有效沿用 / 失效待重确认 / 已由新意见替代（原记录保留不覆盖） */
export type CommentValidity = '有效' | '失效待重确认' | '已重确认'

export interface StageLock {
  /** 先到者占用：持锁单位与会签人 */
  unit: SignUnit
  author: string
  at: string
  opId: string
  content: string
  condition?: string
}

/** 后到者不覆盖先到意见，只留现场文字与差异 */
export interface RivalSubmission {
  unit: SignUnit
  author: string
  at: string
  opId: string
  content: string
  condition?: string
  /** 与先到者意见逐字段的差异 */
  diffs: { field: string; winner: string; rival: string }[]
}

export interface ClosureStage {
  id: string
  name: string
  start: string
  end: string
  lanes: string
  status: StageStatus
  route: [number, number][]
  /** 阶段最近一次修订号；会签、通告都通过它锚定同一条道路修订 */
  baseRevision: number
  /** 旧数据升级到 R1 后，阶段是否已在初始版本上完成重确认 */
  reconfirmed: boolean
  /** 仅旧数据迁移产生：尚未重确认，需在公开通告中单列 */
  legacyUnconfirmed?: boolean
  /** 同阶段同修订并发会签时，先到者持锁 */
  lock?: StageLock
  /** 后到者现场文字（含与先到者差异） */
  rivals?: RivalSubmission[]
}

export interface DetourRoute {
  id: string
  name: string
  distance: number
  extraMinutes: number
  coordinates: [number, number][]
  /** 绕行路线最近一次修订号 */
  baseRevision: number
}

export interface SegmentComment {
  id: string
  segmentId: string
  unit: SignUnit
  author: string
  content: string
  condition?: string
  status: CommentState
  /** 意见锚定的道路修订号，几何一改只作废旧修订意见，绝不覆盖 */
  baseRevision: number
  validity: CommentValidity
  /** 失效原因，例如“R3 围挡调整影响交通、应急单位” */
  invalidatedBy?: { revision: number; change: ChangeType }
  /** 旧数据迁移产生的意见 */
  fromLegacy?: boolean
}

/** 道路修订：施工阶段、会签意见、公开通告三者绑定的同一锚点 */
export interface RoadRevision {
  revision: number
  at: string
  author: string
  changes: ChangeType[]
  reason: string
  stageIds: string[]
  detourIds: string[]
  summary: string
  /** R1 由旧数据升级而来 */
  migratedFromLegacy?: boolean
}

export type OpType = '道路修订' | '会签提交' | '意见处理' | '意见重确认' | '撤销'

export interface AuditRecord {
  /** 原操作号：写入失败重试沿用同一号，保证处理记录不重复追加 */
  opId: string
  type: OpType
  at: string
  detail: string
  result: '成功' | '写入失败'
  attempts: number
}

export interface FailedOp {
  opId: string
  type: OpType
  at: string
  attempts: number
  error: string
}

export interface Scheme {
  id: string
  project: string
  contractor: string
  area: string
  /** 几何草稿版本号（保留原有语义）；正式锚点使用 revision */
  version: number
  /** 道路修订号，初始版本为 1 */
  revision: number
  stages: ClosureStage[]
  detours: DetourRoute[]
  comments: SegmentComment[]
  revisions: RoadRevision[]
  audit: AuditRecord[]
  /** 旧数据是否缺少修订号（升级前为 true，迁移后置 false） */
  legacy?: boolean
}

/** 围挡 / 时间 / 绕行 变更 → 受影响、需重确认的会签单位 */
export const IMPACT_MATRIX: Record<ChangeType, SignUnit[]> = {
  围挡: ['交通', '应急'],
  时间: ['公交', '应急'],
  绕行: ['交通', '公交'],
}
