const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { action, roomId } = event

  if (action === 'join') {
    const roomRes = await db.collection('rooms').doc(roomId).get()
    const room = roomRes.data
    if (!room) return { error: '房间不存在' }
    if (room.status !== 'waiting') return { error: '游戏已开始' }
    if (room.players.length >= 4) return { error: '房间已满' }

    const exists = room.players.find(p => p.openId === OPENID)
    if (!exists) {
      const newPlayer = {
        openId: OPENID,
        name: event.name || '玩家',
        avatar: event.avatar || '',
        isHost: false, ready: false,
      }
      await db.collection('rooms').doc(roomId).update({
        data: { players: _.push(newPlayer), updatedAt: Date.now() }
      })
      room.players.push(newPlayer)
    }
    return { players: room.players, success: true }
  }

  if (action === 'ready') {
    const roomRes = await db.collection('rooms').doc(roomId).get()
    const players = roomRes.data.players.map(p => {
      if (p.openId === OPENID) return { ...p, ready: event.ready }
      return p
    })
    await db.collection('rooms').doc(roomId).update({
      data: { players, updatedAt: Date.now() }
    })
    return { success: true }
  }

  return { error: 'unknown action' }
}
