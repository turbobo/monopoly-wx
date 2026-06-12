const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const { action, roomId, message, gameState } = event

  // 查找房间文档
  const res = await db.collection('rooms').where({ roomId }).get()
  if (!res.data || res.data.length === 0) {
    return { error: '房间不存在' }
  }
  const room = res.data[0]

  // 追加消息到队列
  if (action === 'push-message') {
    await db.collection('rooms').doc(room._id).update({
      data: {
        messages: _.push(message),
        updatedAt: db.serverDate()
      }
    })
    return { ok: true }
  }

  // Host 广播游戏状态
  if (action === 'broadcast-state') {
    await db.collection('rooms').doc(room._id).update({
      data: {
        gameState,
        updatedAt: db.serverDate()
      }
    })
    return { ok: true }
  }

  // 开始游戏
  if (action === 'start-game') {
    if (room.hostId !== openId) return { error: '只有房主可以开始游戏' }
    await db.collection('rooms').doc(room._id).update({
      data: { status: 'playing', updatedAt: db.serverDate() }
    })
    return { ok: true }
  }

  // 清除已读消息（防止消息队列无限增长）
  if (action === 'clear-messages') {
    await db.collection('rooms').doc(room._id).update({
      data: { messages: [], updatedAt: db.serverDate() }
    })
    return { ok: true }
  }

  return { error: 'unknown action' }
}
