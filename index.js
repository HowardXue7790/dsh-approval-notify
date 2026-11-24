// approval-notify — 审批请求直接弹 Windows 通知（带「允许/拒绝」按钮，正文用模型翻成大白话）
// 设计要点：
// - prepend 监听 `approval/request`；弹通知时**不调用 next()**，所以网页里不会留下僵尸卡片。
// - 窗口在前台（用户正看着 DSH）时不弹通知，直接 next() 走原来的网页卡片。
// - 按钮点击 → 自定义 URI 协议（HKCU，仅当前用户）→ wscript 转发到本插件的回环 HTTP → 拿到结果。
// - 无人应答超时 / 非 Windows / 任何一步失败 → 一律 next()，退回原来那条链路。
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCHEME = 'dsh-approval-notify'
const KEY = `HKCU\\Software\\Classes\\${SCHEME}`
// 通知归属靠 toast 里的 `placement="attribution"` 文本（Windows 会把它显示在原本写应用名的位置），
// 不能直接借用 Electron 的 `electron.app.<exe 名>` AUMID：未打包进程没有 package identity，
// CreateToastNotifier 会报 0x80073D54。所以 AUMID 还是用 PowerShell 这个已注册的。
const APP_NAME = path.basename(process.execPath).replace(/\.exe$/i, '')
const AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
const PS = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
// 通知归属：只有自建 AUMID 才会在通知顶部显示 DSH 而不是 Windows PowerShell，
// 而未打包进程要靠开始菜单快捷方式携带 System.AppUserModel.ID 才能注册 AUMID。
const TOAST_AUMID = 'Dsh.ApprovalNotify'
const SHORTCUT = path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'DSH 审批通知.lnk')
const LOG = path.join(os.tmpdir(), 'dsh-approval-notify.log')

export const name = 'approval-notify'
export const inject = []

// 配置项（设置页可改，改完立即生效、不重启插件）：
// 只声明 schema 还不行，字段必须标 `.volatile()` —— dsh-settings 只把 volatile 字段投影成表单。
// schemastery 不从本包解析（本包是 link 到 workspace 的，解析不到 profile 的依赖），
// 所以按 profile → 安装目录 → 裸包名依次找。
export const Config = await makeConfig()

async function loadSchema() {
  const bases = [process.env.DSH_PROFILE_DIR, process.env.DSH_INSTALL_DIR].filter(Boolean)
  for (const base of bases) {
    try {
      const resolved = createRequire(path.join(base, 'package.json')).resolve('@deepseek-ai/schemastery')
      const module = await import(pathToFileURL(resolved).href)
      const Schema = module.Schema ?? module.default
      if (typeof Schema?.object === 'function') return Schema
    } catch {}
  }
  try {
    const module = await import('@deepseek-ai/schemastery')
    const Schema = module.Schema ?? module.default
    if (typeof Schema?.object === 'function') return Schema
  } catch {}
  return null
}

async function makeConfig() {
  const Schema = await loadSchema()
  if (!Schema) return undefined
  return Schema.object({
    locale: Schema.string().default('zh').volatile(),
    waitMs: Schema.number().default(300000).volatile(),
    focusCheck: Schema.boolean().default(true).volatile(),
    // 翻译用的模型：两个都留空就跟随会话的默认模型；只填一个就换掉那一半。
    modelProvider: Schema.string().default('').volatile(),
    model: Schema.string().default('').volatile(),
    // 推理等级：留空用模型自己的默认等级。
    reasoningEffort: Schema.string().default('').volatile(),
    // 自定义系统提示词；留空按通知语言用内置的那段。
    prompt: Schema.string().default('').volatile(),
  })
}

/** volatile 字段在运行时是 `{ get() }` 引用，每次读都要解包，才能拿到刚保存的值。 */
function readCfg(config, key, fallback) {
  const node = config?.[key]
  const value = node && typeof node.get === 'function' ? node.get() : node
  return value === undefined || value === null ? fallback : value
}

export function apply(ctx, config = {}) {
  if (process.platform !== 'win32') return
  const log = (...parts) => {
    try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${parts.join(' ')}\n`) } catch {}
  }
  const settings = () => ({
    locale: String(readCfg(config, 'locale', 'zh')) === 'en' ? 'en' : 'zh',
    waitMs: Number(readCfg(config, 'waitMs', 300_000)) || 300_000,
    // 关掉之后即使正看着 DSH 窗口也只弹通知（默认：前台时用网页卡片，不打扰）。
    focusCheck: readCfg(config, 'focusCheck', true) !== false,
    modelProvider: String(readCfg(config, 'modelProvider', '')).trim(),
    model: String(readCfg(config, 'model', '')).trim(),
    reasoningEffort: String(readCfg(config, 'reasoningEffort', '')).trim(),
    prompt: String(readCfg(config, 'prompt', '')),
  })
  log('apply', `config=${JSON.stringify(settings())} schema=${Boolean(Config)} appid=${AUMID}`)

  const tickets = new Map()
  let port
  const server = http.createServer((req, res) => {
    const answer = settleFromUrl(req.url, tickets, log)
    if (!answer) { res.writeHead(400).end(); return }
    if (answer.hit) focusWindow(log)
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><meta charset="utf-8"><title>DSH</title><body style="font:16px system-ui;padding:2em">`
      + (answer.focus ? '已打开 DSH，请在弹出的卡片上决定。'
        : !answer.hit ? '这条授权已经失效了。'
          : answer.outcome === 'rejected' ? '已拒绝这次操作。可以关掉这个页面。' : '已允许这次操作。可以关掉这个页面。')
      + '</body>')
  })

  ctx.effect(() => {
    registerProtocol(log)
    ensureShortcut(log)
    server.on('error', error => log('server-error', String(error?.message ?? error)))
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port
      log('listening', String(port))
      try {
        fs.writeFileSync(path.join(os.tmpdir(), 'dsh-approval-notify.json'), JSON.stringify({ port, pid: process.pid }), 'utf8')
      } catch {}
    })
    return () => {
      try { server.close() } catch {}
      try { spawnSync('reg', ['delete', KEY, '/f'], { windowsHide: true }) } catch {}
      // 那个开始菜单快捷方式（只为给通知一个 DSH 归属名），一起收走。
      try { fs.unlinkSync(SHORTCUT) } catch {}
    }
  }, 'approval-notify: loopback callback + URI protocol')

  ctx.on('approval/request', async (request, next) => {
    if (!port) return next()
    const { locale, waitMs, focusCheck, modelProvider, model, reasoningEffort, prompt } = settings()
    const token = randomUUID().toLowerCase()
    let decision
    try {
      const body = await explain(ctx, request, locale, log, { provider: modelProvider, model, reasoningEffort, prompt })
      // 卡片上也显示白话：内置审批卡片优先渲染 displayReason，原文留在 reason（浏览器半体当小字）。
      const raw = request.displayReason?.[locale] ?? request.displayReason?.en ?? request.reason
      if (body && body !== raw) {
        try {
          request.displayReason = { ...(request.displayReason || {}), en: body, [locale]: body }
        } catch {}
      }
      const uri = vote => `${SCHEME}://127.0.0.1:${port}/a?v=${vote}&t=${token}`
      const shown = await showToast({
        title: locale === 'en' ? 'DSH needs your permission' : 'DSH 需要你授权',
        body,
        allow: uri('allow'),
        deny: uri('deny'),
        focusUri: uri('focus'),
        allowText: locale === 'en' ? 'Allow' : '允许本次',
        denyText: locale === 'en' ? 'Deny' : '拒绝',
        tag: token.slice(0, 8),
        focusExe: focusCheck ? focusName() : '',
      }, log)
      const [status, toastAppId] = String(shown).split(' ')
      if (status !== 'shown') return next()
      log('toast', request.toolName, body.replace(/\s+/g, ' ').slice(0, 80))
      const tag = token.slice(0, 8)
      const watcher = startFocusWatcher({ appId: toastAppId || AUMID, focusExe: focusCheck ? focusName() : '', tag, token, tickets, waitMs, log })
      decision = await waitAnswer(tickets, token, request.signal, waitMs)
      watcher?.stop()
    } catch (error) {
      log('request-failed', String(error?.message ?? error))
      return next()
    }
    return decision ?? next()
  }, true)
}

/** 把按钮点回来的 URL 结算到等待中的票；返回 null 表示 URL 本身不合法。 */
export function settleFromUrl(rawUrl, tickets, log) {
  let url
  try { url = new URL(rawUrl ?? '/', 'http://127.0.0.1') } catch { return null }
  const token = String(url.searchParams.get('t') ?? '').toLowerCase()
  const vote = url.searchParams.get('v')
  // 点通知正文：不算投票，只把 DSH 抬到前台，并把决定交回网页卡片（settle(null)）。
  if (vote === 'focus') {
    const open = tickets.get(token)
    log('callback', token.slice(0, 8), 'focus', open ? 'opened' : 'ignored')
    open?.settle(null)
    return { hit: true, focus: true, outcome: null }
  }
  const outcome = vote === 'allow' ? 'allowed-once' : vote === 'deny' ? 'rejected' : null
  const ticket = tickets.get(token)
  const hit = Boolean(ticket && outcome)
  log('callback', token.slice(0, 8), vote ?? '-', hit ? 'accepted' : 'ignored')
  if (hit) ticket.settle(outcome)
  return { hit, outcome }
}

/** 回环答案；超时返回 null（交给 next()），中止返回 'cancelled'。 */
export function waitAnswer(tickets, token, signal, waitMs) {
  return new Promise(resolve => {
    let done = false
    const finish = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      tickets.delete(token)
      signal?.removeEventListener?.('abort', onAbort)
      resolve(value)
    }
    const onAbort = () => finish('cancelled')
    const timer = setTimeout(() => finish(null), waitMs)
    tickets.set(token, { settle: finish })
    if (signal?.aborted) onAbort()
    else signal?.addEventListener?.('abort', onAbort, { once: true })
  })
}

/** 把审批请求翻成一句大白话；模型不可用/超时就退回原始文案。 */
async function explain(ctx, request, locale, log, cfg = {}) {
  const raw = request.displayReason?.[locale] ?? request.displayReason?.en ?? request.reason ?? request.toolName
  try {
    const route = resolveRoute(ctx, cfg.provider, cfg.model)
    if (!route) return raw
    log('model', `${route.provider}/${route.model}`, cfg.reasoningEffort || '-')
    const system = pickSystem(locale, cfg.prompt)
    const input = `工具: ${request.toolName}\n原始说明: ${raw}`
    let text = ''
    const stream = ctx.reflect.get('llm', false).stream({
      provider: route.provider,
      model: route.model,
      ...(cfg.reasoningEffort ? { reasoningEffort: cfg.reasoningEffort } : {}),
      system,
      messages: [{ role: 'user', content: [{ type: 'text', text: input }] }],
      maxTokens: 2000,
      signal: AbortSignal.timeout(12000),
    })
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish') {
        log('finish', chunk.reason.kind, `${text.length}ch`)
        if (chunk.reason.kind !== 'stop' && chunk.reason.kind !== 'max-tokens') break
      }
    }
    const clean = text.replace(/\s+/g, ' ').trim().replace(/^["'「]|["'」]$/g, '').slice(0, 100)
    log('translated', clean.slice(0, 40))
    return clean || raw
  } catch (error) {
    log('translate-failed', String(error?.message ?? error))
    return raw
  }
}

const SYSTEM_ZH = '你在为桌面授权通知写一行正文。只回一句不超过 40 个汉字的中文大白话，说明这个操作会动到用户的哪些文件或电脑上的什么，不要 markdown、不要引号、不要工具名。'
const SYSTEM_EN = 'You write the one-line body of a desktop permission notification. Reply with ONE short English sentence, at most 20 words, everyday words, no markdown, no quotes, no tool names. Say what the action does to the user\'s files or computer.'

/** 自定义提示词优先；留空按通知语言用内置那段。 */
export function pickSystem(locale, prompt) {
  const custom = String(prompt ?? '').trim()
  if (custom) return custom
  return locale === 'en' ? SYSTEM_EN : SYSTEM_ZH
}

export function resolveRoute(ctx, provider, model) {
  try {
    const selection = ctx.reflect.get('agentDefaultModel', false)?.currentSelection?.() || null
    const wantProvider = String(provider ?? '').trim()
    const wantModel = String(model ?? '').trim()
    if (wantProvider || wantModel) {
      const route = { provider: wantProvider || selection?.provider, model: wantModel || selection?.model }
      if (route.provider && route.model) return route
    }
    if (selection?.provider && selection?.model) return selection
  } catch {}
  return null
}

function focusName() {
  return path.parse(process.execPath).name
}

/**
 * 点了通知上的按钮就把 DSH 抬到前台——否则用户点完还得自己找窗口。
 * 不能靠「再启动一次自己」：点击时拿到前台权限的是 wscript，DSH 没有，
 * SetForegroundWindow 会被 Windows 的前台锁挡掉；focus.ps1 里改用
 * SwitchToThisWindow（任务栏切换那条路）绕过去。
 */
function focusWindow(log) {
  try {
    if (process.platform !== 'win32' || !process.versions.electron) return
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(HERE, 'focus.ps1'), '-ProcessName', focusName()], { windowsHide: true })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.on('error', error => log('focus-failed', String(error?.message ?? error)))
    child.on('close', () => log('focus', out.trim().split(/\r?\n/).pop() || 'no-output'))
    child.unref()
  } catch (error) {
    log('focus-failed', String(error?.message ?? error))
  }
}

/**
 * 用户一旦把 DSH 窗口切回前台，就把通知收掉、把请求交回网页卡片，
 * 免得他盯着一条点不动的通知干等。返回 { stop } 用于按钮先被点时收尾。
 */
function startFocusWatcher({ appId, focusExe, tag, token, tickets, waitMs, log }) {
  if (!focusExe) return null
  const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(HERE, 'watch.ps1'), '-FocusExe', focusExe, '-AppId', appId || AUMID, '-Tag', tag,
    '-Group', 'dsh-approval', '-TimeoutMs', String(waitMs)], { windowsHide: true })
  let out = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.on('error', error => log('watch-failed', String(error?.message ?? error)))
  child.on('close', () => {
    const line = out.trim().split(/\r?\n/).pop() ?? ''
    if (line !== 'focused') return
    log('focus-returned', tag)
    tickets.get(token)?.settle(null) // 交回网页卡片
  })
  return { stop: () => { try { child.kill() } catch {} } }
}

/** 建（或确认已有）通知归属用的开始菜单快捷方式；启动时做一次，不阻塞、不依赖通知是否发生。 */
function ensureShortcut(log) {
  const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(HERE, 'shortcut.ps1'), '-Lnk', SHORTCUT, '-AppId', TOAST_AUMID, '-Icon', process.execPath],
    { windowsHide: true })
  let out = ''
  child.stdout.on('data', chunk => { out += chunk })
  child.stderr.on('data', chunk => { out += chunk })
  child.on('error', error => log('shortcut-failed', String(error?.message ?? error)))
  child.on('close', () => log('shortcut', out.trim().split(/\r?\n/).pop()?.slice(0, 200) ?? '?'))
}

/** 调 show.ps1：窗口前台时返回 'focused'（不打扰），否则 'shown'。 */
function showToast(payload, log) {
  const file = path.join(os.tmpdir(), `dsh-approval-notify-${payload.tag}.json`)
  try { fs.writeFileSync(file, JSON.stringify({ ...payload, appId: AUMID, aumid: TOAST_AUMID, shortcut: SHORTCUT, attribution: APP_NAME }), 'utf8') } catch (error) {
    log('payload-failed', String(error?.message ?? error))
    return Promise.resolve('failed')
  }
  return new Promise(resolve => {
    const child = spawn(PS, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(HERE, 'show.ps1'), '-Payload', file], { windowsHide: true })
    let out = ''
    child.stdout.on('data', chunk => { out += chunk })
    child.stderr.on('data', chunk => { out += chunk })
    child.on('error', error => { log('ps-spawn-failed', String(error?.message ?? error)); resolve('failed') })
    child.on('close', () => {
      try { fs.unlinkSync(file) } catch {}
      const line = out.trim().split(/\r?\n/).pop() ?? ''
      if (!/^(shown( .+)?|focused)$/.test(line)) log('ps-output', line.slice(0, 200))
      resolve(line || 'failed')
    })
  })
}

/** 注册（覆盖写）仅当前用户的 URI 协议 → answer.vbs。 */
function registerProtocol(log) {
  const vbs = path.join(HERE, 'answer.vbs')
  const wscript = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe')
  const command = `"${wscript}" //nologo "${vbs}" "%1"`
  for (const args of [
    ['add', KEY, '/ve', '/t', 'REG_SZ', '/d', 'URL:DSH approval notification', '/f'],
    // Empty "URL Protocol" is what tells the shell this key handles a URI scheme.
    ['add', KEY, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'],
    ['add', `${KEY}\\shell\\open\\command`, '/ve', '/t', 'REG_SZ', '/d', command, '/f'],
  ]) {
    const result = spawnSync('reg', args, { windowsHide: true, encoding: 'utf8' })
    if (result.status !== 0) log('reg-failed', String(result.stderr || result.stdout).trim().slice(0, 200))
  }
}