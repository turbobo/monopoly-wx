/**
 * 大富翁中国行 - 微信小游戏入口
 */
import MainGame from './js/main.js'

// 启动游戏
const game = new MainGame()

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
