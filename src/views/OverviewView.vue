<script setup lang="ts">
import { computed } from 'vue'
import { useQuery } from '@vue/apollo-composable'
import { SCHEME_QUERY } from '../graphql'
import { useSchemeStore } from '../store/scheme'

const store = useSchemeStore()
const { result, loading, error } = useQuery(SCHEME_QUERY)
void result

const stats = computed(() => [
  { label: '施工阶段', value: store.scheme.stages.length, note: `R${store.scheme.revision} 同修订绑定` },
  { label: '生效高风险冲突', value: store.conflicts.filter((item) => item.level === '高').length, note: '需阶段审批前解决' },
  { label: '失效待重确认意见', value: store.invalidComments.length, note: '仅受影响单位，其他沿用' },
  { label: '道路修订号', value: `R${store.scheme.revision}`, note: '公开通告依据此版本' },
])
</script>

<template>
  <section class="page-head">
    <div>
      <p class="eyebrow">建设 · 交通 · 公交 · 应急</p>
      <h1>封路方案协调总览</h1>
      <p>施工阶段、会签意见、公开通告绑定同一条道路修订；围挡/时间/绕行一变，仅受影响单位重确认。</p>
    </div>
    <a-space>
      <a-button @click="store.exportNotice()">公开通告预览/导出</a-button>
      <a-button type="primary" @click="$router.push('/map')">编辑封路方案</a-button>
    </a-space>
  </section>
  <a-spin :loading="loading" style="width:100%">
    <a-alert v-if="error" type="error" title="GraphQL 请求异常，已使用本地修订数据" class="mb16" />
    <div class="metrics">
      <article v-for="item in stats" :key="item.label" class="card metric"><span>{{ item.label }}</span><strong>{{ item.value }}</strong><small>{{ item.note }}</small></article>
    </div>

    <a-alert v-if="store.unconfirmedStages.length" type="warning" class="mb16">
      <template #title>{{ store.unconfirmedStages.length }} 个阶段未在当前道路修订上重确认，公开通告将单列</template>
      <span v-for="stage in store.unconfirmedStages" :key="stage.id" class="pipeline">{{ stage.id }}（R{{ stage.baseRevision }}）</span>
    </a-alert>

    <div class="grid-2">
      <article class="card">
        <div class="panel-head">
          <div><h2>施工阶段时间轴</h2><p>每条阶段都锚定具体修订号</p></div>
          <a-tag color="arcoblue">R{{ store.scheme.revision }}</a-tag>
        </div>
        <a-table :data="store.scheme.stages" :pagination="false" row-key="id" @row-click="(row: any) => { store.selectedStageId = row.id; $router.push('/map') }">
          <template #columns>
            <a-table-column title="阶段" data-index="name" />
            <a-table-column title="修订" :width="70"><template #cell="{ record }">R{{ record.baseRevision }}</template></a-table-column>
            <a-table-column title="时间" :width="190"><template #cell="{ record }">{{ record.start }} → {{ record.end }}</template></a-table-column>
            <a-table-column title="重确认" :width="120">
              <template #cell="{ record }">
                <a-tag :color="record.reconfirmed ? 'green' : (record.legacyUnconfirmed ? 'orangered' : 'red')">
                  {{ record.reconfirmed ? '已重确认' : (record.legacyUnconfirmed ? '旧版未确认' : '待重确认') }}
                </a-tag>
              </template>
            </a-table-column>
          </template>
        </a-table>
      </article>
      <article class="card">
        <div class="panel-head"><div><h2>道路修订链</h2><p>会签与通告的共同依据</p></div><a-tag color="green">{{ store.scheme.revisions.length }} 版</a-tag></div>
        <div v-for="rev in store.scheme.revisions.slice(0, 4)" :key="rev.revision" class="rev-row" :class="{ current: rev.revision === store.scheme.revision }">
          <b>R{{ rev.revision }} · {{ rev.author }}</b>
          <small>{{ rev.at }}</small>
          <p>{{ rev.summary }}</p>
        </div>
      </article>
    </div>

    <article class="card mt16">
      <div class="panel-head">
        <div><h2>会签单位意见状态</h2><p>有效意见沿用；失效意见仅来自本次修订命中的影响矩阵</p></div>
        <a-button type="text" @click="$router.push('/review')">进入会签</a-button>
      </div>
      <div class="agency-grid">
        <div v-for="agency in (result?.agencies || [])" :key="agency.id" class="agency">
          <span>{{ agency.role }}</span>
          <div>
            <b>{{ agency.name }}</b>
            <small>
              有效 {{ store.scheme.comments.filter((c) => c.unit === agency.role && c.validity === '有效').length }} ·
              失效 {{ store.scheme.comments.filter((c) => c.unit === agency.role && c.validity === '失效待重确认').length }}
            </small>
          </div>
          <a-tag :color="store.scheme.comments.some((c) => c.unit === agency.role && c.validity === '失效待重确认') ? 'red' : 'green'">
            {{ store.scheme.comments.some((c) => c.unit === agency.role && c.validity === '失效待重确认') ? '待重确认' : '已沿用' }}
          </a-tag>
        </div>
      </div>
    </article>
  </a-spin>
</template>

<style scoped>
.metrics{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;margin-bottom:16px}
.metric{padding:17px;border-left:4px solid #2563eb}.metric span,.metric small{display:block;color:#667085}.metric strong{display:block;font-size:29px;margin:7px 0 2px}
.grid-2{display:grid;grid-template-columns:1.3fr .9fr;gap:16px}
.panel-head{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:14px}
.panel-head h2{font-size:17px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:13px;margin:0}
.pipeline{display:inline-block;margin-right:10px;font-size:12px;color:#9a3412}
.rev-row{padding:10px;border:1px solid #edf0f5;border-radius:6px;margin-bottom:7px}
.rev-row.current{border-color:#2563eb;background:#f5f8ff}
.rev-row b,.rev-row small{display:block}.rev-row small{color:#7a8798;margin-top:3px}.rev-row p{margin:6px 0 0;color:#475569;font-size:13px}
.mt16{margin-top:16px}
.agency-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}
.agency{display:flex;align-items:center;gap:10px;padding:12px;border:1px solid #e7ebf1;border-radius:7px}
.agency>span{display:grid;place-items:center;width:35px;height:35px;border-radius:7px;background:#eff6ff;color:#2563eb;font-weight:800}
.agency b,.agency small{display:block}.agency small{color:#7a8798;margin-top:3px}.agency>div{flex:1}
@media(max-width:1050px){.metrics,.agency-grid{grid-template-columns:1fr 1fr}.grid-2{grid-template-columns:1fr}}
@media(max-width:600px){.metrics,.agency-grid{grid-template-columns:1fr}}
</style>
