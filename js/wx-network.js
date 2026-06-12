/**
 * 微信联机对战模块
 * 使用微信云数据库实现房间管理和状态同步（Host-Authority）
 * 无需云函数，全部在客户端完成
 */

const DB_ENV = 'cloud1-d8gpvxsagbb9f7c73'
const COLLECTION = 'rooms'
// 轮询间隔（毫秒），用于 Guest 监听游戏状态
const POLL_INTERVAL = 1500

export class WxNetwork {
  constructor() {
    this.clientId = ''
    this.nickName = ''
    this.roomId = ''
    this.isHost = false
    this.lastState = null
    this.messageHandlers = []
    this.pollTimer = null
    this.db = null
    this.players = []
    this.hostId = ''
    this.lastMsgTimestamp = 0
  }

  getOpenId() { return this.clientId }
  getIsHost() { return this.isHost }
  getRoomId() { return this.roomId }
  onMessage(handler) { this.messageHandlers.push(handler) }

  emit(type, data) {
    for (const h of this.messageHandlers) h(type, data)
  }

  // ===== 初始化云数据库 =====
  initDB() {
    if (this.db) return
    wx.cloud.init({ env: DB_ENV, traceUser: true })
    this.db = wx.cloud.database({ env: DB_ENV })
  }

  // ===== 登录（使用 wx.login code 作为身份标识，无需云函数）=====
  login() {
    return new Promise((resolve, reject) => {
      this.initDB()
      wx.login({
        success: (res) => {
          if (!res.code) {
            // fallback: 用随机 ID
            this.clientId = 'wx-' + Math.random().toString(36).slice(2, 8)
          } else {
            this.clientId = res.code.slice(0, 16)
          }
          this.nickName = '玩家' + this.clientId.slice(-4)
          resolve({ openId: this.clientId, nickName: this.nickName })
        },
        fail: () => {
          // fallback: 用随机 ID
          this.clientId = 'wx-' + Math.random().toString(36).slice(2, 8)
          this.nickName = '玩家' + this.clientId.slice(-4)
          resolve({ openId: this.clientId, nickName: this.nickName })
        }
      })
    })
  }

  setNickName(name, avatar) { this.nickName = name }

  // ===== 创建房间 =====
  createRoom() {
    return new Promise((resolve, reject) => {
      this.roomId = Math.random().toString(36).slice(2, 8).toUpperCase()
      this.isHost = true
      this.hostId = this.clientId
      this.players = [{
        id: this.clientId, name: this.nickName,
        openId: this.clientId, isHost: true, ready: true
      }]

      // 写入云数据库
      this.db.collection(COLLECTION).add({
        data: {
          roomId: this.roomId,
          hostId: this.clientId,
          players: this.players,
          status: 'waiting',
          messages: [],
          gameState: null,
          updatedAt: this.db.serverDate()
        },
        success: () => {
          // Host 开始轮询，处理玩家加入等消息
          this.startHostPoll()
          resolve(this.roomId)
        },
        fail: (err) => reject(new Error('创建房间失败: ' + err.errMsg))
      })
    })
  }

  // ===== 加入房间（直接操作云数据库，无需云函数）=====
  joinRoom(roomId) {
    return new Promise((resolve, reject) => {
      this.roomId = roomId
      this.isHost = false

      // 查找房间文档
      this.db.collection(COLLECTION).where({ roomId }).get({
        success: (res) => {
          if (!res.data || res.data.length === 0) {
            reject(new Error('房间不存在')); return
          }
          const room = res.data[0]
          if (room.status === 'playing') {
            reject(new Error('游戏已开始')); return
          }

          this._docId = room._id
          this.hostId = room.hostId
          this.players = room.players || []

          // 检查是否已在房间中
          if (this.players.find(p => p.id === this.clientId)) {
            this.lastMsgTimestamp = Date.now()
            this.startGuestPoll()
            resolve(this.players)
            return
          }

          // 加入玩家列表
          this.players.push({
            id: this.clientId, name: this.nickName,
            openId: this.clientId, isHost: false, ready: true
          })

          // 更新房间文档
          this.db.collection(COLLECTION).doc(this._docId).update({
            data: {
              players: this.players,
              messages: this.db.command.push({
                type: 'player-join',
                from: this.clientId,
                fromName: this.nickName,
                payload: {},
                timestamp: Date.now()
              }),
              updatedAt: this.db.serverDate()
            },
            success: () => {
              this.lastMsgTimestamp = Date.now()
              this.startGuestPoll()
              resolve(this.players)
            },
            fail: (err) => reject(new Error('加入失败: ' + err.errMsg))
          })
        },
        fail: (err) => reject(new Error('查找房间失败: ' + err.errMsg))
      })
    })
  }

  // ===== 向房间消息队列追加消息（直接写数据库）=====
  pushMessage(type, payload) {
    if (!this._docId || !this.db) return
    const msg = {
      type, from: this.clientId, fromName: this.nickName,
      payload, timestamp: Date.now()
    }
    this.db.collection(COLLECTION).doc(this._docId).update({
      data: {
        messages: this.db.command.push(msg),
        updatedAt: this.db.serverDate()
      },
      fail: (err) => console.error('[WxNetwork] pushMessage fail:', err)
    })
  }

  // ===== Host 轮询：处理消息队列 =====
  startHostPoll() {
    this.stopPoll()
    this.pollTimer = setInterval(() => this.hostPollTick(), POLL_INTERVAL)
  }

  hostPollTick() {
    if (!this.roomId || !this.db) return
    this.db.collection(COLLECTION)
      .where({ roomId: this.roomId })
      .get({
        success: (res) => {
          if (!res.data || res.data.length === 0) return
          const room = res.data[0]
          this._docId = room._id
          const messages = room.messages || []

          // 处理新消息
          for (const msg of messages) {
            if (msg.timestamp <= this.lastMsgTimestamp) continue
            if (msg.from === this.clientId) continue
            this.lastMsgTimestamp = Math.max(this.lastMsgTimestamp, msg.timestamp)
            this.handleMessage(msg)
          }
        }
      })
  }

  // ===== Guest 轮询：监听游戏状态和房间信息 =====
  startGuestPoll() {
    this.stopPoll()
    this.pollTimer = setInterval(() => this.guestPollTick(), POLL_INTERVAL)
  }

  guestPollTick() {
    if (!this.roomId || !this.db) return
    this.db.collection(COLLECTION)
      .where({ roomId: this.roomId })
      .get({
        success: (res) => {
          if (!res.data || res.data.length === 0) return
          const room = res.data[0]
          const messages = room.messages || []

          // 处理新消息（join-response / room-info / game-state）
          for (const msg of messages) {
            if (msg.timestamp <= this.lastMsgTimestamp) continue
            if (msg.from === this.clientId) continue
            this.lastMsgTimestamp = Math.max(this.lastMsgTimestamp, msg.timestamp)
            this.handleMessage(msg)
          }

          // 直接读游戏状态（避免消息丢失）
          if (room.gameState && room.gameState !== this.lastState) {
            this.lastState = room.gameState
            this.emit('game-state', { game: room.gameState })
          }
        }
      })
  }

  stopPoll() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  // ===== 处理收到的消息 =====
  handleMessage(msg) {
    const { type, from, fromName, payload } = msg

    switch (type) {
      case 'player-join':
        if (this.isHost) this.handlePlayerJoin(from, fromName)
        break
      case 'join-response':
        if (!this.isHost && this._onJoinResponse) {
          this._onJoinResponse(payload.players)
          this._onJoinResponse = null
        }
        break
      case 'room-info':
        if (!this.isHost) {
          this.players = payload.players || []
          this.emit('room-info', payload)
        }
        break
      case 'game-state':
        if (!this.isHost) this.handleGameState(payload)
        break
      case 'player-action':
        if (this.isHost) this.emit('player-action', payload)
        break
      case 'player-leave':
        this.handlePlayerLeave(from)
        break
    }
  }

  // ===== Host：处理玩家加入 =====
  handlePlayerJoin(playerId, playerName) {
    if (this.players.find(p => p.id === playerId)) return
    this.players.push({
      id: playerId, name: playerName,
      openId: playerId, isHost: false, ready: true
    })
    // 回复加入响应
    this.hostPushMessage('join-response', { players: this.players })
    this.broadcastRoomInfo()
  }

  // ===== Host 直接写消息 =====
  hostPushMessage(type, payload) {
    if (!this._docId || !this.db) return
    const msg = {
      type, from: this.clientId, fromName: this.nickName,
      payload, timestamp: Date.now()
    }
    this.db.collection(COLLECTION).doc(this._docId).update({
      data: {
        players: this.players,
        messages: this.db.command.push(msg),
        updatedAt: this.db.serverDate()
      }
    })
  }

  handlePlayerLeave(playerId) {
    this.players = this.players.filter(p => p.id !== playerId)
    this.emit('player-leave', { playerId })
    if (this.isHost) this.broadcastRoomInfo()
  }

  broadcastRoomInfo() {
    this.hostPushMessage('room-info', {
      roomId: this.roomId, players: this.players, status: 'waiting'
    })
  }

  // ===== Host 广播游戏状态（直接写 gameState 字段，Guest 轮询读取）=====
  broadcastGameState(gameState) {
    if (!this.isHost || !this._docId || !this.db) return Promise.resolve()
    return new Promise((resolve) => {
      this.db.collection(COLLECTION).doc(this._docId).update({
        data: { gameState, updatedAt: this.db.serverDate() },
        success: () => resolve(),
        fail: () => resolve()
      })
    })
  }

  handleGameState(payload) {
    if (payload.game) {
      this.lastState = payload.game
      this.emit('game-state', payload)
    }
  }

  // ===== Guest 发送操作 =====
  sendAction(actionType, payload) {
    this.pushMessage('player-action', { actionType, payload, playerId: this.clientId })
    return Promise.resolve()
  }

  // ===== 离开房间 =====
  leaveRoom() {
    this.stopPoll()
    if (this.roomId) {
      this.pushMessage('player-leave', {})
      // Host 离开时删除房间文档
      if (this.isHost && this._docId && this.db) {
        this.db.collection(COLLECTION).doc(this._docId).remove()
      }
    }
    this.roomId = ''
    this.isHost = false
    this.players = []
    this._docId = null
    return Promise.resolve()
  }

  destroy() {
    this.leaveRoom()
    this.messageHandlers = []
  }
}

