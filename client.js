/**
 * dsh-mworks-ai — Client half.
 *
 * Renders the MWORKS AI environment report as a section on this bundle's own
 * page under **Plugins**, next to the configuration the Plugin Manager draws.
 * Nothing is added to the conversation UI: the plugin contributes no composer
 * control and no chat row.
 *
 * The section renders nothing for a subject that is not this bundle, so the
 * same registration is inert on every other plugin's page.
 */
window.__ModuleLoader__.load({
  // Must equal package.json "name" verbatim.
  id: 'dsh-mworks-ai',
  factory(require) {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    var PACKAGE_NAME = 'dsh-mworks-ai'
    var LOCALE_NS = 'dshMworksAi'
    var ROUTE = '/api/dsh-mworks-ai/environment'
    var RESTART_ROUTE = '/api/dsh-mworks-ai/restart'

    var zh = {
      sectionTitle: '运行环境',
      sectionHint: '由本插件检测的 MWORKS 安装状态；技能清单来自本机 skill 目录。',
      refresh: '重新检测',
      loading: '正在检测本机 MWORKS 环境…',
      failed: '无法读取 MWORKS 环境：{error}',
      retry: '重试',
      lastChecked: '检测于 {time}',
      syslab: 'Syslab',
      sysplorer: 'Sysplorer',
      julia: 'Julia 运行时',
      juliaRoot: 'Julia 根目录',
      installRoot: '安装目录',
      status: '状态',
      notFound: '未找到',
      missingHint: '未在本机找到该产品的安装目录。安装后点「重新检测」即可；若装在其它路径，请修改本插件的 cordis.patch.yml 配置。',
      mcpServers: '官方 MCP 服务',
      mcpHint: '由本插件以 stdio 方式接入，工具名形如 mcp__mworks_syslab__* 与 mcp__mworks_sysplorer__*。下面是实时连接状态；「重新连接」只重启本插件的 MCP 子进程，不会重启 Sysplorer 或其它窗口。',
      pathsFound: '路径齐全',
      pathsMissing: '路径缺失',
      declaredTools: '连上后约 {count} 个工具',
      stateConnected: '已连接',
      stateConnecting: '连接中',
      stateReconnecting: '重连中',
      stateFailed: '连接失败',
      stateDisabled: '已停用',
      stateAbsent: '未注册',
      stateUnknown: '未知状态',
      stateUnmanaged: '无 MCP 管理器',
      reconnect: '重新连接',
      reconnecting: '正在重连…',
      reconnectFailed: '重新连接失败：{error}',
      managedTools: '{count} 个工具已注册',
      skills: '本会话可用的 MWORKS 技能',
      skillsHint: '由本插件从 MWORKS 安装目录注册，不依赖其它客户端的 skill 目录。',
      noSkills: '未找到可加载的 MWORKS 技能：请确认 MWORKS 已安装，或本机 skill 目录中存在 MWORKS 技能。',
      version: '版本 {version}',
      buildDate: '构建于 {date}',
      moreRoots: '另有 {count} 个安装目录',
    }

    var en = {
      sectionTitle: 'Runtime environment',
      sectionHint: 'The MWORKS installation this plugin detected, plus the skills found on this machine.',
      refresh: 'Re-detect',
      loading: 'Detecting the local MWORKS installation…',
      failed: 'Could not read the MWORKS environment: {error}',
      retry: 'Retry',
      lastChecked: 'Checked {time}',
      syslab: 'Syslab',
      sysplorer: 'Sysplorer',
      julia: 'Julia runtime',
      juliaRoot: 'Julia root',
      installRoot: 'Install root',
      status: 'Status',
      notFound: 'Not found',
      missingHint: 'No installation directory was found for this product. Install it and press Re-detect; if it lives elsewhere, edit this plugin configuration in cordis.patch.yml.',
      mcpServers: 'Official MCP servers',
      mcpHint: 'Bridged over stdio by this plugin; tools are named mcp__mworks_syslab__* and mcp__mworks_sysplorer__*. Below is the live connection state. Reconnect replaces only this plugin\'s MCP child; it does not restart Sysplorer or any other window.',
      pathsFound: 'Paths found',
      pathsMissing: 'Paths missing',
      declaredTools: 'about {count} tools once connected',
      stateConnected: 'Connected',
      stateConnecting: 'Connecting',
      stateReconnecting: 'Reconnecting',
      stateFailed: 'Failed',
      stateDisabled: 'Disabled',
      stateAbsent: 'Not registered',
      stateUnknown: 'Unknown state',
      stateUnmanaged: 'No MCP manager',
      reconnect: 'Reconnect',
      reconnecting: 'Reconnecting…',
      reconnectFailed: 'Reconnect failed: {error}',
      managedTools: '{count} tools registered',
      skills: 'MWORKS skills available in this session',
      skillsHint: 'Registered by this plugin from the MWORKS installation, not from another client\'s skill folder.',
      noSkills: 'No MWORKS skill could be loaded: check that MWORKS is installed, or that its skills exist in a local skill folder.',
      version: 'Version {version}',
      buildDate: 'Built {date}',
      moreRoots: '{count} more installation directories',
    }

    var CSS = [
      // The section draws its own card chrome, matching the host detail page's
      // section pattern (border-l4 card on layer-3, 16px radius).
      '.mworksai-root{margin-top:12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-panel);background:var(--dsw-alias-bg-layer-3);padding:16px;font-family:inherit;color:var(--dsw-alias-label-primary)}',
      '.mworksai-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:4px}',
      '.mworksai-title{margin:0;font-size:15px;font-weight:600;line-height:1.4}',
      '.mworksai-desc{margin:0 0 12px;font-size:12.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.mworksai-meta{margin-left:auto;font-size:12px;color:var(--dsw-alias-label-tertiary);white-space:nowrap}',
      '.mworksai-btn{appearance:none;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);background:none;color:var(--dsw-alias-label-secondary);font-family:inherit;font-size:12.5px;line-height:24px;padding:0 10px;cursor:pointer;white-space:nowrap}',
      '@media (hover:hover){.mworksai-btn:hover:not(:disabled){color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-label-dimmed)}}',
      '.mworksai-btn:disabled{opacity:.45;cursor:default}',
      '.mworksai-btn-tiny{margin-left:auto;font-size:11.5px;line-height:20px;padding:0 8px}',
      '.mworksai-btn:focus-visible{outline:none;box-shadow:0 0 0 2px var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary))}',
      '.mworksai-sec{display:flex;flex-direction:column;gap:6px;padding-top:12px;border-top:.5px solid var(--dsw-alias-border-l2)}',
      '.mworksai-sec:first-of-type{padding-top:0;border-top:0}',
      '.mworksai-sec-title{margin:0;font-size:12.5px;font-weight:600;line-height:1.4;color:var(--dsw-alias-label-secondary)}',
      '.mworksai-hint{margin:0;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}',
      '.mworksai-row{display:flex;align-items:baseline;gap:8px;font-size:12.5px;line-height:1.6;flex-wrap:wrap}',
      '.mworksai-row-label{flex:0 0 auto;min-width:96px;color:var(--dsw-alias-label-secondary)}',
      '.mworksai-row-value{flex:1;min-width:0;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}',
      '.mworksai-indent{margin-left:104px;font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      '.mworksai-chip{flex:0 0 auto;border-radius:999px;padding:0 8px;font-size:11px;line-height:18px;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary)}',
      '.mworksai-chip-ok{color:var(--dsw-alias-state-success-primary);border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-success-primary) 14%,transparent)}',
      '.mworksai-chip-warn{color:var(--dsw-alias-state-warn-label);border-color:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 40%,transparent);background:color-mix(in srgb,var(--dsw-alias-state-warn-primary) 14%,transparent)}',
      '.mworksai-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:10px 12px;display:flex;flex-direction:column;gap:4px;background:var(--dsw-alias-bg-layer-2)}',
      '.mworksai-card-title{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12.5px;font-weight:600;line-height:1.4}',
      '.mworksai-card-meta{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-tertiary);word-break:break-all}',
      '.mworksai-skills{display:flex;flex-wrap:wrap;gap:5px;margin:0;padding:0;list-style:none}',
      '.mworksai-skill{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);padding:0 6px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:18px;color:var(--dsw-alias-label-secondary)}',
      '.mworksai-error{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary);word-break:break-word}',
      '@media (max-width:520px){.mworksai-row-label{min-width:0}.mworksai-indent{margin-left:0}.mworksai-meta{margin-left:0}}',
    ].join('\n')

    function injectStyles() {
      if (document.querySelector('style[data-dsh-mworks-ai]') !== null) return
      var node = document.createElement('style')
      node.setAttribute('data-dsh-mworks-ai', '')
      node.textContent = CSS
      document.head.appendChild(node)
    }

    /** The detail page asks every section about every subject; answer for ours only. */
    function isOurSubject(subject) {
      if (subject === null || typeof subject !== 'object') return false
      if (subject.kind !== 'bundle' && subject.kind !== 'row') return false
      var pkg = subject.pkg
      return pkg !== null && typeof pkg === 'object' && pkg.name === PACKAGE_NAME
    }

    function Row(props) {
      return h(
        'div',
        { className: 'mworksai-row' },
        h('span', { className: 'mworksai-row-label' }, props.label),
        h('span', { className: 'mworksai-row-value' }, props.value),
        props.chip === undefined ? null : h('span', { className: 'mworksai-chip ' + (props.chipClass || '') }, props.chip),
      )
    }

    /** One installed product: root, version line, then the caller's extra rows. */
    function ProductSection(props) {
      var t = props.t
      var title = props.title
      var product = props.product
      var extraRows = props.extraRows || []
      if (product === undefined || product === null) return null

      if (product.installed !== true) {
        return h(
          'section',
          { className: 'mworksai-sec' },
          h('h3', { className: 'mworksai-sec-title' }, title),
          h(Row, { label: t('status'), value: t('notFound') }),
          h('p', { className: 'mworksai-hint' }, t('missingHint')),
        )
      }

      var build = product.build || {}
      var children = [
        h(Row, { key: 'root', label: t('installRoot'), value: product.root }),
      ]

      if (typeof build.version === 'string' || typeof build.buildDate === 'string') {
        var parts = []
        if (typeof build.version === 'string') parts.push(t('version', { version: build.version }))
        if (typeof build.buildDate === 'string') parts.push(t('buildDate', { date: build.buildDate }))
        children.push(h('div', { key: 'build', className: 'mworksai-indent' }, parts.join(' · ')))
      }

      for (var index = 0; index < extraRows.length; index += 1) children.push(extraRows[index])

      var otherRoots = Array.isArray(product.otherRoots) ? product.otherRoots : []
      if (otherRoots.length > 0) {
        children.push(h('div', { key: 'more', className: 'mworksai-indent' }, t('moreRoots', { count: otherRoots.length })))
      }

      return h('section', { className: 'mworksai-sec' }, h('h3', { className: 'mworksai-sec-title' }, title), children)
    }

    /** The two MCP rows. Counts are declared by the servers, not probed. */
    /** Label for one connection state, so the chip never shows a raw enum. */
    function stateLabel(t, state) {
      if (state === 'connected') return t('stateConnected')
      if (state === 'connecting') return t('stateConnecting')
      if (state === 'reconnecting') return t('stateReconnecting')
      if (state === 'failed') return t('stateFailed')
      if (state === 'disabled') return t('stateDisabled')
      if (state === 'absent') return t('stateAbsent')
      if (state === 'unmanaged') return t('stateUnmanaged')
      return t('stateUnknown')
    }

    /**
     * The two MCP cards with their live connection state and a reconnect
     * control per server. A server that stopped answering is the failure this
     * section exists to make visible: without it the only symptom is a call
     * that hangs until its timeout.
     */
    function McpSection(props) {
      var t = props.t
      var servers = props.servers
      var onReconnect = props.onReconnect
      var busyServer = props.busyServer
      var note = props.note
      if (!Array.isArray(servers) || servers.length === 0) return null

      var cards = servers.map(function (server) {
        var healthy = server.healthy === true
        var state = server.state
        var toolText = typeof server.toolCount === 'number'
          ? t('managedTools', { count: server.toolCount })
          : t('declaredTools', { count: server.declaredTools })
        var canReconnect = typeof onReconnect === 'function'
          && state !== 'connected'
          && state !== 'unmanaged'
          && server.manageable !== false
        var busy = busyServer === server.server

        return h(
          'div',
          { key: server.server, className: 'mworksai-card' },
          h(
            'div',
            { className: 'mworksai-card-title' },
            h('span', null, server.label || server.server),
            h(
              'span',
              { className: 'mworksai-chip ' + (healthy ? 'mworksai-chip-ok' : 'mworksai-chip-warn') },
              stateLabel(t, state),
            ),
            h('span', { className: 'mworksai-chip' }, toolText),
            canReconnect
              ? h('button', {
                type: 'button',
                className: 'mworksai-btn mworksai-btn-tiny',
                disabled: busy,
                onClick: function () { onReconnect(server.server) },
              }, busy ? t('reconnecting') : t('reconnect'))
              : null,
          ),
          h('div', { className: 'mworksai-card-meta' }, 'mcp__' + server.server + '__*'),
          typeof server.detail === 'string' && state !== 'connected'
            ? h('div', { className: 'mworksai-card-meta' }, server.detail)
            : null,
        )
      })

      return h(
        'section',
        { className: 'mworksai-sec' },
        h('h3', { className: 'mworksai-sec-title' }, t('mcpServers')),
        h('p', { className: 'mworksai-hint' }, t('mcpHint')),
        cards,
        typeof note === 'string' && note.length > 0
          ? h('p', { className: 'mworksai-error' }, note)
          : null,
      )
    }

    /** Skill names this session can actually call. */
    function SkillSection(props) {
      var t = props.t
      var skills = props.skills
      var names = skills !== null && skills !== undefined && Array.isArray(skills.mworks) ? skills.mworks : []

      return h(
        'section',
        { className: 'mworksai-sec' },
        h('h3', { className: 'mworksai-sec-title' }, t('skills') + ' · ' + names.length),
        h('p', { className: 'mworksai-hint' }, t('skillsHint')),
        names.length === 0
          ? h('p', { className: 'mworksai-hint' }, t('noSkills'))
          : h(
            'ul',
            { className: 'mworksai-skills' },
            names.map(function (skill) { return h('li', { key: skill, className: 'mworksai-skill' }, skill) }),
          ),
      )
    }

    /**
     * The section itself. Reading is one GET; refreshing re-runs it.
     */
    function EnvironmentSection(props) {
      var t = props.t
      var ours = isOurSubject(props.subject)

      var state = React.useState({ status: 'loading', view: null, error: null })
      var snapshot = state[0]
      var setSnapshot = state[1]
      var restart = React.useState({ server: null, note: null })
      var restartState = restart[0]
      var setRestart = restart[1]

      var load = React.useCallback(function () {
        setSnapshot({ status: 'loading', view: null, error: null })
        fetch(ROUTE, { cache: 'no-store', credentials: 'same-origin' })
          .then(function (response) {
            if (!response.ok) throw new Error(response.status + ' ' + response.statusText)
            return response.json()
          })
          .then(function (view) { setSnapshot({ status: 'ready', view: view, error: null }) })
          .catch(function (error) {
            setSnapshot({ status: 'failed', view: null, error: String((error && error.message) || error) })
          })
      }, [])

      /**
       * Rebuild one MCP server, then re-read the environment so the card shows
       * the new state instead of the stale one.
       */
      var reconnect = React.useCallback(function (server) {
        setRestart({ server: server, note: null })
        fetch(RESTART_ROUTE, {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ server: server }),
        })
          .then(function (response) {
            return response.json().then(function (data) { return { ok: response.ok, data: data } })
          })
          .then(function (result) {
            if (!result.ok || result.data === null || result.data.ok !== true) {
              var reason = result.data && result.data.error ? result.data.error : 'restart refused'
              setRestart({ server: null, note: reason })
              return
            }
            setRestart({ server: null, note: null })
            load()
          })
          .catch(function (error) {
            setRestart({ server: null, note: String((error && error.message) || error) })
          })
      }, [load])

      // Only fetch for our own page: every other plugin's page renders null.
      React.useEffect(function () {
        if (!ours) return
        load()
      }, [ours, load])

      if (!ours) return null

      var view = snapshot.view
      var body = []
      // A failed read is retried with the same control, but saying "Retry"
      // instead of "Re-detect" tells the user why it is offered again.
      var failed = snapshot.status === 'failed'
      var canRefresh = snapshot.status !== 'loading'

      if (snapshot.status === 'loading') {
        body.push(h('p', { key: 'loading', className: 'mworksai-hint' }, t('loading')))
      } else if (snapshot.status === 'failed') {
        body.push(h('p', { key: 'error', className: 'mworksai-error' }, t('failed', { error: snapshot.error })))
      } else if (view !== null && view !== undefined) {
        body.push(h(ProductSection, {
          key: 'syslab',
          t: t,
          title: t('syslab'),
          product: view.syslab,
          extraRows: [
            h(Row, {
              key: 'mcp',
              label: 'MCP',
              value: view.syslab.mcpServer === undefined || view.syslab.mcpServer === null ? t('notFound') : view.syslab.mcpServer,
              chip: view.syslab.mcpServer === undefined || view.syslab.mcpServer === null ? t('pathsMissing') : t('pathsFound'),
              chipClass: view.syslab.mcpServer === undefined || view.syslab.mcpServer === null ? 'mworksai-chip-warn' : 'mworksai-chip-ok',
            }),
          ],
        }))
        body.push(h(ProductSection, {
          key: 'sysplorer',
          t: t,
          title: t('sysplorer'),
          product: view.sysplorer,
          extraRows: [
            h(Row, {
              key: 'mcp',
              label: 'MCP',
              value: view.sysplorer.mcpLauncher === undefined || view.sysplorer.mcpLauncher === null ? t('notFound') : view.sysplorer.mcpLauncher,
              chip: view.sysplorer.mcpLauncher === undefined || view.sysplorer.mcpLauncher === null ? t('pathsMissing') : t('pathsFound'),
              chipClass: view.sysplorer.mcpLauncher === undefined || view.sysplorer.mcpLauncher === null ? 'mworksai-chip-warn' : 'mworksai-chip-ok',
            }),
          ],
        }))
        if (view.julia !== undefined && view.julia !== null) {
          body.push(h(
            'section',
            { key: 'julia', className: 'mworksai-sec' },
            h('h3', { className: 'mworksai-sec-title' }, t('julia')),
            h(Row, {
              label: t('juliaRoot'),
              value: view.julia.installed ? view.julia.root : t('notFound'),
              chip: view.julia.installed ? t('pathsFound') : t('pathsMissing'),
              chipClass: view.julia.installed ? 'mworksai-chip-ok' : 'mworksai-chip-warn',
            }),
          ))
        }
        body.push(h(McpSection, {
          key: 'mcp',
          t: t,
          servers: view.mcp !== undefined && view.mcp !== null && Array.isArray(view.mcp.servers)
            ? view.mcp.servers
            : view.mcpServers,
          onReconnect: reconnect,
          busyServer: restartState.server,
          note: restartState.note === null ? undefined : t('reconnectFailed', { error: restartState.note }),
        }))
        body.push(h(SkillSection, { key: 'skills', t: t, skills: view.skills }))
      }

      var checkedAt = view !== null && view !== undefined && typeof view.generatedAt === 'string'
        ? new Date(view.generatedAt).toLocaleTimeString()
        : undefined

      return h(
        'div',
        { className: 'mworksai-root' },
        h(
          'div',
          { className: 'mworksai-head' },
          h('h2', { className: 'mworksai-title' }, t('sectionTitle')),
          h('button', {
            type: 'button',
            className: 'mworksai-btn',
            disabled: !canRefresh,
            onClick: load,
          }, !canRefresh ? t('refresh') : failed ? t('retry') : t('refresh')),
          checkedAt === undefined
            ? null
            : h('span', { className: 'mworksai-meta' }, t('lastChecked', { time: checkedAt })),
        ),
        h('p', { className: 'mworksai-desc' }, t('sectionHint')),
        body,
      )
    }

    function apply(ctx) {
      ctx.effect(function () { injectStyles() }, 'dsh-mworks-ai: styles')

      ctx.effect(function () {
        var offZh = ctx.locale.register(LOCALE_NS, 'zh', zh)
        var offEn = ctx.locale.register(LOCALE_NS, 'en', en)
        return function () { offZh(); offEn() }
      }, 'dsh-mworks-ai: dictionaries')

      // The section sits on this bundle's own page under Plugins, after the
      // configuration the Plugin Manager draws. It renders null elsewhere.
      ctx.slots.inject('plugins.detail.section', function () {
        return ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'dsh-mworks-ai.environment',
          order: 60,
          locale: LOCALE_NS,
        }, EnvironmentSection)
      })
    }

    exports.apply = apply
    exports.inject = ['slots', 'locale']
    return module.exports
  },
})
