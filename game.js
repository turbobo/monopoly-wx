/**
 * 大富翁中国行 - 微信小游戏入口
 */
import MainGame from './js/main.js'

// 初始化微信云开发
if (typeof wx !== 'undefined' && wx.cloud) {
  wx.cloud.init({ traceUser: true })
}

// 启动游戏
new MainGame()
