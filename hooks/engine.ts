// Clawd Brosのシミュレーション。描画はしない(render.tsがworldを読んで描く)。
// 座標系・型・色はmodel.tsを参照。worldは破壊的に更新する。
// Date.now / consoleは使わず、乱数はmodel.tsのrand(world)だけを使う(決定的)。

import { FIGHTER_SPECS, PALETTE, SPRITE_H, SPRITE_W, STOCKS, layout, rand, spriteTopRow } from './model'
import type { ActiveMove, Effect, Family, Fighter, FighterId, Layout, MoveKind, Pose, World } from './model'

// ---- 物理・進行の定数 ----

const GRAVITY = 0.35
const JUMP_V = 1.6
const UPB_V = 1.8
const WALK = 0.5
const RUN = 1.0
const STUN_DECAY = 0.93
const MAX_DAMAGE = 999

const READY_TICKS = 12
const GO_TICKS = 8
const GAME_TICKS = 20
const WIN_TICKS = 30
const KO_TICKS = 15
const RESPAWN_INVINCIBLE = 25
const RESPAWN_Y = 3
const DIZZY_TICKS = 18
const TAUNT_TICKS = 12
const APPROACH_LIMIT = 15
/** CPU同士がこれ未満(中心間の列数)まで寄ると、互いに押し合って離れる */
const PERSONAL_SPACE = 8
const KO_CREDIT_WINDOW = 100

const BALL_LIFE = 900
const BALL_COOLDOWN = 600
const BALL_WINDOW = 80
const BALL_PICKUP_DELAY = 20
const BALL_NEED_CALLS = 6

const BEAM_W = 4
const ASSIST_W = 2
const GRAB_REACH = 14
const FINAL_TICKS = 18
const MAX_EFFECTS = 96
const MAX_PROJECTILES = 24

const DIZZY_YELLOW = 0xffe14a
const ERR_RED = 0xff5a3c

// ---- 技テーブル ----

type HitDef = { dmg: number; base: number; growth: number; angle: number }

const MOVES: Record<MoveKind, HitDef> = {
  jab: { dmg: 3, base: 0.3, growth: 0.5, angle: 10 },
  beam: { dmg: 6, base: 0.5, growth: 0.8, angle: 15 },
  smash: { dmg: 15, base: 1.0, growth: 2.2, angle: 30 },
  meteor: { dmg: 13, base: 0.8, growth: 1.8, angle: -60 },
  dash: { dmg: 9, base: 0.9, growth: 1.6, angle: 40 },
  grab: { dmg: 9, base: 0.9, growth: 1.7, angle: 45 },
  assist: { dmg: 8, base: 0.8, growth: 1.4, angle: 35 },
  special: { dmg: 7, base: 0.7, growth: 1.2, angle: 50 },
  final: { dmg: 30, base: 2.5, growth: 2.0, angle: 20 },
}

/** Readの3連打(3,3,5。最後だけbase 0.8) */
const JAB_COMBO: HitDef[] = [
  { dmg: 3, base: 0.3, growth: 0.5, angle: 10 },
  { dmg: 3, base: 0.3, growth: 0.5, angle: 10 },
  { dmg: 5, base: 0.8, growth: 0.5, angle: 10 },
]

// ---- ツール分類 ----

const WRITE_SMASH = new Set(['Edit', 'MultiEdit', 'NotebookEdit'])
const READ_BEAM = new Set([
  'Grep',
  'Glob',
  'LS',
  'ToolSearch',
  'LSP',
  'NotebookRead',
  'ListMcpResourcesTool',
  'ReadMcpResourceTool',
])
const BASH_SPECIAL = new Set(['BashOutput', 'KillShell', 'KillBash', 'Monitor', 'PowerShell', 'TaskStop'])
const AGENT_ASSIST = new Set(['Agent', 'Task', 'Workflow'])
const AGENT_GRAB = new Set(['WebFetch', 'WebSearch'])

export function familyOf(tool: string): Family {
  if (tool === 'Write' || WRITE_SMASH.has(tool)) return 'write'
  if (tool === 'Read' || READ_BEAM.has(tool)) return 'read'
  if (tool === 'Bash' || BASH_SPECIAL.has(tool)) return 'bash'
  return 'agent'
}

export function moveOf(tool: string): MoveKind {
  if (tool === 'Write') return 'meteor'
  if (WRITE_SMASH.has(tool)) return 'smash'
  if (tool === 'Read') return 'jab'
  if (READ_BEAM.has(tool)) return 'beam'
  if (tool === 'Bash') return 'dash'
  if (BASH_SPECIAL.has(tool)) return 'special'
  if (AGENT_ASSIST.has(tool)) return 'assist'
  if (AGENT_GRAB.has(tool)) return 'grab'
  return 'special'
}

// ---- エンジン内部の補助状態 ----
// model.tsの型にない状態(技の進行・直近の被弾者など)はworld._auxに持つ。
// worldを複製しても付いてくるよう、WeakMapではなくプロパティにしている。

type MoveState = {
  /** 走って近づいている最中 */
  approaching: boolean
  approachTicks: number
  /** 描画に見せるポーズ */
  pose: Pose
  /** 技ごとの段階(meteor: 0上昇1急降下2後隙 / dash: 0突進2後隙 / grab: 0溜め1引き寄せ2後隙) */
  phase: number
  recover: number
  victimId: FighterId | null
  fx: Effect | null
}

type FighterAux = {
  ms: MoveState | null
  lastHit: { by: FighterId; tick: number } | null
  upBUsed: boolean
  wanderTicks: number
  wanderDir: 1 | -1
  /** 引いている最中(相手の方を向いたまま後ろへ歩く)。falseは足場の端から中央へ戻る歩き */
  wanderBack: boolean
  /** 直近の歩く向きと、向きの反転を禁じる残りティック */
  lastSign: number
  signHold: number
  dizzyFx: Effect | null
}

type Aux = { f: FighterAux[] }
type AuxWorld = World & { _aux?: Aux }

function auxOf(world: World): Aux {
  const w = world as AuxWorld
  let a = w._aux
  if (a === undefined) {
    a = { f: [] }
    w._aux = a
  }

  return a
}

function fauxOf(world: World, f: Fighter): FighterAux {
  const a = auxOf(world)
  let x = a.f[f.id]
  if (x === undefined) {
    x = {
      ms: null,
      lastHit: null,
      upBUsed: false,
      wanderTicks: 0,
      wanderDir: 1,
      wanderBack: true,
      lastSign: 0,
      signHold: 0,
      dizzyFx: null,
    }
    a.f[f.id] = x
  }

  return x
}

// ---- 小さな補助関数 ----

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

function cxOf(f: Fighter): number {
  return f.x + SPRITE_W / 2
}

function isActive(f: Fighter): boolean {
  return f.stocks > 0 && f.pose !== 'ko' && f.pose !== 'out'
}

function onStageX(f: Fighter, L: Layout): boolean {
  const c = cxOf(f)

  return c >= L.stageLeft && c < L.stageRight
}

function isGrounded(f: Fighter, L: Layout): boolean {
  return Math.abs(f.y) < 1e-9 && onStageX(f, L)
}

function isOffStage(f: Fighter, L: Layout): boolean {
  return !onStageX(f, L) || f.y < -1e-9
}

function fighterOf(world: World, id: FighterId | null): Fighter | undefined {
  if (id === null) return undefined
  for (const f of world.fighters) if (f.id === id) return f

  return undefined
}

function dirTo(f: Fighter, t: Fighter): 1 | -1 {
  return cxOf(t) >= cxOf(f) ? 1 : -1
}

/** 2体の体のあいだの隙間(重なっていれば負) */
function hgap(a: Fighter, b: Fighter): number {
  return Math.abs(cxOf(a) - cxOf(b)) - SPRITE_W
}

function sanitizeSize(n: number, lo: number, hi: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback

  return clamp(Math.floor(n), lo, hi)
}

/** 足場の上にいるまま届く、自発ジャンプの初速。低い帯でも上場外に出ないよう抑える */
function capV(L: Layout, v: number, y: number): number {
  const room = Math.max(0.3, L.blastTop - 0.3 - Math.max(0, y))

  return Math.min(v, Math.sqrt(2 * GRAVITY * room))
}

/**
 * 横方向のふっとびの倍率。基準は幅100列のステージ。
 * 広い帯ほど場外が遠いので、同じ%で場外に出るよう比例して強める。
 */
function hScale(world: World): number {
  return clamp(Math.sqrt((world.width + 13) / 113), 0.75, 1.6)
}

// ---- エフェクト ----

function addEffect(
  world: World,
  kind: Effect['kind'],
  x: number,
  y: number,
  ttl: number,
  color: number,
  extra?: { text?: string; dir?: 1 | -1; toX?: number },
): Effect {
  const e: Effect = { kind, x, y, ttl, maxTtl: ttl, color }
  if (extra !== undefined) {
    if (extra.text !== undefined) e.text = extra.text
    if (extra.dir !== undefined) e.dir = extra.dir
    if (extra.toX !== undefined) e.toX = extra.toX
  }
  world.effects.push(e)
  if (world.effects.length > MAX_EFFECTS) {
    // 古い順に、バナー以外を1つ捨てる
    const i = world.effects.findIndex(x0 => x0.kind !== 'banner')
    if (i >= 0) world.effects.splice(i, 1)
  }

  return e
}

function banner(world: World, text: string, ttl: number, color: number): void {
  addEffect(world, 'banner', 0, 0, ttl, color, { text })
}

function topRow(world: World, f: Fighter): number {
  return spriteTopRow(world, f.y)
}

function popup(world: World, f: Fighter, text: string, color: number): void {
  addEffect(world, 'popup', Math.round(cxOf(f)), Math.max(0, topRow(world, f) - 1), 14, color, { text })
}

function sparkAt(world: World, f: Fighter): void {
  addEffect(world, 'spark', Math.round(cxOf(f)), topRow(world, f) + 1, 5, PALETTE.spark)
}

/** エフェクトを即座に取り除く(ttlを0にして残すと1フレーム余計に描かれる) */
function dropEffect(world: World, e: Effect): void {
  const i = world.effects.indexOf(e)
  if (i >= 0) world.effects.splice(i, 1)
}

function tickEffects(world: World): void {
  let w = 0
  for (const e of world.effects) {
    e.ttl -= 1
    if (e.ttl > 0) world.effects[w++] = e
  }
  world.effects.length = w
}

// ---- 世界の生成・リセット ----

function makeFighters(world: World): Fighter[] {
  const L = layout(world.width, world.height)
  const span = L.stageRight - L.stageLeft
  const n = FIGHTER_SPECS.length

  return FIGHTER_SPECS.map((spec, i): Fighter => {
    const center = L.stageLeft + (span * (i + 1)) / (n + 1)

    return {
      id: i as FighterId,
      family: spec.family,
      label: spec.label,
      color: spec.color,
      x: center - SPRITE_W / 2,
      y: 0,
      vx: 0,
      vy: 0,
      facing: i < n / 2 ? 1 : -1,
      pose: 'idle',
      poseTicks: 0,
      stunTicks: 0,
      damage: 0,
      stocks: STOCKS,
      invincibleTicks: 0,
      move: null,
      queue: [],
      jumpsLeft: 1,
      hasSmashBall: false,
      kos: 0,
      targetId: null,
    }
  })
}

function beginReady(world: World): void {
  world.phase = 'ready'
  world.phaseTicks = 0
  banner(world, 'READY?', READY_TICKS, PALETTE.bannerFg)
}

export function createWorld(width: number, height: number, seed: number): World {
  const world: World = {
    tick: 0,
    width: sanitizeSize(width, 8, 1000, 100),
    height: sanitizeSize(height, 4, 100, 10),
    phase: 'ready',
    phaseTicks: 0,
    fighters: [],
    projectiles: [],
    effects: [],
    shake: 0,
    smashBall: null,
    activity: 0,
    recentCalls: [],
    lastSmashBallTick: -1000,
    winner: null,
    matchNo: 1,
    seed: Number.isFinite(seed) ? seed | 0 : 1,
    ticker: '',
  }
  world.fighters = makeFighters(world)
  beginReady(world)

  return world
}

export function newMatch(world: World): void {
  world.matchNo += 1
  world.projectiles = []
  world.effects = []
  world.shake = 0
  world.smashBall = null
  world.recentCalls = []
  world.lastSmashBallTick = -1000
  world.winner = null
  world.ticker = ''
  ;(world as AuxWorld)._aux = undefined
  world.fighters = makeFighters(world)
  beginReady(world)
}

export function resizeWorld(world: World, width: number, height: number): void {
  const w = sanitizeSize(width, 8, 1000, world.width)
  const h = sanitizeSize(height, 4, 100, world.height)
  if (w === world.width && h === world.height) return
  const oldL = layout(world.width, world.height)
  const ratio = w / world.width
  world.width = w
  world.height = h
  const L = layout(w, h)

  for (const f of world.fighters) {
    if (f.pose === 'ko' || f.pose === 'out') continue
    const wasGrounded = Math.abs(f.y) < 1e-9 && onStageX(f, oldL)
    let c = cxOf(f) * ratio
    if (wasGrounded) c = clamp(c, L.stageLeft, L.stageRight - 0.01)
    else c = clamp(c, L.blastLeft + 1 + SPRITE_W / 2, L.blastRight - 1 + SPRITE_W / 2)
    f.x = c - SPRITE_W / 2
    f.y = clamp(f.y, L.blastBottom + 1, L.blastTop - 0.5)
  }
  for (const p of world.projectiles) p.x *= ratio
  const b = world.smashBall
  if (b !== null) {
    b.x = clamp(b.x * ratio, L.stageLeft + 2, Math.max(L.stageLeft + 2, L.stageRight - 3))
    b.y = clamp(b.y, 1, Math.max(1.5, L.platformRow - 2))
  }
  // セル座標のエフェクトは新しい大きさでは意味を失うので、座標を使わないものだけ残す
  world.effects = world.effects.filter(e => e.kind === 'banner' || e.kind === 'flash')
}

// ---- 被弾・場外KO ----

function targetable(v: Fighter): boolean {
  return isActive(v) && v.invincibleTicks <= 0
}

function applyHit(
  world: World,
  L: Layout,
  atk: Fighter | null,
  v: Fighter,
  def: HitDef,
  dir: 1 | -1,
): boolean {
  if (world.phase !== 'fight' || !targetable(v)) return false
  const fa = fauxOf(world, v)
  v.damage = Math.min(MAX_DAMAGE, v.damage + def.dmg)
  const kb = def.base + (v.damage * def.growth) / 100
  const rad = (def.angle * Math.PI) / 180
  let vy = kb * Math.sin(rad)
  // メテオは地上の相手を下へ叩けないので跳ね返す(bounce)
  if (def.angle < 0 && v.y <= 0.05 && onStageX(v, L)) vy = Math.abs(vy) * 0.9
  v.vx = kb * Math.cos(rad) * dir * hScale(world)
  v.vy = vy
  v.stunTicks = Math.max(1, Math.round(kb * 4))
  v.pose = kb > 1.0 ? 'tumble' : 'hurt'
  v.poseTicks = 0
  v.facing = dir === 1 ? -1 : 1
  v.move = null
  fa.ms = null
  if (atk !== null) fa.lastHit = { by: atk.id, tick: world.tick }
  sparkAt(world, v)
  popup(world, v, `+${def.dmg}%`, v.color)
  if (kb > 2) world.shake = Math.max(world.shake, 2)

  return true
}

function exitOf(f: Fighter, L: Layout): 'left' | 'right' | 'top' | 'bottom' | null {
  if (f.x < L.blastLeft) return 'left'
  if (f.x > L.blastRight) return 'right'
  if (f.y > L.blastTop) return 'top'
  if (f.y < L.blastBottom) return 'bottom'

  return null
}

function koFighter(world: World, v: Fighter, exit: 'left' | 'right' | 'top' | 'bottom'): void {
  const fa = fauxOf(world, v)
  const hit = fa.lastHit
  let killer: Fighter | undefined
  if (hit !== null && hit.by !== v.id && world.tick - hit.tick <= KO_CREDIT_WINDOW) {
    killer = fighterOf(world, hit.by)
    if (killer !== undefined) killer.kos += 1
  }

  // 出口のセル座標へkoBurstを出す(向きは内向き)
  const cx = Math.round(cxOf(v))
  const midRow = clamp(topRow(world, v) + 1, 0, world.height - 1)
  let ex = 0
  let ey = 0
  let dir: 1 | -1 = 1
  if (exit === 'left') {
    ex = 0
    ey = midRow
    dir = 1
  } else if (exit === 'right') {
    ex = world.width - 1
    ey = midRow
    dir = -1
  } else {
    ex = clamp(cx, 0, world.width - 1)
    ey = exit === 'top' ? 0 : world.height - 1
    dir = ex < world.width / 2 ? 1 : -1
  }
  addEffect(world, 'koBurst', ex, ey, 12, v.color, { dir })
  addEffect(world, 'flash', 0, 0, 1, PALETTE.koHot)
  world.shake = Math.max(world.shake, 4)

  v.stocks -= 1
  v.hasSmashBall = false
  v.move = null
  v.queue = []
  v.stunTicks = 0
  v.vx = 0
  v.vy = 0
  v.invincibleTicks = 0
  v.poseTicks = 0
  v.pose = v.stocks > 0 ? 'ko' : 'out'
  fa.ms = null
  fa.lastHit = null
  if (fa.dizzyFx !== null) {
    dropEffect(world, fa.dizzyFx)
    fa.dizzyFx = null
  }

  world.ticker =
    killer !== undefined
      ? `P${killer.id + 1} ${killer.label} ▸ KO P${v.id + 1}`
      : `P${v.id + 1} ${v.label} ▸ FELL`
}

function respawn(world: World, L: Layout, f: Fighter): void {
  const fa = fauxOf(world, f)
  f.x = (L.stageLeft + L.stageRight) / 2 - SPRITE_W / 2
  f.y = Math.min(RESPAWN_Y, L.blastTop - 1)
  f.vx = 0
  f.vy = 0
  f.damage = 0
  f.stunTicks = 0
  f.invincibleTicks = RESPAWN_INVINCIBLE
  f.move = null
  f.jumpsLeft = 1
  f.pose = 'respawn'
  f.poseTicks = 0
  f.facing = rand(world) < 0.5 ? 1 : -1
  fa.ms = null
  fa.upBUsed = false
  fa.lastHit = null
}

// ---- ターゲット選び ----

function validTarget(world: World, f: Fighter, id: FighterId | null): Fighter | null {
  const t = fighterOf(world, id)
  if (t === undefined || t.id === f.id || !isActive(t)) return null

  return t
}

/** いちばん近い相手。無敵でない相手を優先する */
function nearestTarget(world: World, f: Fighter): Fighter | null {
  let best: Fighter | null = null
  let bestScore = Number.POSITIVE_INFINITY
  for (const t of world.fighters) {
    if (t.id === f.id || !isActive(t)) continue
    const score = Math.abs(cxOf(t) - cxOf(f)) + (t.invincibleTicks > 0 ? 1000 : 0)
    if (score < bestScore) {
      bestScore = score
      best = t
    }
  }

  return best
}

function randomTarget(world: World, f: Fighter): Fighter | null {
  const cands = world.fighters.filter(t => t.id !== f.id && isActive(t))
  if (cands.length === 0) return null

  return cands[Math.floor(rand(world) * cands.length) % cands.length] ?? null
}

// ---- 技の開始 ----

/** 近づく必要がある技か(射程外なら走って近づく) */
function needsApproach(kind: MoveKind): boolean {
  return kind === 'jab' || kind === 'smash' || kind === 'special' || kind === 'meteor' || kind === 'grab'
}

/** 体の外側から数えた射程(列)。meteorは相手の頭上まで寄るので、体が重なる側(負)で測る */
function reachOf(kind: MoveKind): number {
  switch (kind) {
    case 'jab':
      return 2
    case 'smash':
    case 'special':
      return 3
    case 'meteor':
      return -3
    case 'grab':
      return 12
    default:
      return 0
  }
}

function startMove(world: World, f: Fighter, kind: MoveKind, tool: string, target: Fighter | null): void {
  const tgt = target ?? nearestTarget(world, f)
  const mv: ActiveMove = { kind, tick: 0, targetId: tgt !== null ? tgt.id : null, hitIds: [], tool }
  f.move = mv
  const approach = needsApproach(kind) && tgt !== null
  fauxOf(world, f).ms = {
    approaching: approach,
    approachTicks: 0,
    pose: approach ? 'walk' : 'windup',
    phase: 0,
    recover: 0,
    victimId: null,
    fx: null,
  }
  if (tgt !== null) f.facing = dirTo(f, tgt)
}

function cancelMove(world: World, f: Fighter): void {
  f.move = null
  fauxOf(world, f).ms = null
}

/** 足場の外へ踏み出さないための横速度の制限(既に場外なら何もしない) */
function safeVx(f: Fighter, L: Layout, vx: number): number {
  const c = cxOf(f)
  if (c < L.stageLeft || c >= L.stageRight) return vx
  const nc = c + vx
  if (vx < 0 && nc < L.stageLeft + 0.5) return 0
  if (vx > 0 && nc > L.stageRight - 1.5) return 0

  return vx
}

// ---- 当たり判定 ----

/** 前方reach列の判定。facing側へ向けて当てる */
function hitFront(world: World, L: Layout, f: Fighter, mv: ActiveMove, def: HitDef, reach: number): void {
  const x0 = f.facing === 1 ? f.x + SPRITE_W - 1 : f.x - reach
  const x1 = f.facing === 1 ? f.x + SPRITE_W + reach : f.x + 1
  for (const v of world.fighters) {
    if (v === f || mv.hitIds.includes(v.id) || !isActive(v)) continue
    if (Math.abs(v.y - f.y) >= SPRITE_H) continue
    if (x0 >= v.x + SPRITE_W || x1 <= v.x) continue
    if (applyHit(world, L, f, v, def, f.facing)) mv.hitIds.push(v.id)
  }
}

/** 左右両側reach列の判定。ふっとぶ向きは自分から見て相手のいる側 */
function hitAround(world: World, L: Layout, f: Fighter, mv: ActiveMove, def: HitDef, reach: number): void {
  const x0 = f.x - reach
  const x1 = f.x + SPRITE_W + reach
  for (const v of world.fighters) {
    if (v === f || mv.hitIds.includes(v.id) || !isActive(v)) continue
    if (Math.abs(v.y - f.y) >= SPRITE_H) continue
    if (x0 >= v.x + SPRITE_W || x1 <= v.x) continue
    if (applyHit(world, L, f, v, def, dirTo(f, v))) mv.hitIds.push(v.id)
  }
}

// ---- 技の進行(各関数は1ティック分を進め、終わったらtrueを返す) ----

function doJab(world: World, L: Layout, f: Fighter, mv: ActiveMove, ms: MoveState, tgt: Fighter | null): boolean {
  const t = mv.tick
  f.vx = 0
  ms.pose = t === 0 ? 'windup' : 'attack'
  if (mv.tool === '') {
    if (t === 1) hitFront(world, L, f, mv, MOVES.jab, 2)

    return t >= 4
  }
  // Readの3連打。1発ごとに当たり判定をやり直す
  if (t >= 1 && t <= 9 && (t - 1) % 4 === 0) {
    const def = JAB_COMBO[(t - 1) / 4]
    if (tgt !== null && hgap(f, tgt) <= 6) {
      f.facing = dirTo(f, tgt)
      // 相手が離れかけていたら、一歩踏み込んで追いかける
      const g = hgap(f, tgt)
      if (g > 0.5 && g <= 4 && safeVx(f, L, f.facing * 1.5) !== 0) f.x += f.facing * Math.min(g - 0.5, 1.5)
    }
    mv.hitIds = []
    if (def !== undefined) hitFront(world, L, f, mv, def, 2)
  }

  return t >= 13
}

function doSmash(world: World, L: Layout, f: Fighter, mv: ActiveMove, ms: MoveState): boolean {
  const t = mv.tick
  ms.pose = t < 4 ? 'windup' : 'attack'
  f.vx = t === 4 || t === 5 ? safeVx(f, L, f.facing * 0.6) : 0
  if (t === 4 || t === 5) hitFront(world, L, f, mv, MOVES.smash, 3)

  return t >= 11
}

function doMeteor(world: World, L: Layout, f: Fighter, mv: ActiveMove, ms: MoveState, tgt: Fighter | null): boolean {
  if (ms.phase === 0) {
    if (mv.tick === 0) {
      if (isGrounded(f, L)) {
        f.vy = capV(L, JUMP_V, f.y)
      } else if (f.jumpsLeft > 0) {
        f.jumpsLeft -= 1
        f.vy = capV(L, JUMP_V, f.y)
      } else {
        ms.phase = 1
      }
    }
    if (ms.phase === 0) {
      ms.pose = 'jump'
      let overhead = tgt === null
      if (tgt !== null) {
        const dx = cxOf(tgt) - cxOf(f)
        f.facing = dx >= 0 ? 1 : -1
        f.vx = safeVx(f, L, clamp(dx / 3, -1.5, 1.5))
        overhead = Math.abs(dx) < 2.5 && f.vy < 1.2
      }
      if (mv.tick >= 1 && (f.vy <= 0.3 || mv.tick >= 8 || overhead)) {
        ms.phase = 1
      } else {
        return false
      }
    }
    if (ms.phase === 1) {
      // 急降下へ切り替える
      f.vy = Math.min(f.vy, -2.4)
      f.vx *= 0.3
    }
  }

  if (ms.phase === 1) {
    ms.pose = 'attack'
    if (tgt !== null) f.vx = safeVx(f, L, clamp((cxOf(tgt) - cxOf(f)) / 2.5, -1.2, 1.2))
    for (const v of world.fighters) {
      if (v === f || mv.hitIds.includes(v.id) || !isActive(v)) continue
      if (Math.abs(cxOf(v) - cxOf(f)) >= 5.5) continue
      if (f.y > v.y + 3.2 || f.y < v.y - 1.0) continue
      if (applyHit(world, L, f, v, MOVES.meteor, dirTo(f, v))) mv.hitIds.push(v.id)
    }
    if ((isGrounded(f, L) && mv.tick > 0) || mv.tick > 40) {
      ms.phase = 2
      ms.recover = 5
      f.vx = 0
    }

    return false
  }

  ms.pose = 'attack'
  f.vx = 0
  ms.recover -= 1

  return ms.recover <= 0
}

function doDash(world: World, L: Layout, f: Fighter, mv: ActiveMove, ms: MoveState, tgt: Fighter | null): boolean {
  const t = mv.tick
  if (t < 2) {
    ms.pose = 'windup'
    f.vx = 0
    if (t === 0 && tgt !== null) f.facing = dirTo(f, tgt)

    return false
  }
  ms.pose = 'attack'
  if (ms.phase === 0) {
    const vx = safeVx(f, L, f.facing * 2)
    if (vx === 0) {
      ms.phase = 2
      ms.recover = 4
      f.vx = 0

      return false
    }
    f.vx = vx
    // 残像は進行方向の後ろ側の端に置く(renderがxから後ろへ描く)
    const back = f.facing === 1 ? Math.round(f.x) : Math.round(f.x) + SPRITE_W - 1
    addEffect(world, 'trail', back, topRow(world, f) + 1, 4, f.color, { dir: f.facing })
    let hit = false
    for (const v of world.fighters) {
      if (v === f || mv.hitIds.includes(v.id) || !isActive(v)) continue
      if (Math.abs(v.y - f.y) >= SPRITE_H) continue
      if (f.x + vx - 1 >= v.x + SPRITE_W || f.x + vx + SPRITE_W + 1 <= v.x) continue
      if (applyHit(world, L, f, v, MOVES.dash, f.facing)) {
        mv.hitIds.push(v.id)
        hit = true
      }
    }
    if (hit || t >= 13) {
      ms.phase = 2
      ms.recover = hit ? 5 : 4
      f.vx = 0
    }

    return false
  }
  f.vx = 0
  ms.recover -= 1

  return ms.recover <= 0
}

function spawnProjectile(world: World, kind: 'beam' | 'assist', f: Fighter): void {
  if (world.projectiles.length >= MAX_PROJECTILES) world.projectiles.shift()
  if (kind === 'beam') {
    world.projectiles.push({
      kind,
      owner: f.id,
      x: f.facing === 1 ? f.x + SPRITE_W : f.x - BEAM_W,
      y: f.y,
      vx: 2.5 * f.facing,
      ttl: 140,
      hitIds: [],
    })
  } else {
    world.projectiles.push({
      kind,
      owner: f.id,
      x: f.facing === 1 ? f.x + SPRITE_W : f.x - ASSIST_W,
      y: 0,
      vx: 1.5 * f.facing,
      ttl: 90,
      hitIds: [],
    })
  }
}

function doBeam(world: World, f: Fighter, mv: ActiveMove, ms: MoveState, tgt: Fighter | null): boolean {
  const t = mv.tick
  f.vx = 0
  ms.pose = t < 3 ? 'windup' : 'attack'
  if (t === 0 && tgt !== null) f.facing = dirTo(f, tgt)
  if (t === 3) spawnProjectile(world, 'beam', f)

  return t >= 8
}

function doAssist(world: World, f: Fighter, mv: ActiveMove, ms: MoveState, tgt: Fighter | null): boolean {
  const t = mv.tick
  f.vx = 0
  ms.pose = t < 3 ? 'windup' : 'attack'
  if (t === 0 && tgt !== null) f.facing = dirTo(f, tgt)
  if (t === 3) spawnProjectile(world, 'assist', f)

  return t >= 9
}

function doSpecial(world: World, L: Layout, f: Fighter, mv: ActiveMove, ms: MoveState, tgt: Fighter | null): boolean {
  const t = mv.tick
  f.vx = 0
  ms.pose = t < 1 ? 'windup' : 'attack'
  if (t >= 1 && t <= 6) {
    // 向きを毎ティック反転して回転して見せる
    f.facing = t % 2 === 0 ? 1 : -1
    hitAround(world, L, f, mv, MOVES.special, 3)
  }
  if (t >= 9) {
    if (tgt !== null) f.facing = dirTo(f, tgt)

    return true
  }

  return false
}

function findGrabTarget(world: World, f: Fighter): Fighter | null {
  let best: Fighter | null = null
  let bestSide = Number.POSITIVE_INFINITY
  for (const v of world.fighters) {
    if (v === f || !targetable(v)) continue
    if (Math.abs(v.y - f.y) >= SPRITE_H + 0.5) continue
    const side = (cxOf(v) - cxOf(f)) * f.facing
    if (side < -3 || side - SPRITE_W > GRAB_REACH) continue
    if (side < bestSide) {
      bestSide = side
      best = v
    }
  }

  return best
}

function tetherEnds(f: Fighter, toEdgeX: number): { x: number; toX: number } {
  return f.facing === 1
    ? { x: Math.round(f.x) + SPRITE_W, toX: Math.round(toEdgeX) }
    : { x: Math.round(f.x) - 1, toX: Math.round(toEdgeX) + SPRITE_W - 1 }
}

function doGrab(world: World, L: Layout, f: Fighter, mv: ActiveMove, ms: MoveState, tgt: Fighter | null): boolean {
  const t = mv.tick
  f.vx = 0
  const row = topRow(world, f) + 1

  if (ms.phase === 0) {
    ms.pose = t < 3 ? 'windup' : 'attack'
    if (t === 0 && tgt !== null) f.facing = dirTo(f, tgt)
    if (t < 3) return false
    const v = findGrabTarget(world, f)
    if (v === null) {
      // 空振り: 最大の長さまで伸ばして戻す
      const ends = tetherEnds(f, f.facing === 1 ? f.x + SPRITE_W + GRAB_REACH : f.x - GRAB_REACH - SPRITE_W)
      addEffect(world, 'tether', ends.x, row, 4, f.color, { toX: ends.toX, dir: f.facing })
      ms.phase = 2
      ms.recover = 6

      return false
    }
    ms.victimId = v.id
    ms.phase = 1
    const ends = tetherEnds(f, v.x)
    ms.fx = addEffect(world, 'tether', ends.x, row, 3, f.color, { toX: ends.toX, dir: f.facing })
  }

  if (ms.phase === 1) {
    ms.pose = 'attack'
    const v = fighterOf(world, ms.victimId)
    if (v === undefined || !isActive(v) || v.invincibleTicks > 0 || t > 14) {
      if (ms.fx !== null) dropEffect(world, ms.fx)
      ms.phase = 2
      ms.recover = 4

      return false
    }
    // 相手を目の前まで引き寄せる
    const goal = f.facing === 1 ? f.x + SPRITE_W : f.x - SPRITE_W
    const d = goal - v.x
    v.x += clamp(d, -3.5, 3.5)
    v.y += Math.abs(f.y - v.y) < 0.2 ? f.y - v.y : (f.y - v.y) * 0.5
    v.vx = 0
    v.vy = 0
    v.stunTicks = Math.max(v.stunTicks, 3)
    v.pose = 'hurt'
    cancelMove(world, v)
    const ends = tetherEnds(f, v.x)
    if (ms.fx !== null) {
      ms.fx.x = ends.x
      ms.fx.toX = ends.toX
      ms.fx.y = row
      ms.fx.ttl = 3
    }
    if (Math.abs(d) < 0.6) {
      // 引き寄せた向きと逆(=自分が向いている側)へ投げる
      applyHit(world, L, f, v, MOVES.grab, f.facing)
      if (ms.fx !== null) ms.fx.ttl = 1
      ms.phase = 2
      ms.recover = 4
    }

    return false
  }

  ms.pose = 'attack'
  ms.recover -= 1

  return ms.recover <= 0
}

function doFinal(world: World, L: Layout, f: Fighter, mv: ActiveMove, ms: MoveState): boolean {
  const t = mv.tick
  f.vx = 0
  ms.pose = t < 5 ? 'windup' : 'attack'
  if (t === 0) {
    addEffect(world, 'flash', 0, 0, 2, PALETTE.koHot)
    world.shake = Math.max(world.shake, 4)
    f.invincibleTicks = Math.max(f.invincibleTicks, FINAL_TICKS + 2)
    // 敵が多く並んでいる側へ向く(同数なら近い敵の側)
    let right = 0
    let left = 0
    for (const v of world.fighters) {
      if (v === f || !isActive(v) || Math.abs(v.y - f.y) >= SPRITE_H + 0.5) continue
      if (cxOf(v) >= cxOf(f)) right += 1
      else left += 1
    }
    if (right !== left) {
      f.facing = right > left ? 1 : -1
    } else {
      const n = nearestTarget(world, f)
      if (n !== null) f.facing = dirTo(f, n)
    }
  }
  if (t === 5) {
    const dir = f.facing
    const startX = dir === 1 ? Math.round(f.x) + SPRITE_W : Math.round(f.x) - 1
    const endX = dir === 1 ? world.width - 1 : 0
    addEffect(world, 'laser', startX, topRow(world, f), 12, f.color, { toX: endX, dir })
    addEffect(world, 'flash', 0, 0, 2, PALETTE.koHot)
    world.shake = Math.max(world.shake, 6)
    for (const v of world.fighters) {
      if (v === f || !isActive(v)) continue
      if (Math.abs(v.y - f.y) >= SPRITE_H + 0.5) continue
      if ((cxOf(v) - cxOf(f)) * dir < -3) continue
      if (applyHit(world, L, f, v, MOVES.final, dir)) mv.hitIds.push(v.id)
    }
  }

  return t >= FINAL_TICKS
}

function updateMove(world: World, L: Layout, f: Fighter, fa: FighterAux): void {
  const mv = f.move
  if (mv === null) return
  let ms = fa.ms
  if (ms === null) {
    ms = { approaching: false, approachTicks: 0, pose: 'attack', phase: 0, recover: 0, victimId: null, fx: null }
    fa.ms = ms
  }
  let tgt = validTarget(world, f, mv.targetId)
  if (tgt === null) {
    tgt = nearestTarget(world, f)
    mv.targetId = tgt !== null ? tgt.id : null
  }

  if (ms.approaching) {
    ms.approachTicks += 1
    const reach = reachOf(mv.kind)
    const near =
      tgt !== null && (mv.kind === 'meteor' ? hgap(f, tgt) <= reach : hgap(f, tgt) <= reach && Math.abs(tgt.y - f.y) < SPRITE_H + 0.5)
    if (tgt === null || near || ms.approachTicks > APPROACH_LIMIT) {
      ms.approaching = false
      f.vx = 0
    } else {
      const d = dirTo(f, tgt)
      f.facing = d
      f.vx = safeVx(f, L, d * RUN)
      // 足場の端で行き止まりなら、その場で出す
      if (f.vx === 0) ms.approaching = false
      ms.pose = 'walk'

      return
    }
  }

  let done = false
  switch (mv.kind) {
    case 'jab':
      done = doJab(world, L, f, mv, ms, tgt)
      break
    case 'smash':
      done = doSmash(world, L, f, mv, ms)
      break
    case 'meteor':
      done = doMeteor(world, L, f, mv, ms, tgt)
      break
    case 'dash':
      done = doDash(world, L, f, mv, ms, tgt)
      break
    case 'beam':
      done = doBeam(world, f, mv, ms, tgt)
      break
    case 'assist':
      done = doAssist(world, f, mv, ms, tgt)
      break
    case 'special':
      done = doSpecial(world, L, f, mv, ms, tgt)
      break
    case 'grab':
      done = doGrab(world, L, f, mv, ms, tgt)
      break
    case 'final':
      done = doFinal(world, L, f, mv, ms)
      break
  }
  mv.tick += 1
  if (done) {
    f.move = null
    fa.ms = null
  }
}

// ---- CPUの操作 ----

const SIGNATURE_MOVES: Record<Family, MoveKind> = {
  write: 'smash',
  read: 'beam',
  bash: 'dash',
  agent: 'special',
}

function aggression(world: World, isWorking: boolean): number {
  return Math.min(1, 0.3 + 0.6 * world.activity + (isWorking ? 0.15 : 0))
}

function groundJump(f: Fighter, L: Layout): void {
  f.vy = capV(L, JUMP_V, f.y)
}

function recoverAI(world: World, L: Layout, f: Fighter, fa: FighterAux): void {
  const cx = cxOf(f)
  const mid = (L.stageLeft + L.stageRight) / 2
  const inside = cx >= L.stageLeft + 1 && cx < L.stageRight - 1
  const d: 1 | -1 = mid >= cx ? 1 : -1
  const want = inside ? 0 : d * 0.75
  f.vx += clamp(want - f.vx, -0.2, 0.2)
  if (!inside) f.facing = d
  // 足場より下へ落ち始めたら、空中ジャンプ → 上必殺の順で復帰を試みる
  if (f.vy < 0 && f.y < 0.3) {
    if (f.jumpsLeft > 0) {
      f.jumpsLeft -= 1
      f.vy = capV(L, JUMP_V, f.y)
      sparkAt(world, f)
    } else if (!fa.upBUsed) {
      fa.upBUsed = true
      f.vy = capV(L, UPB_V, f.y)
      f.vx = inside ? 0 : d * 0.8
      sparkAt(world, f)
    }
  }
}

/** 近くの相手から離れる向きの速度。全員が同じ場所に重なって見えないようにする */
function separation(world: World, f: Fighter): number {
  const cx = cxOf(f)
  let s = 0
  for (const o of world.fighters) {
    if (o === f || !isActive(o) || Math.abs(o.y - f.y) >= SPRITE_H) continue
    const d = cx - cxOf(o)
    const ad = Math.abs(d)
    if (ad >= PERSONAL_SPACE) continue
    const dir = ad < 0.01 ? (f.id < o.id ? -1 : 1) : d > 0 ? 1 : -1
    s += (dir * (PERSONAL_SPACE - ad)) / PERSONAL_SPACE
  }

  return s * WALK * 1.5
}

function aiIdle(world: World, L: Layout, f: Fighter, fa: FighterAux, aggr: number): void {
  const grounded = isGrounded(f, L)
  if (f.pose === 'taunt' && f.poseTicks < TAUNT_TICKS && grounded) {
    f.vx = 0

    return
  }
  const cx = cxOf(f)
  const tgt = validTarget(world, f, f.targetId) ?? nearestTarget(world, f)
  const toward: 1 | -1 = tgt !== null ? dirTo(f, tgt) : f.facing
  const gap = tgt !== null ? hgap(f, tgt) : Number.POSITIVE_INFINITY
  let desired = 0
  let face: 1 | -1 = tgt !== null ? toward : f.facing

  if (fa.wanderTicks > 0) {
    fa.wanderTicks -= 1
    desired = fa.wanderDir * WALK
    if (!fa.wanderBack || tgt === null) face = fa.wanderDir
  } else if (tgt !== null) {
    if (gap > 2) {
      const run = gap > 16 || (gap > 8 && aggr >= 0.45)
      desired = toward * (run ? RUN : WALK)
    } else if (rand(world) < 0.1) {
      // 近づきすぎたら少し引いて間合いを取り直す(相手の方を向いたまま下がる)
      fa.wanderTicks = 3 + Math.floor(rand(world) * 6)
      fa.wanderDir = toward === 1 ? -1 : 1
      fa.wanderBack = true
    }
  }
  const sep = separation(world, f)
  if (sep !== 0) {
    desired = clamp(desired + sep, -RUN, RUN)
    // 押し合いでごく遅くなったら、足踏みせず止まる
    if (Math.abs(desired) < 0.3) desired = 0
  }

  // 足場の端3列以内では中央へ向きを変える
  let edgeTurn = false
  if (cx < L.stageLeft + 3 && desired <= 0) {
    fa.wanderTicks = 6
    fa.wanderDir = 1
    fa.wanderBack = false
    desired = WALK
    face = 1
    edgeTurn = true
  } else if (cx > L.stageRight - 3 && desired >= 0) {
    fa.wanderTicks = 6
    fa.wanderDir = -1
    fa.wanderBack = false
    desired = -WALK
    face = -1
    edgeTurn = true
  }

  // 歩く向きの反転は数ティック空ける(押し合いでぶるぶる震えないように)
  if (fa.signHold > 0) fa.signHold -= 1
  const sg = Math.sign(desired)
  if (sg !== 0) {
    if (fa.lastSign !== 0 && sg !== fa.lastSign) {
      if (fa.signHold > 0 && !edgeTurn) {
        desired = fa.lastSign * Math.min(Math.abs(desired), WALK)
      } else {
        fa.signHold = 4
        fa.lastSign = sg
      }
    } else if (fa.lastSign === 0) {
      fa.lastSign = sg
    }
  }

  if (!grounded) {
    // 空中はゆるく向きを変えられる
    f.vx += clamp(desired - f.vx, -0.08, 0.08)
    f.facing = face

    return
  }

  f.vx = safeVx(f, L, desired)
  f.facing = face
  const r = rand(world)
  const jabChance = tgt !== null && gap <= 4 && Math.abs(tgt.y - f.y) < SPRITE_H ? 0.12 * aggr : 0
  // ツール呼び出しが無い間も試合が進むよう、たまに自分の得意技を出す(待機中で1体あたり約30秒に1回)
  const signatureChance = tgt !== null ? 0.01 * aggr : 0
  if (r < jabChance) {
    startMove(world, f, 'jab', '', tgt)
  } else if (r < jabChance + signatureChance) {
    startMove(world, f, SIGNATURE_MOVES[f.family], '', tgt)
  } else if (r < jabChance + signatureChance + 0.02) {
    groundJump(f, L)
  } else if (r < jabChance + signatureChance + 0.025) {
    f.pose = 'taunt'
    f.poseTicks = 0
    f.vx = 0
  }
}

function control(world: World, L: Layout, f: Fighter, fa: FighterAux, aggr: number): void {
  if (f.stunTicks > 0) return
  if (f.pose === 'respawn' && f.poseTicks < 2) return
  const off = isOffStage(f, L)
  if (off) {
    if (f.move !== null && f.move.kind !== 'final') cancelMove(world, f)
    if (f.move === null) {
      recoverAI(world, L, f, fa)

      return
    }
  }
  if (f.move === null && f.queue.length > 0) {
    const q = f.queue.shift()
    if (q !== undefined) startMove(world, f, q.kind, q.tool, null)
  }
  if (f.move !== null) {
    updateMove(world, L, f, fa)

    return
  }
  aiIdle(world, L, f, fa, aggr)
}

// ---- 物理 ----

function physics(f: Fighter, fa: FighterAux, L: Layout): void {
  if (f.pose === 'ko' || f.pose === 'out') return
  // 復活台で2ティック浮く
  if (f.pose === 'respawn' && f.poseTicks < 2) return
  const prevY = f.y
  if (f.stunTicks > 0) f.vx *= STUN_DECAY
  f.x += f.vx
  f.y += f.vy - GRAVITY / 2
  f.vy -= GRAVITY
  if (prevY >= -1e-9 && f.y <= 0 && onStageX(f, L)) {
    f.y = 0
    f.vy = 0
    f.jumpsLeft = 1
    fa.upBUsed = false
  }
}

function derivePose(world: World, L: Layout, f: Fighter, fa: FighterAux): Pose {
  if (f.pose === 'ko' || f.pose === 'out') return f.pose
  if (f.stunTicks > 0) {
    return f.pose === 'hurt' || f.pose === 'tumble' || f.pose === 'dizzy' ? f.pose : 'hurt'
  }
  const grounded = isGrounded(f, L)
  if (world.phase === 'game' && f.id === world.winner && grounded) return 'taunt'
  if (f.move !== null && fa.ms !== null) return fa.ms.pose
  if (f.pose === 'respawn' && !grounded) return 'respawn'
  if (f.pose === 'taunt' && f.poseTicks < TAUNT_TICKS && grounded) return 'taunt'
  if (!grounded) return f.vy > 0 ? 'jump' : 'fall'

  return Math.abs(f.vx) > 0.05 ? 'walk' : 'idle'
}

function settlePose(world: World, L: Layout, f: Fighter, fa: FighterAux): void {
  const next = derivePose(world, L, f, fa)
  if (next !== f.pose) {
    f.pose = next
    f.poseTicks = 0
  } else {
    f.poseTicks += 1
  }
  // めまいの星は頭上についていく
  const dz = fa.dizzyFx
  if (dz !== null) {
    if (f.pose === 'dizzy' && f.stunTicks > 0 && dz.ttl > 0) {
      dz.x = Math.round(cxOf(f))
      dz.y = Math.max(0, topRow(world, f) - 1)
    } else {
      dropEffect(world, dz)
      fa.dizzyFx = null
    }
  }
}

// ---- 飛び道具 ----

function updateProjectiles(world: World, L: Layout): void {
  let w = 0
  for (const p of world.projectiles) {
    p.x += p.vx
    p.ttl -= 1
    const width = p.kind === 'beam' ? BEAM_W : ASSIST_W
    const owner = fighterOf(world, p.owner)
    const def = p.kind === 'beam' ? MOVES.beam : MOVES.assist
    const dir: 1 | -1 = p.vx >= 0 ? 1 : -1
    for (const v of world.fighters) {
      if (v.id === p.owner || p.hitIds.includes(v.id) || !targetable(v)) continue
      if (p.x >= v.x + SPRITE_W || p.x + width <= v.x) continue
      // beamは体の中段の高さ、assistは足場の上の1行
      const lo = p.kind === 'beam' ? p.y + 1 : p.y
      const hi = p.kind === 'beam' ? p.y + 2 : p.y + 1
      if (hi <= v.y || lo >= v.y + SPRITE_H) continue
      if (applyHit(world, L, owner ?? null, v, def, dir)) p.hitIds.push(v.id)
    }
    let alive = p.ttl > 0
    if (p.kind === 'beam') {
      if (p.x > world.width + 4 || p.x + width < -4) alive = false
    } else {
      const c = p.x + width / 2
      if (c < L.stageLeft - 1 || c > L.stageRight + 1) alive = false
    }
    if (alive) world.projectiles[w++] = p
  }
  world.projectiles.length = w
}

// ---- スマッシュボール ----

function pruneCalls(world: World): void {
  const lim = world.tick - BALL_WINDOW
  let i = 0
  while (i < world.recentCalls.length && (world.recentCalls[i] ?? 0) < lim) i += 1
  if (i > 0) world.recentCalls.splice(0, i)
  if (world.recentCalls.length > 64) world.recentCalls.splice(0, world.recentCalls.length - 64)
}

function maybeSpawnBall(world: World): void {
  if (world.smashBall !== null || world.phase === 'game') return
  if (world.tick - world.lastSmashBallTick < BALL_COOLDOWN) return
  pruneCalls(world)
  let n = 0
  for (const t of world.recentCalls) if (world.tick - t <= BALL_WINDOW) n += 1
  if (n < BALL_NEED_CALLS) return
  const L = layout(world.width, world.height)
  const xMin = L.stageLeft + 2
  const xMax = Math.max(xMin, L.stageRight - 3)
  const yMax = Math.max(1.5, Math.min(5.5, L.platformRow - 2))
  world.smashBall = {
    x: xMin + rand(world) * (xMax - xMin),
    y: 1 + rand(world) * (yMax - 1),
    vx: (rand(world) < 0.5 ? -1 : 1) * (0.25 + rand(world) * 0.15),
    vy: (rand(world) < 0.5 ? -1 : 1) * (0.12 + rand(world) * 0.1),
  }
  world.lastSmashBallTick = world.tick
}

function tickBall(world: World, L: Layout): void {
  const b = world.smashBall
  if (b === null) return
  if (world.tick - world.lastSmashBallTick >= BALL_LIFE) {
    world.smashBall = null

    return
  }
  b.x += b.vx
  b.y += b.vy
  const xMin = L.stageLeft + 2
  const xMax = Math.max(xMin, L.stageRight - 3)
  const yMax = Math.max(1.5, Math.min(5.5, L.platformRow - 2))
  if (b.x < xMin) {
    b.x = xMin
    b.vx = Math.abs(b.vx)
  } else if (b.x > xMax) {
    b.x = xMax
    b.vx = -Math.abs(b.vx)
  }
  if (b.y < 1) {
    b.y = 1
    b.vy = Math.abs(b.vy)
  } else if (b.y > yMax) {
    b.y = yMax
    b.vy = -Math.abs(b.vy)
  }
  // ときどき向きを変えて予測しにくくする
  if (world.tick % 30 === 0) {
    b.vx = (rand(world) < 0.5 ? -1 : 1) * (0.25 + rand(world) * 0.15)
    b.vy = (rand(world) < 0.5 ? -1 : 1) * (0.12 + rand(world) * 0.1)
  }
}

// ---- 外部からのイベント ----

function fighterByFamily(world: World, fam: Family): Fighter | undefined {
  for (const f of world.fighters) if (f.family === fam) return f

  return undefined
}

function shortTool(tool: string): string {
  return tool.length > 22 ? `${tool.slice(0, 21)}…` : tool
}

export function onToolCall(world: World, tool: string): void {
  world.activity = Math.min(1, world.activity + 0.15)
  world.recentCalls.push(world.tick)
  maybeSpawnBall(world)
  const f = fighterByFamily(world, familyOf(tool))
  if (f === undefined || f.stocks <= 0 || f.pose === 'out') return

  let kind: MoveKind
  if (f.hasSmashBall) {
    kind = 'final'
    f.hasSmashBall = false
  } else {
    kind = moveOf(tool)
  }
  if (f.queue.length < 3) f.queue.push({ kind, tool })
  else if (kind === 'final') f.queue[f.queue.length - 1] = { kind, tool }
  world.ticker = `P${f.id + 1} ${f.label} ▸ ${shortTool(tool)}: ${kind.toUpperCase()}`

  // 出現して20ティック以上経ったあとの最初の呼び出しの持ち主がボールを取る
  if (world.smashBall !== null && !f.hasSmashBall && world.tick - world.lastSmashBallTick >= BALL_PICKUP_DELAY) {
    f.hasSmashBall = true
    world.smashBall = null
    popup(world, f, 'SMASH BALL!', f.color)
  }
}

export function onToolResult(world: World, tool: string, isError: boolean): void {
  if (!isError || world.phase === 'game') return
  const f = fighterByFamily(world, familyOf(tool))
  if (f === undefined || !isActive(f)) return
  const fa = fauxOf(world, f)
  f.stunTicks = DIZZY_TICKS
  f.pose = 'dizzy'
  f.poseTicks = 0
  f.vx = 0
  cancelMove(world, f)
  if (fa.dizzyFx !== null) dropEffect(world, fa.dizzyFx)
  fa.dizzyFx = addEffect(
    world,
    'dizzy',
    Math.round(cxOf(f)),
    Math.max(0, topRow(world, f) - 1),
    DIZZY_TICKS,
    DIZZY_YELLOW,
  )
  popup(world, f, 'ERR', ERR_RED)
}

export function onPrompt(world: World): void {
  world.activity = Math.min(1, world.activity + 0.2)
  if (world.phase !== 'fight') return
  const L = layout(world.width, world.height)
  for (const f of world.fighters) {
    if (!isActive(f) || f.stunTicks > 0 || f.move !== null || !isGrounded(f, L)) continue
    f.vy = capV(L, 1.1, f.y)
  }
}

// ---- 進行 ----

function pickWinner(world: World): Fighter | undefined {
  const alive = world.fighters.filter(f => f.stocks > 0)
  if (alive.length > 0) return alive[0]
  // 同時KOで全滅したら、KO数が多い方(同数ならP番号が小さい方)を勝者にして復活させる
  const sorted = [...world.fighters].sort((a, b) => b.kos - a.kos || a.id - b.id)
  const w = sorted[0]
  if (w !== undefined) w.stocks = 1

  return w
}

function enterGame(world: World, L: Layout): void {
  const winner = pickWinner(world)
  world.phase = 'game'
  world.phaseTicks = 0
  world.winner = winner !== undefined ? winner.id : null
  world.projectiles = []
  world.smashBall = null
  banner(world, 'GAME!', GAME_TICKS, PALETTE.bannerFg)
  for (const f of world.fighters) {
    f.queue = []
    if (f !== winner) continue
    f.move = null
    fauxOf(world, f).ms = null
    f.stunTicks = 0
    f.hasSmashBall = false
    f.invincibleTicks = GAME_TICKS + WIN_TICKS + 10
    if (f.pose === 'ko' || f.pose === 'out' || isOffStage(f, L) || exitOf(f, L) !== null) {
      respawn(world, L, f)
      f.invincibleTicks = GAME_TICKS + WIN_TICKS + 10
    } else {
      f.vx = 0
    }
    settlePose(world, L, f, fauxOf(world, f))
  }
}

function stepGame(world: World, L: Layout): void {
  world.phaseTicks += 1
  for (const f of world.fighters) {
    const fa = fauxOf(world, f)
    if (f.invincibleTicks > 0) f.invincibleTicks -= 1
    if (f.id === world.winner && f.stocks > 0) {
      f.vx = 0
      physics(f, fa, L)
    }
    settlePose(world, L, f, fa)
  }
  if (world.phaseTicks === GAME_TICKS) {
    const w = fighterOf(world, world.winner)
    if (w !== undefined) banner(world, `P${w.id + 1} ${w.label} WINS!`, WIN_TICKS, w.color)
    else banner(world, 'DRAW!', WIN_TICKS, PALETTE.bannerFg)
  }
  if (world.phaseTicks >= GAME_TICKS + WIN_TICKS) newMatch(world)
}

function stepWait(world: World, L: Layout): void {
  // ready / go: 動かない。タイマーとポーズ時間だけ進める
  world.phaseTicks += 1
  for (const f of world.fighters) {
    const fa = fauxOf(world, f)
    if (f.invincibleTicks > 0) f.invincibleTicks -= 1
    if (f.stunTicks > 0) f.stunTicks -= 1
    settlePose(world, L, f, fa)
  }
  if (world.phase === 'ready' && world.phaseTicks >= READY_TICKS) {
    world.phase = 'go'
    world.phaseTicks = 0
    banner(world, 'GO!', GO_TICKS, PALETTE.bannerFg)
  } else if (world.phase === 'go' && world.phaseTicks >= GO_TICKS) {
    world.phase = 'fight'
    world.phaseTicks = 0
  }
}

function stepFight(world: World, L: Layout, aggr: number): void {
  world.phaseTicks += 1
  const fs = world.fighters
  const n = fs.length

  for (const f of fs) {
    if (f.invincibleTicks > 0) f.invincibleTicks -= 1
    if (f.stunTicks > 0) f.stunTicks -= 1
  }

  // 先に動くのが毎回同じ相手にならないよう、開始位置を回す
  for (let k = 0; k < n; k++) {
    const f = fs[(k + world.tick) % n]
    if (f === undefined) continue
    const fa = fauxOf(world, f)
    if (f.pose === 'out') continue
    if (f.pose === 'ko') {
      if (f.poseTicks >= KO_TICKS) respawn(world, L, f)
      continue
    }
    // 40ティックごとに狙いを選び直す。狙いが脱落したときもすぐ選び直す
    if ((world.tick + f.id * 10) % 40 === 0 || validTarget(world, f, f.targetId) === null) {
      const t = randomTarget(world, f)
      f.targetId = t !== null ? t.id : null
    }
    control(world, L, f, fa, aggr)
  }

  for (const f of fs) physics(f, fauxOf(world, f), L)
  updateProjectiles(world, L)

  for (const f of fs) {
    if (!isActive(f)) continue
    const exit = exitOf(f, L)
    if (exit !== null) koFighter(world, f, exit)
  }
  for (const f of fs) settlePose(world, L, f, fauxOf(world, f))

  let alive = 0
  for (const f of fs) if (f.stocks > 0) alive += 1
  if (alive <= 1) enterGame(world, L)
}

export function step(world: World, ctx: { isWorking: boolean }): void {
  world.tick += 1
  tickEffects(world)
  if (world.shake > 0) world.shake -= 1
  world.activity *= 0.995
  const L = layout(world.width, world.height)
  maybeSpawnBall(world)
  tickBall(world, L)

  switch (world.phase) {
    case 'ready':
    case 'go':
      stepWait(world, L)
      break
    case 'fight':
      stepFight(world, L, aggression(world, ctx.isWorking))
      break
    case 'game':
      stepGame(world, L)
      break
  }
}

// ---- ステータスライン ----

export function hudText(world: World): string {
  const parts: string[] = []
  if (world.phase === 'game') {
    const w = fighterOf(world, world.winner)
    parts.push(w !== undefined ? `GAME! P${w.id + 1} ${w.label} WINS` : 'GAME! DRAW')
  } else {
    parts.push('CLAWD BROS')
    if (world.phase === 'ready') parts.push('READY?')
    else if (world.phase === 'go') parts.push('GO!')
  }
  for (const f of world.fighters) {
    const head = `P${f.id + 1} ${f.label}`
    parts.push(f.stocks <= 0 ? `${head} OUT` : `${head} ${Math.floor(f.damage)}% ${'●'.repeat(f.stocks)}`)
  }
  if (world.ticker !== '') parts.push(`▸ ${world.ticker}`)

  return parts.join('  ')
}
