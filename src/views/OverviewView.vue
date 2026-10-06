<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@vue/apollo-composable'
import { SCHEME_QUERY } from '../graphql'
import { useSchemeStore } from '../store/scheme'

const store = useSchemeStore()
const { result, loading, error } = useQuery(SCHEME_QUERY)
const stats = computed(() => [
  { label: '施工阶段', value: store.scheme.stages.length, note: '跨 42 天' },
  { label: '生效冲突', value: store.conflicts.filter((item) => item.level === '高').length, note: '需阶段审批前解决' },
  { label: '待处理条件', value: store.scheme.comments.filter((item) => item.status === '待处理').length, note: '公交单位尚有 1 条' },
  { label: '当前修订', value: store.currentRevision?.id ?? '—', note: store.currentRevision?.label ?? '未绑定修订' },
  { label: '未重确认意见', value: store.unreconfirmedComments.length, note: '受变更影响需重确认' },
  { label: '方案版本', value: `v${result.value?.scheme?.version ?? store.scheme.version}`, note: '每次几何修改留痕' },
])
</script>

<template>
  <section class="page-head"><div><p class="eyebrow">建设 · 交通 · 公交 · 应急</p><h1>封路方案协调总览</h1><p>在同一地图与阶段计划下核验相邻工程、生命通道、公交覆盖与绕行时延。</p></div><a-space><a-button>公开通告预览</a-button><a-button type="primary" @click="$router.push('/map')">编辑封路方案</a-button></a-space></section>
  <a-spin :loading="loading" style="width:100%">
    <a-alert v-if="error" type="error" title="GraphQL 请求异常，已使用本地草案" class="mb16" />
    <div class="metrics"><article v-for="item in stats" :key="item.label" class="card metric"><span>{{ item.label }}</span><strong>{{ item.value }}</strong><small>{{ item.note }}</small></article></div>

    <article class="card revision-banner">
      <div class="panel-head"><div><h2>当前道路修订</h2><p>施工阶段、会签意见与公开通告绑定到同一条修订</p></div><a-tag color="blue">{{ store.currentRevision?.id }}</a-tag></div>
      <p class="revision-label">{{ store.currentRevision?.label }}</p>
      <p class="revision-meta">基于 {{ store.currentRevision?.basedOn ?? '—' }} · 触发 {{ store.currentRevision?.trigger }} · 受影响单位：{{ store.currentRevision?.affectedUnits.length ? store.currentRevision.affectedUnits.join('、') : '无' }}</p>
      <div v-if="store.unreconfirmedComments.length" class="unreconfirmed-banner">
        <a-tag color="orange">{{ store.unreconfirmedComments.length }} 条意见待重确认</a-tag>
        <span>涉及阶段：{{ store.unreconfirmedStages.map((s) => s.id).join('、') }}</span>
        <a-button size="mini" type="text" @click="$router.push('/review')">前往会签重确认</a-button>
      </div>
    </article>

    <div class="grid-2">
      <article class="card">
        <div class="panel-head"><div><h2>施工阶段时间轴</h2><p>点击阶段查看范围与道路占用</p></div><a-tag color="orange">42 天计划</a-tag></div>
        <a-table :data="store.scheme.stages" :pagination="false" row-key="id" @row-click="(row: any) => { store.selectedStageId = row.id; $router.push('/map') }">
          <template #columns><a-table-column title="阶段" data-index="name" /><a-table-column title="时间" :width="190"><template #cell="{ record }">{{ record.start }} → {{ record.end }}</template></a-table-column><a-table-column title="车道方案" data-index="lanes" /><a-table-column title="状态" :width="100"><template #cell="{ record }"><a-tag :color="record.status === '已批准' ? 'green' : record.status === '退回' ? 'red' : 'orange'">{{ record.status }}</a-tag></template></a-table-column></template></a-table>
      </article>
      <article class="card">
        <div class="panel-head"><div><h2>规则检测结果</h2><p>按影响等级排序</p></div><a-tag color="red">{{ store.conflicts.filter((item) => item.level === '高').length }} 高风险</a-tag></div>
        <div v-for="item in store.conflicts" :key="item.id" class="conflict" :class="item.level === '高' ? 'red' : 'amber'"><div><b>{{ item.title }}</b><small>{{ item.segmentId }}</small></div><a-tag :color="item.level === '高' ? 'red' : 'orange'">{{ item.level }}</a-tag><p>{{ item.detail }}</p><a-button size="mini" type="text" @click="store.selectedStageId = item.segmentId; $router.push('/map')">定位路段</a-button></div>
      </article>
    </div>
    <article class="card mt16"><div class="panel-head"><div><h2>会签单位与条件</h2><p>意见锚定具体分段，原记录不覆盖</p></div><a-button type="text" @click="$router.push('/review')">进入会签</a-button></div><div class="agency-grid"><div v-for="agency in result?.agencies || []" :key="agency.id" class="agency"><span>{{ agency.role }}</span><div><b>{{ agency.name }}</b><small>{{ agency.role === '公交' ? '1 条待处理' : agency.role === '应急' ? '条件已接受' : '暂无新增意见' }}</small></div><a-tag :color="agency.role === '公交' ? 'orange' : 'green'">{{ agency.role === '公交' ? '待处理' : '已响应' }}</a-tag></div></div></article>
  </a-spin>
</template>

<style scoped>
.metrics{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:16px}.metric{padding:17px;border-left:4px solid #2563eb}.metric span,.metric small{display:block;color:#667085}.metric strong{display:block;font-size:29px;margin:7px 0 2px}.revision-banner{margin-bottom:16px}.revision-label{margin:6px 0 2px;font-size:15px;color:#1d2939}.revision-meta{margin:0;color:#7a8798;font-size:12px}.unreconfirmed-banner{display:flex;align-items:center;gap:10px;margin-top:10px;padding:8px 12px;background:#fff7ed;border:1px solid #fed7aa;border-radius:6px}.unreconfirmed-banner span{color:#9a3412;font-size:13px}.grid-2{display:grid;grid-template-columns:1.4fr .8fr;gap:16px}.panel-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}.panel-head h2{font-size:17px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:13px;margin:0}.conflict{display:flex;justify-content:space-between;flex-wrap:wrap;gap:8px;padding:12px;margin-bottom:9px;border-radius:6px}.conflict.red{background:#fff1f2;border-left:3px solid #e11d48}.conflict.amber{background:#fff7ed;border-left:3px solid #f59e0b}.conflict>div{min-width:210px}.conflict b,.conflict small{display:block}.conflict small{color:#7a8798;margin-top:3px}.conflict p{width:100%;margin:0;color:#475569}.mt16{margin-top:16px}.agency-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}.agency{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid #e7ebf1;border-radius:7px}.agency>span{display:grid;place-items:center;width:35px;height:35px;border-radius:7px;background:#eff6ff;color:#2563eb;font-weight:800}.agency b,.agency small{display:block}.agency small{color:#7a8798;margin-top:3px}.agency>div{flex:1}
@media(max-width:1050px){.metrics,.agency-grid{grid-template-columns:1fr 1fr}.grid-2{grid-template-columns:1fr}}@media(max-width:600px){.metrics,.agency-grid{grid-template-columns:1fr}}
</style>
