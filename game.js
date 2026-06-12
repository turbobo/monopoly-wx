/**
 * 大富翁中国行 - 微信小游戏入口
 */
import MainGame from './js/main.js'

// 启动游戏
const game = new MainGame()

// 开启右上角分享按钮
try {
  wx.showShareMenu({ withShareTicket: true, menus: ['shareAppMessage'] })
} catch (e) {}

// 默认分享回调（未进入房间时分享游戏本身）
wx.onShareAppMessage(() => {
  return {
    title: '大富翁中国行 - 来和我对战！',
    query: ''
  }
})

// 检查是否从分享卡片进入（好友邀请）
try {
  const launchOpts = wx.getLaunchOptionsSync()
  const query = launchOpts.query || {}
  if (query.roomId) {
    console.log('从分享卡片进入，房间号:', query.roomId)
    game.autoJoinFromShare(query.roomId)
  }
} catch (e) {
  console.warn('获取启动参数失败:', e.message)
}
