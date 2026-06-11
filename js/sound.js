/**
 * 大富翁中国行 - 音效引擎 (微信小游戏版)
 * 微信小游戏不支持 Web Audio API，使用 wx.createInnerAudioContext() 播放音频文件
 * 当前为静音桩函数，后续可添加音频文件到 images/ 目录
 */

let muted = false

export function setMuted(m) { muted = m }
export function isMuted() { return muted }

// 尝试播放音频文件（文件不存在时静默失败）
function tryPlay(name) {
  if (muted) return
  try {
    const audio = wx.createInnerAudioContext()
    audio.src = 'audio/' + name + '.mp3'
    audio.play()
    audio.onEnded(() => audio.destroy())
    audio.onError(() => audio.destroy())
  } catch (e) {
    // 静默失败
  }
}

export function playDiceRoll()    { tryPlay('dice_roll') }
export function playDiceLand()    { tryPlay('dice_land') }
export function playStepSound()   { tryPlay('step') }
export function playBuySound()    { tryPlay('buy') }
export function playPaySound()    { tryPlay('pay') }
export function playBankruptSound() { tryPlay('bankrupt') }
export function playPlayerJoinSound() { tryPlay('join') }
export function playPlayerLeaveSound() { tryPlay('leave') }
