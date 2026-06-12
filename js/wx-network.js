/**
 * 微信联机对战模块
 * 使用 GoEasy PubSub 实现房间管理和状态同步 (Host-Authority)
 */
// @ts-ignore
import GoEasy from './libs/goeasy.min.js'

// GoEasy AppKey - 需要替换为你自己的 AppKey
// 注册地址: https://www.goeasy.io
const GOEASY_APPKEY = 'your-appkey-here'

export class WxNetwork {
  constructor() {
    this.clientId = ''
    this.nickName = ''
    this.avatarUrl = ''
    this.roomId = ''
    this.isHost = false
    this.lastState = null
    this.messageHandlers = []
    this.pingTimer = null
    this.goeasy = null
    this.connected = false
    this.players = []
    this.hostId = ''
  }

  getOpenId() { return this.clientId }
  getIsHost() { return this.isHost }
  getRoomId() { return this.roomId }

  onMessage(handler) { this.messageHandlers.push(handler) }

  emit(type, data) {
    for (const h of this.messageHandlers) h(type, data)
  }

  // ===== 初始化 GoEasy =====
  initGoEasy() {
    if (this.goeasy) return
    // @ts-ignore
    GoEasy.init({
      host: 'hangzhou.goeasy.io',
      appkey: GOEASY_APPKEY,
      modules: ['pubsub']
    })
    this.goeasy = GoEasy
  }

  // ===== 登录 =====
  login() {
    return new Promise((resolve, reject) => {
      if (GOEASY_APPKEY === 'your-appkey-here') {
        reject(new Error('请先配置 GoEasy AppKey'))
        return
      }

      this.initGoEasy()

      // 生成随机 ID（代替 openId）
      this.clientId = 'wx-' + Math.random().toString(36).slice(2, 8)
      this.nickName = '玩家' + this.clientId.slice(-4)

      // 连接 GoEasy
      this.goeasy.connect({
        id: this.clientId,
        data: { name: this.nickName },
        onSuccess: () => {
          this.connected = true
          console.log('[WxNetwork] GoEasy connected')
          resolve({ openId: this.clientId, nickName: this.nickName })
        },
        onFailed: (err) => {
          console.error('[WxNetwork] GoEasy connect failed:', err)
          reject(new Error('连接失败: ' + (err.message || err)))
        }
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
      this.roomId = Math.random().toString(36).slice(2, 8).toUpperCase()
      this.isHost = true
      this.hostId = this.clientId
      this.players = [{
        id: this.clientId,
        name: this.nickName,
        openId: this.clientId,
        isHost: true,
        ready: true
      }]

      // 订阅房间频道
      this.subscribeRoom()

      // 广播房间创建
      this.publish('room-created', {
        roomId: this.roomId,
        hostId: this.clientId,
        hostName: this.nickName
      })

      resolve(this.roomId)
    })
  }

  // ===== 加入房间 =====
  joinRoom(roomId) {
    return new Promise((resolve, reject) => {
      this.roomId = roomId
      this.isHost = false

      // 订阅房间频道
      this.subscribeRoom()

      // 发送加入请求
      this.publish('player-join', {
        roomId: this.roomId,
        playerId: this.clientId,
        playerName: this.nickName
      })

      // 等待 Host 响应
      this.joinTimeout = setTimeout(() => {
        reject(new Error('加入超时，房间可能不存在或已满'))
      }, 10000)

      // 监听加入响应
      this._onJoinResponse = (data) => {
        if (data.playerId === this.clientId) {
          clearTimeout(this.joinTimeout)
          this.hostId = data.hostId
          this.players = data.players || []
          resolve(this.players)
        }
      }
    })
  }

  // ===== 订阅房间频道 =====
  subscribeRoom() {
    if (!this.roomId) return
    const channel = 'monopoly-' + this.roomId

    this.goeasy.pubsub.subscribe({
      channel: channel,
      onMessage: (msg) => {
        try {
          const data = JSON.parse(msg.content)
          this.handleMessage(data)
        } catch (e) {
          console.error('[WxNetwork] Parse error:', e)
        }
      },
      onSuccess: () => {
        console.log('[WxNetwork] Subscribed to', channel)
      },
      onFailed: (err) => {
        console.error('[WxNetwork] Subscribe failed:', err)
      }
    })
  }

  // ===== 发布消息 =====
  publish(type, payload) {
    if (!this.roomId || !this.goeasy) return
    const channel = 'monopoly-' + this.roomId
    const content = JSON.stringify({
      type,
      from: this.clientId,
      fromName: this.nickName,
      payload,
      timestamp: Date.now()
    })

    this.goeasy.pubsub.publish({
      channel: channel,
      content: content,
      onSuccess: () => {},
      onFailed: (err) => {
        console.error('[WxNetwork] Publish failed:', err)
      }
    })
  }

  // ===== 处理收到的消息 =====
  handleMessage(data) {
    if (data.from === this.clientId) return // 忽略自己的消息

    const { type, from, fromName, payload } = data

    switch (type) {
      case 'player-join':
        if (this.isHost) this.handlePlayerJoin(from, fromName)
        break

      case 'join-response':
        if (!this.isHost && this._onJoinResponse) {
          this._onJoinResponse(payload)
        }
        break

      case 'room-info':
        if (!this.isHost) {
          this.players = payload.players || []
          this.emit('room-info', payload)
        }
        break

      case 'game-state':
        if (!this.isHost) {
          this.handleGameState(payload)
        }
        break

      case 'player-action':
        if (this.isHost) {
          this.emit('player-action', payload)
        }
        break

      case 'player-leave':
        this.handlePlayerLeave(from)
        break

      case 'ping':
        // 心跳响应
        break
    }
  }

  // ===== Host 处理玩家加入 =====
  handlePlayerJoin(playerId, playerName) {
    // 检查是否已存在
    if (this.players.find(p => p.id === playerId)) return

    // 添加玩家
    this.players.push({
      id: playerId,
      name: playerName,
      openId: playerId,
      isHost: false,
      ready: true
    })

    // 发送加入响应
    this.publish('join-response', {
      playerId: playerId,
      hostId: this.clientId,
      players: this.players
    })

    // 广播房间信息
    this.broadcastRoomInfo()
  }

  // ===== 处理玩家离开 =====
  handlePlayerLeave(playerId) {
    this.players = this.players.filter(p => p.id !== playerId)
    this.broadcastRoomInfo()
    this.emit('player-leave', { playerId })
  }

  // ===== Host 广播房间信息 =====
  broadcastRoomInfo() {
    this.publish('room-info', {
      roomId: this.roomId,
      players: this.players,
      status: 'waiting'
    })
  }

  // ===== Host 广播游戏状态 =====
  broadcastGameState(gameState) {
    if (!this.isHost || !this.roomId) return Promise.resolve()
    this.publish('game-state', {
      game: gameState,
      updatedAt: Date.now()
    })
    return Promise.resolve()
  }

  // ===== 处理游戏状态更新 =====
  handleGameState(payload) {
    if (payload.game && payload.game !== this.lastState) {
      this.lastState = payload.game
      this.emit('game-state', payload)
    }
  }

  // ===== Guest 发送操作 =====
  sendAction(actionType, payload) {
    this.publish('player-action', {
      actionType,
      payload,
      playerId: this.clientId,
      playerName: this.nickName
    })
    return Promise.resolve()
  }

  // ===== 心跳 =====
  startPing() {
    this.pingTimer = setInterval(() => {
      if (!this.roomId) return
      this.publish('ping', {})
    }, 15000)
  }

  // ===== 离开房间 =====
  leaveRoom() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (this.roomId) {
      this.publish('player-leave', {})
      // 取消订阅
      try {
        this.goeasy.pubsub.unsubscribe({
          channel: 'monopoly-' + this.roomId
        })
      } catch (e) {}
    }
    this.roomId = ''
    this.isHost = false
    this.players = []
    return Promise.resolve()
  }

  destroy() {
    this.leaveRoom()
    if (this.goeasy && this.connected) {
      try {
        this.goeasy.disconnect()
      } catch (e) {}
    }
    this.messageHandlers = []
  }
}
