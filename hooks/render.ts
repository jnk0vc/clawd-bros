// Clawd Brosの描画。Worldを読むだけで、書き換えない。
// 使う文字は印字可能ASCIIと、ブロック要素 ▀▄█▌▐▖▗▘▙▚▛▜▝▞▟ のみ。

import { DEFAULT_COLOR, PALETTE, SPRITE_H, SPRITE_W, layout, spriteTopRow } from './model'
import type { Effect, Fighter, Grid, Layout, MoveKind, World } from './model'

// ---- 文字コード ----
const SPACE = 0x20
const STAR = 0x2a // *
const PLUS = 0x2b // +
const DOT = 0x2e // .
const UPPER = 0x2580 // ▀
const LOWER = 0x2584 // ▄
const FULL = 0x2588 // █
const WHITE = 0xffffff

// ---- 数値・色のヘルパー ----

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** aからbへt(0..1)だけ寄せる */
function mix(a: number, b: number, t: number): number {
  if (t <= 0) return a
  if (t >= 1) return b
  const ar = (a >> 16) & 255
  const ag = (a >> 8) & 255
  const ab = a & 255
  const br = (b >> 16) & 255
  const bg = (b >> 8) & 255
  const bb = b & 255
  return (
    (((ar + (br - ar) * t + 0.5) | 0) << 16) |
    (((ag + (bg - ag) * t + 0.5) | 0) << 8) |
    ((ab + (bb - ab) * t + 0.5) | 0)
  )
}

/** 明るさをk倍する(0..1で暗く) */
function scale(c: number, k: number): number {
  const r = clamp((((c >> 16) & 255) * k + 0.5) | 0, 0, 255)
  const g = clamp((((c >> 8) & 255) * k + 0.5) | 0, 0, 255)
  const b = clamp(((c & 255) * k + 0.5) | 0, 0, 255)
  return (r << 16) | (g << 8) | b
}

/** 虹色の64段テーブル(毎回計算しない) */
const RAINBOW = new Uint32Array(64)
for (let i = 0; i < 64; i++) {
  const s = 0.65
  const k = (i / 64) * 6
  const sector = Math.floor(k)
  const f = k - sector
  const p = 1 - s
  const q = 1 - s * f
  const t = 1 - s * (1 - f)
  let r = 1
  let g = t
  let b = p
  switch (sector % 6) {
    case 1:
      r = q
      g = 1
      b = p
      break
    case 2:
      r = p
      g = 1
      b = t
      break
    case 3:
      r = p
      g = q
      b = 1
      break
    case 4:
      r = t
      g = p
      b = 1
      break
    case 5:
      r = 1
      g = p
      b = q
      break
    default:
      break
  }
  RAINBOW[i] = (((r * 255 + 0.5) | 0) << 16) | (((g * 255 + 0.5) | 0) << 8) | ((b * 255 + 0.5) | 0)
}

function rainbowAt(step: number): number {
  return RAINBOW[Math.floor(step) & 63] ?? WHITE
}

/** 3値の整数ハッシュ。星の配置とまたたき、火花のばらつきに使う */
function hash3(a: number, b: number, c: number): number {
  let h = Math.imul(a | 0, 0x27d4eb2d) ^ Math.imul(b | 0, 0x165667b1) ^ Math.imul(c | 0, 0x2545f491)
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

// ---- セル書き込み(範囲外は黙って捨てる) ----

/** 文字と前景色だけ書く。背景はそのまま */
function put(g: Grid, c: number, r: number, ch: number, fg: number): void {
  if (c < 0 || c >= g.columns || r < 0 || r >= g.rows) return
  const i = r * g.columns + c
  g.ch[i] = ch
  g.fg[i] = fg
}

function putBg(g: Grid, c: number, r: number, ch: number, fg: number, bg: number): void {
  if (c < 0 || c >= g.columns || r < 0 || r >= g.rows) return
  const i = r * g.columns + c
  g.ch[i] = ch
  g.fg[i] = fg
  g.bg[i] = bg
}

function printable(code: number): number {
  return code >= 0x20 && code <= 0x7e ? code : SPACE
}

/** ASCII文字列を書く。bgが負なら背景は触らない */
function putText(g: Grid, c: number, r: number, text: string, fg: number, bg: number): void {
  if (r < 0 || r >= g.rows) return
  for (let k = 0; k < text.length; k++) {
    const code = printable(text.charCodeAt(k))
    if (bg >= 0) putBg(g, c + k, r, code, fg, bg)
    else if (code !== SPACE) put(g, c + k, r, code, fg)
  }
}

// ---- 背景(グラデーション + 流れる星) ----

function drawBackground(g: Grid, L: Layout, world: World): void {
  const cols = g.columns
  const rows = g.rows
  for (let r = 0; r < rows; r++) {
    let color: number = PALETTE.voidTop
    if (r < L.platformRow) {
      const t = L.platformRow <= 1 ? 1 : r / (L.platformRow - 1)
      color =
        t < 0.5
          ? mix(PALETTE.voidTop, PALETTE.nebula, t * 2)
          : mix(PALETTE.nebula, PALETTE.horizon, (t - 0.5) * 2)
    }
    g.bg.fill(color, r * cols, (r + 1) * cols)
  }

  // 8ティックごとに1列左へ流れる。星の位置は世界の列で決める
  const shift = Math.floor(world.tick / 8)
  const twinkle = Math.floor(world.tick / 3)
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const h = hash3(c + shift, r, world.matchNo)
      if (h % 1000 >= 30) continue
      const kind = (h >>> 12) % 10
      const phase = (twinkle + (h >>> 20)) & 3
      const fg = phase === 0 ? PALETTE.starDim : phase === 2 ? PALETTE.starBright : PALETTE.starMid
      const i = r * cols + c
      g.ch[i] = kind < 6 ? DOT : kind < 9 ? PLUS : STAR
      g.fg[i] = fg
    }
  }
}

// ---- 終点の足場 ----

function drawPlatform(g: Grid, L: Layout, dx: number): void {
  const pr = L.platformRow
  const sl = L.stageLeft + dx
  const sr = L.stageRight + dx
  const under = PALETTE.platformUnder

  // 上面: 光る縁
  for (let c = sl; c < sr; c++) {
    putBg(g, c, pr, UPPER, PALETTE.platformEdge, PALETTE.platformBody)
  }

  // 1段下: 両端2列ずつ内側。端は半ブロックで斜めに
  const r1 = pr + 1
  for (let c = sl + 2; c < sr - 2; c++) putBg(g, c, r1, SPACE, under, under)
  put(g, sl + 1, r1, 0x2590, under) // ▐
  put(g, sr - 2, r1, 0x258c, under) // ▌

  // 2段下: もっと細く先細り(上半分だけ)
  const r2 = pr + 2
  const k = clamp(Math.round((sr - sl) * 0.2), 5, 36)
  for (let c = sl + k; c < sr - k; c++) put(g, c, r2, UPPER, under)
  put(g, sl + k - 1, r2, 0x259d, under) // ▝
  put(g, sr - k, r2, 0x2598, under) // ▘
}

// ---- スプライト ----

type Frame = readonly [string, string, string]

const HEAD = ' ▐▛███▜▌ '
const BODY = '▝▜█████▛▘'
const HEAD_UP = '▗▐▛███▜▌▖' // 腕を上げた頭
const BODY_UP = ' ▜█████▛ ' // 腕の先を外した胴
const LEGS_STAND = '  ▘▘ ▝▝  '
const LEGS_STRIDE = ' ▗▘   ▝▖ ' // 大股
const LEGS_STEP = '  ▝▘ ▝▘  ' // そろえて踏み出す
const LEGS_TUCK = '  ▝▀▀▀▘  ' // 脚をたたむ
const LEGS_DANGLE = '  ▗▘ ▝▖  ' // ぶらさがる
const LEGS_CROSS = '  ▝▝ ▘▘  ' // ふらつき・回転
const LEGS_FUNNEL = '  ▝▜█▛▘  ' // 急降下の先すぼまり

/** 上下反転(ブロック文字の上下を入れ替える) */
function flipV(code: number): number {
  switch (code) {
    case 0x2580:
      return 0x2584
    case 0x2584:
      return 0x2580
    case 0x2598:
      return 0x2596
    case 0x2596:
      return 0x2598
    case 0x259d:
      return 0x2597
    case 0x2597:
      return 0x259d
    case 0x259b:
      return 0x2599
    case 0x2599:
      return 0x259b
    case 0x259c:
      return 0x259f
    case 0x259f:
      return 0x259c
    case 0x259e:
      return 0x259a
    case 0x259a:
      return 0x259e
    default:
      return code
  }
}

/** 左右反転 */
function flipH(code: number): number {
  switch (code) {
    case 0x2598:
      return 0x259d
    case 0x259d:
      return 0x2598
    case 0x2596:
      return 0x2597
    case 0x2597:
      return 0x2596
    case 0x2599:
      return 0x259f
    case 0x259f:
      return 0x2599
    case 0x259b:
      return 0x259c
    case 0x259c:
      return 0x259b
    case 0x258c:
      return 0x2590
    case 0x2590:
      return 0x258c
    case 0x259a:
      return 0x259e
    case 0x259e:
      return 0x259a
    default:
      return code
  }
}

function flipRowV(s: string): string {
  let out = ''
  for (let i = 0; i < s.length; i++) out += String.fromCharCode(flipV(s.charCodeAt(i)))
  return out
}

const F_BASE: Frame = [HEAD, BODY, LEGS_STAND]
const F_WALK_A: Frame = [HEAD, BODY, LEGS_STRIDE]
const F_WALK_B: Frame = [HEAD, BODY, LEGS_STEP]
const F_JUMP: Frame = [HEAD_UP, BODY_UP, LEGS_TUCK]
const F_FALL: Frame = [HEAD_UP, BODY_UP, LEGS_DANGLE]
const F_TAUNT_A: Frame = [HEAD_UP, BODY_UP, LEGS_STAND]
const F_TAUNT_B: Frame = [HEAD_UP, BODY_UP, LEGS_STEP]
const F_CROSS: Frame = [HEAD, BODY, LEGS_CROSS]
const F_METEOR: Frame = [HEAD, BODY, LEGS_FUNNEL]
const F_ASSIST_R: Frame = [' ▐▛███▜▌▗', '▝▜█████▛ ', LEGS_STAND]
const F_ASSIST_L: Frame = ['▖▐▛███▜▌ ', ' ▜█████▛▘', LEGS_STAND]
const F_TUMBLE: Frame = [flipRowV(LEGS_STAND), flipRowV(BODY), flipRowV(HEAD)]

/** テスト用に公開。全フレームはSPRITE_H行、SPRITE_W列 */
export const SPRITE_FRAMES: readonly Frame[] = [
  F_BASE,
  F_WALK_A,
  F_WALK_B,
  F_JUMP,
  F_FALL,
  F_TAUNT_A,
  F_TAUNT_B,
  F_CROSS,
  F_METEOR,
  F_ASSIST_R,
  F_ASSIST_L,
  F_TUMBLE,
]

/** 攻撃時に伸ばす腕(右向きの形。左向きは左右反転して使う) */
const ARM: Record<MoveKind, string> = {
  jab: '▀▀',
  beam: '▀▀',
  smash: '▀▀▀█',
  meteor: '',
  dash: '▀▀▀',
  grab: '▀▀▀▝',
  assist: '',
  special: '▀▀',
  final: '▀▀▀',
}

function drawRow(g: Grid, s: string, col: number, row: number, fg: number): void {
  if (row < 0 || row >= g.rows) return
  for (let j = 0; j < s.length; j++) {
    const code = s.charCodeAt(j)
    if (code !== SPACE) put(g, col + j, row, code, fg)
  }
}

/** 腕をfacing側へ伸ばす。shown列ぶんだけ描く */
function drawArm(g: Grid, col0: number, top: number, facing: 1 | -1, kind: MoveKind, shown: number, fg: number): void {
  const text = ARM[kind]
  const n = Math.min(text.length, shown)
  for (let k = 0; k < n; k++) {
    const code = text.charCodeAt(k)
    if (facing === 1) put(g, col0 + SPRITE_W + k, top + 1, code, fg)
    else put(g, col0 - 1 - k, top + 1, flipH(code), fg)
  }
}

function bodyColor(world: World, f: Fighter): number {
  let c = f.color
  if (f.hasSmashBall || (f.pose === 'attack' && f.move !== null && f.move.kind === 'final')) {
    c = rainbowAt(world.tick * 2 + f.id * 16)
  }
  switch (f.pose) {
    case 'windup':
      return mix(c, WHITE, (f.poseTicks & 1) === 0 ? 0.55 : 0.2)
    case 'hurt':
      return mix(c, WHITE, (world.tick & 1) === 0 ? 0.45 : 0.1)
    case 'tumble':
      return (world.tick & 1) === 0 ? WHITE : c
    default:
      return c
  }
}

function pickFrame(world: World, f: Fighter, kind: MoveKind): Frame {
  const tick = world.tick
  switch (f.pose) {
    case 'walk':
      return ((tick >> 1) & 1) === 0 ? F_WALK_A : F_WALK_B
    case 'jump':
      return F_JUMP
    case 'fall':
      return F_FALL
    case 'taunt':
      return ((tick >> 1) & 1) === 0 ? F_TAUNT_A : F_TAUNT_B
    case 'tumble':
      return (tick & 3) === 3 ? F_BASE : F_TUMBLE
    case 'dizzy':
      return Math.floor(tick / 3) % 2 === 0 ? F_BASE : F_CROSS
    case 'attack':
      switch (kind) {
        case 'meteor':
          return F_METEOR
        case 'assist':
          return f.facing === 1 ? F_ASSIST_R : F_ASSIST_L
        case 'smash':
          return F_WALK_A
        case 'dash':
        case 'special':
        case 'final':
          return (tick & 1) === 0 ? F_WALK_A : F_CROSS
        default:
          return F_BASE
      }
    default:
      return F_BASE
  }
}

/** 頭上を回る星。位相は0が左、1が奥、2が右、3が手前 */
function drawDizzyStars(g: Grid, cx: number, row: number, tick: number, color: number): void {
  const ph = (tick >> 1) & 3
  for (let s = 0; s < 2; s++) {
    switch ((ph + s * 2) & 3) {
      case 0:
        put(g, cx - 2, row, STAR, color)
        break
      case 1:
        put(g, cx, row - 1, STAR, color)
        break
      case 2:
        put(g, cx + 2, row, STAR, color)
        break
      default:
        put(g, cx, row, STAR, color)
        break
    }
  }
}

const DIZZY_YELLOW = 0xffe14a

function drawFighter(g: Grid, world: World, f: Fighter, dx: number, dizzyFx: boolean): void {
  const pose = f.pose
  if (pose === 'ko' || pose === 'out') return
  let col0 = Math.round(f.x) + dx
  const top = spriteTopRow(world, f.y)

  // respawnと無敵中は1ティックおきに点滅。復活台は消さない
  if (pose === 'respawn') {
    for (let k = 1; k <= 7; k++) put(g, col0 + k, top + SPRITE_H, UPPER, WHITE)
  }
  if ((pose === 'respawn' || f.invincibleTicks > 0) && (world.tick & 1) === 1) return

  // ひるみは1列揺れる(のけぞる側へ)
  if (pose === 'hurt' && (world.tick & 1) === 0) col0 -= f.facing

  const color = bodyColor(world, f)
  const kind: MoveKind = f.move !== null ? f.move.kind : 'jab'
  const frame = pickFrame(world, f, kind)
  drawRow(g, frame[0], col0, top, color)
  drawRow(g, frame[1], col0, top + 1, color)
  drawRow(g, frame[2], col0, top + 2, color)

  if (pose === 'attack') {
    const arm = mix(color, WHITE, 0.35)
    const shown = 2 + f.poseTicks
    if (kind === 'special' || kind === 'final') {
      drawArm(g, col0, top, 1, kind, shown, arm)
      drawArm(g, col0, top, -1, kind, shown, arm)
    } else {
      drawArm(g, col0, top, f.facing, kind, shown, arm)
    }
  } else if (pose === 'dizzy' && !dizzyFx) {
    drawDizzyStars(g, col0 + 4, top - 1, world.tick, DIZZY_YELLOW)
  }
}

function drawLabel(g: Grid, world: World, f: Fighter, dx: number): void {
  if (f.pose === 'ko' || f.pose === 'out') return
  const row = spriteTopRow(world, f.y) - 1
  if (row < 0 || row >= g.rows) return
  const col = Math.round(f.x) + dx + 3
  put(g, col, row, 0x50, f.color) // P
  put(g, col + 1, row, 0x31 + f.id, f.color) // 1..4
}

// ---- 飛び道具・スマッシュボール ----

function drawProjectiles(g: Grid, world: World, dx: number): void {
  const tick = world.tick
  for (const p of world.projectiles) {
    const col = Math.round(p.x) + dx
    const top = spriteTopRow(world, p.y)
    let owner: Fighter | undefined
    for (const f of world.fighters) {
      if (f.id === p.owner) {
        owner = f
        break
      }
    }
    if (p.kind === 'beam') {
      const dir = p.vx > 0 ? 1 : p.vx < 0 ? -1 : owner !== undefined ? owner.facing : 1
      const text = dir === 1 ? '-==>' : '<==-'
      const head = mix(PALETTE.beam, WHITE, 0.55)
      for (let k = 0; k < 4; k++) {
        const isHead = dir === 1 ? k === 3 : k === 0
        put(g, col + k, top + 1, text.charCodeAt(k), isHead ? head : PALETTE.beam)
      }
    } else {
      // ミニClawd。足場の上を走るので足元の行に置く
      const color = owner !== undefined ? owner.color : WHITE
      const flip = (tick & 1) === 1
      put(g, col, top + 2, flip ? 0x2599 : 0x259f, color) // ▙ / ▟
      put(g, col + 1, top + 2, flip ? 0x259f : 0x2599, color)
    }
  }
}

function drawSmashBall(g: Grid, world: World, dx: number): void {
  const sb = world.smashBall
  if (sb === null) return
  const col = Math.round(sb.x) + dx
  const row = spriteTopRow(world, sb.y) + 1
  const color = rainbowAt(world.tick * 3)
  put(g, col, row, 0x2590, color) // ▐
  put(g, col + 1, row, 0x258c, color) // ▌
}

// ---- エフェクト ----

/** KOフレアの扇を組み立てる作業領域(半ブロック単位のビット。1が上半分、2が下半分) */
let koScratch = new Uint8Array(0)

function markHalf(m: Uint8Array, cols: number, rows: number, col: number, h: number): void {
  const row = h >> 1
  if (row < 0 || row >= rows || col < 0 || col >= cols) return
  const i = row * cols + col
  m[i] = (m[i] ?? 0) | ((h & 1) === 0 ? 1 : 2)
}

/** 出口から先端へ: 白 → 赤 → 暗赤。時間が進むほど全体が冷めて暗くなる */
function koColor(f: number, p: number): number {
  const ff = clamp(f * 0.9 + (1 - p) * 0.5, 0, 1)
  const c =
    ff < 0.3 ? mix(PALETTE.koHot, PALETTE.koMid, ff / 0.3) : mix(PALETTE.koMid, PALETTE.koCool, (ff - 0.3) / 0.7)
  return scale(c, 0.5 + 0.5 * p)
}

const RAY_SLOPE = [0.45, 1.1] // 列あたりの半行
const RAY_MIN_P = [0.25, 0.55]
const RAY_LEN = [0.7, 0.45]

function drawKoBurst(g: Grid, e: Effect, dx: number, tick: number): void {
  const cols = g.columns
  const rows = g.rows
  const maxT = e.maxTtl > 0 ? e.maxTtl : 1
  const p = clamp(e.ttl / maxT, 0, 1)
  const elapsed = maxT - e.ttl
  const dir: 1 | -1 = e.dir ?? (e.x < cols / 2 ? 1 : -1)
  const ox = clamp(Math.round(e.x) + dx, 0, cols - 1)
  const oy = clamp(Math.round(e.y), 0, rows - 1)

  // 出口の端に全高の柱。数ティックだけ
  if (elapsed < 4) {
    const pillar = scale(PALETTE.koMid, 1 - Math.max(0, elapsed) * 0.18)
    for (let r = 0; r < rows; r++) put(g, ox, r, FULL, pillar)
  }

  const n = cols * rows
  if (koScratch.length < n) koScratch = new Uint8Array(n)
  const m = koScratch
  m.fill(0, 0, n)

  const lenMax = clamp(Math.round(cols * 0.42), 12, 96)
  const lc = Math.max(3, Math.round(lenMax * (0.18 + 0.82 * Math.pow(p, 0.6))))

  // 中心の光線(全面)
  for (let i = 0; i < lc; i++) {
    const col = ox + dir * i
    if (col < 0 || col >= cols) break
    m[oy * cols + col] = 3
  }
  // 中心の上下の細い行('▄'が上、'▀'が下で中心行に接する)
  const l1 = Math.round(lc * (0.55 + 0.25 * p))
  const core = p > 0.5 ? Math.round(3 * p) : 0
  for (let i = 0; i < l1; i++) {
    const col = ox + dir * i
    if (col < 0 || col >= cols) break
    const full = i < core ? 3 : -1
    if (oy - 1 >= 0) m[(oy - 1) * cols + col] = (m[(oy - 1) * cols + col] ?? 0) | (full === 3 ? 3 : 2)
    if (oy + 1 < rows) m[(oy + 1) * cols + col] = (m[(oy + 1) * cols + col] ?? 0) | (full === 3 ? 3 : 1)
  }
  // 斜めの光線。半ブロック解像度で扇状に広げる
  for (let si = 0; si < 2; si++) {
    if (p <= (RAY_MIN_P[si] ?? 1)) continue
    const slope = RAY_SLOPE[si] ?? 0.5
    const len = Math.round(lc * (RAY_LEN[si] ?? 0.5))
    for (let sign = -1; sign <= 1; sign += 2) {
      let prev = sign > 0 ? 2 * oy + 1 : 2 * oy
      for (let i = 1; i <= len; i++) {
        const col = ox + dir * i
        if (col < 0 || col >= cols) break
        const off = Math.round(slope * i)
        const h = sign > 0 ? 2 * oy + 1 + off : 2 * oy - off
        if (h === prev) {
          markHalf(m, cols, rows, col, h)
        } else {
          const lo = Math.min(prev, h)
          const hi = Math.max(prev, h)
          for (let hh = lo; hh <= hi; hh++) if (hh !== prev) markHalf(m, cols, rows, col, hh)
        }
        prev = h
      }
    }
  }

  // 書き出し。光線にならなかったセルの一部にまばらな'*'
  const sparkBase = e.color !== 0 ? e.color : PALETTE.koMid
  const sparkColor = scale(sparkBase, 0.5 + 0.5 * p)
  const sparkRange = p > 0.6 ? 3 : 2
  for (let i = 0; i < lc; i++) {
    const col = ox + dir * i
    if (col < 0 || col >= cols) break
    const color = koColor(i / lc, p)
    const sparkMod = 6 + Math.floor((6 * i) / lc)
    for (let r = 0; r < rows; r++) {
      const v = m[r * cols + col] ?? 0
      if (v !== 0) {
        put(g, col, r, v === 3 ? FULL : v === 1 ? UPPER : LOWER, color)
      } else if (p > 0.3 && i >= 2 && i < lc * 0.95) {
        const d = r > oy ? r - oy : oy - r
        if (d >= 2 && d <= sparkRange && hash3(col * 31 + tick, r, ox) % sparkMod === 0) {
          // 足場やファイターは壊さず、空きセルと星の上にだけ散らす
          const under = g.ch[r * cols + col] ?? SPACE
          if (under === SPACE || under === DOT || under === PLUS || under === STAR) put(g, col, r, STAR, sparkColor)
        }
      }
    }
  }
}

function drawEffect(g: Grid, world: World, e: Effect, dx: number): void {
  const tick = world.tick
  const maxT = e.maxTtl > 0 ? e.maxTtl : 1
  const p = clamp(e.ttl / maxT, 0, 1) // 1 → 0
  const elapsed = maxT - e.ttl
  const x = Math.round(e.x) + dx
  const y = Math.round(e.y)
  switch (e.kind) {
    case 'spark': {
      const prog = 1 - p
      put(g, x, y, prog < 1 / 3 ? STAR : prog < 2 / 3 ? PLUS : DOT, PALETTE.spark)
      break
    }
    case 'popup': {
      const text = e.text ?? ''
      const rise = Math.floor(Math.max(0, elapsed) / 3)
      const color = p < 0.25 ? scale(e.color, 0.6) : e.color
      putText(g, x - (text.length >> 1), y - rise, text, color, -1)
      break
    }
    case 'trail': {
      const dir = e.dir ?? 1
      const n = 2 + Math.ceil(3 * p)
      const base = 0.35 + 0.35 * p
      for (let k = 1; k <= n; k++) {
        put(g, x - dir * k, y, 0x2d, scale(e.color, base * (1 - 0.12 * k))) // -
      }
      break
    }
    case 'tether': {
      const tx = Math.round(e.toX ?? e.x) + dx
      const lo = Math.min(x, tx)
      const hi = Math.max(x, tx)
      for (let c = lo; c <= hi; c++) put(g, c, y, 0x7e, e.color) // ~
      break
    }
    case 'laser': {
      const tx = Math.round(e.toX ?? e.x) + dx
      const lo = Math.min(x, tx)
      const hi = Math.max(x, tx)
      const phase = tick % 3
      const color = phase === 0 ? WHITE : phase === 1 ? 0xffe14a : e.color
      // 終わりぎわは細く絞る
      const r0 = p < 0.2 ? 1 : 0
      const r1 = p < 0.2 ? 1 : 2
      for (let r = r0; r <= r1; r++) {
        for (let c = lo; c <= hi; c++) put(g, c, y + r, FULL, color)
      }
      break
    }
    case 'dizzy': {
      drawDizzyStars(g, x, y, tick, e.color !== 0 ? e.color : DIZZY_YELLOW)
      break
    }
    case 'banner': {
      const text = e.text ?? ''
      const row = clamp(Math.max(layout(g.columns, g.rows).platformRow - 5, 0), 0, g.rows - 1)
      const c0 = Math.floor((g.columns - text.length) / 2) + dx
      putBg(g, c0 - 1, row, SPACE, PALETTE.bannerFg, PALETTE.bannerBg)
      putText(g, c0, row, text, PALETTE.bannerFg, PALETTE.bannerBg)
      putBg(g, c0 + text.length, row, SPACE, PALETTE.bannerFg, PALETTE.bannerBg)
      break
    }
    case 'koBurst':
      drawKoBurst(g, e, dx, tick)
      break
    default:
      break // flashはdrawFrameで処理する
  }
}

// ---- 公開API: フレーム生成 ----

export function drawFrame(world: World): Grid {
  const columns = Math.max(1, Math.floor(world.width) || 1)
  const rows = Math.max(1, Math.floor(world.height) || 1)
  const n = columns * rows
  const g: Grid = {
    columns,
    rows,
    ch: new Uint32Array(n).fill(SPACE),
    fg: new Uint32Array(n),
    bg: new Uint32Array(n),
  }
  const L = layout(columns, rows)
  const dx = world.shake > 0 ? ((world.tick & 1) === 0 ? -1 : 1) : 0

  let flash = 0
  let hasDizzyFx = false
  for (const e of world.effects) {
    if (e.kind === 'flash') {
      const maxT = e.maxTtl > 0 ? e.maxTtl : 1
      flash = Math.max(flash, 0.2 + 0.3 * clamp(e.ttl / maxT, 0, 1)) // 最初は元色と白の中間、だんだん戻る
    } else if (e.kind === 'dizzy') {
      hasDizzyFx = true
    }
  }

  // 背景と足場
  drawBackground(g, L, world)
  drawPlatform(g, L, dx)

  // ファイター(スプライトを先に、ラベルは重なっても読めるよう最後)
  for (const f of world.fighters) drawFighter(g, world, f, dx, hasDizzyFx)
  for (const f of world.fighters) drawLabel(g, world, f, dx)

  // 飛び道具・スマッシュボール
  drawProjectiles(g, world, dx)
  drawSmashBall(g, world, dx)

  // フラッシュ(背景を白寄りにする。この上にエフェクトを重ねる)
  if (flash > 0) {
    const bg = g.bg
    let lastIn = -1
    let lastOut = 0
    for (let i = 0; i < n; i++) {
      const v = bg[i] ?? 0
      if (v !== lastIn) {
        lastIn = v
        lastOut = mix(v, WHITE, flash)
      }
      bg[i] = lastOut
    }
  }

  // エフェクト
  for (const e of world.effects) drawEffect(g, world, e, dx)
  return g
}

// ---- 公開API: Raster ----

const B64_CODES = new Uint8Array(64)
{
  const table = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  for (let i = 0; i < 64; i++) B64_CODES[i] = table.charCodeAt(i)
}

function bytesToBase64(b: Uint8Array): string {
  const len = b.length
  const out = new Uint8Array(Math.ceil(len / 3) * 4)
  let j = 0
  let i = 0
  for (; i + 2 < len; i += 3) {
    const v = ((b[i] ?? 0) << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0)
    out[j++] = B64_CODES[(v >> 18) & 63] ?? 0
    out[j++] = B64_CODES[(v >> 12) & 63] ?? 0
    out[j++] = B64_CODES[(v >> 6) & 63] ?? 0
    out[j++] = B64_CODES[v & 63] ?? 0
  }
  const rest = len - i
  if (rest === 1) {
    const v = (b[i] ?? 0) << 16
    out[j++] = B64_CODES[(v >> 18) & 63] ?? 0
    out[j++] = B64_CODES[(v >> 12) & 63] ?? 0
    out[j++] = 0x3d
    out[j++] = 0x3d
  } else if (rest === 2) {
    const v = ((b[i] ?? 0) << 16) | ((b[i + 1] ?? 0) << 8)
    out[j++] = B64_CODES[(v >> 18) & 63] ?? 0
    out[j++] = B64_CODES[(v >> 12) & 63] ?? 0
    out[j++] = B64_CODES[(v >> 6) & 63] ?? 0
    out[j++] = 0x3d
  }
  // fromCharCodeの引数が増えすぎないよう分割して文字列にする
  let s = ''
  for (let k = 0; k < out.length; k += 8192) {
    s += String.fromCharCode.apply(null, out.subarray(k, k + 8192) as unknown as number[])
  }
  return s
}

/** 行優先で各セル[codePoint, fg, bg]をu32リトルエンディアンで並べ、標準padded base64にする */
export function gridToRasterBase64(grid: Grid): string {
  const n = grid.columns * grid.rows
  const bytes = new Uint8Array(n * 12)
  let o = 0
  for (let i = 0; i < n; i++) {
    const a = grid.ch[i] ?? 0
    const f = grid.fg[i] ?? 0
    const b = grid.bg[i] ?? 0
    bytes[o] = a & 255
    bytes[o + 1] = (a >>> 8) & 255
    bytes[o + 2] = (a >>> 16) & 255
    bytes[o + 3] = (a >>> 24) & 255
    bytes[o + 4] = f & 255
    bytes[o + 5] = (f >>> 8) & 255
    bytes[o + 6] = (f >>> 16) & 255
    bytes[o + 7] = (f >>> 24) & 255
    bytes[o + 8] = b & 255
    bytes[o + 9] = (b >>> 8) & 255
    bytes[o + 10] = (b >>> 16) & 255
    bytes[o + 11] = (b >>> 24) & 255
    o += 12
  }
  return bytesToBase64(bytes)
}

// ---- 公開API: SVG(デスクトップ用。1セル8×16px) ----

const CELL_W = 8
const CELL_H = 16
const SVG_LIMIT = 120000

const HEX2: string[] = []
for (let i = 0; i < 256; i++) HEX2.push((i < 16 ? '0' : '') + i.toString(16))

function hex(c: number, fallback: string): string {
  if ((c & DEFAULT_COLOR) !== 0) return fallback // 端末既定色(bit24)は固定色で代用
  return (HEX2[(c >> 16) & 255] ?? '00') + (HEX2[(c >> 8) & 255] ?? '00') + (HEX2[c & 255] ?? '00')
}

/** ブロック要素U+2580..259Fの4象限ビット(1が左上、2が右上、4が左下、8が右下)。-1は使わない文字 */
const BLOCK_MASK = new Int8Array(32).fill(-1)
BLOCK_MASK[0x00] = 3 // ▀
BLOCK_MASK[0x04] = 12 // ▄
BLOCK_MASK[0x08] = 15 // █
BLOCK_MASK[0x0c] = 5 // ▌
BLOCK_MASK[0x10] = 10 // ▐
BLOCK_MASK[0x16] = 4 // ▖
BLOCK_MASK[0x17] = 8 // ▗
BLOCK_MASK[0x18] = 1 // ▘
BLOCK_MASK[0x19] = 13 // ▙
BLOCK_MASK[0x1a] = 9 // ▚
BLOCK_MASK[0x1b] = 7 // ▛
BLOCK_MASK[0x1c] = 11 // ▜
BLOCK_MASK[0x1d] = 2 // ▝
BLOCK_MASK[0x1e] = 6 // ▞
BLOCK_MASK[0x1f] = 14 // ▟

function rectEl(x: number, y: number, w: number, h: number, fill: string): string {
  return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" fill="#' + fill + '"/>'
}

function escapeChar(code: number): string {
  return code === 0x26 ? '&amp;' : code === 0x3c ? '&lt;' : code === 0x3e ? '&gt;' : String.fromCharCode(code)
}

/** 0は重要な文字、1は細部('.' '+' '*')、2は星(細部のうち星の色のもの。最初に捨てる) */
function textClass(code: number, fg: number): number {
  if (code === DOT || code === PLUS || code === STAR) {
    return fg === PALETTE.starDim || fg === PALETTE.starMid || fg === PALETTE.starBright ? 2 : 1
  }
  return 0
}

export function gridToSvg(grid: Grid): string {
  const cols = grid.columns
  const rows = grid.rows
  const width = cols * CELL_W
  const height = rows * CELL_H
  const head =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' +
    width +
    ' ' +
    height +
    '" width="' +
    width +
    '" height="' +
    height +
    '" shape-rendering="crispEdges">'
  const tail = '</svg>'

  const bgEls: string[] = []
  const blockEls: string[] = []
  const textEls: string[][] = [[], [], []]

  for (let r = 0; r < rows; r++) {
    const base = r * cols
    const y = r * CELL_H

    // 背景: 同色の連続セルを1つのrectに
    let c = 0
    while (c < cols) {
      const color = grid.bg[base + c] ?? 0
      let e = c + 1
      while (e < cols && grid.bg[base + e] === color) e++
      bgEls.push(rectEl(c * CELL_W, y, (e - c) * CELL_W, CELL_H, hex(color, '000000')))
      c = e
    }

    // 文字・ブロック
    c = 0
    while (c < cols) {
      const code = grid.ch[base + c] ?? SPACE
      const fg = grid.fg[base + c] ?? 0
      if (code === SPACE) {
        c++
        continue
      }
      const x = c * CELL_W
      const mask = code >= 0x2580 && code <= 0x259f ? (BLOCK_MASK[code - 0x2580] ?? -1) : -1
      if (mask === 3 || mask === 12 || mask === 15) {
        // 全幅のブロックは同じ文字・同色の連続をまとめる
        let e = c + 1
        while (e < cols && grid.ch[base + e] === code && grid.fg[base + e] === fg) e++
        const hh = mask === 15 ? CELL_H : CELL_H / 2
        const yy = mask === 12 ? y + CELL_H / 2 : y
        blockEls.push(rectEl(x, yy, (e - c) * CELL_W, hh, hex(fg, 'cccccc')))
        c = e
      } else if (mask > 0) {
        const fill = hex(fg, 'cccccc')
        const hw = CELL_W / 2
        const hh = CELL_H / 2
        if ((mask & 5) === 5) blockEls.push(rectEl(x, y, hw, CELL_H, fill))
        else {
          if ((mask & 1) !== 0) blockEls.push(rectEl(x, y, hw, hh, fill))
          if ((mask & 4) !== 0) blockEls.push(rectEl(x, y + hh, hw, hh, fill))
        }
        if ((mask & 10) === 10) blockEls.push(rectEl(x + hw, y, hw, CELL_H, fill))
        else {
          if ((mask & 2) !== 0) blockEls.push(rectEl(x + hw, y, hw, hh, fill))
          if ((mask & 8) !== 0) blockEls.push(rectEl(x + hw, y + hh, hw, hh, fill))
        }
        c++
      } else if (code > SPACE && code <= 0x7e) {
        // 印字可能ASCII: 同色・同種の連続をまとめる
        const cls = textClass(code, fg)
        let e = c + 1
        let s = escapeChar(code)
        while (e < cols) {
          const nc = grid.ch[base + e] ?? SPACE
          if (nc <= SPACE || nc > 0x7e) break
          const nf = grid.fg[base + e] ?? 0
          if (nf !== fg || textClass(nc, nf) !== cls) break
          s += escapeChar(nc)
          e++
        }
        const run = e - c
        const el =
          '<text x="' +
          x +
          '" y="' +
          (y + 12) +
          '" font-family="monospace" font-size="14" fill="#' +
          hex(fg, 'cccccc') +
          '"' +
          (run > 1 ? ' textLength="' + run * CELL_W + '" lengthAdjust="spacing"' : '') +
          '>' +
          s +
          '</text>'
        const bucket = textEls[cls]
        if (bucket !== undefined) bucket.push(el)
        c = e
      } else {
        c++ // 描かない文字
      }
    }
  }

  // 上限(Svgのsourceは131072文字)に収める。背景、ブロック、重要な文字、細部、星の順に入れ、入りきらない後ろ側は捨てる
  const out: string[] = [head]
  let used = head.length + tail.length
  const add = (els: string[], partial: boolean): void => {
    let sum = 0
    for (const s of els) sum += s.length
    if (used + sum <= SVG_LIMIT) {
      for (const s of els) out.push(s)
      used += sum
      return
    }
    if (!partial) return
    for (const s of els) {
      if (used + s.length > SVG_LIMIT) break
      out.push(s)
      used += s.length
    }
  }
  add(bgEls, true)
  add(blockEls, true)
  add(textEls[0] ?? [], false)
  add(textEls[1] ?? [], false)
  add(textEls[2] ?? [], false)
  out.push(tail)
  return out.join('')
}
