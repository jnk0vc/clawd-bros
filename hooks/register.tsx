import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { ClawdBrosState } from '../types'
import {
  createWorld,
  hudText,
  newMatch,
  onPrompt,
  onToolCall,
  onToolResult,
  resizeWorld,
  step,
} from './engine'
import { MAX_COLUMNS, MAX_ROWS, MIN_COLUMNS, MIN_ROWS, TICK_MS } from './model'
import type { World } from './model'
import { drawFrame, gridToRasterBase64, gridToSvg } from './render'

const COMMAND = 'clawd-bros'
const STAGE_KEY = 'stage'
/** デスクトップは再描画1回が重いので2ティックに1回(5fps) */
const REMOTE_EVERY = 2
/** 非ターミナル面の描画がこのティック数途絶えたら、そちら向けの更新を止める */
const REMOTE_IDLE_TICKS = 50

const initialFrame: ClawdBrosState['frame'] = 0
const frame = atom({ plugin: 'clawd-bros', key: 'frame' } as const, initialFrame)
const isPaused = atom({ plugin: 'clawd-bros', key: 'isPaused' } as const, false)

type Mount = { requestId: string; columns: number; rows: number }

// ゲームの状態はモジュール変数に持つ(ホットリロードで試合がやり直しになるだけで害はない)
const game: {
  world: World | null
  loop: Timer | null
  mount: Mount | null
  isWorking: boolean
  lastStatus: string | undefined
  lastRemoteDraw: number
  denies: number
  lastInvalidate: number
  seed: number
} = {
  world: null,
  loop: null,
  mount: null,
  isWorking: false,
  lastStatus: undefined,
  lastRemoteDraw: Number.NEGATIVE_INFINITY,
  denies: 0,
  lastInvalidate: Number.NEGATIVE_INFINITY,
  seed: 1,
}

function ensureWorld(columns: number, rows: number): World {
  if (game.world === null) {
    game.world = createWorld(columns, rows, game.seed)
  } else if (game.world.width !== columns || game.world.height !== rows) {
    resizeWorld(game.world, columns, rows)
  }

  return game.world
}

function noteDeny($: EngineInterface, w: World): void {
  game.denies += 1
  // 帯が畳まれた・サイズが変わった等。描き直しを頼んで Raster を貼り直してもらう
  if (game.denies >= 5 && w.tick - game.lastInvalidate >= 20) {
    game.lastInvalidate = w.tick
    $.ui.invalidate('ui.render')
  }
}

function tick($: EngineInterface): void {
  const w = game.world
  if (w === null) return
  step(w, { isWorking: game.isWorking })

  const target = game.mount
  // 失敗が続く間は10ティックに1回だけ試す(畳まれた帯へ毎回エンコードしない)
  if (target !== null && (game.denies < 5 || w.tick % 10 === 0)) {
    if (target.columns !== w.width || target.rows !== w.height) {
      noteDeny($, w)
    } else {
      $.ui
        .blit({
          requestId: target.requestId,
          key: STAGE_KEY,
          cells: gridToRasterBase64(drawFrame(w)),
          columns: target.columns,
          rows: target.rows,
        })
        .then(
          result => {
            if (result.deny === undefined) game.denies = 0
            else noteDeny($, w)
          },
          () => noteDeny($, w),
        )
    }
  }

  if (w.tick - game.lastRemoteDraw < REMOTE_IDLE_TICKS && w.tick % REMOTE_EVERY === 0) {
    update($, frame, n => n + 1).catch(() => undefined)
  }

  const hud = hudText(w)
  if (hud !== game.lastStatus) {
    game.lastStatus = hud
    $.ui.status(hud)
  }
}

function runTick($: EngineInterface): void {
  try {
    tick($)
  } catch (error) {
    $.ui.log(`clawd-bros: tick failed: ${String(error)}`, { to: 'debug' })
  }
}

function startLoop($: EngineInterface): void {
  if (game.loop !== null) return
  game.loop = $.clock.every(TICK_MS, () => runTick($))
}

function stopLoop($: EngineInterface): void {
  game.loop?.cancel()
  game.loop = null
  game.lastStatus = undefined
  $.ui.status(undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Clawd Bros を一時停止/再開する(reset で新しい試合)',
      argumentHint: '[pause|resume|reset]',
      immediate: true,
    })
    game.seed = Math.floor(await $.clock.now()) | 0
    // 帯がまだ描かれていなければ仮のサイズで作る(描画時に帯の幅へ合わせ直す)
    if (game.world === null) game.world = createWorld(100, MAX_ROWS, game.seed)
    if (!(await read($, isPaused))) startLoop($)

    return next(e)
  })

  on('session.end', ($, e, next) => {
    stopLoop($)

    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    const paused = await read($, isPaused)

    if (arg === 'reset') {
      if (game.world !== null) newMatch(game.world)
      if (paused) {
        await update($, isPaused, () => false)
        startLoop($)
      }

      return { text: 'Clawd Bros: 新しい試合を始めました。' }
    }

    const wantPause = arg === 'pause' ? true : arg === 'resume' ? false : !paused
    await update($, isPaused, () => wantPause)
    if (wantPause) {
      stopLoop($)

      return { text: 'Clawd Bros: 一時停止しました。/clawd-bros で再開します。' }
    }
    startLoop($)

    return { text: 'Clawd Bros: 再開しました。' }
  })

  on('prompt.submit', ($, e, next) => {
    if (game.world !== null) onPrompt(game.world)

    return next(e)
  })

  on('turn.start', ($, e, next) => {
    game.isWorking = true

    return next(e)
  })

  on('turn.complete', ($, e, next) => {
    game.isWorking = false

    return next(e)
  })

  // ツール呼び出しを観測するだけ。ゲーム側の失敗でツール実行を止めないよう、
  // 失敗時は必ず next に流す
  on('tool.call', async ($, e, next) => {
    const tool = String(e.tool)
    try {
      if (game.world !== null) onToolCall(game.world, tool)
    } catch (error) {
      $.ui.log(`clawd-bros: onToolCall failed: ${String(error)}`, { to: 'debug' })
    }
    const result = await next(e)
    try {
      const isError = result.deny !== undefined || result.isError === true
      if (game.world !== null) onToolResult(game.world, tool, isError)
    } catch (error) {
      $.ui.log(`clawd-bros: onToolResult failed: ${String(error)}`, { to: 'debug' })
    }

    return result
  }).catch(($, e, next) => next(e))

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || (await read($, isPaused))) return next(e)

    if (e.surface === 'terminal') {
      const columns = Math.min(MAX_COLUMNS, e.props.bodyColumns)
      const rows = Math.min(MAX_ROWS, e.props.maxRows)
      if (columns < MIN_COLUMNS || rows < MIN_ROWS) {
        game.mount = null

        return next(e)
      }
      const w = ensureWorld(columns, rows)
      const { Raster } = $.ui.resolve(e)
      game.mount = { requestId: e.requestId, columns, rows }
      game.denies = 0

      return (
        <Raster
          key={STAGE_KEY}
          columns={columns}
          rows={rows}
          cells={gridToRasterBase64(drawFrame(w))}
        />
      )
    }

    if (e.surface === 'desktop') {
      // フレーム番号を読んで購読する。タイマーが番号を進めるたびに描き直される
      await read($, frame)
      // ターミナルが描いていればそちらのサイズに従い、Svg は viewBox で伸縮させる
      const columns = Number.isFinite(e.props.bodyColumns)
        ? Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, e.props.bodyColumns))
        : 100
      const m = game.mount
      const w = m === null ? ensureWorld(columns, MAX_ROWS) : ensureWorld(m.columns, m.rows)
      game.lastRemoteDraw = w.tick
      const { Svg } = $.ui.resolve(e)

      return <Svg source={gridToSvg(drawFrame(w))} alt={hudText(w)} />
    }

    return next(e)
  })
}
