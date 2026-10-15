// Clawd Bros の共有モデル: engine.ts(シミュレーション)と render.ts(描画)が
// 同じ座標系・型・色を使うための約束事。ここにロジックは置かない。

/** 0x00RRGGBB。端末既定色は DEFAULT_COLOR(bit24のみ) */
export const DEFAULT_COLOR = 0x01000000

/** 1ティックの長さ(ms)。物理パラメータはこの周期を前提にする */
export const TICK_MS = 100

export const SPRITE_W = 9
export const SPRITE_H = 3

/** ステージの下に足すHUD(各Clawdの%と残機)の行数。drawFrame の Grid はステージ + この行数 */
export const HUD_ROWS = 1

/** ステージの高さ(HUDを除く)。これ未満ならステージを描かない */
export const MIN_ROWS = 7
export const MAX_ROWS = 10
export const MIN_COLUMNS = 40
export const MAX_COLUMNS = 240

export const STOCKS = 3

export type FighterId = 0 | 1 | 2 | 3
export type Family = 'write' | 'read' | 'bash' | 'agent'

/**
 * 技の種類。ツール呼び出しが引き金になるもの(jab以外)と、CPUが自発的に出す jab。
 * jab: Read / 自発攻撃, beam: Grep・Glob系の飛び道具, smash: Edit系の横スマ,
 * meteor: Write の急降下, dash: Bash のダッシュ攻撃, grab: Web系のつかみ投げ,
 * assist: Agent系のミニClawd召喚, special: その他(MCP・Skill等)の回転攻撃,
 * final: スマッシュボール取得後の最後の切りふだ
 */
export type MoveKind =
  | 'jab'
  | 'beam'
  | 'smash'
  | 'meteor'
  | 'dash'
  | 'grab'
  | 'assist'
  | 'special'
  | 'final'

export type Pose =
  | 'idle'
  | 'walk'
  | 'jump'
  | 'fall'
  | 'windup'
  | 'attack'
  | 'hurt'
  | 'tumble'
  | 'dizzy'
  | 'taunt'
  | 'ko'
  | 'respawn'
  | 'out'

export type ActiveMove = {
  kind: MoveKind
  /** 技を始めてからのティック数 */
  tick: number
  targetId: FighterId | null
  /** 既に当てた相手(多段ヒットを防ぐ) */
  hitIds: FighterId[]
  /** 引き金になったツール名(自発攻撃は '') */
  tool: string
}

export type Fighter = {
  id: FighterId
  family: Family
  /** 'WRITE' 等。ステータスラインと勝利バナーに使う */
  label: string
  color: number
  /** スプライト左端の列(ステージ座標、小数可) */
  x: number
  /** 足元の高さ。足場の上面に立つと 0、上が正。足場の外へ落ちると負 */
  y: number
  vx: number
  vy: number
  facing: 1 | -1
  pose: Pose
  /** 現在のポーズに入ってからのティック数 */
  poseTicks: number
  /** ふっとび・ひるみの残りティック。>0 の間は操作不能 */
  stunTicks: number
  damage: number
  stocks: number
  invincibleTicks: number
  move: ActiveMove | null
  /** ツール呼び出しで積まれた技(最大3件) */
  queue: { kind: MoveKind; tool: string }[]
  jumpsLeft: number
  hasSmashBall: boolean
  kos: number
  /** CPUの狙い。null なら近い相手 */
  targetId: FighterId | null
}

export type Projectile = {
  kind: 'beam' | 'assist'
  owner: FighterId
  /** 左端の列 */
  x: number
  /** 足場上面からの高さ(Fighter.y と同じ座標) */
  y: number
  vx: number
  ttl: number
  hitIds: FighterId[]
}

/**
 * 描画専用のエフェクト。x,y はセル座標(x=列, y=行。行は画面上端が0)で、
 * engine が足場座標から変換して入れる。
 * spark: ヒット火花, popup: '+12%' 等の浮き文字, koBurst: 場外KOのフレア(看板演出),
 * flash: 画面全体の白フラッシュ, banner: 'READY?' 'GO!' 'GAME!' 等の中央文字,
 * trail: ダッシュの残像, tether: つかみのワイヤー(x→toX), laser: 最後の切りふだ,
 * dizzy: 頭上の星
 */
export type Effect = {
  kind: 'spark' | 'popup' | 'koBurst' | 'flash' | 'banner' | 'trail' | 'tether' | 'laser' | 'dizzy'
  x: number
  y: number
  ttl: number
  maxTtl: number
  color: number
  text?: string
  dir?: 1 | -1
  /** tether / laser の終端列 */
  toX?: number
}

export type MatchPhase = 'ready' | 'go' | 'fight' | 'game'

/** コントローラー行から届くP1の操作。WASD / < > (と矢印・, .)を register 側でこれに直す */
export type PilotCommand = 'left' | 'right' | 'jump' | 'down' | 'attack' | 'special'

/** この間入力が無ければP1はCPUに戻る */
export const PILOT_IDLE_TICKS = 100

/** P1の手動操作の状態。端末はキーを離したことを伝えないので、押下ごとに数ティック押しっぱなし扱いにする */
export type Pilot = {
  /** 最後に入力があった tick。-1 なら一度も操作していない */
  lastInputTick: number
  /** 左右・下を押しっぱなし扱いにする残りティック */
  left: number
  right: number
  down: number
  /** 同じ向きに動き続けているティック数(歩き→走りの切り替え用) */
  heldTicks: number
  /** 次の操作可能ティックで1回だけ出す入力 */
  jump: boolean
  attack: boolean
  special: boolean
}

export type World = {
  tick: number
  width: number
  height: number
  phase: MatchPhase
  phaseTicks: number
  fighters: Fighter[]
  projectiles: Projectile[]
  effects: Effect[]
  /** 画面揺れの残りティック */
  shake: number
  smashBall: { x: number; y: number; vx: number; vy: number } | null
  /** 0..1。ツール呼び出しで上がり、時間で下がる。CPUの積極性に効く */
  activity: number
  /** 直近のツール呼び出し時刻(tick)。スマッシュボール出現判定に使う */
  recentCalls: number[]
  lastSmashBallTick: number
  winner: FighterId | null
  matchNo: number
  /** mulberry32 の状態 */
  seed: number
  /** ステータスライン末尾に出す直近の出来事。'P3 BASH ▸ Bash: DASH' 等 */
  ticker: string
  /** P1の手動操作 */
  pilot: Pilot
}

export type Layout = {
  /** 足場上面の行(画面上端が0) */
  platformRow: number
  /** 足場の左端列(含む) */
  stageLeft: number
  /** 足場の右端列(含まない) */
  stageRight: number
  /** スプライト左端がこれ未満で左場外KO */
  blastLeft: number
  /** スプライト左端がこれ超で右場外KO */
  blastRight: number
  /** y がこれ超で上場外KO(画面外上方) */
  blastTop: number
  /** y がこれ未満で下場外KO(落下) */
  blastBottom: number
}

export function layout(width: number, height: number): Layout {
  const platformRow = height - 3
  const stageLeft = Math.round(width * 0.14)
  return {
    platformRow,
    stageLeft,
    stageRight: width - stageLeft,
    blastLeft: -SPRITE_W - 2,
    blastRight: width + 2,
    blastTop: platformRow - SPRITE_H + 3,
    blastBottom: -(height + 2),
  }
}

/** 足場座標の y(足元の高さ)から、スプライト最上段の行を出す */
export function spriteTopRow(world: { height: number }, y: number): number {
  return layout(0, world.height).platformRow - SPRITE_H - Math.round(y)
}

export const PALETTE = {
  voidTop: 0x07061a,
  nebula: 0x1b1046,
  horizon: 0x2a1e6e,
  platformBody: 0x3b3f8c,
  platformEdge: 0x8fe3ff,
  platformUnder: 0x241f5c,
  starDim: 0x6c6a9c,
  starMid: 0xb8b6ff,
  starBright: 0xffffff,
  spark: 0xfff4c2,
  koHot: 0xffffff,
  koMid: 0xff5a3c,
  koCool: 0x7a1a10,
  beam: 0x7fe7ff,
  bannerFg: 0xffffff,
  bannerBg: 0x000000,
} as const

export const FIGHTER_SPECS: readonly { family: Family; label: string; color: number }[] = [
  { family: 'write', label: 'WRITE', color: 0xd97757 },
  { family: 'read', label: 'READ', color: 0x5aa9ff },
  { family: 'bash', label: 'BASH', color: 0xf2c14e },
  { family: 'agent', label: 'AGENT', color: 0x5bd08a },
]

/** mulberry32。world.seed を進めて [0,1) を返す */
export function rand(world: World): number {
  world.seed = (world.seed + 0x6d2b79f5) | 0
  let t = world.seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

/** 描画結果。行優先で columns*rows 要素 */
export type Grid = {
  columns: number
  rows: number
  ch: Uint32Array
  fg: Uint32Array
  bg: Uint32Array
}
