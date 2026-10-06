/**
 * 自检入口：用 esbuild（vite 自带依赖）打包 scripts/*.ts 后在 node 运行，
 * 无需额外测试框架。
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'

const targets = ['scripts/selftest.ts', 'scripts/selftest-store.ts']
for (const entry of targets) {
  const outfile = `node_modules/.test-${entry.replace(/[\\/]/g, '-')}.cjs`
  await build({ entryPoints: [entry], bundle: true, platform: 'node', format: 'cjs', outfile, logLevel: 'silent' })
  try {
    execFileSync(process.execPath, [outfile], { stdio: 'inherit' })
  } finally {
    rmSync(outfile, { force: true })
  }
}
