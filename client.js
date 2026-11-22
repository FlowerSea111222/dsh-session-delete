// Client half: a native "Delete session…" item on the Session row menu plus a
// confirmation dialog built from the app's own primitives, so the whole
// surface follows the current appearance settings (theme, density, font size).
window.__ModuleLoader__.load({
  id: '@local/dsh-session-delete',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')

    const { Button, IconTrashOutlineRegular, Modal } = primitives
    const h = React.createElement

    const DELETE_URL = '/api/dsh-session-delete/delete'
    const STYLE_ID = 'dssd-styles'
    const ICON_KEY = 'session.delete'

    const MESSAGES = {
      en: {
        menu: 'Delete session…',
        title: 'Delete this session permanently?',
        desc: (vars) => `"${vars.title}" and its stored transcript will be removed from disk. This cannot be undone.`,
        confirm: 'Delete permanently',
        deleting: 'Deleting…',
        cancel: 'Cancel',
        close: 'Close',
        failed: (vars) => `Delete failed: ${vars.error}`,
        busy: 'This session still has running work. Stop it first, then delete.',
        locked: 'Another program is holding this session’s files. Try again, or restart DSH.',
        current: 'This session is open in this window. Switch to another session before deleting it.',
      },
      zh: {
        menu: '删除会话…',
        title: '永久删除这个会话？',
        desc: (vars) => `“${vars.title}”及其对话记录会从磁盘移除，此操作不可撤销。`,
        confirm: '永久删除',
        deleting: '正在删除…',
        cancel: '取消',
        close: '关闭',
        failed: (vars) => `删除失败：${vars.error}`,
        busy: '这个会话还有正在运行的工作，先停止再删除。',
        locked: '有其他程序占用着这个会话的文件，请稍后重试，或重启 DSH。',
        current: '这个会话正在当前窗口打开，请先切换到别的会话再删除。',
      },
    }

    /** Pick the dictionary from the document language. */
    function dictionary() {
      const tag = (typeof document === 'undefined' ? '' : document.documentElement.lang)
        || (typeof navigator === 'undefined' ? '' : navigator.language)
        || 'en'
      return String(tag).toLowerCase().startsWith('zh') ? MESSAGES.zh : MESSAGES.en
    }

    /** Read one message, formatting its variables. */
    function t(key, vars) {
      const entry = dictionary()[key]
      if (typeof entry === 'function') return entry(vars ?? {})
      if (vars && typeof entry === 'string') {
        return entry.replace(/\{(\w+)\}/g, (whole, name) => String(vars[name] ?? whole))
      }
      return entry ?? key
    }

    /** The dialog request shared between the menu action and the overlay seat. */
    let pending = null
    const listeners = new Set()

    function setPending(request) {
      pending = request
      for (const listener of [...listeners]) listener()
    }

    function usePending() {
      const [, rerender] = React.useReducer((value) => value + 1, 0)
      React.useEffect(() => {
        listeners.add(rerender)
        return () => { listeners.delete(rerender) }
      }, [])
      return pending
    }

    /** One token-only rule: the destructive label and the two status lines. */
    function ensureStyles() {
      if (typeof document === 'undefined' || document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = [
        '.dssd-danger:not(:disabled){color:var(--dsw-alias-state-error-primary,#ef7272)}',
        '.dssd-status,.dssd-error{font-size:inherit;margin-top:8px;line-height:1.6}',
        '.dssd-status{color:var(--dsw-alias-label-tertiary,#a0a0a0)}',
        '.dssd-error{color:var(--dsw-alias-state-error-primary,#ef7272)}',
      ].join('')
      document.head.appendChild(style)
    }

    /** Ask the Host to erase the Session directory. */
    async function requestDelete(sessionId) {
      const response = await fetch(new URL(DELETE_URL, document.baseURI), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        throw new Error(`HTTP ${response.status}`)
      }
      if (payload?.ok !== true) {
        const error = new Error(payload?.error ?? payload?.code ?? `HTTP ${response.status}`)
        error.code = payload?.code
        throw error
      }
      return payload.data
    }

    /** The open dialog for the current request; nothing while none is pending. */
    function DeleteDialog() {
      const request = usePending()
      if (request === null) return null
      return h(DeleteForm, { key: request.sessionId, request })
    }

    /** One request's dialog: busy and error state die with it. */
    function DeleteForm({ request }) {
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(request.blocked === true ? t('current') : null)

      const close = () => {
        if (busy) return
        setPending(null)
      }

      const confirm = () => {
        // The window may have navigated to this Session while the dialog was open.
        if (shownInMainView(request.sessionId)) {
          setError(t('current'))
          return
        }
        setBusy(true)
        setError(null)
        requestDelete(request.sessionId).then(() => {
          setBusy(false)
          setPending(null)
          // The row is gone from disk already, so a refresh failure is not a failure.
          try {
            const sessions = hostCtx === null ? undefined : hostCtx.get('sessions')
            if (sessions !== undefined && typeof sessions.refresh === 'function') sessions.refresh()
          } catch {
            // The next list refresh reconciles the row.
          }
        }).catch((reason) => {
          setBusy(false)
          const code = reason instanceof Error ? reason.code : undefined
          if (code === 'session/busy') {
            setError(t('busy'))
            return
          }
          if (code === 'session/locked') {
            setError(t('locked'))
            return
          }
          setError(t('failed', { error: reason instanceof Error ? reason.message : String(reason) }))
        })
      }

      return h(
        Modal,
        {
          open: true,
          onClose: close,
          closeLabel: t('close'),
          title: t('title'),
          description: t('desc', { title: request.displayTitle || request.sessionId }),
          footer: h(
            React.Fragment,
            null,
            h(Button, { variant: 'outline', disabled: busy, onClick: close }, t('cancel')),
            h(Button, { variant: 'outline', className: 'dssd-danger', disabled: busy || request.blocked === true, onClick: confirm }, busy ? t('deleting') : t('confirm')),
          ),
        },
        error !== null ? h('div', { className: 'dssd-error', role: 'alert' }, error) : null,
        busy ? h('div', { className: 'dssd-status', role: 'status' }, t('deleting')) : null,
      )
    }

    /** The client context, kept for the Session baseline refresh after a delete. */
    let hostCtx = null

    /**
     * Retention info for one Session, or undefined when the Client cannot answer.
     * The Client keeps a `mainView` reference only while a Session is the open
     * conversation, which is exactly the case a delete must not touch.
     * @param sessionId - the Session in question.
     */
    function retainInfoOf(sessionId) {
      try {
        const sessions = hostCtx === null ? undefined : hostCtx.get('sessions')
        if (sessions === undefined || sessions === null || typeof sessions.retainInfo !== 'function') return undefined
        return sessions.retainInfo(sessionId)
      } catch {
        return undefined
      }
    }

    /**
     * True while the main conversation view holds this Session open.
     * @param sessionId - the Session in question.
     */
    function shownInMainView(sessionId) {
      const snapshot = retainInfoOf(sessionId)?.getSnapshot?.()
      return Boolean(snapshot) && (snapshot.retainedBy?.mainView ?? 0) > 0
    }

    /** Register the native Session menu item and the confirmation dialog. */
    function apply(ctx) {
      hostCtx = ctx
      ensureStyles()

      const menus = ctx.contextMenus ?? (typeof ctx.get === 'function' ? ctx.get('contextMenus') : undefined)
      const hasIcon = typeof IconTrashOutlineRegular === 'function'
      if (hasIcon) {
        // The menu renders `icon.key` through the `contextMenu.icon` slot, so the
        // key has to be registered here; the component is the app's own outline
        // trash icon, the same family as the built-in items.
        ctx.slots.inject('contextMenu.icon', () => ctx.slots.register({
          name: 'contextMenu.icon',
          key: ICON_KEY,
        }, IconTrashOutlineRegular))
      }
      if (menus !== undefined && menus !== null && typeof menus.register === 'function') {
        ctx.effect(() => menus.register({
          id: 'session.delete',
          target: 'session',
          order: 550,
          observe: () => [],
          resolve: (target) => [{
            id: 'delete',
            label: t('menu'),
            ...hasIcon ? { icon: { key: ICON_KEY } } : {},
            danger: true,
            separatorBefore: true,
            run: () => {
              setPending({
                sessionId: target.sessionId,
                displayTitle: target.displayTitle,
                blocked: shownInMainView(target.sessionId),
              })
            },
          }],
        }), 'session-delete: session menu')
      } else {
        console.warn('dsh-session-delete: the Session menu service is unavailable, the delete item was not added')
      }

      ctx.slots.inject('shell.overlay', () => ctx.slots.register({
        name: 'shell.overlay',
        id: 'session-delete.dialog',
      }, DeleteDialog))
    }

    return {
      inject: ['slots', 'contextMenus'],
      apply,
    }
  },
})
