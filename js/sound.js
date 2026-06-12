/**
 * 大富翁中国行 - 音效引擎 (微信小游戏版)
 * 音频文件放在 audio/ 目录下，文件不存在时完全静默不报错
 */

let muted = false
// 记录哪些文件已确认存在/不存在，避免重复检测
const fileExists = {}
const audioPool = {}

export function setMuted(m) { muted = m }
export function isMuted() { return muted }

function tryPlay(name) {
  if (muted) return
  const path = 'audio/' + name + '.mp3'

  // 已知文件不存在，直接跳过
  if (fileExists[path] === false) return

  // 已知文件存在，直接播放
  if (fileExists[path] === true) {
    playAudio(name, path)
    return
  }

  // 首次：先检测文件是否存在
  wx.getFileSystemManager().access({
    path,
    success: () => {
      fileExists[path] = true
      playAudio(name, path)
    },
    fail: () => {
      // 文件不存在，记录后跳过，不产生任何报错
      fileExists[path] = false
    }
  })
}

function playAudio(name, path) {
  try {
    let audio = audioPool[name]
    if (!audio) {
      audio = wx.createInnerAudioContext()
      audio.src = path
      audio.obeyMuteSwitch = false
      audio.onError(() => {
        delete audioPool[name]
        try { audio.destroy() } catch (e) {}
      })
      audioPool[name] = audio
    }
    audio.stop()
    audio.play()
  } catch (e) {}
}

export function playDiceRoll()         { tryPlay('dice_roll') }
export function playDiceLand()         { tryPlay('dice_land') }
export function playStepSound()        { tryPlay('step') }
export function playBuySound()         { tryPlay('buy') }
export function playPaySound()         { tryPlay('pay') }
export function playBankruptSound()    { tryPlay('bankrupt') }
export function playMove()             { tryPlay('step') }
export function playPlayerJoinSound()  { tryPlay('join') }
export function playPlayerLeaveSound() { tryPlay('leave') }
