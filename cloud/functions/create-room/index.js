const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const { action, roomId, playerName } = event

  // 获取 openId
  if (action === 'get-openid') {
    return { openId }
  }

  // 创建房间
  if (action === 'create') {
    const newRoomId = Math.random().toString(36).slice(2, 8).toUpperCase()
    const player = { id: openId, name: playerName || ('玩家' + openId.slice(-4)), openId, isHost: true, ready: true }
    await db.collection('rooms').add({
      data: {
        roomId: newRoomId,
        hostId: openId,
        players: [player],
        status: 'waiting',
        messages: [],
        gameState: null,
        updatedAt: db.serverDate()
      }
    })
    return { roomId: newRoomId, openId }
  }

  return { error: 'unknown action' }
}
