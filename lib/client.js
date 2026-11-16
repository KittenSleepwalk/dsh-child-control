/**
 * dsh-child-control — 浏览器端。
 *
 * 往会话头部动作区（`conversation.session.header.actions`）放一个「子智能体」
 * 按钮，点开是当前会话的完整子进程表单：子智能体行（状态 / 深度 / 类型）+ 后台
 * 作业行，支持一键全部停止、单行停止、发送提示词（冷启动自动 resume）、删除会话、
 * 以及新增子智能体并注入知识。所有控制走宿主端 `/dsh-child-control/*` 路由，
 * 本文件不 require 任何 @deepseek-ai 包（只 require 平台种子 `react`）。
 *
 * 手写 CJS 工厂是刻意的：客户端 bundle 由 `__ModuleLoader__` 直接执行，不需要
 * 打包器，也就不需要把插件放进 dsh-web 仓库的构建链。
 *
 * @module dsh-child-control/client
 */

window.__ModuleLoader__.load({
  id: '@kittensleepwalk/dsh-child-control',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    var React = require('react')
    var h = React.createElement

    var API = '/dsh-child-control'
    var SLOT = 'conversation.session.header.actions'

    /* ------------------------------------------------------------- style --- */

    var CSS = [
      '.dcc-btn{appearance:none;display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 10px;',
      'border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.28));background:var(--dsw-alias-fill-subtle,transparent);',
      'color:var(--dsw-alias-label-secondary,inherit);border-radius:999px;font:inherit;font-size:12px;font-weight:500;cursor:pointer}',
      '.dcc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12));color:var(--dsw-alias-label-primary,inherit)}',
      '.dcc-btn:disabled{opacity:.5;cursor:default}',
      '.dcc-badge{min-width:16px;height:16px;padding:0 5px;border-radius:999px;background:var(--dsw-alias-state-business-primary,#3b82f6);',
      'color:#fff;font-size:10px;font-weight:700;line-height:16px;text-align:center}',
      '.dcc-badge-live{background:var(--dsw-alias-state-warn-primary,#f59e0b)}',
      '.dcc-pop{position:fixed;z-index:2147483000;width:620px;max-width:calc(100vw - 24px);max-height:min(72vh,720px);overflow:auto;',
      'box-sizing:border-box;padding:12px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));',
      'border-radius:12px;background:var(--dsw-alias-bg-layer-2,#1e1f22);color:var(--dsw-alias-label-primary,inherit);',
      'box-shadow:0 18px 48px rgba(0,0,0,.34);font-size:12px}',
      '.dcc-head{display:flex;align-items:center;gap:8px;margin-bottom:10px}',
      '.dcc-title{font-size:13px;font-weight:650;flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dcc-sub{color:var(--dsw-alias-label-tertiary,inherit);font-size:11px;font-weight:400}',
      '.dcc-err{display:flex;gap:8px;justify-content:space-between;align-items:flex-start;margin:0 0 8px;padding:8px 10px;border-radius:9px;',
      'border:1px solid color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 40%,transparent);',
      'background:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 10%,transparent);color:var(--dsw-alias-state-error-primary,#ef4444)}',
      '.dcc-note{margin:0 0 8px;padding:7px 10px;border-radius:9px;background:var(--dsw-alias-fill-subtle,rgba(127,127,127,.1));',
      'color:var(--dsw-alias-label-secondary,inherit)}',
      '.dcc-form{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;margin:0 0 10px}',
      '.dcc-in,.dcc-ta{box-sizing:border-box;width:100%;padding:6px 9px;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));',
      'border-radius:8px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.18));color:inherit;font:inherit;font-size:12px;resize:vertical}',
      '.dcc-ta{min-height:52px;grid-column:1 / -1}',
      '.dcc-list{display:flex;flex-direction:column;gap:6px}',
      '.dcc-row{border:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.2));border-radius:10px;padding:7px 9px;',
      'background:var(--dsw-alias-fill-subtle,rgba(127,127,127,.06))}',
      '.dcc-row-top{display:flex;align-items:center;gap:8px;min-width:0}',
      '.dcc-dot{width:8px;height:8px;border-radius:50%;flex:none;background:var(--dsw-alias-label-tertiary,#777)}',
      '.dcc-dot-running{background:var(--dsw-alias-state-business-primary,#3b82f6);box-shadow:0 0 0 3px color-mix(in srgb,var(--dsw-alias-state-business-primary,#3b82f6) 22%,transparent)}',
      '.dcc-dot-idle{background:var(--dsw-alias-state-warn-primary,#f59e0b)}',
      '.dcc-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550}',
      '.dcc-meta{flex:none;color:var(--dsw-alias-label-tertiary,inherit);font-size:11px;white-space:nowrap}',
      '.dcc-id{color:var(--dsw-alias-label-tertiary,inherit);font-size:10px;font-family:ui-monospace,Menlo,Consolas,monospace;',
      'overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dcc-acts{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}',
      '.dcc-danger{border-color:color-mix(in srgb,var(--dsw-alias-state-error-primary,#ef4444) 45%,transparent);',
      'color:var(--dsw-alias-state-error-primary,#ef4444)}',
      '.dcc-sec{margin:14px 0 6px;font-size:11px;font-weight:600;letter-spacing:.02em;color:var(--dsw-alias-label-secondary,inherit);',
      'text-transform:uppercase}',
      '.dcc-empty{color:var(--dsw-alias-label-tertiary,inherit);padding:8px 2px}',
      '.dcc-foot{display:flex;align-items:center;gap:8px;margin-top:12px;flex-wrap:wrap}',
      '.dcc-chk{display:inline-flex;align-items:center;gap:6px;color:var(--dsw-alias-label-secondary,inherit)}',
    ].join('')

    /* -------------------------------------------------------------- api --- */

    async function request(path, init) {
      var response = await fetch(API + path, init)
      var body = await response.text()
      var value = {}
      if (body !== '') {
        try {
          value = JSON.parse(body)
        } catch (error) {
          value = { ok: false, error: 'bad-response', message: body.slice(0, 200) }
        }
      }
      if (response.ok !== true || value.ok === false) {
        var failure = new Error(value.message || value.error || ('HTTP ' + response.status))
        failure.code = value.error || 'http-' + response.status
        throw failure
      }
      return value
    }

    function post(path, body) {
      return request(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body || {}),
      })
    }

    function tree(sessionId) {
      return request('/tree?sessionId=' + encodeURIComponent(sessionId))
    }

    /* ----------------------------------------------------------- helpers -- */

    function shortId(id) {
      var value = String(id)
      return value.length > 14 ? value.slice(0, 8) + '…' + value.slice(-4) : value
    }

    function modeText(row) {
      if (row.mode === 'continuable') return '可续会话'
      if (row.mode === 'one-shot') return '一次性'
      if (row.durable) return '会话'
      return '进程内'
    }

    function statusText(row) {
      if (row.live !== true) return '未驻留'
      return row.status === 'running' ? '运行中' : '空闲'
    }

    function dotClass(row) {
      if (row.live !== true) return 'dcc-dot'
      return row.status === 'running' ? 'dcc-dot dcc-dot-running' : 'dcc-dot dcc-dot-idle'
    }

    function jobStateText(status) {
      if (status === 'running') return '运行中'
      if (status === 'stopping') return '停止中'
      if (status === 'completed') return '已完成'
      if (status === 'killed') return '已终止'
      if (status === 'failed') return '失败'
      return String(status)
    }

    /* ------------------------------------------------------------- panel -- */

    function Panel(props) {
      var sessionId = props.sessionId === undefined || props.sessionId === null ? '' : String(props.sessionId)
      var [open, setOpen] = React.useState(false)
      var [data, setData] = React.useState(null)
      var [failure, setFailure] = React.useState('')
      var [note, setNote] = React.useState('')
      var [busy, setBusy] = React.useState('')
      var [expanded, setExpanded] = React.useState('')
      var [drafts, setDrafts] = React.useState({})
      var [label, setLabel] = React.useState('')
      var [inject, setInject] = React.useState('')
      var [includeRoot, setIncludeRoot] = React.useState(false)
      var [confirmStop, setConfirmStop] = React.useState(false)
      var [rect, setRect] = React.useState(null)
      var triggerRef = React.useRef(null)
      var panelRef = React.useRef(null)

      var refresh = React.useCallback(() => {
        if (sessionId === '') return
        return tree(sessionId).then(
          function (value) { setData(value); setFailure('') },
          function (error) { setFailure(String(error.message || error)) },
        )
      }, [sessionId])

      React.useEffect(function () {
        if (open !== true) return undefined
        refresh()
        var timer = setInterval(refresh, 2500)
        return function () { clearInterval(timer) }
      }, [open, refresh])

      React.useEffect(function () {
        if (open !== true) return undefined
        var place = function () {
          var node = triggerRef.current
          if (node === null || node === undefined) return
          var box = node.getBoundingClientRect()
          var width = Math.min(620, window.innerWidth - 24)
          var left = Math.max(12, Math.min(box.left, window.innerWidth - width - 12))
          setRect({ top: box.bottom + 6, left: left, width: width })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        return function () {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open])

      React.useEffect(function () {
        if (open !== true) return undefined
        var onDown = function (event) {
          var target = event.target
          if (panelRef.current !== null && panelRef.current !== undefined && panelRef.current.contains(target)) return
          if (triggerRef.current !== null && triggerRef.current !== undefined && triggerRef.current.contains(target)) return
          setOpen(false)
          setConfirmStop(false)
        }
        var onKey = function (event) { if (event.key === 'Escape') { setOpen(false); setConfirmStop(false) } }
        document.addEventListener('pointerdown', onDown, true)
        document.addEventListener('keydown', onKey)
        return function () {
          document.removeEventListener('pointerdown', onDown, true)
          document.removeEventListener('keydown', onKey)
        }
      }, [open])

      if (sessionId === '') return null

      function run(key, action) {
        setBusy(key)
        setNote('')
        return Promise.resolve()
          .then(action)
          .then(
            function (message) { if (message) setNote(message); return refresh() },
            function (error) { setFailure(String(error.message || error)) },
          )
          .then(function () { setBusy('') })
      }

      function doStopAll() {
        setConfirmStop(false)
        run('stopAll', function () {
          return post('/stop-all', { sessionId: sessionId, includeRoot: includeRoot }).then(function (value) {
            var live = value.stillLive === undefined ? [] : value.stillLive
            return '已停止 ' + value.before + ' 个子智能体' + (live.length === 0 ? '（全部释放）' : '，仍有 ' + live.length + ' 个在运行')
          })
        })
      }

      function doStop(row) {
        run('stop:' + row.id, function () {
          return post('/stop', { sessionId: sessionId, childId: row.id }).then(function (value) {
            var remaining = value.stillLive === undefined ? [] : value.stillLive
            return remaining.length > 0 ? '停止请求已下发，目标仍在收尾' : '已停止 ' + shortId(row.id)
          })
        })
      }

      function doSend(row) {
        var content = drafts[row.id] === undefined ? '' : drafts[row.id]
        if (String(content).trim() === '') { setFailure('请先输入提示词'); return }
        run('send:' + row.id, function () {
          return post('/prompt', { sessionId: sessionId, childId: row.id, text: content, delivery: 'queue' }).then(function () {
            setDrafts(function (previous) {
              var next = Object.assign({}, previous)
              delete next[row.id]
              return next
            })
            return '提示词已送达 ' + shortId(row.id)
          })
        })
      }

      function doDeleteSession(row) {
        run('del:' + row.id, function () {
          return post('/session/delete', { sessionId: sessionId, childId: row.id, stopFirst: true }).then(function () {
            return '会话已移入回收目录'
          })
        })
      }

      function doAdd() {
        if (String(inject).trim() === '' && String(label).trim() === '') {
          setFailure('请至少填写名称或注入提示词')
          return
        }
        run('add', function () {
          return post('/add', { sessionId: sessionId, label: label, prompt: inject }).then(function (value) {
            setLabel('')
            setInject('')
            return '已创建子智能体 ' + shortId(value.childId)
          })
        })
      }

      var rows = data === null || data.rows === undefined ? [] : data.rows
      var jobs = data === null || data.jobs === undefined ? [] : data.jobs
      var liveCount = rows.filter(function (row) { return row.live === true }).length
      var runningCount = rows.filter(function (row) { return row.status === 'running' }).length

      var trigger = h('button', {
        type: 'button',
        ref: triggerRef,
        className: 'dcc-btn',
        title: '子智能体与子进程',
        onClick: function () { setOpen(!open); setFailure(''); setNote('') },
      }, h('span', null, '子智能体'),
        rows.length > 0 ? h('span', { className: runningCount > 0 ? 'dcc-badge dcc-badge-live' : 'dcc-badge' },
          String(runningCount > 0 ? runningCount + '/' + rows.length : rows.length)) : null)

      if (open !== true) return trigger

      var panelStyle = rect === null
        ? { top: 56, left: 12 }
        : { top: rect.top, left: rect.left, width: rect.width }

      var children = []
      children.push(h('div', { className: 'dcc-head', key: 'head' },
        h('div', { className: 'dcc-title' }, '子智能体 / 子进程',
          h('span', { className: 'dcc-sub' },
            ' ' + rows.length + ' 个子智能体（' + liveCount + ' 驻留），' + jobs.length + ' 个后台作业')),
        h('button', { type: 'button', className: 'dcc-btn', onClick: refresh, disabled: busy !== '' }, '刷新')))

      if (failure !== '') {
        children.push(h('div', { className: 'dcc-err', key: 'err' },
          h('span', null, failure),
          h('button', { type: 'button', className: 'dcc-btn', onClick: function () { setFailure('') } }, '关闭')))
      }
      if (note !== '') children.push(h('div', { className: 'dcc-note', key: 'note' }, note))

      children.push(h('div', { className: 'dcc-form', key: 'form' },
        h('input', {
          className: 'dcc-in',
          placeholder: '名称（可选）',
          value: label,
          onChange: function (event) { setLabel(event.target.value) },
        }),
        h('button', {
          type: 'button',
          className: 'dcc-btn',
          disabled: busy !== '',
          onClick: doAdd,
        }, busy === 'add' ? '创建中…' : '添加子智能体'),
        h('textarea', {
          className: 'dcc-ta',
          placeholder: '注入提示词 / 原始知识（留空则只做一次就绪握手）',
          value: inject,
          onChange: function (event) { setInject(event.target.value) },
        })))

      var list = []
      for (var index = 0; index < rows.length; index += 1) {
        list.push(renderRow(rows[index], index))
      }
      children.push(h('div', { className: 'dcc-sec', key: 'sec-agents' }, '子智能体'))
      children.push(rows.length === 0
        ? h('div', { className: 'dcc-empty', key: 'empty' }, '当前会话没有子智能体。')
        : h('div', { className: 'dcc-list', key: 'rows' }, list))

      if (jobs.length > 0) {
        children.push(h('div', { className: 'dcc-sec', key: 'sec-jobs' }, '后台作业（bash / 后台子智能体）'))
        children.push(h('div', { className: 'dcc-list', key: 'jobs' }, jobs.map(function (job) {
          return h('div', { className: 'dcc-row', key: 'job:' + job.id },
            h('div', { className: 'dcc-row-top' },
              h('span', { className: 'dcc-dot' + (job.status === 'running' ? ' dcc-dot-running' : '') }),
              h('span', { className: 'dcc-name' }, job.label || job.kind || job.id),
              h('span', { className: 'dcc-meta' }, job.kind + ' · ' + jobStateText(job.status))),
            h('div', { className: 'dcc-id' }, job.id + (job.ownerSession ? ' · owner ' + shortId(job.ownerSession) : '')))
        })))
      }

      children.push(h('div', { className: 'dcc-foot', key: 'foot' },
        confirmStop === true
          ? h('span', null,
            h('span', { className: 'dcc-meta' }, '确认停止全部 ' + rows.length + ' 个子智能体与其后台作业？'),
            h('button', { type: 'button', className: 'dcc-btn dcc-danger', onClick: doStopAll }, '确认停止'),
            h('button', { type: 'button', className: 'dcc-btn', onClick: function () { setConfirmStop(false) } }, '取消'))
          : h('button', {
            type: 'button',
            className: 'dcc-btn dcc-danger',
            disabled: busy !== '' || rows.length === 0,
            onClick: function () { setConfirmStop(true) },
          }, '一键停止全部子智能体'),
        h('label', { className: 'dcc-chk' },
          h('input', {
            type: 'checkbox',
            checked: includeRoot,
            onChange: function (event) { setIncludeRoot(event.target.checked) },
          }),
          '同时中止主会话当前轮')))

      return h('span', { key: 'wrap' }, trigger,
        h('div', { className: 'dcc-pop', ref: panelRef, style: panelStyle }, children))

      function renderRow(row, position) {
        var isOpen = expanded === row.id
        var head = h('div', {
          className: 'dcc-row-top',
          style: { cursor: 'pointer' },
          onClick: function () { setExpanded(isOpen ? '' : row.id) },
        },
          h('span', { className: dotClass(row) }),
          h('span', { className: 'dcc-name' }, (row.label === '' ? shortId(row.id) : row.label)),
          h('span', { className: 'dcc-meta' }, statusText(row) + ' · ' + modeText(row) + ' · L' + row.depth))

        var body = [
          h('div', { className: 'dcc-id', key: 'id' }, row.id + (row.parentId ? '  ←  ' + shortId(row.parentId) : '')),
        ]
        if (isOpen === true) {
          body.push(h('textarea', {
            key: 'ta',
            className: 'dcc-ta',
            placeholder: '输入提示词（发送即开始/继续该子智能体的会话，冷会话会自动 resume）',
            value: drafts[row.id] === undefined ? '' : drafts[row.id],
            onChange: function (event) {
              var value = event.target.value
              setDrafts(function (previous) { return Object.assign({}, previous, { [row.id]: value }) })
            },
          }))
          body.push(h('div', { className: 'dcc-acts', key: 'acts' },
            h('button', {
              type: 'button',
              className: 'dcc-btn',
              disabled: busy !== '',
              onClick: function () { doSend(row) },
            }, busy === 'send:' + row.id ? '发送中…' : '开始会话 / 发送提示词'),
            h('button', {
              type: 'button',
              className: 'dcc-btn',
              disabled: busy !== '' || row.live !== true,
              onClick: function () { doStop(row) },
            }, '停止'),
            h('button', {
              type: 'button',
              className: 'dcc-btn dcc-danger',
              disabled: busy !== '',
              onClick: function () { doDeleteSession(row) },
            }, '删除会话')))
        }
        return h('div', { className: 'dcc-row', key: row.id + ':' + position }, head, body)
      }
    }

    /* ------------------------------------------------------------ plugin -- */

    var inject = ['slots']

    function apply(ctx) {
      var style = document.createElement('style')
      style.setAttribute('data-dsh-child-control', '1')
      style.textContent = CSS
      document.head.appendChild(style)
      ctx.effect(function () {
        return function () {
          if (style.parentNode !== null) style.parentNode.removeChild(style)
        }
      }, 'dsh-child-control: styles')
      ctx.slots.inject(SLOT, function () {
        return ctx.slots.register({ name: SLOT, id: 'child-control', order: 30 }, Panel)
      })
    }

    exports.apply = apply
    exports.inject = inject
    exports.Panel = Panel
    return module.exports
  },
})
