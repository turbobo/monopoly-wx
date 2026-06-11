const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext()
  const { roomId, actionType, payload } = event
  if (!roomId) return { error: '缺少 roomId' }

  if (actionType === 'leave') {
    try {
      const roomRes = await db.collection('rooms').doc(roomId).get()
      const room = roomRes.data
      const newPlayers = room.players.filter(p => p.openId !== OPENID)
      if (newPlayers.length === 0) {
        await db.collection('rooms').doc(roomId).remove()
      } else {
        let hostId = room.hostId
        if (room.hostId === OPENID && newPlayers.length > 0) {
          newPlayers[0].isHost = true
          hostId = newPlayers[0].openId
        }
        await db.collection('rooms').doc(roomId).update({
          data: { players: newPlayers, hostId, updatedAt: Date.now() }
        })
      }
    } catch (e) { return { error: e.message } }
    return { success: true }
  }

  if (actionType === 'ping') {
    try {
      await db.collection('rooms').doc(roomId).update({
        data: { ['lastPing.' + OPENID]: Date.now() }
      })
    } catch (e) {}
    return { success: true }
  }

  if (['roll', 'buy', 'skip', 'card-action'].includes(actionType)) {
    try {
      await db.collection('rooms').doc(roomId).update({
        data: {
          pendingActions: _.push({
            type: actionType,
            openId: OPENID,
            playerName: event.playerName,
            payload: payload || {},
            timestamp: Date.now(),
          }),
          updatedAt: Date.now(),
        }
      })
    } catch (e) { return { error: e.message } }
    return { success: true }
  }

  return { error: 'unknown action: ' + actionType }
}
