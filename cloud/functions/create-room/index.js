const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()

function generateRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase()
}

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { action } = event

  if (action === 'get-openid') {
    return { openId: OPENID }
  }

  if (action === 'create') {
    const roomId = generateRoomId()
    const room = {
      _id: roomId, roomId,
      hostId: OPENID,
      players: [{
        openId: OPENID,
        name: event.hostName || '房主',
        avatar: event.hostAvatar || '',
        isHost: true, ready: false,
      }],
      status: 'waiting',
      gameState: null,
      pendingActions: [],
      updatedAt: Date.now(),
      createdAt: Date.now(),
    }
    await db.collection('rooms').add({ data: room })
    return { roomId, success: true }
  }

  return { error: 'unknown action' }
}
