/**
 * 业务规则自检（node scripts/selftest.ts，经 esbuild 打包运行）
 * 覆盖：
 *  1. 修订绑定（阶段/意见/通告同一 revision）
 *  2. 围挡/时间/绕行影响矩阵：仅受影响单位失效，其他沿用
 *  3. 同阶段并发会签：先到占用、后到留场+差异
 *  4. 写入失败按原操作号重试，审计记录不重复追加
 *  5. 旧数据缺修订号 → 升级 R1，未重确认阶段单列
 *  6. 公开通告写明依据修订号，单列未重确认阶段
 */
import {
  applyReconfirm,
  applyResolve,
  applyRevision,
  applySignoff,
  buildNotice,
  migrateLegacy,
} from '../src/core/revision'
import { writeTransport } from '../src/core/transport'
import type { Scheme } from '../src/types'

let passed = 0
let failed = 0
function assert(cond: unknown, message: string) {
  if (cond) {
    passed += 1
    console.log(`  ✅ ${message}`)
  } else {
    failed += 1
    console.error(`  ❌ ${message}`)
  }
}

function fallback(): Scheme {
  return {
    id: '', project: '', contractor: '', area: '', version: 0, revision: 1,
    stages: [], detours: [], comments: [], revisions: [], audit: [],
  }
}
function baseScheme(): Scheme {
  return migrateLegacy({
    id: 'RC-T', project: '测试路', contractor: 'C', area: 'A', version: 3,
    stages: [
      { id: 'S1', name: '阶段一', start: '2026-10-01', end: '2026-10-10', lanes: '2 车道', status: '待协商', route: [[1, 1], [2, 2]] },
      { id: 'S2', name: '阶段二', start: '2026-10-11', end: '2026-10-20', lanes: '全封闭', status: '待协商', route: [[2, 2], [3, 3]] },
    ],
    detours: [{ id: 'D1', name: '绕行一', distance: 1.2, extraMinutes: 5, coordinates: [[1, 1], [3, 3]] }],
    comments: [
      { id: 'C1', segmentId: 'S1', unit: '交通', author: '甲', content: '交通意见', status: '待处理' },
      { id: 'C2', segmentId: 'S1', unit: '应急', author: '乙', content: '应急意见', status: '待处理' },
      { id: 'C3', segmentId: 'S1', unit: '公交', author: '丙', content: '公交意见', status: '待处理' },
      { id: 'C4', segmentId: 'S2', unit: '交通', author: '丁', content: 'S2交通意见', status: '待处理' },
      { id: 'C5', segmentId: 'S2', unit: '应急', author: '乙2', content: 'S2应急意见', status: '待处理' },
    ],
  }, fallback(), '2026-10-06 08:00:00')
}
/** 模拟 R1 全部单位完成重确认 */
function confirmedScheme(): Scheme {
  let s = baseScheme()
  for (const c of [...s.comments]) {
    s = applyReconfirm(s, {
      commentId: c.id, unit: c.unit, author: c.author,
      content: `${c.content}（R1 已确认）`, at: '2026-10-06 09:00:00',
    }).scheme
  }
  return s
}

async function main() {
  console.log('\n规则 1：阶段、会签、通告绑定同一条道路修订')
  {
    let s = confirmedScheme()
    const out = applyRevision(s, {
      stageIds: ['S1'], patches: { S1: { lanes: '1 车道' } },
      reason: '围挡收窄测试', author: '工程师', at: '2026-10-06 10:00:00',
    })
    s = out.scheme
    assert(s.revision === 2, '修订号 R1 → R2')
    assert(s.stages.find((x) => x.id === 'S1')!.baseRevision === 2, 'S1 阶段锚定 R2')
    assert(s.stages.find((x) => x.id === 'S2')!.baseRevision === 1, 'S2 阶段仍锚定 R1')
    const notice = buildNotice(s)
    assert(notice.text.includes('依据道路修订：R2'), '公开通告写明依据 R2')
    assert(notice.filename.includes('R2'), '通告文件名含 R2')
  }

  console.log('\n规则 2：围挡/时间/绕行仅失效受影响单位，其他沿用')
  {
    let s = confirmedScheme()
    const barrier = applyRevision(s, {
      stageIds: ['S1'], patches: { S1: { lanes: '1 车道' } },
      reason: '围挡', author: '工', at: '2026-10-06 10:00:00',
    })
    s = barrier.scheme
    const valid = (seg: string, unit: string) =>
      s.comments.filter((x) => x.segmentId === seg && x.unit === unit && x.validity === '有效').length
    const invalid = (seg: string, unit: string) =>
      s.comments.some((x) => x.segmentId === seg && x.unit === unit && x.validity === '失效待重确认')
    assert(invalid('S1', '交通'), '围挡：S1 交通意见失效')
    assert(invalid('S1', '应急'), '围挡：S1 应急意见失效')
    assert(valid('S1', '公交') >= 1, '围挡：S1 公交意见沿用')
    assert(valid('S2', '交通') >= 1, '围挡：S2 交通意见不受影响')
    assert(barrier.affectedUnits.join() === '交通,应急', '影响单位 = 交通、应急')
    assert(s.stages.find((x) => x.id === 'S1')!.reconfirmed === false, 'S1 进入待重确认')

    const time = applyRevision(s, {
      stageIds: ['S2'], patches: { S2: { start: '2026-10-12' } },
      reason: '时间', author: '工', at: '2026-10-06 11:00:00',
    })
    s = time.scheme
    assert(time.affectedUnits.join() === '公交,应急', '时间：影响单位 = 公交、应急')
    assert(!time.affectedUnits.includes('交通'), '时间：交通不失效')
    assert(s.comments.some((x) => x.segmentId === 'S2' && x.unit === '应急' && x.validity === '失效待重确认'), '时间：S2 应急意见失效')
    assert(s.comments.some((x) => x.segmentId === 'S2' && x.unit === '交通' && x.validity === '有效'), '时间：S2 交通意见沿用')
    assert(s.revision === 3, 'R2 → R3')

    const detour = applyRevision(s, {
      stageIds: ['S1'], detourIds: ['D1'],
      detourPatches: { D1: { extraMinutes: 9 } },
      reason: '绕行调整', author: '工', at: '2026-10-06 12:00:00',
    })
    s = detour.scheme
    assert(detour.affectedUnits.join() === '交通,公交', '绕行：影响单位 = 交通、公交')
    assert(s.detours.find((x) => x.id === 'D1')!.baseRevision === 4, '绕行锚定 R4')
    assert(s.stages.find((x) => x.id === 'S1')!.baseRevision === 4, '绕行关联阶段 S1 锚定 R4')

    const invalidTraffic = s.comments.find((x) => x.segmentId === 'S1' && x.unit === '交通' && x.validity === '失效待重确认')!
    const beforeCount = s.comments.length
    const rc = applyReconfirm(s, {
      commentId: invalidTraffic.id, unit: '交通', author: '甲',
      content: 'R4 交通重新确认', at: '2026-10-06 12:30:00',
    })
    s = rc.scheme
    assert(s.comments.length === beforeCount + 1, '重确认新增一条意见')
    assert(s.comments.find((x) => x.id === invalidTraffic.id)!.validity === '已重确认', '原失效意见保留并标记已重确认')
    assert(s.comments.some((x) => x.content === 'R4 交通重新确认' && x.baseRevision === 4 && x.validity === '有效'), '新意见锚定 R4 且有效')
  }

  console.log('\n规则 2b：跨修订沿用 —— R1 有效意见在后续变更时按单位职责精确失效')
  {
    let s = confirmedScheme()
    // R2：只改 S1 围挡 → 交通、应急（R1）失效，公交沿用
    s = applyRevision(s, {
      stageIds: ['S1'], patches: { S1: { lanes: '1 车道' } },
      reason: '围挡', author: '工', at: 't2',
    }).scheme
    // 交通 R2 重确认
    const invT = s.comments.find((x) => x.segmentId === 'S1' && x.unit === '交通' && x.validity === '失效待重确认')!
    s = applyReconfirm(s, { commentId: invT.id, unit: '交通', author: '甲', content: 'R2交通确认', at: 't2b' }).scheme
    // 应急也重确认
    const invE = s.comments.find((x) => x.segmentId === 'S1' && x.unit === '应急' && x.validity === '失效待重确认')!
    s = applyReconfirm(s, { commentId: invE.id, unit: '应急', author: '乙', content: 'R2应急确认', at: 't2c' }).scheme

    // R3：只改 S1 时间 → 公交（R1 旧锚定，职责含时间）、应急（R2，矩阵命中）失效；
    //       交通（R2，不关心时间）沿用
    const r3 = applyRevision(s, {
      stageIds: ['S1'], patches: { S1: { start: '2026-10-02' } },
      reason: '时间', author: '工', at: 't3',
    })
    s = r3.scheme
    assert(s.comments.some((x) => x.segmentId === 'S1' && x.unit === '公交' && x.content.includes('R1') && x.validity === '失效待重确认'), 'R3 时间：R1 公交旧意见失效')
    assert(s.comments.some((x) => x.segmentId === 'S1' && x.unit === '应急' && x.content === 'R2应急确认' && x.validity === '失效待重确认'), 'R3 时间：R2 应急意见失效')
    assert(s.comments.some((x) => x.segmentId === 'S1' && x.unit === '交通' && x.content === 'R2交通确认' && x.validity === '有效'), 'R3 时间：R2 交通意见沿用')
  }

  console.log('\n规则 3：两名会签人同阶段同时提交，先到占用、后到留场+差异')
  {
    const first = applySignoff(confirmedScheme(), {
      stageId: 'S1', unit: '交通', author: '郑航',
      content: '保留 3.5 米通道', condition: '夜间巡查', at: '2026-10-06 10:31:00',
    })
    assert(first.outcome === '占用', '先到者占用')
    let s = first.scheme
    assert(s.stages.find((x) => x.id === 'S1')!.lock?.author === '郑航', '锁归属先到者')
    const second = applySignoff(s, {
      stageId: 'S1', unit: '应急', author: '夏川',
      content: '必须 4 米，改为对向借道', condition: '专职引导员', at: '2026-10-06 10:31:40',
    })
    s = second.scheme
    assert(second.outcome === '留场', '后到者不占用')
    assert(s.stages.find((x) => x.id === 'S1')!.lock?.author === '郑航', '先到锁未被覆盖')
    const rivals = s.stages.find((x) => x.id === 'S1')!.rivals ?? []
    assert(rivals.length === 1 && rivals[0].author === '夏川', '后到者现场文字留存')
    assert(rivals[0].diffs.length === 2, `记录 2 项字段差异（实际 ${rivals[0].diffs.length}）`)
    assert(rivals[0].diffs.some((d) => d.field === '现场意见' && d.rival.includes('4 米')), '差异保留后到者现场文字')
    const third = applySignoff(s, {
      stageId: 'S1', unit: '公交', author: '丙',
      content: '站点要挪', at: '2026-10-06 10:32:00',
    })
    s = third.scheme
    assert((s.stages.find((x) => x.id === 'S1')!.rivals ?? []).length === 2, '第三个提交者同样只留场')

    const rev = applyRevision(s, {
      stageIds: ['S1'], patches: { S1: { lanes: '1 车道' } },
      reason: '围挡改', author: '工', at: '2026-10-06 11:00:00',
    })
    const stage = rev.scheme.stages.find((x) => x.id === 'S1')!
    assert(!stage.lock && (stage.rivals ?? []).length === 0, '新修订后旧会签锁与留场记录清空')
  }

  console.log('\n规则 4：写入失败按原操作号重试，处理记录不重复追加')
  {
    const opId = 'OP-RETRY-1'
    writeTransport.failNext(1)
    let failedOnce = false
    try {
      await writeTransport.write(opId, 'snapshot-a')
    } catch {
      failedOnce = true
    }
    assert(failedOnce, '第一次写入失败')
    const retry = await writeTransport.write(opId, 'snapshot-a')
    assert(retry.attempt === 2, '按原操作号重试，尝试次数 = 2')
    assert(writeTransport.attempts.get(opId) === 2, '同一操作号只维护一个尝试计数')

    // 复刻 store execute/retry：审计记录随草案只 unshift 一次，失败留在内存，同号重试更新尝试次数
    const s0 = confirmedScheme()
    const a = applyResolve(s0, {
      commentId: s0.comments.find((x) => x.status === '待处理')!.id,
      status: '已接受', at: 't',
    })
    const draft: Scheme = structuredClone(a.scheme)
    draft.audit.unshift(a.record)
    const lenBefore = draft.audit.length
    writeTransport.failNext(1)
    let engineFailed = false
    try {
      await writeTransport.write(a.record.opId, JSON.stringify(draft))
    } catch {
      engineFailed = true
    }
    assert(engineFailed, '引擎首次写入失败，草案与审计记录保留内存')
    assert(draft.audit.length === lenBefore, '失败不产生第二条审计记录')
    const rr = await writeTransport.write(a.record.opId, JSON.stringify(draft))
    a.record.attempts = rr.attempt
    a.record.result = '成功'
    assert(draft.audit.filter((r) => r.opId === a.record.opId).length === 1, '重试后处理记录仍只有一条')
    assert(draft.audit.find((r) => r.opId === a.record.opId)!.attempts === 2, '同一条记录尝试次数更新为 2')
  }

  console.log('\n规则 5：旧数据缺少修订号 → 升级 R1，未重确认阶段单列')
  {
    const migrated = baseScheme()
    assert(migrated.revision === 1, '旧数据升级到 R1')
    assert(migrated.stages.every((x) => x.baseRevision === 1), '全部阶段锚定 R1')
    assert(migrated.stages.every((x) => !x.reconfirmed), '全部阶段标记为未重确认')
    assert(migrated.stages.every((x) => x.legacyUnconfirmed === true), '全部阶段带“旧版未确认”单列标记')
    assert(migrated.comments.every((x) => x.validity === '失效待重确认' && x.fromLegacy), '旧会签意见全部失效待重确认且保留')
    assert(migrated.revisions[0].migratedFromLegacy === true, 'R1 修订记录标注旧数据升级')
    const again = migrateLegacy(JSON.parse(JSON.stringify(migrated)), migrated, 't')
    assert(again.revision === 1 && again.revisions.length === 1, '已是新格式不重复迁移')
    let s = migrated
    for (const c of [...s.comments].filter((x) => x.segmentId === 'S1')) {
      s = applyReconfirm(s, { commentId: c.id, unit: c.unit, author: c.author, content: 'R1确认', at: 't' }).scheme
    }
    assert(s.stages.find((x) => x.id === 'S1')!.reconfirmed === true, 'S1 重确认后离开单列')
    assert(s.stages.find((x) => x.id === 'S1')!.legacyUnconfirmed === undefined, '旧版未确认标记清除')
    assert(s.stages.find((x) => x.id === 'S2')!.reconfirmed === false, 'S2 仍单列')
  }

  console.log('\n规则 6：公开通告依据明确、未重确认阶段单列')
  {
    let s = confirmedScheme()
    s = applyRevision(s, {
      stageIds: ['S1'], patches: { S1: { lanes: '1 车道' } },
      reason: '围挡', author: '工', at: '2026-10-06 10:00:00',
    }).scheme
    const notice = buildNotice(s)
    assert(notice.text.includes('通告编号：RC-T-NOTICE-R2'), '通告编号含修订号')
    assert(/未重确认阶段单列[\s\S]*S1/.test(notice.text), '未重确认 S1 单列')
    assert(notice.text.includes('待重确认单位'), '单列清单写明待重确认单位')
    const migratedNotice = buildNotice(baseScheme())
    assert(migratedNotice.text.includes('未重确认 · 旧数据升级'), '旧数据阶段标注为旧版升级未重确认')
    // 全部确认后通告第三段为“无”
    const allConfirmed = confirmedScheme()
    assert(buildNotice(allConfirmed).text.includes('无。全部阶段会签意见均已在当前修订上确认。'), '全部确认后无单列内容')
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed) process.exit(1)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
