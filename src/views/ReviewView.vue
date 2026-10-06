<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { Message } from '@arco-design/web-vue'
import { useSchemeStore } from '../store/scheme'
import type { SignUnit } from '../types'

const store = useSchemeStore()

/* ---------------- 会签提交 ---------------- */
const sign = reactive<{ unit: SignUnit; author: string; content: string; condition: string }>({
  unit: '应急', author: '', content: '', condition: '',
})
const signResult = ref<{ outcome: '占用' | '留场'; detail: string } | null>(null)

async function submitSignoff() {
  if (!sign.author.trim() || !sign.content.trim()) {
    Message.warning('请填写会签人和现场意见')
    return
  }
  const stageId = store.selectedStageId
  const result = await store.submitSignoff({
    stageId, unit: sign.unit, author: sign.author.trim(),
    content: sign.content.trim(), condition: sign.condition.trim() || undefined,
  })
  if (result.ok) {
    const outcome = result.outcome ?? '占用'
    if (outcome === '占用') {
      signResult.value = { outcome: '占用', detail: `${sign.unit}·${sign.author} 先到，已占用 ${stageId}（R${store.scheme.revision}）会签锁。` }
      Message.success('先到者占用成功')
    } else {
      signResult.value = { outcome: '留场', detail: `${sign.unit}·${sign.author} 后到：先到意见保持不变，现场文字与差异已留痕。` }
      Message.info('后到提交已留现场文字和差异，未覆盖先到意见')
    }
    sign.content = ''
    sign.condition = ''
  } else {
    Message.error(`写入失败：${result.error}，请用顶部横幅按原操作号重试`)
  }
}

/* ---------------- 意见处理 / 重确认 ---------------- */
async function resolve(id: string, status: '已接受' | '已退回') {
  const result = await store.resolveComment(id, status)
  if (!result.ok) Message.error(`写入失败：${result.error}，请按原操作号重试`)
  else Message.success(`意见已处理为「${status}」`)
}

const reconfirm = reactive({ author: '', content: '', condition: '' })
async function reconfirmComment(id: string) {
  const comment = store.scheme.comments.find((c) => c.id === id)
  if (!comment) return
  if (!reconfirm.author.trim() || !reconfirm.content.trim()) {
    Message.warning('请填写重确认人和确认意见')
    return
  }
  const result = await store.reconfirmComment(id, {
    unit: comment.unit, author: reconfirm.author.trim(),
    content: reconfirm.content.trim(), condition: reconfirm.condition.trim() || undefined,
  })
  if (result.ok) {
    Message.success('已在当前修订上重确认，原意见保留')
    reconfirm.author = ''
    reconfirm.content = ''
    reconfirm.condition = ''
  } else {
    Message.error(`写入失败：${result.error}，请按原操作号重试`)
  }
}

/* ---------------- 展示派生 ---------------- */
const sortedComments = computed(() => [...store.scheme.comments].sort((a, b) => {
  const rank = { 有效: 0, 失效待重确认: 1, 已重确认: 2 } as const
  return rank[a.validity] - rank[b.validity]
}))
const pendingCount = computed(() => store.scheme.comments.filter((c) => c.status === '待处理' && c.validity === '有效').length)
const invalidCount = computed(() => store.invalidComments.length)
const expandedAudit = ref(false)

function validityColor(validity: string) {
  return validity === '有效' ? 'green' : validity === '失效待重确认' ? 'red' : 'gray'
}
function statusColor(status: string) {
  return status === '已接受' ? 'green' : status === '已退回' ? 'red' : 'orange'
}

function exportNotice() {
  store.exportNotice()
  Message.success('公开通告包已导出，通告内写明依据的道路修订号')
}
</script>

<template>
  <section class="page-head compact">
    <div>
      <p class="eyebrow">条件会签与修订批复</p>
      <h1>会签意见 · 先到占用 · 重确认</h1>
      <p>意见与施工阶段绑定同一条道路修订；修订后仅受影响单位失效重确认。导出的公开通告明确依据 R{{ store.scheme.revision }}。</p>
    </div>
    <a-space>
      <a-button status="danger" size="small" @click="store.armFailures(1)">模拟下一次写入失败</a-button>
      <a-button type="primary" @click="exportNotice">导出公开通告包（R{{ store.scheme.revision }}）</a-button>
    </a-space>
  </section>

  <div class="review-grid">
    <article class="card">
      <div class="panel-head">
        <div>
          <h2>会签意见</h2>
          <p>原意见不覆盖；失效意见保留并等待当前修订重确认</p>
        </div>
        <a-space>
          <a-tag color="orange">{{ pendingCount }} 待处理</a-tag>
          <a-tag color="red">{{ invalidCount }} 失效待重确认</a-tag>
        </a-space>
      </div>
      <button
        v-for="comment in sortedComments"
        :key="comment.id"
        class="comment"
        :class="{ active: store.selectedCommentId === comment.id, stale: comment.validity !== '有效' }"
        @click="store.selectedCommentId = comment.id"
      >
        <div class="comment-head">
          <span>{{ comment.unit }}</span><b>{{ comment.author }}</b>
          <a-tag :color="validityColor(comment.validity)">{{ comment.validity }}</a-tag>
          <a-tag :color="statusColor(comment.status)">{{ comment.status }}</a-tag>
        </div>
        <p>{{ comment.content }}</p>
        <small v-if="comment.condition">条件：{{ comment.condition }}</small>
        <em>{{ comment.segmentId }} · 锚定 R{{ comment.baseRevision }}
          <template v-if="comment.invalidatedBy"> · 被 R{{ comment.invalidatedBy.revision }}「{{ comment.invalidatedBy.change }}」变更失效</template>
          <template v-else-if="comment.fromLegacy"> · 旧数据升级，需在 R1 重确认</template>
        </em>
      </button>
    </article>

    <div class="right">
      <!-- 同阶段并发会签：先到占用 / 后到留场 -->
      <article class="card">
        <div class="panel-head">
          <div><h2>阶段会签提交</h2><p>当前阶段：{{ store.selectedStageId }}（锚定 R{{ store.selectedStage?.baseRevision }}）</p></div>
          <a-tag :color="store.selectedStage?.lock ? 'red' : 'green'">{{ store.selectedStage?.lock ? `先到者：${store.selectedStage.lock.unit}·${store.selectedStage.lock.author}` : '会签锁空闲' }}</a-tag>
        </div>
        <div v-if="store.selectedStage?.lock" class="winner-box">
          <b>先到占用意见</b>
          <p>{{ store.selectedStage.lock.unit }} · {{ store.selectedStage.lock.author }} · {{ store.selectedStage.lock.at }}</p>
          <p>{{ store.selectedStage.lock.content }}</p>
          <small v-if="store.selectedStage.lock.condition">条件：{{ store.selectedStage.lock.condition }}</small>
        </div>
        <div v-for="rival in store.selectedStage?.rivals ?? []" :key="rival.opId" class="rival-box">
          <b>后到现场文字（未覆盖先到意见）</b>
          <p>{{ rival.unit }} · {{ rival.author }} · {{ rival.at }}</p>
          <p>{{ rival.content }}</p>
          <small v-if="rival.condition">条件：{{ rival.condition }}</small>
          <div class="diff-line" v-for="(d, i) in rival.diffs" :key="i">
            <a-tag color="purple">差异 · {{ d.field }}</a-tag>
            <div class="diff-pair"><label>先到</label><span>{{ d.winner }}</span><label>后到</label><span>{{ d.rival }}</span></div>
          </div>
        </div>
        <a-form layout="vertical" :model="sign" class="mt10">
          <div class="two">
            <a-form-item label="会签单位">
              <a-select v-model="sign.unit">
                <a-option v-for="u in ['建设','交通','公交','应急']" :key="u" :value="u">{{ u }}</a-option>
              </a-select>
            </a-form-item>
            <a-form-item label="会签人"><a-input v-model="sign.author" placeholder="姓名" /></a-form-item>
          </div>
          <a-form-item label="现场意见"><a-textarea v-model="sign.content" :auto-size="{ minRows: 2, maxRows: 3 }" /></a-form-item>
          <a-form-item label="附加条件（可选）"><a-input v-model="sign.condition" /></a-form-item>
        </a-form>
        <a-button type="primary" long :loading="store.writing" @click="submitSignoff">提交会签（同人同时提交，先到占用）</a-button>
        <p v-if="signResult" class="sign-result" :class="signResult.outcome === '占用' ? 'ok' : 'warn'">{{ signResult.detail }}</p>
      </article>

      <!-- 选中意见的处理 -->
      <article class="card" v-if="store.selectedComment">
        <div class="panel-head">
          <div><h2>意见处理与重确认</h2><p>{{ store.selectedComment.id }} · {{ store.selectedComment.unit }} · {{ store.selectedComment.author }}</p></div>
        </div>
        <div class="condition">
          <b>影响解释</b><p>{{ store.selectedComment.content }}</p>
          <b>要求条件</b><p>{{ store.selectedComment.condition || '无附加条件' }}</p>
        </div>

        <template v-if="store.selectedComment.validity === '有效'">
          <a-space>
            <a-button status="danger" :disabled="store.selectedComment.status !== '待处理' || store.writing" @click="resolve(store.selectedComment!.id, '已退回')">退回方案</a-button>
            <a-button type="primary" :disabled="store.selectedComment.status !== '待处理' || store.writing" @click="resolve(store.selectedComment!.id, '已接受')">接受条件</a-button>
          </a-space>
        </template>

        <template v-else-if="store.selectedComment.validity === '失效待重确认'">
          <a-alert type="error" class="mb16">
            <template #title>该意见锚定 R{{ store.selectedComment.baseRevision }}，已因道路修订失效</template>
            请在当前阶段修订 R{{ store.selectedStage?.baseRevision }} 上重新确认；原意见保留不覆盖。
          </a-alert>
          <a-form layout="vertical" :model="reconfirm">
            <a-form-item :label="`${store.selectedComment.unit} 重确认人`"><a-input v-model="reconfirm.author" placeholder="姓名" /></a-form-item>
            <a-form-item label="重确认意见"><a-textarea v-model="reconfirm.content" :auto-size="{ minRows: 2, maxRows: 3 }" /></a-form-item>
            <a-form-item label="附加条件（可选）"><a-input v-model="reconfirm.condition" /></a-form-item>
          </a-form>
          <a-button type="primary" long :loading="store.writing" @click="reconfirmComment(store.selectedComment!.id)">在 R{{ store.selectedStage?.baseRevision }} 上重确认</a-button>
        </template>

        <p v-else class="stale-note">该意见已由同单位的新意见替代（已重确认），原记录保留备查。</p>
      </article>

      <!-- 未重确认阶段单列（规则 6 + 修订失效） -->
      <article class="card">
        <div class="panel-head"><div><h2>未重确认阶段单列</h2><p>公开通告中不作为生效承诺</p></div><a-tag color="red">{{ store.unconfirmedStages.length }}</a-tag></div>
        <div v-if="!store.unconfirmedStages.length" class="empty">全部阶段已在当前道路修订上完成重确认。</div>
        <div v-for="stage in store.unconfirmedStages" :key="stage.id" class="unstage">
          <div><b>{{ stage.id }} · {{ stage.name }}</b><small>锚定 R{{ stage.baseRevision }}</small></div>
          <a-tag :color="stage.legacyUnconfirmed ? 'orangered' : 'red'">{{ stage.legacyUnconfirmed ? '旧版升级待重确认' : '修订失效待重确认' }}</a-tag>
        </div>
      </article>

      <!-- 道路修订链 + 审计 -->
      <article class="card">
        <div class="panel-head">
          <div><h2>道路修订链</h2><p>施工阶段、会签意见、公开通告共同的依据</p></div>
          <a-button size="mini" type="text" @click="expandedAudit = !expandedAudit">{{ expandedAudit ? '收起处理记录' : `处理记录 ${store.scheme.audit.length} 条` }}</a-button>
        </div>
        <div class="version-list">
          <div v-for="rev in store.scheme.revisions" :key="rev.revision" :class="{ selected: rev.revision === store.scheme.revision, migrated: rev.migratedFromLegacy }">
            <b>R{{ rev.revision }} · {{ rev.author }}<a-tag v-if="rev.migratedFromLegacy" size="small" color="orangered" class="ml6">旧数据升级</a-tag></b>
            <small>{{ rev.at }} · 阶段 {{ rev.stageIds.join('、') || '—' }}<template v-if="rev.detourIds.length"> · 绕行 {{ rev.detourIds.join('、') }}</template></small>
            <p>{{ rev.summary }}</p>
            <small class="reason">原因：{{ rev.reason }}</small>
          </div>
        </div>
        <div v-if="expandedAudit" class="audit">
          <a-divider style="margin:8px 0" />
          <h3>处理记录（同一操作号失败重试不重复追加）</h3>
          <div v-for="item in store.scheme.audit" :key="item.opId" class="audit-row">
            <a-tag :color="item.result === '成功' ? 'green' : 'red'">{{ item.result }}</a-tag>
            <span class="opid">{{ item.opId }}</span>
            <small>{{ item.type }} · 尝试 {{ item.attempts }} 次 · {{ item.at }}</small>
            <p>{{ item.detail }}</p>
          </div>
        </div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.review-grid{display:grid;grid-template-columns:1fr 1.2fr;gap:16px}
.right{display:grid;gap:16px;height:fit-content}
.panel-head{display:flex;justify-content:space-between;gap:10px;margin-bottom:12px}
.panel-head h2{font-size:17px;margin:0 0 4px}.panel-head p{color:#7a8798;font-size:12px;margin:0}
.comment{display:block;width:100%;text-align:left;border:1px solid #e7ebf1;background:#fff;border-radius:7px;padding:13px;margin-bottom:9px;color:inherit;cursor:pointer}
.comment:hover,.comment.active{border-color:#2563eb;background:#f5f8ff}
.comment.stale{opacity:.82;background:#fafafa}
.comment-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.comment-head>span{display:grid;place-items:center;min-width:36px;height:36px;padding:0 6px;border-radius:6px;background:#eef2f7;font-weight:800}
.comment-head b{flex:1}
.comment p{margin:9px 0 5px;color:#475569}
.comment small,.comment em{display:block;color:#7a8798}
.comment em{margin-top:6px;font-style:normal;font-size:12px}
.two{display:grid;grid-template-columns:1fr 1fr;gap:8px}
.mt10{margin-top:10px}
.sign-result{margin:9px 0 0;font-size:13px}
.sign-result.ok{color:#00834a}.sign-result.warn{color:#d25f00}
.winner-box{border-left:3px solid #00b42a;background:#f0fff5;border-radius:6px;padding:10px;margin-bottom:10px}
.winner-box p{margin:5px 0;color:#334155;font-size:13px}.winner-box small{color:#00834a}
.rival-box{border-left:3px solid #7c3aed;background:#f8f5ff;border-radius:6px;padding:10px;margin-bottom:10px}
.rival-box p{margin:5px 0;color:#334155;font-size:13px}.rival-box small{color:#6d28d9}
.diff-line{margin-top:8px;border-top:1px dashed #ddd6fe;padding-top:8px}
.diff-pair{display:grid;grid-template-columns:auto 1fr;gap:2px 8px;margin-top:5px;font-size:12px}
.diff-pair label{color:#7a8798}.diff-pair span{color:#334155}
.condition p{color:#475569}
.stale-note{color:#7a8798;font-size:13px}
.unstage{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:9px;border-bottom:1px solid #edf0f5}
.unstage b,.unstage small{display:block}.unstage small{color:#7a8798;margin-top:3px}
.empty{color:#7a8798;font-size:13px;padding:6px 0}
.version-list>div{padding:11px;border:1px solid #edf0f5;border-radius:6px;margin-bottom:7px}
.version-list>div.selected{border-color:#2563eb;background:#f5f8ff}
.version-list>div.migrated{border-style:dashed}
.version-list b,.version-list small{display:block}
.version-list small{color:#7a8798;margin-top:3px}
.version-list p{margin:7px 0 0;color:#475569;font-size:13px}
.version-list .reason{color:#94a3b8}
.ml6{margin-left:6px}
.audit h3{font-size:14px;margin:0 0 8px}
.audit-row{padding:8px 0;border-bottom:1px dashed #edf0f5}
.audit-row .opid{font-family:monospace;font-size:11px;color:#2563eb;margin:0 8px}
.audit-row small{color:#7a8798}
.audit-row p{margin:5px 0 0;font-size:13px;color:#475569}
@media(max-width:980px){.review-grid{grid-template-columns:1fr}}
</style>
