// コントローラー行: 帯の最下段に置く Client のサーフェスモジュール。
// クリックでフォーカスを受け取り、WASD / < > (矢印・, . も可)をフックモジュールへ post する。
// このモジュールは描画スレッドで動く($ は無い)。

import type { ClientKeyEvent, ClientModule } from 'claude-code'

type Command = 'left' | 'right' | 'jump' | 'down' | 'attack' | 'special'

type PadProps = { color: string }

type PadState = {
  counts: Record<Command, number>
  /** 最後のキーから経った 500ms の数 */
  idle: number
}

/** エンジンが手動操作をやめてCPUに戻すまでの時間(10秒)と揃える */
const IDLE_STEPS = 20

const KEYS: Readonly<Record<string, Command>> = {
  a: 'left',
  left: 'left',
  d: 'right',
  right: 'right',
  w: 'jump',
  up: 'jump',
  ' ': 'jump',
  space: 'jump',
  s: 'down',
  down: 'down',
  '<': 'attack',
  ',': 'attack',
  '>': 'special',
  '.': 'special',
}

function commandOf(event: ClientKeyEvent): Command | undefined {
  if (event.ctrl || event.meta) return undefined
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key

  return KEYS[key]
}

const Pad: ClientModule<PadProps, PadState> = (props, surface) => {
  const { Box, Text } = surface.elements
  let state = surface.state
  if (state === undefined) {
    // 初回だけキー受付とタイマーを仕掛ける。s を正として持ち、描き直しのたびに写しを渡す
    const s: PadState = {
      counts: { left: 0, right: 0, jump: 0, down: 0, attack: 0, special: 0 },
      idle: IDLE_STEPS,
    }
    surface.onKey(event => {
      const cmd = commandOf(event)
      if (cmd === undefined) return
      s.counts[cmd] += 1
      const wasIdle = s.idle >= IDLE_STEPS
      s.idle = 0
      // 同じフレームの post は後のもので置き換わるので、累計回数を送って取りこぼしを防ぐ
      surface.post({ counts: { ...s.counts }, last: cmd })
      if (wasIdle) surface.setState({ ...s, counts: { ...s.counts } })
    })
    surface.every(500, () => {
      if (s.idle >= IDLE_STEPS) return
      s.idle += 1
      if (s.idle === IDLE_STEPS) surface.setState({ ...s, counts: { ...s.counts } })
    })
    state = { ...s, counts: { ...s.counts } }
    surface.setState(state)
  }

  const help = 'A/D 移動  W ジャンプ  S 急降下  < 攻撃  > 必殺'
  if (state.idle < IDLE_STEPS) {
    return (
      <Box>
        <Text inverse color={props.color} bold>
          {' YOU '}
        </Text>
        <Text wrap="truncate"> {help}  (Esc で終了、10秒さわらないとCPUに戻る)</Text>
      </Box>
    )
  }

  return (
    <Box>
      <Text color={props.color} bold>
        [P1を操作]
      </Text>
      <Text dimColor wrap="truncate">
        {' '}
        ここをクリックしてから {help}
      </Text>
    </Box>
  )
}

export default Pad
