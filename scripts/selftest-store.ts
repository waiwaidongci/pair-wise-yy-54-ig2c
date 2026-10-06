/**
 * Store 层端到端自检（最小 localStorage 垫片 + Pinia/Vue 真实运行）
 */
const storage = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (storage.has(k) ? storage.get(k)! : null),
  setItem: (k: string, v: string) => void storage.set(k, v),
  removeItem: (k: string) => void storage.delete(k),
  clear: () => storage.clear(),
}

import { createPinia, setActivePinia } from 'pinia'
import { useSchemeStore } from '../src/store/scheme'
import { writeTransport } from '../src/core/transport'

let passed = 0
let failed = 0
function assert(cond: unknown, message: string) {
  if (cond) { passed++; console.log(`  ✅ ${message}`) }
  else { failed++; console.error(`  ❌ ${message}`) }
}

async function main() {
  setActivePinia(createPinia())
  const store = useSchemeStore()
  assert(store.scheme.revision === 2, `初始载入 R2 演示数据（实际 R${store.scheme.revision}）`)

  console.log('\nA. 旧数据升级')
  store.resetToLegacyDemo()
  assert(store.scheme.revision === 1, '一键载入旧数据后升级为 R1')
  assert(store.unconfirmedStages.length === 3, 'R1 全部 3 个阶段单列为未重确认')
  assert(store.scheme.comments.every((c) => c.validity === '失效待重确认'), '旧意见全部失效待重确认')
  assert(storage.get('yy54-road-scheme-v2')?.includes('"revision":1'), '升级结果已写入 v2 缓存')

  console.log('\nB0. R2 演示种子上再修订：只失效命中单位，其他沿用')
  store.loadDemoSeed()
  // R2 种子中 ST-01：交通 CM-53 有效（锁），公交 CM-51 有效（R1），应急无有效意见
  // 改 ST-01 时间 → 影响 公交、应急：公交 CM-51 失效；交通 CM-53 沿用
  const rt = await store.revise({
    stageIds: ['ST-01'],
    patches: { 'ST-01': { start: '2026-10-09' } },
    reason: '开工推迟一天', author: '测试工程师',
  })
  assert(rt.ok && store.scheme.revision === 3, '时间修订成功 R2 → R3')
  const cm51 = store.scheme.comments.find((c) => c.id === 'CM-51')!
  const cm53 = store.scheme.comments.find((c) => c.id === 'CM-53')!
  assert(cm51.validity === '失效待重确认' && cm51.invalidatedBy?.revision === 3, '时间：公交 CM-51 失效，标记 R3')
  assert(cm53.validity === '有效', '时间：交通 CM-53 不属影响单位，意见沿用')
  assert(store.scheme.stages.find((s) => s.id === 'ST-01')?.lock === undefined, '时间修订后旧会签锁清空，等待重新会签')
  assert(store.invalidComments.some((c) => c.segmentId === 'ST-01'), '失效意见清单可追踪到阶段')

  // 回到旧数据场景继续 B-E
  store.resetToLegacyDemo()
  console.log('\nB. 道路修订影响矩阵（在 R1 数据上直接改围挡）')
  store.selectedStageId = 'ST-01'
  const r = await store.revise({
    stageIds: ['ST-01'],
    patches: { 'ST-01': { lanes: '夜间再收窄 1 车道' } },
    reason: '管线作业', author: '测试工程师',
  })
  assert(r.ok, '修订提交成功')
  assert(store.scheme.revision === 2, 'R1 → R2')
  // 旧数据中 ST-01 只有公交 CM-41（交通 CM-43 在 ST-03、应急 CM-42 在 ST-02）
  const s01 = store.scheme.stages.find((x) => x.id === 'ST-01')!
  assert(s01.baseRevision === 2, 'ST-01 锚定 R2')
  assert(s01.reconfirmed === false, 'ST-01 修订后重新待重确认')
  assert(store.scheme.comments.find((c) => c.id === 'CM-41')?.validity === '失效待重确认', '公交 CM-41 维持迁移失效态，不被 R2 重复标记')
  assert(store.scheme.comments.find((c) => c.id === 'CM-42')?.validity === '失效待重确认', 'ST-02 应急 CM-42 未被本次修订触及')
  assert(store.scheme.comments.find((c) => c.id === 'CM-43')?.validity === '失效待重确认', 'ST-03 交通 CM-43 未被本次修订触及')
  assert(store.scheme.comments.every((c) => !(c.invalidatedBy?.revision === 2)), '没有“有效”意见可失效 → R2 不产生新失效标记')

  console.log('\nC. 先到占用 / 后到留场')
  const s1 = await store.submitSignoff({ stageId: 'ST-01', unit: '应急', author: '测试甲', content: '保留 4 米通道' })
  assert(s1.ok && s1.outcome === '占用', '先到会签占用')
  const s2 = await store.submitSignoff({ stageId: 'ST-01', unit: '交通', author: '测试乙', content: '3.5 米即可', condition: '夜间巡查' })
  assert(s2.ok && s2.outcome === '留场', '后到会签留场')
  const stage = store.scheme.stages.find((x) => x.id === 'ST-01')!
  assert(stage.lock?.author === '测试甲', '锁仍是先到者')
  assert(stage.rivals?.length === 1 && stage.rivals[0].diffs.length === 2, '后到文字 + 2 项差异留痕')

  console.log('\nD. 写入失败 → 按原操作号重试，审计不重复')
  const auditBefore = store.scheme.audit.length
  writeTransport.failNext(1)
  const fail = await store.resolveComment(store.scheme.comments.find((c) => c.status === '待处理')!.id, '已接受')
  assert(!fail.ok, '写入失败被捕获')
  assert(store.failedOp !== null, '失败队列登记原操作号')
  assert(store.scheme.audit.length === auditBefore + 1, '失败后审计只多 1 条（在内存中等待重试）')
  const persisted1 = JSON.parse(storage.get('yy54-road-scheme-v2')!)
  assert(!persisted1.audit.some((x: any) => x.opId === store.failedOp!.opId), '失败的记录未落入 localStorage')
  const pendingOpId = store.failedOp!.opId
  const retry = await store.retryFailed()
  assert(retry.ok, '按原操作号重试成功')
  assert(store.failedOp === null, '失败队列清空')
  assert(store.scheme.audit.length === auditBefore + 1, '重试后审计仍只多 1 条，未重复追加')
  const rec = store.scheme.audit.find((x) => x.opId === pendingOpId)!
  assert(rec.attempts === 2 && rec.result === '成功', '同一条记录尝试次数刷新为 2')
  const persisted2 = JSON.parse(storage.get('yy54-road-scheme-v2')!)
  assert(persisted2.audit.filter((x: any) => x.opId === pendingOpId).length === 1, 'localStorage 中也只有一条')

  console.log('\nE. 重确认让阶段离开单列')
  const invalid = store.scheme.comments.filter((c) => c.segmentId === 'ST-01' && c.validity === '失效待重确认')
  for (const c of [...invalid]) {
    await store.reconfirmComment(c.id, { unit: c.unit, author: `${c.author}重确认`, content: `${c.unit} R2 重新确认通过` })
  }
  const st01 = store.scheme.stages.find((x) => x.id === 'ST-01')!
  assert(st01.reconfirmed === true, '所有失效单位重确认后 ST-01 离开单列')
  assert(!store.unconfirmedStages.some((x) => x.id === 'ST-01'), '总览的未重确认清单移除 ST-01')
  assert(store.scheme.comments.filter((c) => c.segmentId === 'ST-01').every((c) => c.validity !== '失效待重确认'), 'ST-01 不再有失效意见')

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  if (failed) process.exit(1)
}

main().catch((e) => { console.error(e); process.exit(1) })
