/**
 * 大富翁中国行 - 微信小游戏入口
 */
import MainGame from './js/main.js'

// 初始化微信云开发（未开通时静默失败，AI模式仍可正常运行）
try {
  if (typeof wx !== 'undefined' && wx.cloud) {
    wx.cloud.init({ traceUser: true })
  }
} catch (e) {
  console.warn('云开发未开通，在线模式不可用。AI模式正常。', e.message)
}

// 启动游戏
new MainGame()
