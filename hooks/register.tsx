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
  pilotInput,
  resizeWorld,
  step,
} from './engine'
import { FIGHTER_SPECS, HUD_ROWS, MAX_COLUMNS, MAX_ROWS, MIN_COLUMNS, MIN_ROWS, TICK_MS } from './model'
import type { PilotCommand, World } from './model'
import { drawFrame, gridToRasterBase64, gridToSvg } from './render'

const COMMAND = 'clawd-bros'
const STAGE_KEY = 'stage'
const PAD_KEY = 'pad'
/** コントローラー行の分。ステージはこれを引いた高さで描く */
const PAD_ROWS = 1
const P1_COLOR = `#${(FIGHTER_SPECS[0]?.color ?? 0xd97757).toString(16).padStart(6, '0')}`
const PILOT_COMMANDS: readonly PilotCommand[] = ['left', 'right', 'jump', 'down', 'attack', 'special']
const PAUSE_STORE_KEY = 'isPaused'
/** フルスクリーンでない端末では maxRows が端末の高さそのものなので、帯はその1/3までにする */
const MAIN_SCREEN_SHARE = 3
/** デスクトップは再描画1回が重いので2ティックに1回(5fps) */
const REMOTE_EVERY = 2
/** 非ターミナル面の描画がこのティック数途絶えたら、そちら向けの更新を止める */
const REMOTE_IDLE_TICKS = 50

const initialFrame: ClawdBrosState['frame'] = 0
const frame = atom({ plugin: 'clawd-bros', key: 'frame' } as const, initialFrame)
const isPaused = atom({ plugin: 'clawd-bros', key: 'isPaused' } as const, false)

/** 帯に貼った Raster。rows はステージ + HUD の行数 */
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

/** コントローラー行ごとの、前回までに届いた累計回数 */
const padCounts = new Map<string, Record<PilotCommand, number>>()

function isPilotCommand(value: unknown): value is PilotCommand {
  return typeof value === 'string' && (PILOT_COMMANDS as readonly string[]).includes(value)
}

/**
 * コントローラー行の post({ counts, last }) をエンジンへの入力に直す。
 * counts は押した回数の累計なので、前回との差が出たコマンドを1回ずつ入れる。
 * 初めて見る行(リロード直後など)や数え直し(行の作り直し)のときは last だけ入れる。
 */
function applyPad(w: World, source: string, data: unknown): void {
  if (typeof data !== 'object' || data === null) return
  const raw = (data as { counts?: unknown }).counts
  const last = (data as { last?: unknown }).last
  if (typeof raw !== 'object' || raw === null) return
  const counts = {} as Record<PilotCommand, number>
  for (const cmd of PILOT_COMMANDS) {
    const v = (raw as Record<string, unknown>)[cmd]
    counts[cmd] = typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0
  }
  const prev = padCounts.get(source)
  padCounts.set(source, counts)
  const isFresh = prev === undefined || PILOT_COMMANDS.some(cmd => counts[cmd] < prev[cmd])
  if (isFresh) {
    if (isPilotCommand(last)) pilotInput(w, last)

    return
  }
  for (const cmd of PILOT_COMMANDS) {
    if (counts[cmd] > prev[cmd]) pilotInput(w, cmd)
  }
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
    if (target.columns !== w.width || target.rows !== w.height + HUD_ROWS) {
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

/** 一時停止の切り替え。帯の再描画用に $.state、次回起動用に $.store へ書く */
async function setPaused($: EngineInterface, paused: boolean): Promise<void> {
  await update($, isPaused, () => paused)
  await $.store.set(PAUSE_STORE_KEY, paused)
  if (paused) stopLoop($)
  else startLoop($)
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
    // 一時停止は $.store にも書いてあるので、起動し直しても止めたままにする
    // 読めなければ止めていない扱い(ゲームが始まらないよりはよい)
    const storedPause = (await $.store.get(PAUSE_STORE_KEY).catch(() => false)) === true
    if (storedPause !== (await read($, isPaused))) await update($, isPaused, () => storedPause)
    if (!storedPause) startLoop($)

    return next(e)
  })

  on('session.end', ($, e, next) => {
    // /clear と resume ではプロセスが続き、session.start は来ない。ループは止めない
    if (e.reason !== 'clear' && e.reason !== 'resume') stopLoop($)

    return next(e)
  })

  // 返答の text はモデルの会話にも入るので、結果はトーストで知らせて text は返さない
  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()

    if (arg === 'reset') {
      if (game.world !== null) newMatch(game.world)
      await setPaused($, false)
      $.ui.toast('Clawd Bros: 新しい試合を始めました')

      return {}
    }

    let wantPause: boolean
    if (arg === 'pause') wantPause = true
    else if (arg === 'resume') wantPause = false
    else if (arg === '') wantPause = game.loop !== null
    else {
      $.ui.toast('使い方: /clawd-bros [pause|resume|reset]')

      return {}
    }
    await setPaused($, wantPause)
    $.ui.toast(wantPause ? 'Clawd Bros: 一時停止しました(/clawd-bros で再開)' : 'Clawd Bros: 再開しました')

    return {}
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
      const room =
        e.viewport?.isFullscreen === false
          ? Math.floor(e.viewport.rows / MAIN_SCREEN_SHARE)
          : e.props.maxRows
      const stageRows = Math.min(MAX_ROWS, room - PAD_ROWS - HUD_ROWS)
      if (columns < MIN_COLUMNS || stageRows < MIN_ROWS) {
        game.mount = null

        return next(e)
      }
      const w = ensureWorld(columns, stageRows)
      const rows = stageRows + HUD_ROWS
      const { Box, Client, Raster } = $.ui.resolve(e)
      game.mount = { requestId: e.requestId, columns, rows }
      game.denies = 0

      return (
        <Box flexDirection="column">
          <Raster
            key={STAGE_KEY}
            columns={columns}
            rows={rows}
            cells={gridToRasterBase64(drawFrame(w))}
          />
          <Client key={PAD_KEY} module="./pad.tsx" props={{ color: P1_COLOR }} height={PAD_ROWS} width={columns} />
        </Box>
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
      const w = m === null ? ensureWorld(columns, MAX_ROWS) : ensureWorld(m.columns, m.rows - HUD_ROWS)
      game.lastRemoteDraw = w.tick
      const { Box, Client, Svg } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          <Svg source={gridToSvg(drawFrame(w))} alt={hudText(w)} />
          <Client key={PAD_KEY} module="./pad.tsx" props={{ color: P1_COLOR }} height={PAD_ROWS} />
        </Box>
      )
    }

    return next(e)
  })

  // コントローラー行からのキー入力。P1を手動操作に切り替える
  on('ui.message', ($, e, next) => {
    if (e.element === PAD_KEY && game.world !== null) {
      applyPad(game.world, `${e.surface}:${e.requestId}`, e.data)
    }

    return next(e)
  })
}
