<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useSchemeStore } from '../store/scheme'
import type { CountersignPayload, CountersignResult } from '../store/scheme'
import type { Unit } from '../types'

const store = useSchemeStore()

const units: Unit[] = ['建设', '交通', '公交', '应急']

const form = reactive({
  stageId: 'ST-01',
  unit: '交通' as Unit,
  author: '郑航',
  content: '',
  condition: '',
})
const simulateFailure = ref(false)
const lastOperationId = ref('')
const lastPayload = ref<CountersignPayload | null>(null)
const lastResult = ref<CountersignResult | null>(null)

const unreconfirmedCount = computed(() => store.unreconfirmedComments.length)

function submit() {
  const payload: CountersignPayload = {
    stageId: form.stageId, unit: form.unit, author: form.author,
    content: form.content, condition: form.condition,
    simulateFailure: simulateFailure.value,
  }
  lastPayload.value = payload
  const result = store.submitCountersign(payload)
  lastOperationId.value = result.operationId
  lastResult.value = result
  if (!result.ok) {
    Message.warning('写入失败，请按原操作号重试')
  } else if (!result.occupied) {
    Message.info(`阶段已被 ${result.by?.author}（${result.by?.unit}）先到占用，您的现场文字与差异已保留`)
  } else {
    Message.success('会签已提交并占用阶段')
  }
}

function retry() {
  if (!lastOperationId.value || !lastPayload.value) return
  const result = store.submitCountersign({ ...lastPayload.value, operationId: lastOperationId.value, simulateFailure: false })
  lastResult.value = result
  if (result.ok) Message.success('按原操作号重试成功，处理记录未重复追加')
}

function simulateConcurrent() {
  const otherUnit = units.find((u) => u !== form.unit) ?? '公交'
  const result = store.submitCountersign({
    stageId: form.stageId, unit: otherUnit, author: '并发会签人',
    content: `【并发模拟】${otherUnit}单位对该阶段的现场意见，与已占用版本存在差异。`,
    condition: '需现场核对。',
  })
  lastResult.value = result
  if (!result.occupied) {
    Message.info(`您是后到者，阶段已被 ${result.by?.author} 占用，现场文字与差异已保留`)
  } else {
    Message.success('并发会签人先到占用阶段')
  }
}

function exportNotice() {
  const notice = store.currentRevision?.notice
  if (!notice) return
  const blob = new Blob([notice.text], { type: 'text/plain;charset=utf-8' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `封路公开通告-${store.scheme.id}-REV-${String(notice.revisionNumber).padStart(3, '0')}.txt`
  link.click()
  URL.revokeObjectURL(link.href)
}

function triggerColor(trigger: string) {
  return trigger === 'geometry' ? 'red' : trigger === 'fencing' ? 'orange' : trigger === 'time' ? 'blue' : trigger === 'detour' ? 'green' : 'gray'
}
function confirmColor(status: string) {
  return status === '有效' ? 'green' : status === '需重确认' ? 'orange' : 'blue'
}
function resultColor(result: string) {
  return result === '成功' ? 'green' : result === '失败' ? 'red' : result === '占用' ? 'orange' : 'blue'
}
</script>

<template>
  <section class="page-head compact"><div><p class="eyebrow">条件会签与版本批复</p><h1>路段意见与阶段审批</h1><p>施工阶段、会签意见与公开通告绑定到同一条道路修订；围挡、时间或绕行变更仅受影响单位重确认，其他沿用。</p></div><a-button type="primary" @click="exportNotice">导出公开通告包</a-button></section>

  <!-- 道路修订链 -->
  <article class="card revision-card">
    <div class="panel-head"><div><h2>道路修订</h2><p>施工阶段 · 会签意见 · 公开通告 同绑一条修订</p></div><a-tag color="blue">当前 {{ store.currentRevision?.id }}</a-tag></div>
    <div class="revision-chain">
      <div v-for="rev in store.scheme.revisions" :key="rev.id" class="revision" :class="{ current: rev.id === store.currentRevisionId }">
        <div class="rev-top"><b>{{ rev.id }}</b><a-tag :color="triggerColor(rev.trigger)">{{ rev.trigger }}</a-tag></div>
        <p>{{ rev.label }}</p>
        <small>基于 {{ rev.basedOn ?? '—' }} · {{ new Date(rev.createdAt).toLocaleString('zh-CN') }}</small>
        <small v-if="rev.affectedUnits.length">受影响：<span v-for="u in rev.affectedUnits" :key="u" class="unit-chip">{{ u }}</span></small>
      </div>
    </div>
  </article>

  <!-- 未重确认阶段单列 -->
  <article class="card unreconfirmed-card">
    <div class="panel-head"><div><h2>未重确认阶段</h2><p>受变更影响、意见需重确认的阶段单列</p></div><a-tag :color="unreconfirmedCount ? 'orange' : 'green'">{{ unreconfirmedCount }} 条待重确认</a-tag></div>
    <div v-if="store.unreconfirmedStages.length" class="unreconfirmed-list">
      <div v-for="stage in store.unreconfirmedStages" :key="stage.id" class="unreconfirmed">
        <div><b>{{ stage.id }}</b><span>{{ stage.name }}</span><small>{{ stage.start }} → {{ stage.end }}</small></div>
        <a-tag color="orange">{{ store.unreconfirmedComments.filter((c) => c.segmentId === stage.id).length }} 条待重确认</a-tag>
      </div>
    </div>
    <a-empty v-else description="所有阶段意见均已确认" />
  </article>

  <div class="review-grid">
    <article class="card">
      <div class="panel-head"><div><h2>会签意见</h2><p>原意见不可覆盖，处理动作进入审计记录</p></div><a-tag color="orange">{{ store.scheme.comments.filter((item) => item.status === '待处理').length }} 待处理</a-tag></div>
      <button v-for="comment in store.scheme.comments" :key="comment.id" class="comment" :class="{ active: store.selectedCommentId === comment.id }" @click="store.selectedCommentId = comment.id">
        <div class="comment-head"><span>{{ comment.unit }}</span><b>{{ comment.author }}</b><a-tag :color="confirmColor(comment.confirmStatus)">{{ comment.confirmStatus }}</a-tag><a-tag :color="comment.status === '已接受' ? 'green' : comment.status === '已退回' ? 'red' : 'orange'">{{ comment.status }}</a-tag></div>
        <p>{{ comment.content }}</p><small v-if="comment.condition">条件：{{ comment.condition }}</small><em>锚点 {{ comment.segmentId }} · 绑定 {{ comment.revisionId }}</em></button>
    </article>
    <div class="right">
      <article class="card">
        <div class="panel-head"><div><h2>阶段条件处理</h2><p>{{ store.selectedComment?.segmentId }} · {{ store.selectedComment?.unit }}</p></div></div>
        <div v-if="store.selectedComment" class="condition"><b>要求条件</b><p>{{ store.selectedComment.condition || '无附加条件' }}</p><b>影响解释</b><p>{{ store.selectedComment.content }}</p></div>
        <a-space><a-button status="danger" :disabled="store.selectedComment?.status !== '待处理'" @click="store.resolveComment(store.selectedComment!.id, '已退回')">退回方案</a-button><a-button type="primary" :disabled="store.selectedComment?.status !== '待处理'" @click="store.resolveComment(store.selectedComment!.id, '已接受')">接受条件</a-button><a-button v-if="store.selectedComment?.confirmStatus === '需重确认'" type="outline" @click="store.reconfirm(store.selectedComment!.id)">重确认并绑定当前修订</a-button></a-space>
      </article>
      <article class="card">
        <div class="panel-head"><div><h2>公开通告</h2><p>依据当前道路修订签发</p></div><a-tag color="blue">{{ store.currentRevision?.id }}</a-tag></div>
        <pre class="notice-text">{{ store.currentRevision?.notice.text }}</pre>
      </article>
    </div>
  </div>

  <div class="bottom-grid">
    <!-- 会签提交 -->
    <article class="card">
      <div class="panel-head"><div><h2>会签提交</h2><p>两名会签人同时提交同一阶段：先到者占用，后到者留现场文字与差异</p></div></div>
      <a-form layout="vertical" :model="form">
        <a-form-item label="阶段"><a-select v-model="form.stageId" style="width:100%"><a-option v-for="stage in store.scheme.stages" :key="stage.id" :value="stage.id">{{ stage.id }} · {{ stage.name }}</a-option></a-select></a-form-item>
        <div class="two"><a-form-item label="单位"><a-select v-model="form.unit" style="width:100%"><a-option v-for="u in units" :key="u" :value="u">{{ u }}</a-option></a-select></a-form-item><a-form-item label="提交人"><a-input v-model="form.author" /></a-form-item></div>
        <a-form-item label="意见内容"><a-textarea v-model="form.content" placeholder="填写会签意见" /></a-form-item>
        <a-form-item label="附加条件"><a-input v-model="form.condition" placeholder="无附加条件可留空" /></a-form-item>
        <a-space><a-switch v-model="simulateFailure" /><span>模拟写入失败</span></a-space>
        <a-space class="mt12"><a-button type="primary" @click="submit">提交会签</a-button><a-button status="warning" @click="simulateConcurrent">模拟并发会签人同时提交</a-button><a-button v-if="lastResult && !lastResult.ok" type="outline" @click="retry">按原操作号重试</a-button></a-space>
        <p v-if="lastOperationId" class="op-hint">最近操作号：{{ lastOperationId }}（重试不变）</p>
      </a-form>
    </article>

    <!-- 处理记录 -->
    <article class="card">
      <div class="panel-head"><div><h2>处理记录</h2><p>按原操作号幂等追加，同一操作号不重复</p></div><a-tag color="blue">{{ store.scheme.processingRecords.length }} 条</a-tag></div>
      <div v-for="record in [...store.scheme.processingRecords].reverse()" :key="record.operationId" class="record">
        <div class="record-head"><a-tag :color="resultColor(record.result)">{{ record.result }}</a-tag><b>{{ record.action }}</b><span>{{ record.operationId }}</span></div>
        <p v-if="record.detail">{{ record.detail }}</p>
        <small>{{ record.unit }} · {{ record.author }} · {{ record.stageId || '全局' }} · {{ new Date(record.at).toLocaleString('zh-CN') }}</small>
      </div>
    </article>

    <!-- 现场文字 -->
    <article class="card">
      <div class="panel-head"><div><h2>现场文字与差异</h2><p>后到者未占用阶段，保留原文及与占用版本的差异</p></div><a-tag color="orange">{{ store.scheme.onSiteTexts.length }} 条</a-tag></div>
      <div v-for="ost in store.scheme.onSiteTexts" :key="ost.id" class="onsite">
        <div class="record-head"><a-tag color="orange">后到</a-tag><b>{{ ost.unit }}</b><span>{{ ost.author }}</span></div>
        <p>{{ ost.content }}</p><small v-if="ost.condition">条件：{{ ost.condition }}</small>
        <p class="diff-line">差异：{{ ost.diff }}</p>
        <small>{{ ost.stageId }} · {{ new Date(ost.at).toLocaleString('zh-CN') }}</small>
      </div>
      <a-empty v-if="!store.scheme.onSiteTexts.length" description="暂无后到现场文字" />
    </article>
  </div>
</template>

<style scoped>
.revision-card{margin-bottom:16px}.revision-chain{display:flex;gap:12px;flex-wrap:wrap}.revision{flex:1;min-width:220px;padding:12px;border:1px solid #e7ebf1;border-radius:7px;border-top:3px solid #cbd5e1}.revision.current{border-color:#2563eb;border-top-color:#2563eb;background:#f5f8ff}.rev-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:6px}.revision p{margin:4px 0;color:#475569;font-size:13px}.revision small{display:block;color:#7a8798;margin-top:3px}.unit-chip{display:inline-block;margin-left:4px;padding:0 6px;border-radius:4px;background:#eef2f7;color:#475569;font-size:12px}
.unreconfirmed-card{margin-bottom:16px}.unreconfirmed-list{display:flex;flex-direction:column;gap:8px}.unreconfirmed{display:flex;justify-content:space-between;align-items:center;padding:10px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:6px}.unreconfirmed>div{display:flex;flex-direction:column;gap:2px}.unreconfirmed b{color:#9a3412}.unreconfirmed span{color:#475569;font-size:13px}.unreconfirmed small{color:#7a8798}
.review-grid{display:grid;grid-template-columns:1fr 1.15fr;gap:16px;margin-bottom:16px}.right{display:grid;gap:16px;height:fit-content}.panel-head{display:flex;justify-content:space-between;margin-bottom:12px}.panel-head h2{font-size:17px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:12px;margin:0}.comment{display:block;width:100%;text-align:left;border:1px solid #e7ebf1;background:#fff;border-radius:7px;padding:13px;margin-bottom:9px;color:inherit;cursor:pointer}.comment:hover,.comment.active{border-color:#2563eb;background:#f5f8ff}.comment-head{display:flex;align-items:center;gap:8px}.comment-head>span{display:grid;place-items:center;width:36px;height:36px;border-radius:6px;background:#eef2f7;font-weight:800}.comment-head b{flex:1}.comment p{margin:9px 0 5px;color:#475569}.comment small,.comment em{display:block;color:#7a8798}.comment em{margin-top:6px;font-style:normal}.condition p{color:#475569}.notice-text{white-space:pre-wrap;font-family:inherit;font-size:13px;color:#475569;background:#f8fafc;padding:12px;border-radius:6px;margin:0;max-height:280px;overflow:auto}
.bottom-grid{display:grid;grid-template-columns:1.1fr 1fr 1fr;gap:16px}.two{display:grid;grid-template-columns:1fr 1fr;gap:8px}.mt12{margin-top:12px}.op-hint{margin:10px 0 0;color:#7a8798;font-size:12px}
.record{padding:10px;border:1px solid #edf0f5;border-radius:6px;margin-bottom:8px}.record-head{display:flex;align-items:center;gap:8px}.record-head b{flex:1;font-size:13px}.record-head span{color:#7a8798;font-size:11px}.record p{margin:6px 0 2px;color:#475569;font-size:13px}.record small{color:#7a8798;font-size:11px}
.onsite{padding:10px;border:1px solid #fed7aa;background:#fff7ed;border-radius:6px;margin-bottom:8px}.onsite p{margin:6px 0 2px;color:#475569;font-size:13px}.onsite small{color:#7a8798;font-size:11px}.diff-line{color:#9a3412!important}
@media(max-width:1100px){.bottom-grid{grid-template-columns:1fr}.review-grid{grid-template-columns:1fr}}
</style>
