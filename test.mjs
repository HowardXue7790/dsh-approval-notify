// Self-check for the answer plumbing: node test.mjs (no framework, no network).
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { settleFromUrl, waitAnswer, resolveRoute, pickSystem } from './index.js'

// Model / prompt settings: empty follows the session default, a set field overrides only that half.
const ctxWith = selection => ({ reflect: { get: (name, strict) => (name === 'agentDefaultModel' ? { currentSelection: () => selection } : undefined) } })
const sel = { provider: 'magpie', model: 'group/ds-v4.1-flash' }
assert.deepEqual(resolveRoute(ctxWith(sel)), sel)
assert.deepEqual(resolveRoute(ctxWith(sel), 'other', 'big/model'), { provider: 'other', model: 'big/model' })
assert.deepEqual(resolveRoute(ctxWith(sel), '', 'tiny'), { provider: 'magpie', model: 'tiny' })
assert.deepEqual(resolveRoute(ctxWith(sel), 'other', ''), { provider: 'other', model: 'group/ds-v4.1-flash' })
assert.equal(resolveRoute(ctxWith(null), 'other', ''), null, 'half a route with no default is unusable')
assert.match(pickSystem('zh', ''), /40 个汉字/)
assert.match(pickSystem('en', '  '), /ONE short English sentence/)
assert.equal(pickSystem('zh', ' 说人话 '), '说人话')

const quiet = () => {}
const tickets = new Map()

// A click settles the ticket once and unregisters it.
const pending = waitAnswer(tickets, 'tok', null, 5000)
assert.equal(tickets.has('tok'), true, 'ticket must be registered while waiting')
const ticket = tickets.get('tok')
ticket.settle('allowed-once')
ticket.settle('rejected') // second click on a used token must not win
assert.equal(await pending, 'allowed-once')
assert.equal(tickets.has('tok'), false, 'ticket must be dropped after settling')

// Nobody clicks: resolve null so the caller can fall back to the card.
assert.equal(await waitAnswer(tickets, 'tok2', null, 25), null)
assert.equal(tickets.has('tok2'), false)

// The turn is cancelled while the toast is up.
const controller = new AbortController()
const aborted = waitAnswer(tickets, 'tok3', controller.signal, 5000)
controller.abort()
assert.equal(await aborted, 'cancelled')

// The URL the toast button opens must produce the same verdict.
const allow = waitAnswer(tickets, 'tok4', null, 5000)
assert.deepEqual(settleFromUrl('/a?v=allow&t=tok4', tickets, quiet), { hit: true, outcome: 'allowed-once' })
assert.equal(await allow, 'allowed-once')

const deny = waitAnswer(tickets, 'tok5', null, 5000)
settleFromUrl('/a?v=deny&t=TOK5', tickets, quiet) // protocol handlers upper-case the host, not the query; token stays as sent
assert.equal(await deny, 'rejected')

// Clicking the toast body opens DSH instead of voting: the wait falls back to the in-app card.
const opened = waitAnswer(tickets, 'tok6', null, 5000)
assert.deepEqual(settleFromUrl('/a?v=focus&t=tok6', tickets, quiet), { hit: true, focus: true, outcome: null })
assert.equal(await opened, null)

// Stale token, unknown vote, or garbage URL: nothing settles, no crash.
assert.deepEqual(settleFromUrl('/a?v=allow&t=expired', tickets, quiet), { hit: false, outcome: 'allowed-once' })
assert.deepEqual(settleFromUrl('/a?v=maybe&t=tok5', tickets, quiet), { hit: false, outcome: null })
assert.equal(settleFromUrl('http://[bad', tickets, quiet), null)
assert.equal(tickets.size, 0)

// The browser half must register the same panel on both settings surfaces and render it.
let registration
const fakeWindow = { __ModuleLoader__: { load: value => { registration = value } } }
new Function('window', fs.readFileSync(new URL('./client.js', import.meta.url), 'utf8'))(fakeWindow)
assert.equal(registration.id, 'dsh-approval-notify')
const React = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  useState: value => [typeof value === 'function' ? value() : value, () => {}],
  useEffect: () => {},
}
const client = registration.factory(() => React)
assert.deepEqual(client.inject, ['slots', 'locale', 'configForms', 'remote.session'])

const registered = []
const form = {
  getSnapshot: () => ({ status: 'ready', value: { locale: 'zh', waitMs: 600000, focusCheck: false, modelProvider: '', model: 'group/ds-v4.1-flash', reasoningEffort: '', prompt: '说人话' }, writable: true, revision: 7 }),
  subscribe: () => () => {},
  set: async () => true,
}
const remoteService = { session: { modelCatalog: async () => ({ ok: true, value: { default: { provider: 'magpie', model: 'group/ds-v4.1-flash' }, groups: [] } }) } }
const ctxFor = storedForm => ({
  effect: effect => effect(),
  locale: { register: () => () => {}, bind: () => key => key },
  configForms: { whileServed: (namespaces, register) => register(new Set(namespaces)), get: () => storedForm },
  get: name => (name === 'remote.session' ? remoteService.session : undefined),
  slots: {
    inject: (name, callback) => callback(),
    register: (options, Component) => { registered.push({ options, Component }); return () => {} },
  },
})
client.apply(ctxFor(form))
const byName = name => registered.find(item => item.options.name === name)
assert.deepEqual(registered.map(item => item.options.name).sort(), ['conversation.composer', 'plugins.bundle.config', 'settings.section'])
const tree = registered[0].Component()
assert.ok(tree && tree.children.length > 0, 'panel must render')
assert.match(JSON.stringify(tree), /"textarea"/, 'panel must expose the prompt field')
const optionValues = node => {
  const out = []
  const visit = value => {
    if (!value || typeof value !== 'object') return
    if (value.type === 'option') out.push(value.props.value)
    ;(value.children || []).forEach(visit)
  }
  visit(node)
  return out
}
assert.ok(optionValues(tree).includes(JSON.stringify(['', ''])), 'model picker must offer the follow-default choice')
assert.ok(optionValues(tree).includes(JSON.stringify(['', 'group/ds-v4.1-flash'])), 'a stored route missing from the catalog must still show up')

// Empty prompt must show the built-in wording, so the user can edit it instead of writing one from scratch.
const emptyPrompt = { ...form, getSnapshot: () => ({ status: 'ready', value: { ...form.getSnapshot().value, prompt: '' }, writable: true, revision: 8 }) }
registered.length = 0
client.apply(ctxFor(emptyPrompt))
assert.match(JSON.stringify(registered[0].Component()), /40 个汉字/, 'prompt box must prefill the built-in wording')

// The approval card takeover: only fires with a model rewrite in hand, and shows both texts.
const composer = byName('conversation.composer')
assert.equal(composer.options.priority, 0.5, 'must be tried before the built-in approval card at priority 1')
const pendingApproval = {
  kind: 'approval',
  reason: 'Auto review rejected this call: This creates a new key under HKCU',
  displayReason: { zh: '会在你的注册表里写一个测试项', en: 'writes one test key in your registry' },
  answerable: true,
  answer: async () => {},
}
assert.equal(composer.options.select({ pendingInteraction: pendingApproval }), pendingApproval)
assert.equal(composer.options.select({ pendingInteraction: { ...pendingApproval, displayReason: undefined } }), null, 'no rewrite means the built-in card stays')
assert.equal(composer.options.select({ pendingInteraction: { ...pendingApproval, displayReason: { zh: pendingApproval.reason } } }), null, 'a rewrite equal to the original is not a rewrite')
assert.equal(composer.options.select({ pendingInteraction: { kind: 'question' } }), null)
assert.equal(composer.options.select({}), null)
const card = composer.Component({ matched: pendingApproval })
const cardText = JSON.stringify(card)
assert.match(cardText, /会在你的注册表里写一个测试项/, 'card must headline the plain-language rewrite')
assert.match(cardText, /approvalOriginal.*HKCU/, 'card must keep the original reason as small print')

// A throwing `ctx.remote` must not blank the page: the panel still renders, the catalog just reports failed.
const ReactWithEffects = { ...React, useEffect: effect => { effect() } }
const clientWithEffects = registration.factory(() => ReactWithEffects)
const badCtx = { ...ctxFor(form), get: () => { throw new Error('remote.session is not available') } }
clientWithEffects.apply(badCtx)
const badTree = byName('plugins.bundle.config').Component()
assert.ok(badTree && badTree.children.length > 0, 'panel must render even when the catalog lookup throws')

console.log('ok')