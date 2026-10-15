import { describe, expect, mock, test } from 'claude-code/testing'

import {
  createWorld,
  familyOf,
  hudText,
  moveOf,
  onToolCall,
  onToolResult,
  step,
} from '../hooks/engine'
import { DEFAULT_COLOR } from '../hooks/model'
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
      expect(grid.rows).toBe(rows)
      for (const code of grid.ch) expect(ALLOWED.has(code)).toBe(true)
      for (const color of [...grid.fg, ...grid.bg]) {
        expect(color === DEFAULT_COLOR || color <= 0xffffff).toBe(true)
      }
      const cells = gridToRasterBase64(grid)
      expect(cells.length).toBe(Math.ceil((cols * rows * 12) / 3) * 4)
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
