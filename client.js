// approval-notify 的浏览器半体：把配置项（locale / waitMs / focusCheck /
// modelProvider / model / reasoningEffort / prompt）同时挂到
// 「设置 → 审批通知」和「插件 → 已安装插件 → 本插件」两处。
// 读写全部走 DSH 自己的 configForms（= 插件 Config 的那份设置文档），不另存状态。
window.__ModuleLoader__.load({
  id: '@local/approval-notify',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'approval-notify'
    // 设置命名空间就是 Host 那条 plugin entry 的 id；不同装载路径下 id 形式不同，两种都认。
    const CANDIDATES = ['approval-notify', 'include:approval-notify']

    const zh = {
      nav: '审批通知',
      title: '审批通知（Windows 桌面通知）',
      intro: 'Agent 需要你授权时，直接弹一条带「允许 / 拒绝」按钮的 Windows 通知；正文由模型翻成一句大白话。',
      language: '通知语言',
      languageHint: '通知正文和按钮用哪种语言。',
      langZh: '中文',
      langEn: 'English',
      waitMinutes: '等待时长',
      waitHint: '这段时间里没人点按钮，就收掉通知、把请求交回网页卡片。',
      minutesShort: '分',
      secondsShort: '秒',
      focusCheck: '看着 DSH 时不弹通知',
      focusHint: 'DSH 窗口在前台时直接出网页卡片，不打扰；关掉则永远先弹通知。',
      modelPick: '翻译用的模型',
      modelPickHint: '和聊天窗口共用同一份模型列表；选「跟随会话默认」就完全跟着当前默认模型走。',
      followDefault: '跟随会话默认',
      catalogLoading: '正在读取模型列表…',
      catalogFailed: '读不到模型列表，先按默认模型翻译。',
      effort: '推理等级',
      effortHint: '只对支持分级推理的模型有用；「默认」用该模型自带的等级。',
      effortDefault: '默认（模型自带）',
      prompt: '提示词',
      promptHint: '框里是内置提示词，可以直接改；清空并离开输入框就恢复内置那段。',
      saved: '已保存',
      failed: '保存失败，请再试一次',
      loading: '正在读取设置…',
      unavailable: '设置暂不可用（Host 端未加载本插件）',
      readonly: '当前设置文档只读',
    }
    const en = {
      nav: 'Approval notifications',
      title: 'Approval notifications (Windows toast)',
      intro: 'When the agent needs your permission, DSH pops a Windows toast with Allow / Deny buttons; the model rewrites the body into one plain sentence.',
      language: 'Notification language',
      languageHint: 'Language used for the toast body and buttons.',
      langZh: '中文',
      langEn: 'English',
      waitMinutes: 'Wait for',
      waitHint: 'If nobody clicks within this time, the toast is withdrawn and the request returns to the in-page card.',
      minutesShort: 'min',
      secondsShort: 's',
      focusCheck: 'Skip toast while DSH is focused',
      focusHint: 'When the DSH window is in front, show the in-page card instead. Turn off to always pop the toast.',
      modelPick: 'Model for the rewrite',
      modelPickHint: 'Same list as the chat model picker. "Follow session default" tracks the current default model.',
      followDefault: 'Follow session default',
      catalogLoading: 'Loading models…',
      catalogFailed: 'Could not load the model list; falling back to the default model.',
      effort: 'Reasoning effort',
      effortHint: 'Only for models that advertise efforts; "Default" uses the model default.',
      effortDefault: 'Default (model)',
      prompt: 'System prompt',
      promptHint: 'The built-in prompt is filled in; edit it freely, or clear it and leave the box to restore the built-in wording.',
      saved: 'Saved',
      failed: 'Could not save, try again',
      loading: 'Loading settings…',
      unavailable: 'Settings unavailable (host plugin not loaded)',
      readonly: 'This settings document is read-only',
    }

    // 内置提示词（与 index.js 的 SYSTEM_ZH / SYSTEM_EN 一致，只用于在设置页预填显示）
    const BUILTIN = {
      zh: '你在为桌面授权通知写一行正文。只回一句不超过 40 个汉字的中文大白话，说明这个操作会动到用户的哪些文件或电脑上的什么，不要 markdown、不要引号、不要工具名。',
      en: "You write the one-line body of a desktop permission notification. Reply with ONE short English sentence, at most 20 words, everyday words, no markdown, no quotes, no tool names. Say what the action does to the user's files or computer.",
    }
    // 下拉框用一个不会出现在 provider / model id 里的分隔符把两段拼成一个 value。
    const routeKey = (provider, model) => JSON.stringify([provider || '', model || ''])
    const parseRoute = text => {
      try {
        const parts = JSON.parse(String(text))
        return Array.isArray(parts) ? [parts[0] || '', parts[1] || ''] : ['', '']
      } catch { return ['', ''] }
    }

    const label = { display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }
    const hint = { margin: '4px 0 0', fontSize: 12, opacity: 0.65, lineHeight: 1.5 }
    const row = { marginBottom: 18 }
    const control = { fontSize: 13, padding: '6px 8px', minWidth: 160 }

    function Row(title, children, hintText) {
      return h('div', { style: row },
        title ? h('label', { style: label }, title) : null,
        children,
        hintText ? h('p', { style: hint }, hintText) : null)
    }

    function createPanel(form, t, getRemote) {
      return function ApprovalNotifySettings() {
        const [snapshot, setSnapshot] = React.useState(form.getSnapshot())
        const [note, setNote] = React.useState('')
        const [catalog, setCatalog] = React.useState({ status: 'loading' })
        const [promptDraft, setPromptDraft] = React.useState(null)
        React.useEffect(() => {
          setSnapshot(form.getSnapshot())
          return form.subscribe(() => setSnapshot(form.getSnapshot()))
        }, [])
        // 模型列表走和聊天窗口同一个远程接口，一次拿全 provider / model / 推理等级。
        React.useEffect(() => {
          let live = true
          const fail = error => {
            if (live) setCatalog({ status: 'failed', detail: String((error && error.message) || error || '') })
          }
          try {
            const candidates = [getRemote('remote.session'), (() => { const remote = getRemote('remote'); return remote && remote.session })()]
            const service = candidates.find(item => item && typeof item.modelCatalog === 'function')
            if (!service) return fail('remote.session.modelCatalog unavailable')
            Promise.resolve(service.modelCatalog()).then(
              result => {
                if (!live) return
                if (result && result.ok) setCatalog({ status: 'ready', value: result.value })
                else fail(result && result.error)
              },
              fail)
          } catch (error) { fail(error) }
          return () => { live = false }
        }, [])

        if (snapshot.status === 'loading') return h('p', { style: hint }, t('loading'))
        if (snapshot.status === 'unavailable') return h('p', { style: hint }, t('unavailable'))

        const value = snapshot.value || {}
        const disabled = snapshot.writable === false
        const write = (field, next) => {
          form.set(field, next).then(ok => setNote(ok ? t('saved') : t('failed')), () => setNote(t('failed')))
        }

        const groups = catalog.status === 'ready' && catalog.value ? (catalog.value.groups || []) : []
        const fallback = catalog.status === 'ready' && catalog.value ? (catalog.value.default || {}) : {}
        const models = groups.flatMap(group => (group.models || []).map(model => ({ provider: group.id, model })))
        const picked = models.find(item => item.provider === (value.modelProvider || '') && item.model.id === (value.model || ''))
        const efforts = picked?.model?.reasoning?.efforts || []
        const followDefault = t('followDefault')
          + (fallback.provider ? ` (${fallback.provider}${fallback.model ? ' / ' + fallback.model : ''})` : '')
        // 存着的模型如果不在当前列表里（换了服务商、列表还没读回来），也要显示出来，不然下拉会假装成「跟随默认」。
        const stale = Boolean(value.modelProvider || value.model) && !picked

        const totalSeconds = Math.max(5, Math.round((Number(value.waitMs) || 300000) / 1000))
        const setWait = (minutes, seconds) => {
          const total = Math.max(5, (Number(minutes) || 0) * 60 + (Number(seconds) || 0))
          write('waitMs', total * 1000)
        }
        const promptText = promptDraft !== null
          ? promptDraft
          : ((value.prompt ?? '') || BUILTIN[value.locale === 'en' ? 'en' : 'zh'])

        return h('div', null,
          h('h4', { style: { margin: '0 0 6px', fontSize: 14 } }, t('title')),
          h('p', { style: hint }, t('intro')),
          h('div', { style: { height: 14 } }),

          Row(t('language'),
            h('select', {
              style: control,
              disabled,
              value: value.locale === 'en' ? 'en' : 'zh',
              onChange: event => write('locale', event.target.value),
            }, h('option', { value: 'zh' }, t('langZh')), h('option', { value: 'en' }, t('langEn'))),
            t('languageHint')),

          Row(t('waitMinutes'),
            h('span', null,
              h('input', {
                style: { ...control, width: 80 },
                type: 'number',
                min: 0,
                max: 120,
                step: 1,
                disabled,
                value: Math.floor(totalSeconds / 60),
                onChange: event => setWait(event.target.value, totalSeconds % 60),
              }),
              h('span', { style: { marginLeft: 6, marginRight: 14, fontSize: 13, opacity: 0.7 } }, t('minutesShort')),
              h('input', {
                style: { ...control, width: 80 },
                type: 'number',
                min: 0,
                max: 59,
                step: 5,
                disabled,
                value: totalSeconds % 60,
                onChange: event => setWait(Math.floor(totalSeconds / 60), event.target.value),
              }),
              h('span', { style: { marginLeft: 6, fontSize: 13, opacity: 0.7 } }, t('secondsShort'))),
            t('waitHint')),

          Row(null,
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 } },
              h('input', {
                type: 'checkbox',
                disabled,
                checked: value.focusCheck !== false,
                onChange: event => write('focusCheck', event.target.checked),
              }),
              t('focusCheck')),
            t('focusHint')),

          Row(t('modelPick'),
            h('span', null,
              h('select', {
                style: { ...control, width: 320, maxWidth: '100%' },
                disabled,
                value: routeKey(value.modelProvider, value.model),
                onChange: event => {
                  const [provider, model] = parseRoute(event.target.value)
                  write('modelProvider', provider)
                  write('model', model)
                },
              },
                h('option', { value: routeKey('', '') }, followDefault),
                stale ? h('option', { value: routeKey(value.modelProvider, value.model) },
                  `${value.modelProvider || '?'} / ${value.model || '?'}`) : null,
                groups.map(group => h('optgroup', { key: group.id, label: group.name || group.id },
                  (group.models || []).map(model => h('option', {
                    key: model.id, value: routeKey(group.id, model.id),
                  }, model.name || model.id))))),
              catalog.status === 'loading' ? h('span', { style: { ...hint, display: 'inline', marginLeft: 8 } }, t('catalogLoading')) : null,
              catalog.status === 'failed' ? h('span', { style: { ...hint, display: 'inline', marginLeft: 8 } },
                t('catalogFailed') + (catalog.detail ? ` (${catalog.detail})` : '')) : null),
            t('modelPickHint')),

          Row(t('effort'),
            h('select', {
              style: control,
              disabled: disabled || efforts.length === 0,
              value: efforts.some(effort => effort.id === value.reasoningEffort) ? value.reasoningEffort : '',
              onChange: event => write('reasoningEffort', event.target.value),
            },
              h('option', { value: '' }, t('effortDefault')),
              efforts.map(effort => h('option', { key: effort.id, value: effort.id }, effort.name || effort.id))),
            t('effortHint')),

          Row(t('prompt'),
            h('textarea', {
              style: { ...control, width: '100%', maxWidth: 520, minHeight: 110, fontFamily: 'inherit', lineHeight: 1.5 },
              disabled,
              value: promptText,
              onChange: event => setPromptDraft(event.target.value),
              onBlur: () => {
                if (promptDraft === null) return
                const next = String(promptDraft).trim()
                setPromptDraft(null)
                if (next !== String(value.prompt ?? '')) write('prompt', next)
              },
            }),
            t('promptHint')),

          disabled ? h('p', { style: hint }, t('readonly')) : null,
          note ? h('p', { style: { ...hint, opacity: 0.9 } }, note) : null)
      }
    }

    return {
      // remote.session 是带点的独立服务名，动态半体的守卫要求写进 inject 才让读。
      inject: ['slots', 'locale', 'configForms', 'remote.session'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'approval-notify: dictionaries')
        const t = ctx.locale.bind(NS)
        // 设置命名空间只有在 Host 端真的发布了它之后才存在，所以先等它出现再挂页面。
        const mount = (slot, options) => () => ctx.configForms.whileServed(CANDIDATES, served => {
          const namespace = CANDIDATES.find(candidate => served.has(candidate))
          const form = ctx.configForms.get(namespace)
          return ctx.slots.register({ ...options, name: slot, locale: NS }, createPanel(form, t, name => {
            // 服务名带点的（remote.session）在 cordis 里是独立服务，只能按全名取。
            try { return ctx.get(name) } catch { return null }
          }))
        })
        ctx.slots.inject('settings.section', mount('settings.section', {
          id: 'approval-notify', order: 63, label: () => t('nav'),
        }))
        ctx.slots.inject('plugins.bundle.config', mount('plugins.bundle.config', {
          key: '@local/approval-notify',
        }))
      },
    }
  },
})
