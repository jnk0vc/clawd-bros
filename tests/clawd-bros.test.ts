import { describe, expect, mock, test } from 'claude-code/testing'

import {
  createWorld,
  familyOf,
  hudText,
  isPiloted,
  moveOf,
  onToolCall,
  onToolResult,
  pilotInput,
  step,
} from '../hooks/engine'
import { DEFAULT_COLOR, HUD_ROWS } from '../hooks/model'
import type { World } from '../hooks/model'
import { drawFrame, gridToRasterBase64, gridToSvg } from '../hooks/render'

const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 100,
  scroll: { offset: 0, bodyRows: 11 },
  view: {},
}

const ALLOWED = new Set(
  [
    ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)),
    ...'▀▄█▌▐▖▗▘▙▚▛▜▝▞▟',
  ].map(c => c.codePointAt(0)),
)

const run = (w: World, ticks: number, tools: readonly string[] = []) => {
  for (let i = 0; i < ticks; i++) {
    const tool = tools[i % Math.max(1, tools.length)]
    if (tools.length > 0 && i % 7 === 0 && tool !== undefined) {
      onToolCall(w, tool)
      onToolResult(w, tool, false)
    }
    step(w, { isWorking: tools.length > 0 })
  }
}

const totalDamage = (w: World) => w.fighters.reduce((sum, f) => sum + f.damage, 0)
const totalStocksLost = (w: World) => w.fighters.reduce((sum, f) => sum + (3 - f.stocks), 0)

describe('engine', () => {
  test('ツール呼び出しが無くてもCPUは動き回る', () => {
    const w = createWorld(100, 10, 42)
    const start = w.fighters.map(f => f.x)
    run(w, 300)
    const moved = w.fighters.filter((f, i) => Math.abs(f.x - (start[i] ?? f.x)) > 1)
    expect(moved.length).toBeGreaterThanOrEqual(3)
    expect(totalDamage(w)).toBeGreaterThan(0)
  })

  test('ツールはファミリーと技に振り分けられる', () => {
    expect(familyOf('Edit')).toBe('write')
    expect(moveOf('Edit')).toBe('smash')
    expect(moveOf('Write')).toBe('meteor')
    expect(familyOf('Read')).toBe('read')
    expect(moveOf('Grep')).toBe('beam')
    expect(familyOf('Bash')).toBe('bash')
    expect(moveOf('Bash')).toBe('dash')
    expect(familyOf('mcp__github__create_issue')).toBe('agent')
    expect(moveOf('WebFetch')).toBe('grab')
    expect(moveOf('Agent')).toBe('assist')
  })

  test('Edit を連打するとダメージが積み上がり、いずれ撃墜が起きる', () => {
    const w = createWorld(100, 10, 7)
    run(w, 60)
    const before = totalDamage(w)
    run(w, 200, ['Edit'])
    expect(totalDamage(w) + totalStocksLost(w) * 100).toBeGreaterThan(before)
    run(w, 2500, ['Edit', 'Read', 'Bash', 'Grep', 'Write', 'WebFetch', 'Agent'])
    expect(totalStocksLost(w) + (w.matchNo > 1 ? 1 : 0)).toBeGreaterThan(0)
  })

  test('ステータスラインに全員の%が出る', () => {
    const w = createWorld(100, 10, 3)
    run(w, 40)
    const hud = hudText(w)
    for (const label of ['P1 WRITE', 'P2 READ', 'P3 BASH', 'P4 AGENT']) {
      expect(hud).toContain(label)
    }
    expect(hud).toMatch(/\d+%/)
  })
})

describe('pilot', () => {
  /** 試合開始後、P1以外を遠くで固めておく(CPUに殴られて結果がぶれないように) */
  const soloWorld = () => {
    const w = createWorld(100, 10, 5)
    run(w, 25)
    for (const f of w.fighters.slice(1)) {
      f.x = 80
      f.vx = 0
      f.stunTicks = 10_000
    }
    const p1 = w.fighters[0]
    if (p1 === undefined) throw new Error('P1 がいない')
    p1.x = 30
    p1.vx = 0

    return { w, p1 }
  }
  const tick = (w: World) => step(w, { isWorking: false })

  test('D を押し続けると右へ走り、ステータスに YOU が出る', () => {
    const { w, p1 } = soloWorld()
    const x0 = p1.x
    for (let i = 0; i < 10; i++) {
      pilotInput(w, 'right')
      tick(w)
    }
    expect(isPiloted(w)).toBe(true)
    expect(p1.x).toBeGreaterThan(x0 + 5)
    expect(p1.facing).toBe(1)
    expect(hudText(w)).toContain('P1 WRITE(YOU)')
  })

  test('W でジャンプ、< で弱攻撃、> で得意技(横スマ)を出す', () => {
    const { w, p1 } = soloWorld()
    pilotInput(w, 'jump')
    tick(w)
    tick(w)
    expect(p1.y).toBeGreaterThan(0.5)
    for (let i = 0; i < 20; i++) tick(w)
    pilotInput(w, 'attack')
    tick(w)
    expect(p1.move?.kind).toBe('jab')
    for (let i = 0; i < 10; i++) tick(w)
    pilotInput(w, 'special')
    tick(w)
    expect(p1.move?.kind).toBe('smash')
  })

  test('手動操作中はツール呼び出しで勝手に技を出さず、10秒放置でCPUに戻る', () => {
    const { w, p1 } = soloWorld()
    pilotInput(w, 'left')
    tick(w)
    onToolCall(w, 'Edit')
    expect(p1.queue).toHaveLength(0)
    for (let i = 0; i < 110; i++) tick(w)
    expect(isPiloted(w)).toBe(false)
    expect(hudText(w)).not.toContain('(YOU)')
  })
})

describe('render', () => {
  test('どのサイズでも許可した文字だけでフレームを描く', () => {
    for (const [cols, rows] of [
      [40, 7],
      [80, 10],
      [240, 10],
    ] as const) {
      const w = createWorld(cols, rows, 11)
      run(w, 400, ['Edit', 'Grep', 'Bash', 'Agent', 'Write', 'WebSearch'])
      const grid = drawFrame(w)
      expect(grid.columns).toBe(cols)
      expect(grid.rows).toBe(rows + HUD_ROWS)
      for (const code of grid.ch) expect(ALLOWED.has(code)).toBe(true)
      for (const color of [...grid.fg, ...grid.bg]) {
        expect(color === DEFAULT_COLOR || color <= 0xffffff).toBe(true)
      }
      const cells = gridToRasterBase64(grid)
      expect(cells.length).toBe(Math.ceil((cols * grid.rows * 12) / 3) * 4)
      // 最下段のHUDに4人分の%が並ぶ
      const hud = String.fromCodePoint(...grid.ch.slice(cols * rows))
      for (const p of ['P1', 'P2', 'P3', 'P4']) expect(hud).toContain(p)
      expect(hud).toMatch(/\d+%|OUT/)
      const svg = gridToSvg(grid)
      expect(svg.startsWith('<svg')).toBe(true)
      expect(svg.length).toBeLessThan(131072)
    }
  })
})

describe('band', () => {
  test('ターミナルは Raster、デスクトップは Svg で終点を描く', async $ => {
    const terminal = await $.ui.mount({
      plugin: 'clawd-bros',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: BAND,
    })
    const stage = await terminal.find({ key: 'stage' })
    expect(stage?.type).toBe('Raster')
    await terminal.unmount()

    const desktop = await $.ui.mount({
      plugin: 'clawd-bros',
      surface: 'desktop',
      component: 'AbovePrompt',
      props: BAND,
    })
    expect(await desktop.find({ type: 'Svg' })).toBeDefined()
    await desktop.unmount()
  })

  test('コントローラー行のキーでP1が手動操作になり、ステータスに YOU が出る', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    const statuses: (string | undefined)[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.status', ($, e) => {
      statuses.push(e.text)

      return { value: undefined }
    })
    on('ui.log', () => ({ value: undefined }))
    on('ui.blit', () => ({ value: {} }))
    on('ui.invalidate', () => ({ value: undefined }))

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({ plugin: 'clawd-bros', surface, component: 'AbovePrompt', props: BAND })
      expect(await ui.find({ text: /P1を操作/, in: 'pad' })).toBeDefined()
      await ui.key({ key: 'd', in: 'pad' })
      await ui.key({ key: '<', shift: true, in: 'pad' })
      await ui.advance(100)
      expect(await ui.find({ text: /YOU/, in: 'pad' })).toBeDefined()
      await clock.advance(500)
      expect(statuses.at(-1)).toContain('P1 WRITE(YOU)')
      await ui.unmount()
    }
  })

  test('/clear の後もループは止まらず、/clawd-bros で一時停止が次回起動まで残る', async ($, on) => {
    const clock = mock.clock(on)
    const stored = new Map<string, unknown>()
    on('store.get', ($, e) => ({ value: stored.get(e.key) }))
    on('store.set', ($, e) => {
      stored.set(e.key, e.value)

      return { value: undefined }
    })
    const statuses: (string | undefined)[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.end', ($, e) => ({ sessionId: e.sessionId }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('command.run', () => ({}))
    on('ui.status', ($, e) => {
      statuses.push(e.text)

      return { value: undefined }
    })
    on('ui.toast', () => ({ value: undefined }))
    on('ui.log', () => ({ value: undefined }))
    on('ui.blit', () => ({ value: {} }))
    on('ui.invalidate', () => ({ value: undefined }))

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await $.session.end({ reason: 'clear', sessionId: 'old' } as never)
    statuses.length = 0
    await clock.advance(1000)
    expect(statuses.length).toBeGreaterThan(0)

    await $.command.run({ command: 'clawd-bros', args: '' } as never)
    expect(statuses.at(-1)).toBeUndefined()
    expect(stored.get('isPaused')).toBe(true)

    await $.command.run({ command: 'clawd-bros', args: 'typo' } as never)
    expect(stored.get('isPaused')).toBe(true)
  })

  test('アンケート表示中は帯を譲る', async ($, on) => {
    // エンジン側の帯(アンケート)の代役
    on('ui.render', ($, e) => {
      const { Text } = $.ui.resolve(e)

      return Text({ children: 'survey' })
    })
    const ui = await $.ui.mount({
      plugin: 'clawd-bros',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { ...BAND, hasSurvey: true },
    })
    expect(await ui.find({ key: 'stage' })).toBeUndefined()
    await ui.unmount()
  })

  test('セッション開始でループが回り、ツール呼び出しがステータスラインに出る', async ($, on) => {
    const clock = mock.clock(on)
    mock.store(on)
    const statuses: (string | undefined)[] = []
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('command.register', ($, e) => ({ value: { command: e.name } }))
    on('ui.status', ($, e) => {
      statuses.push(e.text)

      return { value: undefined }
    })
    on('ui.log', () => ({ value: undefined }))
    on('ui.blit', () => ({ value: {} }))
    on('ui.invalidate', () => ({ value: undefined }))
    on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }) as never)

    await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
    await clock.advance(2000)
    expect(statuses.some(text => text?.includes('CLAWD BROS'))).toBe(true)

    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await clock.advance(1000)
    expect(statuses.some(text => text?.includes('Bash'))).toBe(true)
  })
})
