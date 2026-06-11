/**
 * 微信联机对战模块
 * 使用微信云开发实现房间管理和状态同步 (Host-Authority)
 */

export class WxNetwork {
  constructor() {
    this.openId = ''
    this.nickName = ''
    this.avatarUrl = ''
    this.roomId = ''
    this.isHost = false
    this.watcher = null
    this.lastState = null
    this.messageHandlers = []
    this.pingTimer = null
  }

  getOpenId() { return this.openId }
  getIsHost() { return this.isHost }
  getRoomId() { return this.roomId }

  onMessage(handler) { this.messageHandlers.push(handler) }

  emit(type, data) {
    for (const h of this.messageHandlers) h(type, data)
  }

  // ===== 微信登录 =====
  login() {
    return new Promise((resolve, reject) => {
      wx.login({
        success: (res) => {
          if (!res.code) { reject(new Error('wx.login failed')); return }
          wx.cloud.callFunction({
            name: 'create-room',
            data: { action: 'get-openid', code: res.code },
            success: (cfRes) => {
              this.openId = (cfRes.result && cfRes.result.openId) || ''
              this.nickName = '玩家' + this.openId.slice(-4)
              resolve({ openId: this.openId, nickName: this.nickName })
            },
            fail: (err) => reject(err)
          })
        },
        fail: (err) => reject(err)
      })
    })
  }

  setNickName(name, avatar) {
    this.nickName = name
    if (avatar) this.avatarUrl = avatar
  }

  // ===== 创建房间 =====
  createRoom() {
    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: 'create-room',
        data: {
          action: 'create',
          hostId: this.openId,
          hostName: this.nickName,
          hostAvatar: this.avatarUrl,
        },
        success: (res) => {
          this.roomId = (res.result && res.result.roomId) || ''
          this.isHost = true
          this.watchRoom()
          this.startPing()
          resolve(this.roomId)
        },
        fail: (err) => reject(err)
      })
    })
  }

  // ===== 加入房间 =====
  joinRoom(roomId) {
    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: 'join-room',
        data: {
          action: 'join', roomId,
          openId: this.openId,
          name: this.nickName, avatar: this.avatarUrl,
        },
        success: (res) => {
          this.roomId = roomId
          this.isHost = false
          this.watchRoom()
          this.startPing()
          resolve((res.result && res.result.players) || [])
        },
        fail: (err) => reject(err)
      })
    })
  }

  // ===== 实时监听 =====
  watchRoom() {
    if (!this.roomId) return
    const db = wx.cloud.database()
    this.watcher = db.collection('rooms').doc(this.roomId).watch({
      onChange: (snapshot) => {
        if (snapshot.type === 'init' || !(snapshot.docChanges && snapshot.docChanges.length)) return
        for (const change of snapshot.docChanges) {
          if (change.dataType === 'update' || change.dataType === 'replace') {
            this.handleRoomUpdate(change.doc)
          }
        }
      },
      onError: (err) => {
        console.error('[WxNetwork] watch error:', err)
        this.emit('error', { message: '连接中断' })
      }
    })
  }

  handleRoomUpdate(room) {
    if (!room) return
    this.emit('room-info', {
      roomId: room.roomId,
      players: room.players,
      status: room.status,
    })
    if (room.gameState && room.gameState !== this.lastState) {
      this.lastState = room.gameState
      this.emit('game-state', { game: room.gameState, updatedAt: room.updatedAt })
    }
    // Host 监听 pendingActions（Guest 发来的操作）
    if (this.isHost && room.pendingActions && room.pendingActions.length > 0) {
      for (const action of room.pendingActions) {
        this.emit('player-action', action)
      }
      // 清除已处理的 actions
      const db = wx.cloud.database()
      db.collection('rooms').doc(this.roomId).update({ data: { pendingActions: [] } })
    }
  }

  // ===== Host 广播游戏状态 =====
  broadcastGameState(gameState) {
    if (!this.isHost || !this.roomId) return Promise.resolve()
    const db = wx.cloud.database()
    return new Promise((resolve, reject) => {
      db.collection('rooms').doc(this.roomId).update({
        data: { gameState, status: 'playing', updatedAt: Date.now() },
        success: () => resolve(),
        fail: (err) => reject(err)
      })
    })
  }

  // ===== Guest 发送操作 =====
  sendAction(actionType, payload) {
    return new Promise((resolve, reject) => {
      wx.cloud.callFunction({
        name: 'game-action',
        data: {
          roomId: this.roomId, openId: this.openId,
          playerName: this.nickName, actionType, payload,
        },
        success: () => resolve(),
        fail: (err) => reject(err)
      })
    })
  }

  startPing() {
    this.pingTimer = setInterval(() => {
      if (!this.roomId) return
      wx.cloud.callFunction({
        name: 'game-action',
        data: { roomId: this.roomId, openId: this.openId, actionType: 'ping', payload: {} },
        fail: () => {}
      })
    }, 15000)
  }

  leaveRoom() {
    if (this.watcher) { this.watcher.close(); this.watcher = null }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null }
    if (!this.roomId) return Promise.resolve()
    return new Promise((resolve) => {
      wx.cloud.callFunction({
        name: 'game-action',
        data: { roomId: this.roomId, openId: this.openId, actionType: 'leave', payload: {} },
        success: () => { this.roomId = ''; this.isHost = false; resolve() },
        fail: () => { this.roomId = ''; this.isHost = false; resolve() }
      })
    })
  }

  destroy() {
    this.leaveRoom()
    this.messageHandlers = []
  }
}
