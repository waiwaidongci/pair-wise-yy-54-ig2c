export type StageStatus = '待协商' | '条件通过' | '已批准' | '退回'

export type Unit = '建设' | '交通' | '公交' | '应急'

export type CommentStatus = '待处理' | '已接受' | '已退回'

/** 会签意见的确认状态：有效（沿用） / 需重确认 / 已重确认 */
export type ConfirmStatus = '有效' | '需重确认' | '已重确认'

/** 触发新修订的变更类型 */
export type ChangeTrigger = 'initial' | 'geometry' | 'fencing' | 'time' | 'detour'

export type RecordAction = '修订生成' | '会签提交' | '重确认' | '占用' | '现场文字'

export type RecordResult = '成功' | '占用' | '失败' | '重试'

export interface ClosureStage {
  id: string
  name: string
  start: string
  end: string
  lanes: string
  status: StageStatus
  route: [number, number][]
}

export interface DetourRoute {
  id: string
  name: string
  distance: number
  extraMinutes: number
  coordinates: [number, number][]
}

export interface SegmentComment {
  id: string
  segmentId: string
  unit: Unit
  author: string
  content: string
  condition?: string
  status: CommentStatus
  /** 该意见确认时所绑定的道路修订号 */
  revisionId: string
  /** 有效 / 需重确认 / 已重确认 */
  confirmStatus: ConfirmStatus
  confirmedAt?: string
}

export interface NoticeStage {
  id: string
  name: string
  start: string
  end: string
  lanes: string
}

export interface NoticeDetour {
  id: string
  name: string
  extraMinutes: number
}

/** 公开通告：绑定到某一条道路修订 */
export interface PublicNotice {
  revisionId: string
  revisionNumber: number
  project: string
  area: string
  issuedAt: string
  stages: NoticeStage[]
  detours: NoticeDetour[]
  text: string
}

/** 道路修订：把施工阶段、会签意见、公开通告绑到同一条修订 */
export interface RoadRevision {
  id: string
  number: number
  label: string
  createdAt: string
  basedOn: string | null
  trigger: ChangeTrigger
  /** 本次变更影响、需要重确认意见的单位 */
  affectedUnits: Unit[]
  stageIds: string[]
  commentIds: string[]
  notice: PublicNotice
}

/** 处理记录：按操作号幂等追加，同一操作号只保留一条 */
export interface ProcessingRecord {
  /** 原操作号，失败重试时保持不变 */
  operationId: string
  revisionId: string
  stageId: string
  unit: Unit
  author: string
  action: RecordAction
  result: RecordResult
  at: string
  detail?: string
}

/** 现场文字：后到者未占用阶段时保留的原文及与占用版本的差异 */
export interface OnSiteText {
  id: string
  operationId: string
  revisionId: string
  stageId: string
  unit: Unit
  author: string
  content: string
  condition?: string
  diff: string
  at: string
}

/** 阶段占用：两名会签人同时提交同一阶段时先到者占用 */
export interface Occupancy {
  operationId: string
  revisionId: string
  unit: Unit
  author: string
  commentId: string
  at: string
}

export interface Scheme {
  id: string
  project: string
  contractor: string
  area: string
  version: number
  stages: ClosureStage[]
  detours: DetourRoute[]
  comments: SegmentComment[]
  revisions: RoadRevision[]
  currentRevisionId: string
  processingRecords: ProcessingRecord[]
  onSiteTexts: OnSiteText[]
  occupancy: Record<string, Occupancy>
}
