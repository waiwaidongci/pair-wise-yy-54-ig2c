<script setup lang="ts">
import { useRoute, useRouter } from 'vue-router'
import { useSchemeStore } from './store/scheme'

const route = useRoute()
const router = useRouter()
const store = useSchemeStore()
const nav = [
  { name: 'overview', label: '方案总览' },
  { name: 'map', label: '地图与修订' },
  { name: 'review', label: '多单位会签' },
]
</script>

<template>
  <a-layout class="shell">
    <a-layout-sider :width="224" class="sider">
      <div class="brand"><b>路</b><div><strong>封路协调台</strong><small>ROAD CONTROL</small></div></div>
      <a-menu :selected-keys="[route.name]" class="menu" @menu-item-click="(key: string) => router.push({ name: key })">
        <a-menu-item v-for="item in nav" :key="item.name">{{ item.label }}</a-menu-item>
      </a-menu>
      <div class="project-card">
        <span></span>
        <div>
          <b>{{ store.scheme.project }}</b>
          <small>道路修订 R{{ store.scheme.revision }} · 4 家单位会签</small>
          <small v-if="store.unconfirmedStages.length" class="warn">{{ store.unconfirmedStages.length }} 个阶段待重确认</small>
        </div>
      </div>
    </a-layout-sider>
    <a-layout>
      <a-layout-header class="topbar">
        <div><b>{{ store.scheme.id }}</b><span>{{ store.scheme.area }} · 2026 年第四季度施工计划 · 当前生效依据 R{{ store.scheme.revision }}</span></div>
        <div class="top-actions">
          <a-tag color="green">协同在线 11</a-tag>
          <a-button size="small" @click="store.resetToLegacyDemo()">载入旧数据(演示升级)</a-button>
          <a-button size="small" @click="store.loadDemoSeed()">载入 R2 演示数据</a-button>
          <a-button :disabled="!store.dirty" @click="store.undo">撤销修改</a-button>
        </div>
      </a-layout-header>
      <div v-if="store.failedOp" class="write-banner">
        <a-alert type="error" :show-icon="true">
          <template #title>
            <span>写入失败：操作号 {{ store.failedOp.opId }}（{{ store.failedOp.type }}，已尝试 {{ store.failedOp.attempts }} 次）—— {{ store.failedOp.error }}</span>
          </template>
          <template #default>
            <span>业务草案已在本地保留，审计记录未重复追加。请按原操作号重试；重试成功后处理记录只更新尝试次数。</span>
            <a-button size="small" type="primary" class="retry-btn" :loading="store.writing" @click="store.retryFailed()">按原操作号重试</a-button>
            <a-button size="small" class="retry-btn" @click="store.armFailures(1)">模拟下次仍失败</a-button>
          </template>
        </a-alert>
      </div>
      <a-layout-content class="main">
        <div v-if="store.migrated" class="mb16">
          <a-alert type="warning" show-icon>
            <template #title>旧数据已升级到初始版本 R1</template>
            原数据缺少道路修订号，全部施工阶段已锚定 R1；{{ store.unconfirmedStages.length }} 个未重确认阶段已单列，公开通告不会把它们作为生效承诺。
          </a-alert>
        </div>
        <router-view />
      </a-layout-content>
    </a-layout>
  </a-layout>
</template>

<style scoped>
.write-banner{padding:10px 22px 0;background:#eef2f6}
.write-banner .retry-btn{margin-left:10px}
.project-card .warn{color:#fbbf24!important}
</style>
