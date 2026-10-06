<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { Message } from '@arco-design/web-vue'
import maplibregl, { Map as MapLibreMap } from 'maplibre-gl'
import { useSchemeStore } from '../store/scheme'
import type { ChangeType, SignUnit } from '../types'
import { IMPACT_MATRIX } from '../types'
import type { StagePatch } from '../core/revision'

const store = useSchemeStore()
const mapEl = ref<HTMLDivElement>()
let map: MapLibreMap | undefined
const layers = ref({ closure: true, detour: true, ambulance: true, bus: true, adjacent: true })

/* ---------------- 道路修订表单 ---------------- */
const form = ref({
  name: '',
  start: '',
  end: '',
  lanes: '',
  reason: '',
  detourId: 'DR-01',
  detourName: '',
  detourDistance: 0,
  detourMinutes: 0,
})

function syncForm() {
  const stage = store.selectedStage
  form.value.name = stage?.name ?? ''
  form.value.start = stage?.start ?? ''
  form.value.end = stage?.end ?? ''
  form.value.lanes = stage?.lanes ?? ''
  form.value.reason = ''
}
watch(() => store.selectedStageId, syncForm, { immediate: true })
watch(() => store.scheme.revision, syncForm)

const stagePatch = computed<StagePatch | undefined>(() => {
  const stage = store.selectedStage
  if (!stage) return undefined
  const patch: StagePatch = {}
  if (form.value.name !== stage.name) patch.name = form.value.name
  if (form.value.start !== stage.start) patch.start = form.value.start
  if (form.value.end !== stage.end) patch.end = form.value.end
  if (form.value.lanes !== stage.lanes) patch.lanes = form.value.lanes
  if (useDrawnRoute.value && store.draftRoute.length >= 2) patch.route = [...store.draftRoute]
  return Object.keys(patch).length ? patch : undefined
})
const pendingChanges = computed<ChangeType[]>(() => {
  const patch = stagePatch.value
  const changes: ChangeType[] = []
  if (patch && ('lanes' in patch || 'route' in patch)) changes.push('围挡')
  if (patch && ('start' in patch || 'end' in patch)) changes.push('时间')
  return changes
})
const affectedUnits = computed<SignUnit[]>(() => [...new Set(pendingChanges.value.flatMap((c) => IMPACT_MATRIX[c]))])
const unaffectedUnits = computed(() => (['建设', '交通', '公交', '应急'] as SignUnit[]).filter((u) => !affectedUnits.value.includes(u)))

const useDrawnRoute = ref(false)
watch(useDrawnRoute, (value) => { if (!value) store.cancelDraw() })

function useGeometry() {
  useDrawnRoute.value = true
  store.startDraw()
}

async function commitRevision() {
  const stage = store.selectedStage
  if (!stage) return
  if (!form.value.reason.trim()) {
    Message.warning('请填写修订原因，公开通告需要据此说明依据')
    return
  }
  const patch = stagePatch.value
  const changes = pendingChanges.value
  if (!changes.length) {
    Message.info('未检测到围挡、时间或几何字段变更（仅改名称不影响会签）')
  }
  const result = await store.revise({
    stageIds: [stage.id],
    patches: patch ? { [stage.id]: patch } : {},
    reason: form.value.reason,
    author: '建设组 · 现场工程师',
  })
  if (result.ok) {
    store.cancelDraw()
    useDrawnRoute.value = false
    Message.success(`已生成 R${store.scheme.revision}：${changes.length ? affectedUnits.value.join('、') + ' 意见失效重确认，其他沿用' : '无意见失效'}`)
    syncForm()
  } else {
    Message.error(`提交失败：${result.error}（已保留，可用顶部横幅按原操作号重试）`)
  }
}

function syncDetourForm() {
  const detour = store.scheme.detours.find((d) => d.id === form.value.detourId)
  form.value.detourName = detour?.name ?? ''
  form.value.detourDistance = detour?.distance ?? 0
  form.value.detourMinutes = detour?.extraMinutes ?? 0
}
watch(() => form.value.detourId, syncDetourForm, { immediate: true })

const detourPatch = computed<Partial<{ name: string; distance: number; extraMinutes: number }> | undefined>(() => {
  const detour = store.scheme.detours.find((d) => d.id === form.value.detourId)
  if (!detour) return undefined
  const patch: Partial<{ name: string; distance: number; extraMinutes: number }> = {}
  if (form.value.detourName !== detour.name) patch.name = form.value.detourName
  if (Number(form.value.detourDistance) !== detour.distance) patch.distance = Number(form.value.detourDistance)
  if (Number(form.value.detourMinutes) !== detour.extraMinutes) patch.extraMinutes = Number(form.value.detourMinutes)
  return Object.keys(patch).length ? patch : undefined
})

async function commitDetour() {
  if (!form.value.reason.trim()) {
    Message.warning('请填写绕行修订原因')
    return
  }
  if (!detourPatch.value) {
    Message.info('绕行路线参数没有变化')
    return
  }
  // 绕行会签锚点落在阶段上：默认关联当前选中阶段
  const stageId = store.selectedStageId
  const result = await store.revise({
    stageIds: [stageId],
    detourIds: [form.value.detourId],
    detourPatches: { [form.value.detourId]: detourPatch.value },
    reason: form.value.reason,
    author: '建设组 · 交通组织',
  })
  if (result.ok) {
    Message.success(`绕行修订 R${store.scheme.revision} 已生成：交通、公交在 ${stageId} 上重确认`)
    syncDetourForm()
    form.value.reason = ''
  } else {
    Message.error(`提交失败：${result.error}`)
  }
}

/* ---------------- 地图 ---------------- */
function addGeoSource(id: string, coordinates: [number, number][], color: string, dasharray?: number[]) {
  if (!map?.isStyleLoaded()) return
  if (map.getLayer(id)) { map.removeLayer(id); map.removeSource(id) }
  map.addSource(id, { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } } })
  map.addLayer({ id, type: 'line', source: id, paint: { 'line-color': color, 'line-width': 5, 'line-opacity': .85, ...(dasharray ? { 'line-dasharray': dasharray } : {}) } })
}

function drawAll() {
  if (!map?.isStyleLoaded()) return
  const stage = store.selectedStage
  if (stage) addGeoSource('closure', stage.route, '#ef4444')
  store.scheme.detours.forEach((route, index) => addGeoSource(`detour-${index}`, route.coordinates, '#2563eb', [2, 2]))
  addGeoSource('ambulance', [[121.476, 31.216], [121.478, 31.228], [121.496, 31.235]], '#16a34a')
  addGeoSource('bus', [[121.466, 31.220], [121.480, 31.229], [121.502, 31.238]], '#d97706', [1, 1])
  addGeoSource('adjacent', [[121.502, 31.244], [121.514, 31.236], [121.524, 31.228]], '#7c3aed')
}
function toggleLayer(id: string, visible: boolean) { if (map?.getLayer(id)) map.setLayoutProperty(id, 'visibility', visible ? 'visible' : 'none') }
function fit() {
  const bounds = new maplibregl.LngLatBounds()
  store.scheme.stages.flatMap((stage) => stage.route).forEach((point) => bounds.extend(point))
  map?.fitBounds(bounds, { padding: 60 })
}
onMounted(async () => {
  await nextTick()
  map = new maplibregl.Map({
    container: mapEl.value!,
    style: { version: 8, sources: { osm: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap' } }, layers: [{ id: 'osm', type: 'raster', source: 'osm' }] },
    center: [121.488, 31.23], zoom: 13,
  })
  map.addControl(new maplibregl.NavigationControl(), 'top-right')
  map.on('load', drawAll)
  map.on('click', (event) => store.addPoint([event.lngLat.lng, event.lngLat.lat]))
})
onBeforeUnmount(() => map?.remove())
watch(() => store.selectedStageId, () => {
  if (!map) return
  const stage = store.selectedStage
  if (stage) { map.flyTo({ center: stage.route[0], zoom: 14 }); drawAll() }
})
watch(() => store.scheme.revision, () => drawAll())
watch(layers, () => {
  if (!map) return
  toggleLayer('closure', layers.value.closure)
  store.scheme.detours.forEach((_, index) => toggleLayer(`detour-${index}`, layers.value.detour))
  toggleLayer('ambulance', layers.value.ambulance)
  toggleLayer('bus', layers.value.bus)
  toggleLayer('adjacent', layers.value.adjacent)
}, { deep: true })
</script>

<template>
  <section class="page-head compact">
    <div>
      <p class="eyebrow">同一条道路修订绑定阶段 · 会签 · 通告</p>
      <h1>封路范围与阶段修订</h1>
      <p>围挡、时间、绕行的任何变化都会生成新道路修订（R+1），仅受影响单位的会签意见失效重确认，其他沿用。</p>
    </div>
    <a-space>
      <a-button @click="fit">定位全段</a-button>
      <a-tag color="arcoblue">当前修订 R{{ store.scheme.revision }}</a-tag>
    </a-space>
  </section>
  <div class="toolbar card">
    <a-radio-group v-model="store.selectedStageId" type="button">
      <a-radio v-for="stage in store.scheme.stages" :key="stage.id" :value="stage.id">
        {{ stage.id }}<i :class="stage.reconfirmed ? 'dot ok' : 'dot warn'" />
      </a-radio>
    </a-radio-group>
    <span class="spacer"></span>
    <a-checkbox v-model="layers.closure">封路</a-checkbox>
    <a-checkbox v-model="layers.detour">绕行</a-checkbox>
    <a-checkbox v-model="layers.ambulance">救护通道</a-checkbox>
    <a-checkbox v-model="layers.bus">公交</a-checkbox>
    <a-checkbox v-model="layers.adjacent">相邻工程</a-checkbox>
  </div>
  <div class="map-grid">
    <div ref="mapEl" class="map"></div>
    <aside class="card inspector">
      <div class="panel-head">
        <div>
          <h2>{{ store.selectedStage?.name }}</h2>
          <p>{{ store.selectedStage?.start }} → {{ store.selectedStage?.end }} · 锚定 R{{ store.selectedStage?.baseRevision }}</p>
        </div>
        <a-tag :color="store.selectedStage?.reconfirmed ? 'green' : 'orange'">
          {{ store.selectedStage?.reconfirmed ? `R${store.selectedStage?.baseRevision} 已重确认` : (store.selectedStage?.legacyUnconfirmed ? '旧版未重确认' : '意见失效待重确认') }}
        </a-tag>
      </div>

      <a-alert v-if="store.selectedStage && !store.selectedStage.reconfirmed" type="warning" class="mb16">
        <template #title>该阶段未在当前修订上完成会签重确认</template>
        公开通告会将 {{ store.selectedStage.id }} 单列，不作为生效承诺。
      </a-alert>

      <h3>修订内容（提交后生成 R{{ store.scheme.revision + 1 }}）</h3>
      <a-form layout="vertical" :model="form">
        <a-form-item label="阶段名称（仅文字，不影响会签有效性）">
          <a-input v-model="form.name" />
        </a-form-item>
        <a-form-item label="围挡 / 车道方案">
          <a-input v-model="form.lanes" placeholder="如：夜间再收窄 1 车道" />
        </a-form-item>
        <div class="two">
          <a-form-item label="开始时间"><a-date-picker v-model="form.start" value-format="YYYY-MM-DD" style="width:100%" /></a-form-item>
          <a-form-item label="结束时间"><a-date-picker v-model="form.end" value-format="YYYY-MM-DD" style="width:100%" /></a-form-item>
        </div>
        <a-form-item label="封路几何">
          <a-space>
            <a-button size="small" :status="useDrawnRoute ? 'danger' : undefined" @click="useGeometry">
              {{ useDrawnRoute ? `重新绘制 · 已点 ${store.draftRoute.length} 点` : '在地图上重画围挡' }}
            </a-button>
            <span v-if="useDrawnRoute" class="hint">点击地图取点 ≥2，随修订一起提交</span>
          </a-space>
        </a-form-item>
        <a-form-item label="修订原因（写入修订记录与公开通告）">
          <a-textarea v-model="form.reason" :auto-size="{ minRows: 2, maxRows: 4 }" placeholder="如：燃气管线夜间作业需要再收窄一条车道" />
        </a-form-item>
      </a-form>

      <div class="impact-box" v-if="pendingChanges.length">
        <b>本次变更：{{ pendingChanges.join('、') }}</b>
        <p><a-tag color="red">失效重确认</a-tag> {{ affectedUnits.join('、') || '无' }}</p>
        <p><a-tag color="green">意见沿用</a-tag> {{ unaffectedUnits.join('、') }}</p>
      </div>

      <a-button type="primary" long :loading="store.writing" @click="commitRevision">提交道路修订</a-button>

      <a-divider />
      <h3>绕行修订（影响 交通、公交）</h3>
      <a-form layout="vertical" :model="form">
        <a-form-item label="绕行路线">
          <a-select v-model="form.detourId">
            <a-option v-for="d in store.scheme.detours" :key="d.id" :value="d.id">{{ d.id }} · {{ d.name }}（R{{ d.baseRevision }}）</a-option>
          </a-select>
        </a-form-item>
        <a-form-item label="路线名称"><a-input v-model="form.detourName" /></a-form-item>
        <div class="two">
          <a-form-item label="里程 km"><a-input-number v-model="form.detourDistance" :step="0.1" :min="0" style="width:100%" /></a-form-item>
          <a-form-item label="增加分钟"><a-input-number v-model="form.detourMinutes" :min="0" style="width:100%" /></a-form-item>
        </div>
      </a-form>
      <a-button long :loading="store.writing" @click="commitDetour">提交绕行修订（关联 {{ store.selectedStageId }}）</a-button>

      <a-divider />
      <h3>路段冲突</h3>
      <div v-for="item in store.conflicts.filter((conflict) => conflict.segmentId === store.selectedStageId)" :key="item.id" class="issue" :class="item.level === '高' ? 'red' : 'amber'">
        <b>{{ item.title }}</b><p>{{ item.detail }}</p>
      </div>
    </aside>
  </div>
</template>

<style scoped>
.toolbar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px;margin-bottom:14px}
.spacer{flex:1}
.dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-left:6px;font-style:normal}
.dot.ok{background:#00b42a}.dot.warn{background:#ff7d00}
.map-grid{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(360px,.72fr);gap:16px}
.map{height:min(68vh,680px);min-height:420px;border-radius:8px;overflow:hidden}
.inspector{height:fit-content;max-height:min(72vh,760px);overflow:auto}
.panel-head{display:flex;justify-content:space-between;gap:8px}
.panel-head h2{font-size:17px;margin:0 0 5px}
.panel-head p{color:#7a8798;font-size:12px;margin:0}
.two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.inspector h3{font-size:14px;margin:16px 0 10px}
.hint{color:#7a8798;font-size:12px}
.impact-box{border:1px dashed #f0a020;background:#fff7e8;border-radius:6px;padding:10px;margin-bottom:12px}
.impact-box b{font-size:13px}
.impact-box p{margin:7px 0 0;font-size:13px}
.issue{padding:10px;border-radius:6px;margin-bottom:8px}
.issue.red{background:#fff1f2}.issue.amber{background:#fff7ed}
.issue p{margin:4px 0 0;color:#64748b;font-size:13px}
@media(max-width:1050px){.map-grid{grid-template-columns:1fr}.map{height:55vh}}
</style>
