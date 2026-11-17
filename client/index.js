/**
 * Settings page for the Cua computer-control plugin.
 *
 * Registers a **Settings** section (sidebar → Settings → Cua 电脑控制) through
 * the `settings.section` slot, the same surface other third-party plugins use.
 * The form edits this plugin's `.volatile()` fields through `ctx.configForms`,
 * so a save applies in place without restarting the plugin.
 *
 * Written in the plain module-loader form, so the bundle needs no build step.
 */
window.__ModuleLoader__.load({
  id: 'dsh-plug-computeruse',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Dictionary namespace owned by this page. */
    const NS = 'settings.cua'
    /**
     * Candidate config namespaces, most specific first.
     *
     * The settings service keys each form by the Loader entry id of the row,
     * which a profile may mount as `include:dsh-cua`. The Host publishes the
     * exact id through the index injection; the rest are fallbacks for a page
     * loaded without it.
     */
    const ENTRY_NAMESPACES = [
      globalThis.__DSH_CUA_SETTINGS_NS__,
      'dsh-cua',
      'include:dsh-cua',
      'dsh-plug-computeruse',
      'include:dsh-plug-computeruse',
    ].filter(value => typeof value === 'string' && value !== '')

    const en = {
      'nav.panel': 'Cua computer control',
      title: 'Cua computer control',
      intro: 'These settings apply to every session using this profile and take effect on the next desktop call.',
      scope: 'Control scope',
      scopeDesktop: 'Whole desktop',
      scopeWindow: 'One app only',
      scopeHelp: 'Whole desktop lets the model capture the screen and act anywhere. One app only pins every call to a single app and refuses whole-desktop capture, so screenshots never include other windows.',
      app: 'Pinned app',
      appName: 'Executable name',
      appPid: 'Or process id',
      appHelp: 'Required for one app only. A name such as CalculatorApp.exe keeps working after the app restarts; a process id fixes one process.',
      approval: 'Approval before acting',
      approvalMutations: 'Ask for state-changing actions',
      approvalAll: 'Ask for every action',
      approvalNone: 'Never ask',
      approvalHelp: 'State-changing actions include clicking, typing, key presses, dragging, scrolling and launching apps. Read-only calls such as listing windows or taking a screenshot never prompt.',
      focusCursor: 'Show a focus cursor',
      focusCursorHelp: 'Marks where the model is about to act over the target window, per session.',
      retention: 'Keep screenshots for (seconds)',
      retentionHelp: 'Screenshots saved to disk are deleted after this many seconds and cleared when the turn ends. Zero keeps them only until the turn ends.',
      maxImage: 'Limit screenshot long edge (pixels)',
      maxImageHelp: 'Leave empty for the driver default. A smaller value sends smaller images to the model.',
      timeout: 'Call timeout (milliseconds)',
      timeoutHelp: 'Upper bound for one driver call, between 1000 and 900000.',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved.',
      overridden: 'Overridden',
      resetAll: 'Reset to defaults',
      loading: 'Loading settings…',
      unavailable: 'Settings are unavailable in this deployment.',
      readOnly: 'This profile cannot save plugin settings, so these fields are read-only.',
      invalid: 'Check the fields marked below.',
      requestFailed: 'The host refused the change.',
      errApp: 'Pinning one app needs an executable name or a process id.',
      errRetention: 'Use zero or a positive whole number of seconds.',
      errMaxImage: 'Use a positive whole number of pixels, or leave it empty.',
      errTimeout: 'Use a whole number between 1000 and 900000.',
    }

    const zh = {
      'nav.panel': 'Cua 电脑控制',
      title: 'Cua 电脑控制',
      intro: '这些设置对该配置档中的所有会话生效，并在下一次桌面调用时起作用。',
      scope: '控制范围',
      scopeDesktop: '整个桌面',
      scopeWindow: '仅一个应用',
      scopeHelp: '整个桌面允许模型截取全屏并在任意位置操作。仅一个应用会把每次调用都固定到同一个应用，并拒绝整屏截图，因此截图不会包含其他窗口。',
      app: '固定应用',
      appName: '可执行文件名',
      appPid: '或进程号',
      appHelp: '选择「仅一个应用」时必填。填 CalculatorApp.exe 这类文件名，应用重启后仍然有效；填进程号则只固定那一个进程。',
      approval: '操作前确认',
      approvalMutations: '仅修改类操作需要确认',
      approvalAll: '所有操作都需要确认',
      approvalNone: '从不确认',
      approvalHelp: '修改类操作包括点击、输入文字、按键、拖拽、滚动和启动应用。只读调用（例如列出窗口、截图）不会弹出确认。',
      focusCursor: '显示焦点光标',
      focusCursorHelp: '在目标窗口上标记模型即将操作的位置，按会话区分。',
      retention: '截图保留时间（秒）',
      retentionHelp: '落盘保存的截图会在这个秒数后被删除，并在对话结束时清空。填 0 表示只保留到本轮对话结束。',
      maxImage: '截图长边上限（像素）',
      maxImageHelp: '留空使用驱动默认值。数值越小，发给模型的图片越小。',
      timeout: '调用超时（毫秒）',
      timeoutHelp: '单次驱动调用的上限，范围 1000 到 900000。',
      save: '保存',
      saving: '正在保存…',
      saved: '已保存。',
      overridden: '已覆盖',
      resetAll: '恢复默认',
      loading: '正在读取设置…',
      unavailable: '当前部署无法读取设置。',
      readOnly: '当前配置档无法保存插件设置，因此这些字段是只读的。',
      invalid: '请检查下面标出的字段。',
      requestFailed: '宿主拒绝了这次修改。',
      errApp: '固定应用需要填写可执行文件名或进程号。',
      errRetention: '请填写 0 或正整数秒数。',
      errMaxImage: '请填写正整数像素值，或留空。',
      errTimeout: '请填写 1000 到 900000 之间的整数。',
    }

    /**
     * Peel one `{get(): T}` live reference.
     *
     * DSH hands volatile fields back as live references, which are still
     * `typeof === 'object'`; reading them directly yields `undefined`.
     */
    const unwrap = value => (value !== null && typeof value === 'object' && typeof value.get === 'function' ? value.get() : value)

    /** Whole-number parse; an empty field means "unset". */
    const numberOf = text => {
      if (text === undefined || text === null || String(text).trim() === '') return undefined
      const value = Number(text)
      return Number.isFinite(value) ? value : Number.NaN
    }

    /**
     * Build the write list from the draft, collecting field errors.
     * @param draft - page state as strings.
     * @param t - dictionary binder.
     */
    function buildWrites(draft, t) {
      const errors = {}
      const writes = []
      const set = (field, value) => writes.push([field, value])

      set('scope', draft.scope)
      set('approval', draft.approval)
      set('showFocusCursor', draft.focusCursor === true)

      if (draft.scope === 'window') {
        const name = String(draft.appName ?? '').trim()
        const pid = numberOf(draft.appPid)
        if (name !== '') set('app', { name })
        else if (pid !== undefined && !Number.isNaN(pid)) set('app', { pid })
        else errors.app = t('errApp')
      } else {
        set('app', undefined)
      }

      const retention = numberOf(draft.retention)
      if (retention === undefined || Number.isNaN(retention) || retention < 0) errors.retention = t('errRetention')
      else set('screenshotRetentionMs', Math.round(retention * 1000))

      const sweep = numberOf(draft.sweep)
      if (sweep !== undefined && !Number.isNaN(sweep) && sweep >= 0) set('screenshotSweepMs', Math.round(sweep * 1000))

      const maxImage = numberOf(draft.maxImage)
      if (maxImage === undefined) set('maxImageDimension', undefined)
      else if (Number.isNaN(maxImage) || maxImage < 0) errors.maxImage = t('errMaxImage')
      else set('maxImageDimension', Math.round(maxImage))

      const timeout = numberOf(draft.timeout)
      if (timeout === undefined || Number.isNaN(timeout) || timeout < 1000 || timeout > 900000) errors.timeout = t('errTimeout')
      else set('timeoutMs', Math.round(timeout))

      return { writes, errors }
    }

    /** Draft state derived from a settings snapshot. */
    function draftOf(value) {
      const app = unwrap(value?.app) ?? {}
      return {
        scope: unwrap(value?.scope) ?? 'desktop',
        appName: app.name ?? '',
        appPid: app.pid === undefined ? '' : String(app.pid),
        approval: unwrap(value?.approval) ?? 'mutations',
        focusCursor: unwrap(value?.showFocusCursor) !== false,
        retention: String(Math.round((unwrap(value?.screenshotRetentionMs) ?? 900000) / 1000)),
        sweep: String(Math.round((unwrap(value?.screenshotSweepMs) ?? 60000) / 1000)),
        maxImage: unwrap(value?.maxImageDimension) === undefined ? '' : String(unwrap(value?.maxImageDimension)),
        timeout: String(unwrap(value?.timeoutMs) ?? 120000),
      }
    }

    /** Build the settings section component. */
    function createSection(ctx) {
      const t = ctx.locale.bind(NS)
      return function CuaSettingsCard() {
        // Try every candidate namespace and keep the first one the Host serves.
        const scope = React.useMemo(() => {
          for (const ns of ENTRY_NAMESPACES) {
            try {
              const form = ctx.configForms.get(ns)
              const snapshot = form?.getSnapshot?.()
              if (snapshot !== undefined && snapshot.status === 'ready') return form
            } catch {
              // Try the next candidate.
            }
          }
          // None ready yet: keep the first so the subscribe below can settle.
          try {
            return ctx.configForms.get(ENTRY_NAMESPACES[0])
          } catch {
            return undefined
          }
        }, [])

        const [snapshot, setSnapshot] = React.useState(() => {
          try {
            return scope?.getSnapshot?.()
          } catch {
            return undefined
          }
        })
        const [draft, setDraft] = React.useState(() => (snapshot ? draftOf(snapshot.value) : null))
        const [errors, setErrors] = React.useState({})
        const [busy, setBusy] = React.useState(false)
        const [notice, setNotice] = React.useState(null)

        React.useEffect(() => {
          if (scope === undefined) return undefined
          const read = () => {
            const next = scope.getSnapshot?.()
            if (next !== undefined) {
              setSnapshot(next)
              setDraft(current => current ?? draftOf(next.value))
            }
          }
          read()
          return scope.subscribe?.(read)
        }, [scope])

        if (scope === undefined) {
          return h('p', { style: { margin: 0, opacity: 0.7 } }, t('unavailable'))
        }
        if (snapshot === undefined || snapshot.status === 'loading') {
          return h('p', { style: { margin: 0, opacity: 0.7 } }, t('loading'))
        }
        // A namespace the Host never serves must say so rather than render a
        // form full of defaults that cannot be saved.
        if (snapshot.status === 'unavailable' || draft === null) {
          return h('p', { style: { margin: 0, opacity: 0.7 } }, t('unavailable'))
        }

        const writable = snapshot.writable === true
        const update = (key, value) => setDraft({ ...draft, [key]: value })

        const onSave = async () => {
          const built = buildWrites(draft, t)
          setErrors(built.errors)
          setNotice(null)
          if (Object.keys(built.errors).length > 0) return
          setBusy(true)
          try {
            // One atomic operation list: a partial write could leave `scope:
            // window` stored without its `app`, which the plugin rejects.
            // Shapes follow SettingsPathOpView: { op, path, value }.
            const operations = built.writes.map(([path, value]) => (value === undefined
              ? { op: 'unset', path: [path] }
              : { op: 'set', path: [path], value }))
            const accepted = await scope.mutate(operations)
            if (accepted === false) throw new Error(t('requestFailed'))
            const after = scope.getSnapshot?.()
            if (after !== undefined) {
              setSnapshot(after)
              setDraft(draftOf(after.value))
            }
            setNotice({ kind: 'ok', text: t('saved') })
          } catch (error) {
            setNotice({ kind: 'error', text: String(error?.message ?? error) })
            // Re-read so the form shows what the host actually stored.
            const next = scope.getSnapshot?.()
            if (next !== undefined) {
              setSnapshot(next)
              setDraft(draftOf(next.value))
            }
          } finally {
            setBusy(false)
          }
        }

        const field = (label, control, help, error) => h('label', {
          key: label,
          style: { display: 'block', marginBlockEnd: 16 },
        },
        h('span', { style: { display: 'block', fontWeight: 500, marginBlockEnd: 4 } }, label),
        control,
        help !== undefined ? h('span', { style: { display: 'block', opacity: 0.7, fontSize: '0.9em', marginBlockStart: 4 } }, help) : null,
        error !== undefined ? h('span', { style: { display: 'block', color: 'crimson', fontSize: '0.9em', marginBlockStart: 4 } }, error) : null)

        const select = (key, options) => h('select', {
          value: draft[key],
          disabled: !writable || busy,
          onChange: event => update(key, event.target.value),
          style: { width: '100%', padding: '5px 6px' },
        }, ...options.map(([value, label]) => h('option', { key: value, value }, label)))

        const input = (key, type) => h('input', {
          type: type ?? 'text',
          value: draft[key],
          disabled: !writable || busy,
          onChange: event => update(key, event.target.value),
          style: { width: '100%', padding: '5px 6px', boxSizing: 'border-box' },
        })

        return h('section', { style: { display: 'grid', gap: 4, maxWidth: 620 } },
          h('h2', { style: { margin: 0, marginBlockEnd: 4 } }, t('title')),
          h('p', { style: { margin: 0, marginBlockEnd: 12, opacity: 0.75, fontSize: '0.9em' } }, t('intro')),
          !writable ? h('p', { style: { margin: 0, marginBlockEnd: 12, opacity: 0.8 } }, t('readOnly')) : null,

          field(t('scope'),
            select('scope', [['desktop', t('scopeDesktop')], ['window', t('scopeWindow')]]),
            t('scopeHelp')),

          draft.scope === 'window' ? field(t('app'), h('div', { style: { display: 'grid', gap: 6 } },
            h('div', null,
              h('span', { style: { display: 'block', fontSize: '0.9em', opacity: 0.75, marginBlockEnd: 2 } }, t('appName')),
              input('appName')),
            h('div', null,
              h('span', { style: { display: 'block', fontSize: '0.9em', opacity: 0.75, marginBlockEnd: 2 } }, t('appPid')),
              input('appPid', 'number'))),
          t('appHelp'), errors.app) : null,

          field(t('approval'),
            select('approval', [['mutations', t('approvalMutations')], ['all', t('approvalAll')], ['none', t('approvalNone')]]),
            t('approvalHelp')),

          field(t('focusCursor'),
            h('input', {
              type: 'checkbox',
              checked: draft.focusCursor === true,
              disabled: !writable || busy,
              onChange: event => update('focusCursor', event.target.checked),
            }),
            t('focusCursorHelp')),

          field(t('retention'), input('retention', 'number'), t('retentionHelp'), errors.retention),
          field(t('maxImage'), input('maxImage', 'number'), t('maxImageHelp'), errors.maxImage),
          field(t('timeout'), input('timeout', 'number'), t('timeoutHelp'), errors.timeout),

          h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
            h('button', {
              type: 'button',
              disabled: !writable || busy,
              onClick: onSave,
              style: { padding: '6px 16px' },
            }, busy ? t('saving') : t('save')),
            notice !== null
              ? h('span', {
                style: { fontSize: '0.9em', color: notice.kind === 'error' ? 'crimson' : 'inherit', opacity: notice.kind === 'error' ? 1 : 0.8 },
              }, notice.text)
              : Object.keys(errors).length > 0 ? h('span', { style: { fontSize: '0.9em', color: 'crimson' } }, t('invalid')) : null),
        )
      }
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'dsh-cua: settings dictionaries')
        const t = ctx.locale.bind(NS)
        const CuaSettingsCard = createSection(ctx)
        const Id = 'dsh-cua'

        ctx.effect(() => ctx.slots.inject('settings.section', () => {
          const disposers = []
          try {
            disposers.push(ctx.slots.register({
              name: 'settings.section',
              id: Id,
              order: 30,
              label: () => t('nav.panel'),
              locale: NS,
            }, CuaSettingsCard))
            // The nav glyph shares the page id: a mismatched id never renders.
            disposers.push(ctx.slots.register({
              name: 'settings.section.icon',
              id: Id,
            }, ({ size }) => h('svg', {
              width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true,
              style: { display: 'block' },
            }, h('rect', { x: 2.5, y: 4.5, width: 19, height: 12.5, rx: 2, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
            h('path', { d: 'M12 17.5v2.5M8.5 20.5h7', stroke: 'currentColor', strokeWidth: 1.6, fill: 'none', strokeLinecap: 'round' }),
            h('path', { d: 'M8 12.2l2.6-3.1 2.3 2.6 2.7-3.4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))))
          } catch (error) {
            console.error('[dsh-cua] settings section failed to register:', error)
            for (const dispose of disposers) {
              try { dispose() } catch { /* already gone */ }
            }
            return () => {}
          }
          return () => {
            for (const dispose of disposers) {
              try { dispose() } catch { /* already gone */ }
            }
          }
        }), 'dsh-cua: settings section')
      },
    }
  },
})
