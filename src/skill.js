/**
 * 技能自安装。
 *
 * 为什么是「写一份到用户技能根」而不是让 patch 指向插件目录：
 * `dsh-skill-filesystem` 的自定义根（`customSkillDirs`）需要**绝对路径**，
 * 而本插件的安装路径每台机器都不同；把绝对路径写进随包提交的 cordis.patch.yml
 * 会让 patch 在别人机器上指向不存在的目录。
 * 用户技能根 `<dshHome>/skills` 是官方扫描根（rank 400），且被 watcher 监视，
 * 新增技能**无需重启**即可进入下一次会话目录。
 *
 * 只碰我们自己那一个目录，并且只覆盖带本插件标记的文件：
 * 用户自己写过 `computer-use/SKILL.md` 时保留用户版本并给出提示。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { readFile as readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { dshHome } from './config.js'

/** 写进技能正文末尾的所有权标记（放末尾以免破坏 YAML frontmatter）。 */
export const SKILL_MARKER = '<!-- generated-by: dsh-computer-use -->'

/** 插件自带的技能源文件。 */
export function bundledSkillPath() {
  return new URL('../skills/computer-use/SKILL.md', import.meta.url)
}

/** 供调用方直接拿到磁盘路径（不是 URL）。 */
export function bundledSkillFilePath() {
  return decodeURIComponent(bundledSkillPath().pathname.replace(/^\//u, ''))
}

/** 用户技能根下的安装目标。 */
export async function installedSkillPath() {
  return join(await dshHome(), 'skills', 'computer-use', 'SKILL.md')
}

async function readBundledSkill() {
  const text = await readFile(bundledSkillPath(), 'utf8')
  return `${text.replace(/\s*$/u, '')}\n\n${SKILL_MARKER}\n`
}

/**
 * 确保技能已安装在用户技能根。
 * @returns `{ status, path }`，status ∈ installed | updated | kept-user-file | failed
 */
export async function ensureSkillInstalled(log) {
  const target = await installedSkillPath()
  let desired
  try {
    desired = await readBundledSkill()
  } catch (error) {
    log?.warn?.(`computer-use skill source is missing: ${error instanceof Error ? error.message : String(error)}`)
    return { status: 'failed', path: target }
  }
  try {
    const existing = await readFile(target, 'utf8')
    if (!existing.includes(SKILL_MARKER)) {
      log?.warn?.(
        `computer-use skill already exists at ${target} but was not written by this plugin; leaving it untouched`,
      )
      return { status: 'kept-user-file', path: target }
    }
    if (existing === desired) return { status: 'installed', path: target }
    await writeFile(target, desired, 'utf8')
    return { status: 'updated', path: target }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log?.warn?.(`cannot read existing computer-use skill: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  try {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, desired, 'utf8')
    return { status: 'installed', path: target }
  } catch (error) {
    log?.warn?.(`cannot install computer-use skill: ${error instanceof Error ? error.message : String(error)}`)
    return { status: 'failed', path: target }
  }
}

/** 同步读取（供探针/CLI 在不关心顺序时使用）。 */
export function readBundledSkillSync() {
  return readFileSync(bundledSkillPath(), 'utf8')
}

/** 当前安装状态：missing | current | stale | foreign。 */
export async function skillStatus() {
  const target = await installedSkillPath()
  let desired
  try {
    desired = await readBundledSkill()
  } catch {
    return { status: 'source-missing', path: target }
  }
  try {
    const existing = await readFile(target, 'utf8')
    if (!existing.includes(SKILL_MARKER)) return { status: 'foreign', path: target }
    return { status: existing === desired ? 'current' : 'stale', path: target }
  } catch {
    return { status: 'missing', path: target }
  }
}
