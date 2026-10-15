export type ClawdBrosState = {
  /** 非ターミナル面(デスクトップ)の再描画用フレーム番号 */
  frame: number
  /** /clawd-bros で一時停止中か */
  isPaused: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'clawd-bros': { frame: number; isPaused: boolean }
  }
}
