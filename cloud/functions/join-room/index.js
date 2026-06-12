const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

exports.main = async (event, context) => {
  const wxContext = cloud.getWXContext()
  const openId = wxContext.OPENID
  const { roomId, playerName } = event

  // 查找房间
  const res = await db.collection('rooms').where({ roomId }).get()
  if (!res.data || res.data.length === 0) {
    return { error: '房间不存在' }
  }

  const room = res.data[0]
  if (room.status !== 'waiting') {
    return { error: '游戏已开始' }
  }
  if (room.players.find(p => p.id === openId)) {
    return { players: room.players, roomId }
  }

  const player = {
    id: openId,
    name: playerName || ('玩家' + openId.slice(-4)),
    openId,
    isHost: false,
    ready: true
  }
  const players = [...room.players, player]

  const joinMsg = {
    type: 'join-response',
    from: 'system',
    fromName: 'system',
    payload: { players },
    timestamp: Date.now()
  }

  await db.collection('rooms').doc(room._id).update({
    data: {
      players,
      messages: _.push(joinMsg),
      updatedAt: db.serverDate()
    }
  })

  return { players, roomId }
}
