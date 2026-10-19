#!/usr/bin/env node
/**
 * 技能安装 CLI：把随包技能装到 / 更新到 / 从用户技能根移除。
 *
 * 插件加载时也会自动装（配置 `installSkill: true`，默认开），这个 CLI 用于：
 *  - 不重启 DSH 就想刷新技能（`install`）；
 *  - 排查「为什么技能没出现」（`status`）；
 *  - 卸载时清干净（`uninstall`）。
 *
 * 只会碰 `<dshHome>/skills/computer-use`，且只会删除带本插件标记的文件。
 *
 * 用法：
 *   node tools/install-skill.mjs status
 *   node tools/install-skill.mjs install
 *   node tools/install-skill.mjs uninstall
 */
import { readFile, rm, stat } from 'node:fs/promises'
import { SKILL_MARKER, bundledSkillPath, ensureSkillInstalled, installedSkillPath, skillStatus } from '../src/skill.js'

const command = (process.argv[2] ?? 'status').toLowerCase()

const logger = {
  info: (message) => console.log(message),
  warn: (message) => console.warn(`warn: ${message}`),
  error: (message) => console.error(`error: ${message}`),
}

async function describeSource() {
  try {
    const path = new URL(bundledSkillPath())
    const info = await stat(path)
    return `${decodeURIComponent(path.pathname.replace(/^\//u, ''))} (${info.size} bytes)`
  } catch (error) {
    return `unavailable: ${error instanceof Error ? error.message : String(error)}`
  }
}

async function main() {
  const target = await installedSkillPath()

  if (command === 'status') {
    const status = await skillStatus()
    console.log(`dsh home      : ${process.env.DSH_HOME ?? '(default ~/.dsh)'}`)
    console.log(`skill target  : ${target}`)
    console.log(`bundled skill : ${await describeSource()}`)
    console.log(`status        : ${status.status}`)
    if (status.status === 'foreign') {
      console.log('note          : that file exists but was not written by this plugin; it will never be overwritten.')
    }
    if (status.status === 'stale') console.log('note          : installed copy differs from the bundled one; run `install` to refresh.')
    return
  }

  if (command === 'install') {
    const result = await ensureSkillInstalled(logger)
    console.log(`skill ${result.status}: ${result.path}`)
    console.log('The skill watcher picks this up without a DSH restart; new sessions see it in their skill catalog.')
    return
  }

  if (command === 'uninstall' || command === 'remove') {
    let text
    try {
      text = await readFile(target, 'utf8')
    } catch {
      console.log('nothing to remove: no installed skill file')
      return
    }
    if (!text.includes(SKILL_MARKER)) {
      console.log(`refusing to remove ${target}: it was not written by this plugin`)
      process.exitCode = 1
      return
    }
    await rm(target, { force: true })
    console.log(`removed ${target}`)
    return
  }

  console.error(`unknown command: ${command} (expected status | install | uninstall)`)
  process.exitCode = 2
}

await main()
