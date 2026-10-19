#!/usr/bin/env node
/**
 * 极简 asar 读取器（无 npm 依赖）：DSH 桌面端的 app.asar 就是普通文件，
 * 头 16 字节是 pickle 头，随后是 JSON 目录，再往后是对齐的文件数据。
 *
 * CLI：
 *   node tools/asar.mjs list    <asar> [过滤子串] [--depth=N] [--all]
 *   node tools/asar.mjs read    <asar> <内部路径>
 *   node tools/asar.mjs extract <asar> <内部前缀> <输出目录> [过滤子串]
 *
 * 也可作为模块用：`import { readAsarEntry, listAsarEntries } from './asar.mjs'`
 * （tools/doctor.mjs 就是这么读 DSH 的 API 目录做契约核对的）。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 解析 asar 目录，返回 `{ header, dataStart, buffer }`。 */
export function openAsar(file) {
  const buffer = readFileSync(file)
  const jsonSize = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + jsonSize).toString('utf8'))
  return { header, dataStart: 16 + jsonSize, buffer }
}

/** 拍平目录树 → `[{ path, size, offset, unpacked }]`。 */
export function listAsarEntries(file, filter = '', maxDepth) {
  const { header, dataStart, buffer } = openAsar(file)
  const out = []
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const path = prefix ? `${prefix}/${name}` : name
      if (entry.files) walk(entry, path)
      else out.push({ path, size: entry.size ?? 0, offset: entry.offset, unpacked: entry.unpacked === true })
    }
  }
  walk(header, '')
  return out.filter((entry) => (filter === '' || entry.path.includes(filter)) && (maxDepth === undefined || entry.path.split('/').length <= maxDepth)).map((entry) => ({ ...entry, asar: file, dataStart, buffer }))
}

/** 读一个 asar 内部文件为 UTF-8 文本；不存在时抛错。 */
export function readAsarEntry(file, internalPath) {
  const normalized = internalPath.replace(/\\/gu, '/').replace(/^\//u, '')
  const entry = listAsarEntries(file).find((item) => item.path === normalized)
  if (entry === undefined) throw new Error(`asar entry not found: ${normalized}`)
  if (entry.unpacked) throw new Error(`asar entry is unpacked (read it from app.asar.unpacked): ${normalized}`)
  const { buffer, dataStart } = entry
  return buffer.subarray(dataStart + Number(entry.offset), dataStart + Number(entry.offset) + entry.size).toString('utf8')
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

async function main() {
  const [cmd, file, ...rest] = process.argv.slice(2)
  if (!cmd || !file) {
    console.error('usage: asar.mjs <list|read|extract> <asar> [args]')
    process.exit(2)
  }
  if (cmd === 'list') {
    const depthArg = rest.find((arg) => arg.startsWith('--depth='))
    const filter = rest.find((arg) => !arg.startsWith('--')) ?? ''
    const entries = listAsarEntries(file, filter, depthArg ? Number(depthArg.slice(8)) : undefined)
    if (rest.includes('--all')) {
      for (const entry of entries) console.log(`${String(entry.size).padStart(9)}  ${entry.path}`)
    } else {
      const dirs = new Set()
      for (const entry of entries) {
        const parts = entry.path.split('/')
        for (let i = 1; i <= parts.length - 1; i++) dirs.add(parts.slice(0, i).join('/'))
      }
      for (const dir of [...dirs].sort()) console.log(dir)
    }
    console.error(`[${entries.length} files]`)
    return
  }
  if (cmd === 'read') {
    process.stdout.write(readAsarEntry(file, rest[0]))
    return
  }
  if (cmd === 'extract') {
    const prefix = rest[0].replace(/\\/gu, '/').replace(/\/$/u, '')
    const outDir = rest[1]
    const filter = rest[2] ?? ''
    const entries = listAsarEntries(file).filter((entry) => entry.path.startsWith(`${prefix}/`) && !entry.unpacked && (filter === '' || entry.path.includes(filter)))
    let bytes = 0
    for (const entry of entries) {
      const dest = join(outDir, entry.path.slice(prefix.length + 1))
      mkdirSync(dirname(dest), { recursive: true })
      writeFileSync(dest, entry.buffer.subarray(entry.dataStart + Number(entry.offset), entry.dataStart + Number(entry.offset) + entry.size))
      bytes += entry.size
    }
    console.error(`extracted ${entries.length} files (${(bytes / 1048576).toFixed(1)} MiB) from ${prefix} -> ${outDir}`)
    return
  }
  console.error(`unknown command: ${cmd}`)
  process.exit(2)
}

if (import.meta.main) await main()
