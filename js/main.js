/**
 * 大富翁中国行 - 微信小游戏主控制器
 * 替代 v3 的 page.tsx React UI，全部用 Canvas 绘制
 */
import {
  BOARD, BOARD_SIZE, createGame, executeTurn, buyProperty, nextPlayer,
  rollDice, aiDecision, totalWealth,
  useRemoteDice, useSwapCard, useRoadblockCard, useFreePassCard, usePriceHikeCard,
} from './game-engine.js'
import { BoardRenderer } from './board-renderer.js'
import { WxNetwork } from './wx-network.js'
import * as Sound from './sound.js'

const SCREEN = { MENU: 0, LOBBY: 1, GAME: 2 }

export default class MainGame {
  constructor() {
    // 微信小游戏主 canvas
    this.canvas = wx.createCanvas()
    this.ctx = this.canvas.getContext('2d')
    const sys = wx.getSystemInfoSync()
    this.W = sys.screenWidth
    this.H = sys.screenHeight
    // dpr 限制为 2，避免高分屏性能问题
    this.dpr = Math.min(sys.pixelRatio || 1, 2)

    this.canvas.width = this.W * this.dpr
    this.canvas.height = this.H * this.dpr
    this.ctx.scale(this.dpr, this.dpr)

    this.renderer = new BoardRenderer(this.canvas)
    this.renderer.resize()
    // renderer.tick() 由主循环统一调用，不再单独启动动画循环

    this.network = new WxNetwork()
    this.game = null
    this.screen = SCREEN.MENU
    this.mode = 'ai'       // 'ai' | 'online'
    this.rolling = false
    this.paused = false
    this.muted = false
    this.logs = []
    this.diceResult = null
    this.buyPrompt = null   // { tile, price }
    this.tileInfo = null    // { tileIndex }
    this.showCards = false
    this.selectedCard = null
    this.roomId = ''
    this.onlinePlayers = []
    this.isMyTurn = false
    this.lastTouchY = 0

    // 绑定触摸
    wx.onTouchEnd((e) => this.onTouch(e))

    // 注册网络消息
    this.network.onMessage((type, data) => this.onNetMessage(type, data))

    // 启动主循环
    this.loop()
  }

  // ===== 主渲染循环 =====
  loop() {
    this.ctx.clearRect(0, 0, this.W, this.H)

    // 背景
    this.ctx.fillStyle = '#0f1419'
    this.ctx.fillRect(0, 0, this.W, this.H)

    if (this.screen === SCREEN.MENU) this.drawMenu()
    else if (this.screen === SCREEN.LOBBY) this.drawLobby()
    else if (this.screen === SCREEN.GAME) {
      this.renderer.tick()  // 棋盘 + 动画（统一由主循环驱动）
      this.drawGameUI()
      if (this.tileInfo !== null) this.drawTileInfo()
    }

    requestAnimationFrame(() => this.loop())
  }

  // ===== 触摸处理 =====
  onTouch(e) {
    if (!e.changedTouches || !e.changedTouches.length) return
    const t = e.changedTouches[0]
    const x = t.clientX, y = t.clientY

    if (this.screen === SCREEN.MENU) this.handleMenuTouch(x, y)
    else if (this.screen === SCREEN.LOBBY) this.handleLobbyTouch(x, y)
    else if (this.screen === SCREEN.GAME) this.handleGameTouch(x, y)
  }

  // ===== 菜单界面 =====
  drawMenu() {
    const ctx = this.ctx, cx = this.W / 2
    const btnW = this.W * 0.7  // 按钮宽度 70% 屏幕
    const btnH = 56            // 按钮高度
    const btnX = cx - btnW / 2

    // 标题（更大更醒目）
    ctx.textAlign = 'center'
    ctx.fillStyle = '#f59e0b'
    ctx.font = 'bold 48px sans-serif'
    ctx.fillText('大富翁', cx, this.H * 0.18)

    ctx.font = '20px sans-serif'
    ctx.fillStyle = '#fbbf24'
    ctx.fillText('中国行 · 微信版', cx, this.H * 0.24)

    // AI 模式按钮
    this.drawButton(btnX, this.H * 0.38, btnW, btnH, '🤖 AI 对战', '#f59e0b', 'menu-ai')

    // 在线模式按钮
    this.drawButton(btnX, this.H * 0.50, btnW, btnH, '🌐 在线对战', '#3b82f6', 'menu-online')

    // 音效按钮（居中，更宽）
    const soundW = 80
    const soundIcon = this.muted ? '🔇' : '🔊'
    this.drawButton(cx - soundW / 2, this.H * 0.65, soundW, 48, soundIcon, '#374151', 'menu-sound')

    // 版本
    ctx.font = '14px sans-serif'
    ctx.fillStyle = '#4b5563'
    ctx.fillText('v1.0 · 基于 monopoly-cn-v3', cx, this.H * 0.88)
  }

  handleMenuTouch(x, y) {
    const cx = this.W / 2
    const btnW = this.W * 0.7
    const btnX = cx - btnW / 2

    if (this.hitBtn(x, y, btnX, this.H * 0.38, btnW, 56)) {
      this.startAIMode(3)
    } else if (this.hitBtn(x, y, btnX, this.H * 0.50, btnW, 56)) {
      this.startOnlineMode()
    } else if (this.hitBtn(x, y, cx - 40, this.H * 0.65, 80, 48)) {
      this.muted = !this.muted
      Sound.setMuted(this.muted)
    }
  }

  // 棋盘底部的 CSS 像素位置（与 board-renderer.resize() 保持一致）
  getBoardBottom() {
    return this.renderer.boardCssTop + this.renderer.boardCssSize + 8
  }
  startAIMode(aiCount) {
    this.mode = 'ai'
    this.game = createGame('ai', aiCount)
    this.screen = SCREEN.GAME
    this.logs = ['🎲 游戏开始！']
    this.renderer.setCurrentPlayer(0)
    this.addLog('🎲 AI模式 - ' + (aiCount + 1) + '人')
  }

  // ===== 在线模式 =====
  async startOnlineMode() {
    this.screen = SCREEN.LOBBY
    this.mode = 'online'
    this.addLog('正在连接服务器...')

    try {
      const user = await this.network.login()
      this.addLog('已连接: ' + user.nickName)
    } catch (err) {
      this.addLog('连接失败: ' + err.message)
    }
  }

  // ===== 大厅界面 =====
  drawLobby() {
    const ctx = this.ctx, cx = this.W / 2
    const btnW = this.W * 0.75
    const btnX = cx - btnW / 2
    const H = this.H

    // 标题
    ctx.textAlign = 'center'
    ctx.fillStyle = '#f59e0b'
    ctx.font = 'bold 30px sans-serif'
    ctx.fillText('在线对战', cx, H * 0.06)

    if (!this.roomId) {
      // ===== 未加入房间：显示创建/加入按钮 =====
      const createY = H * 0.15
      this.drawButton(btnX, createY, btnW, 56, '🏠 创建房间', '#f59e0b', 'lobby-create')

      const joinY = H * 0.28
      this.drawButton(btnX, joinY, btnW, 56, '🔗 加入房间', '#3b82f6', 'lobby-join')
    } else {
      // ===== 已在房间中：显示房间信息 =====

      // 房间号卡片
      const cardY = H * 0.10
      const cardH = 70
      ctx.fillStyle = '#1a2332'
      this.roundRect(20, cardY, this.W - 40, cardH, 16)
      ctx.fill()
      ctx.strokeStyle = '#2d4a3e'
      ctx.lineWidth = 1
      ctx.stroke()

      ctx.textAlign = 'center'
      ctx.font = 'bold 28px monospace'
      ctx.fillStyle = '#10b981'
      ctx.fillText(this.roomId, cx - 30, cardY + 42)

      ctx.font = '13px sans-serif'
      ctx.fillStyle = '#6b7280'
      ctx.fillText('房间号', cx - 30, cardY + 60)

      // 复制按钮
      this.drawButton(this.W - 90, cardY + 15, 65, 40, '复制', '#374151', 'lobby-copy')

      // 玩家列表
      const listY = cardY + cardH + 20
      ctx.textAlign = 'left'
      ctx.font = 'bold 16px sans-serif'
      ctx.fillStyle = '#9ca3af'
      ctx.fillText('玩家 (' + this.onlinePlayers.length + '/4)', 32, listY)

      let py = listY + 30
      for (let i = 0; i < this.onlinePlayers.length; i++) {
        const p = this.onlinePlayers[i]
        // 玩家卡片
        ctx.fillStyle = '#1a2332'
        this.roundRect(24, py - 18, this.W - 48, 40, 10)
        ctx.fill()

        ctx.textAlign = 'left'
        ctx.font = 'bold 16px sans-serif'
        ctx.fillStyle = p.isHost ? '#f59e0b' : '#e5e7eb'
        ctx.fillText((p.isHost ? '👑 ' : '🎮 ') + p.name, 40, py + 4)

        if (p.isHost) {
          ctx.textAlign = 'right'
          ctx.font = '13px sans-serif'
          ctx.fillStyle = '#f59e0b'
          ctx.fillText('房主', this.W - 40, py + 4)
        }
        py += 50
      }

      // 等待提示
      if (this.onlinePlayers.length < 2) {
        ctx.textAlign = 'center'
        ctx.font = '14px sans-serif'
        ctx.fillStyle = '#6b7280'
        ctx.fillText('等待其他玩家加入...', cx, py + 10)
      }

      // 复制房间号按钮（分享受限时的替代方案）
      const inviteY = Math.max(py + 30, H * 0.58)
      this.drawButton(btnX, inviteY, btnW, 52, '📋 复制房间号发给好友', '#8b5cf6', 'lobby-invite')

      // 开始游戏按钮（仅房主可见，2人以上）
      if (this.network.getIsHost() && this.onlinePlayers.length >= 2) {
        this.drawButton(btnX, inviteY + 66, btnW, 56, '🎮 开始游戏', '#10b981', 'lobby-start')
      }
    }

    // 返回按钮
    this.drawButton(20, H - 60, 100, 44, '← 返回', '#374151', 'lobby-back')

    // 状态提示（仅一行，居中）
    this.drawLogArea(H - 68, this.W - 40, 30)
  }

  handleLobbyTouch(x, y) {
    const cx = this.W / 2
    const btnW = this.W * 0.75
    const btnX = cx - btnW / 2
    const H = this.H

    // 返回按钮（始终可用）
    if (this.hitBtn(x, y, 20, H - 60, 100, 44)) {
      this.network.leaveRoom()
      this.roomId = ''
      this.onlinePlayers = []
      this.screen = SCREEN.MENU
      return
    }

    if (!this.roomId) {
      // 未加入房间
      const createY = H * 0.15
      const joinY = H * 0.28
      if (this.hitBtn(x, y, btnX, createY, btnW, 56)) this.onCreateRoom()
      else if (this.hitBtn(x, y, btnX, joinY, btnW, 56)) this.onJoinRoom()
    } else {
      // 已在房间中
      const cardY = H * 0.10
      if (this.hitBtn(x, y, this.W - 90, cardY + 15, 65, 40)) this.onCopyRoomId()

      const inviteY = Math.max(
        cardY + 70 + 20 + 30 + this.onlinePlayers.length * 50 + 30,
        H * 0.58
      )
      if (this.hitBtn(x, y, btnX, inviteY, btnW, 52)) this.onInviteFriend()
      else if (this.hitBtn(x, y, btnX, inviteY + 66, btnW, 56)) this.onHostStartGame()
    }
  }

  async onCreateRoom() {
    try {
      this.roomId = await this.network.createRoom()
      this.onlinePlayers = this.network.players
      this.addLog('房间已创建: ' + this.roomId)
    } catch (err) { this.addLog('创建失败: ' + err.message) }
  }

  async onJoinRoom() {
    // 微信小游戏中用 wx.showModal 输入房间号
    const self = this
    wx.showModal({
      title: '加入房间',
      placeholderText: '请输入6位房间号',
      editable: true,
      success: async (res) => {
        if (res.confirm && res.content) {
          try {
            const players = await self.network.joinRoom(res.content.trim().toUpperCase())
            self.roomId = res.content.trim().toUpperCase()
            self.onlinePlayers = players
            self.addLog('已加入房间')
          } catch (err) { self.addLog('加入失败: ' + err.message) }
        }
      }
    })
  }

  onCopyRoomId() {
    if (!this.roomId) return
    wx.setClipboardData({
      data: this.roomId,
      success: () => this.addLog('房间号 ' + this.roomId + ' 已复制'),
      fail: () => {
        // 剪贴板权限不足时，直接显示房间号让用户手动记录
        wx.showModal({
          title: '房间号',
          content: this.roomId,
          showCancel: false,
          confirmText: '知道了'
        })
      }
    })
  }

  onInviteFriend() {
    if (!this.roomId) return
    // 分享功能受限，改为复制房间号
    wx.setClipboardData({ data: this.roomId })
    this.addLog('房间号已复制，发送给好友加入')
  }

  // 从分享卡片进入时自动加入房间
  async autoJoinFromShare(roomId) {
    this.screen = SCREEN.LOBBY
    this.mode = 'online'
    this.addLog('正在加入房间: ' + roomId)

    try {
      await this.network.login()
      await this.network.joinRoom(roomId)
      this.roomId = roomId
      this.addLog('已加入房间: ' + roomId)
    } catch (err) {
      this.addLog('加入失败: ' + err.message)
    }
  }

  async onHostStartGame() {
    this.game = createGame('online', this.onlinePlayers.length || 2, 1500, 'normal')
    // 设置玩家 openId
    for (let i = 0; i < this.game.players.length; i++) {
      if (i < this.onlinePlayers.length) {
        this.game.players[i].name = this.onlinePlayers[i].name
        this.game.players[i].openId = this.onlinePlayers[i].openId
      }
    }
    this.screen = SCREEN.GAME
    this.renderer.setCurrentPlayer(0)
    await this.network.broadcastGameState(this.game)
    this.addLog('游戏开始！')
  }

  // ===== 游戏界面 =====
  drawGameUI() {
    const ctx = this.ctx, g = this.game
    if (!g) return
    const W = this.W, H = this.H

    const boardTop = this.renderer.boardCssTop
    const boardBottom = this.getBoardBottom()
    const panelTop = boardBottom + 8
    const panelH = H - panelTop - 50  // 底部按钮预留 50px

    // ===== 当前回合头部 =====
    const cp = g.players[g.currentPlayer]
    const headerH = 44
    ctx.fillStyle = '#1a2332'
    this.roundRect(8, panelTop, W - 16, headerH, 12)
    ctx.fill()

    // 顶部色条
    ctx.fillStyle = cp.color || '#f59e0b'
    this.roundRect(8, panelTop, W - 16, 3, 3)
    ctx.fill()

    // 头像 + 名称
    ctx.textAlign = 'left'
    ctx.font = '20px sans-serif'
    ctx.fillStyle = '#fff'
    ctx.fillText(cp.avatar, 20, panelTop + 30)

    ctx.font = 'bold 15px sans-serif'
    ctx.fillStyle = '#e5e7eb'
    ctx.fillText(cp.name + ' 的回合', 46, panelTop + 25)

    ctx.font = '11px sans-serif'
    ctx.fillStyle = '#6b7280'
    ctx.fillText('第' + g.round + '回合', 46, panelTop + 38)

    // 金钱
    ctx.textAlign = 'right'
    ctx.font = 'bold 14px sans-serif'
    ctx.fillStyle = '#10b981'
    ctx.fillText('¥' + cp.money, W - 20, panelTop + 25)

    ctx.font = '11px sans-serif'
    ctx.fillStyle = '#6b7280'
    const totalWealth = cp.money + cp.properties.reduce((s, ti) => s + BOARD[ti].price, 0)
    ctx.fillText('资产 ¥' + totalWealth, W - 20, panelTop + 38)

    // ===== 玩家列表 =====
    const listTop = panelTop + headerH + 6
    const rowH = 36
    for (let i = 0; i < g.players.length; i++) {
      const p = g.players[i]
      const y = listTop + i * rowH
      const isCurrent = i === g.currentPlayer

      // 行背景
      ctx.fillStyle = isCurrent ? 'rgba(245,158,11,0.10)' : '#111827'
      this.roundRect(8, y, W - 16, rowH - 4, 8)
      ctx.fill()

      // 当前玩家指示
      if (isCurrent) {
        ctx.fillStyle = '#f59e0b'
        this.roundRect(8, y, 3, rowH - 4, 3)
        ctx.fill()
      }

      // 头像 + 名称
      ctx.textAlign = 'left'
      ctx.font = '14px sans-serif'
      ctx.fillStyle = p.bankrupt ? '#4b5563' : '#d1d5db'
      ctx.fillText(p.avatar, 18, y + 22)
      ctx.font = (isCurrent ? 'bold ' : '') + '13px sans-serif'
      ctx.fillText(p.name, 38, y + 22)

      // 地皮数
      ctx.textAlign = 'center'
      ctx.font = '11px sans-serif'
      ctx.fillStyle = '#6b7280'
      ctx.fillText(p.properties.length + '块', W / 2 + 20, y + 22)

      // 金钱
      ctx.textAlign = 'right'
      ctx.font = '13px sans-serif'
      ctx.fillStyle = p.bankrupt ? '#ef4444' : '#10b981'
      ctx.fillText('¥' + p.money, W - 20, y + 22)
    }

    // ===== 操作区域 =====
    const actionTop = listTop + g.players.length * rowH + 6
    if (!cp) return  // 防御：currentPlayer 越界时停止渲染
    const currentIsHuman = this.mode === 'ai'
      ? !cp.isAI
      : cp.openId === this.network.getOpenId()

    const cx = W / 2

    // 购买提示
    if (this.buyPrompt) {
      const tile = this.buyPrompt.tile
      if (tile) {
        ctx.textAlign = 'center'
        ctx.font = '13px sans-serif'
        ctx.fillStyle = '#d1d5db'
        ctx.fillText(tile.name + ' ¥' + tile.price, cx, actionTop + 12)
        this.drawButton(cx - 100, actionTop + 18, 90, 40, '✅ 购买', '#10b981', 'buy-yes')
        this.drawButton(cx + 10, actionTop + 18, 90, 40, '❌ 跳过', '#ef4444', 'buy-no')
      }
    } else if (currentIsHuman && !this.rolling && g.phase === 'roll') {
      // 掷骰子按钮
      this.drawButton(cx - 70, actionTop + 6, 140, 46, '🎲 掷骰子', '#f59e0b', 'game-roll')
    } else if (this.rolling) {
      ctx.textAlign = 'center'
      ctx.font = '14px sans-serif'
      ctx.fillStyle = '#6b7280'
      ctx.fillText('掷骰中...', cx, actionTop + 30)
    }

    // 骰子结果
    if (this.diceResult) {
      ctx.textAlign = 'center'
      ctx.font = 'bold 18px sans-serif'
      ctx.fillStyle = '#fff'
      const dr = this.diceResult
      ctx.fillText(dr[0] + ' + ' + dr[1] + ' = ' + (dr[0] + dr[1]), cx, actionTop + 66)
    }

    // 道具卡按钮
    const myPlayer = g.players.find(p => p.openId === this.network.getOpenId() || (this.mode === 'ai' && p.id === 0))
    if (myPlayer && myPlayer.cards && myPlayer.cards.length > 0) {
      this.drawButton(W - 80, panelTop, 68, 30, '🃏 ' + myPlayer.cards.length, '#8b5cf6', 'game-cards')
    }

    // 道具卡面板
    if (this.showCards && myPlayer) this.drawCardPanel(myPlayer)

    // 状态提示
    this.drawLogArea(H - 58, W - 40, 20)

    // 底部控制按钮
    this.drawButton(12, H - 44, 56, 32, this.paused ? '▶' : '⏸', '#374151', 'game-pause')
    this.drawButton(76, H - 44, 56, 32, this.muted ? '🔇' : '🔊', '#374151', 'game-mute')
    this.drawButton(W - 68, H - 44, 56, 32, '退出', '#991b1b', 'game-exit')
  }

  handleGameTouch(x, y) {
    const g = this.game
    if (!g) return
    const W = this.W, H = this.H
    const boardBottom = this.getBoardBottom()
    const cx = W / 2
    const panelTop = boardBottom + 8
    const headerH = 44
    const listTop = panelTop + headerH + 6
    const rowH = 36
    const actionTop = listTop + g.players.length * rowH + 6

    // 掷骰子
    if (this.hitBtn(x, y, cx - 70, actionTop + 6, 140, 46)) this.handleRoll()
    // 道具卡
    else if (this.hitBtn(x, y, W - 80, panelTop, 68, 30)) this.showCards = !this.showCards
    // 购买确认
    else if (this.buyPrompt && this.hitBtn(x, y, cx - 100, actionTop + 18, 90, 40)) this.handleBuy(true)
    else if (this.buyPrompt && this.hitBtn(x, y, cx + 10, actionTop + 18, 90, 40)) this.handleBuy(false)
    // 暂停
    else if (this.hitBtn(x, y, 12, H - 44, 56, 32)) this.paused = !this.paused
    // 静音
    else if (this.hitBtn(x, y, 76, H - 44, 56, 32)) { this.muted = !this.muted; Sound.setMuted(this.muted) }
    // 退出
    else if (this.hitBtn(x, y, W - 68, H - 44, 56, 32)) {
      this.network.leaveRoom()
      this.game = null; this.screen = SCREEN.MENU
    }
    // 棋盘触摸（显示地皮信息）
    else {
      const tileIdx = this.renderer.hitTest(x, y)
      if (tileIdx >= 0) {
        this.tileInfo = this.tileInfo === tileIdx ? null : tileIdx
      } else {
        this.tileInfo = null
        this.showCards = false
      }
    }
  }

  // ===== 掷骰子 =====
  async handleRoll() {
    const g = this.game
    if (!g || this.rolling || g.phase !== 'roll') return
    const cp = g.players[g.currentPlayer]
    if (!cp || cp.bankrupt) return

    // AI 模式下只允许人类玩家触发
    if (this.mode === 'ai' && cp.isAI) return

    // 在线模式 Guest
    if (this.mode === 'online' && !this.network.getIsHost()) {
      await this.network.sendAction('roll', {})
      return
    }

    this.rolling = true
    this.buyPrompt = null
    Sound.playDiceRoll()

    const dice = rollDice()
    g.dice = dice
    this.diceResult = dice

    setTimeout(() => Sound.playDiceLand(), 400)

    const msgs = executeTurn(g, dice)
    this.appendLogs(msgs)
    this.renderer.setCurrentPlayer(g.currentPlayer)

    // 检测租金/税收/机会卡等事件并触发特效
    for (const msg of msgs) {
      if (typeof msg === 'string' && msg.includes('支付租金')) {
        const rentMatch = msg.match(/¥(\d+)/)
        if (rentMatch) {
          this.renderer.showRentEffect(cp.position, parseInt(rentMatch[1]))
        }
      } else if (typeof msg === 'string' && msg.includes('罚款')) {
        this.renderer.emitSparkle(this.renderer.size / 2, this.renderer.size / 2, 6)
      }
    }

    // 购买阶段：记录需要决策的格子
    if (g.phase === 'action') {
      const tile = BOARD[cp.position]
      if (tile) {
        this.buyPrompt = { tile, price: tile.price }
      } else {
        // 格子无效，直接跳过
        g.phase = 'roll'
        nextPlayer(g)
      }
    }

    this.rolling = false

    // 在线广播
    if (this.mode === 'online' && this.network.getIsHost()) {
      await this.network.broadcastGameState(g)
    }

    // AI 回合
    if (this.mode === 'ai' && !g.gameOver) {
      setTimeout(() => this.processAITurns(), 800)
    }
  }

  // ===== 购买 =====
  async handleBuy(buy) {
    const g = this.game
    if (!g) return
    const cp = g.players[g.currentPlayer]
    if (!cp) return
    const tile = BOARD[cp.position]
    if (!tile) return

    if (buy) {
      const success = buyProperty(cp, tile.id)
      if (success) {
        Sound.playBuySound()
        this.addLog('🏠 ' + cp.name + ' 购买了 ' + tile.name)
        // 购买成功特效
        this.renderer.showPurchaseEffect(tile.id)
      } else {
        this.addLog('💸 ' + cp.name + ' 资金不足，无法购买 ' + tile.name)
      }
    } else {
      this.addLog('⏭️ ' + cp.name + ' 跳过了 ' + tile.name)
    }

    g.phase = 'roll'
    this.buyPrompt = null
    // 决策完成后推进到下一个玩家
    nextPlayer(g)

    if (this.mode === 'online' && this.network.getIsHost()) {
      await this.network.broadcastGameState(g)
    }

    if (this.mode === 'ai' && !g.gameOver) {
      setTimeout(() => this.processAITurns(), 500)
    }
  }

  // ===== AI 回合 =====
  processAITurns() {
    const g = this.game
    if (!g || g.gameOver) return
    const cp = g.players[g.currentPlayer]
    if (!cp || cp.bankrupt || !cp.isAI) return

    const dice = rollDice()
    g.dice = dice
    this.diceResult = dice
    Sound.playDiceRoll()

    const fromTile = cp.position
    const steps = dice[0] + dice[1]

    // 先执行游戏逻辑（更新 position、money 等状态）
    const msgs = executeTurn(g, dice)
    this.appendLogs(msgs)

    // AI 购买决策（executeTurn 可能设置 phase='action'）
    if (g.phase === 'action') {
      const tile = BOARD[cp.position]
      if (tile && aiDecision(cp, tile, g.difficulty, g)) {
        buyProperty(cp, tile.id)
        this.addLog('🏠 ' + cp.name + ' 购买了 ' + tile.name)
      } else {
        this.addLog('❌ ' + cp.name + ' 跳过')
      }
      g.phase = 'roll'
    }

    // 纯视觉动画（不影响逻辑，只是让棋子"走过来"）
    this.renderer.playMoveAnimation(
      cp.id, fromTile, steps, cp.color || '#f59e0b', cp.avatar || '🤖',
      () => {
        // 动画结束后更新当前玩家高亮
        this.renderer.setCurrentPlayer(g.currentPlayer)
        if (!g.gameOver) setTimeout(() => this.processAITurns(), 400)
      },
      () => { Sound.playMove() },
      1.5
    )
  }

  // ===== 地皮信息弹窗 =====
  drawTileInfo() {
    const g = this.game
    if (this.tileInfo === null || !g) return
    const tile = BOARD[this.tileInfo]
    if (!tile) return

    const owner = g.players.find(p => p.properties.includes(tile.id))
    const hike = g.priceHikes ? g.priceHikes.find(h => h.tileId === tile.id) : null

    const pw = 200, ph = 180
    const px = (this.W - pw) / 2, py = (this.H - ph) / 3

    // 背景
    this.ctx.fillStyle = 'rgba(15,20,25,0.92)'
    this.roundRect(px, py, pw, ph, 12)
    this.ctx.fill()
    this.ctx.strokeStyle = 'rgba(255,255,255,0.15)'
    this.ctx.lineWidth = 1
    this.ctx.stroke()

    const ctx = this.ctx
    ctx.textAlign = 'left'

    // 名称
    ctx.font = 'bold 16px sans-serif'
    ctx.fillStyle = '#fff'
    ctx.fillText(tile.emoji + ' ' + tile.name, px + 12, py + 28)

    // 拥有者
    ctx.font = '12px sans-serif'
    if (owner) {
      ctx.fillStyle = '#10b981'
      ctx.fillText('👤 ' + owner.name + ' (拥有者)', px + 12, py + 52)
    } else if (tile.price > 0) {
      ctx.fillStyle = '#6b7280'
      ctx.fillText('暂无拥有者', px + 12, py + 52)
    }

    // 价格和租金
    if (tile.price > 0) {
      ctx.fillStyle = '#f59e0b'
      ctx.fillText('💰 价格: ¥' + tile.price, px + 12, py + 76)
      if (tile.rent[0]) {
        ctx.fillStyle = '#d1d5db'
        ctx.fillText('📊 租金: ¥' + tile.rent[0], px + 12, py + 96)
      }
      if (tile.rent[2]) {
        ctx.fillText('🏆 全套: ¥' + tile.rent[2], px + 12, py + 116)
      }
      if (hike) {
        ctx.fillStyle = '#ef4444'
        ctx.fillText('📈 涨价中 (' + hike.roundsLeft + '回合)', px + 12, py + 136)
      }
    }

    // 关闭提示
    ctx.textAlign = 'center'
    ctx.fillStyle = '#6b7280'
    ctx.font = '10px sans-serif'
    ctx.fillText('点击空白处关闭', px + pw / 2, py + ph - 10)
  }

  // ===== 购买弹窗 =====
  drawBuyPrompt() {
    if (!this.buyPrompt) return
    const ctx = this.ctx
    const cx = this.W / 2
    const tile = this.buyPrompt.tile

    // 遮罩
    ctx.fillStyle = 'rgba(0,0,0,0.5)'
    ctx.fillRect(0, 0, this.W, this.H)

    // 卡片
    const pw = 240, ph = 140
    const px = (this.W - pw) / 2, py = (this.H - ph) / 2
    ctx.fillStyle = '#1a1f2e'
    this.roundRect(px, py, pw, ph, 12)
    ctx.fill()

    ctx.textAlign = 'center'
    ctx.font = 'bold 18px sans-serif'
    ctx.fillStyle = '#fff'
    ctx.fillText(tile.emoji + ' ' + tile.name, cx, py + 35)

    ctx.font = '14px sans-serif'
    ctx.fillStyle = '#f59e0b'
    ctx.fillText('价格 ¥' + tile.price + '  |  租金 ¥' + (tile.rent[0] || 0), cx, py + 62)

    // 按钮
    this.drawButton(cx - 90, py + 85, 80, 40, '✅ 购买', '#10b981', 'buy-yes')
    this.drawButton(cx + 10, py + 85, 80, 40, '❌ 跳过', '#ef4444', 'buy-no')
  }

  // ===== 道具卡面板 =====
  drawCardPanel(player) {
    const ctx = this.ctx
    const pw = this.W - 40, ph = 200
    const px = 20, py = this.H - ph - 60

    ctx.fillStyle = 'rgba(15,20,25,0.95)'
    this.roundRect(px, py, pw, ph, 12)
    ctx.fill()

    ctx.textAlign = 'left'
    ctx.font = 'bold 14px sans-serif'
    ctx.fillStyle = '#a78bfa'
    ctx.fillText('🃏 我的道具卡', px + 12, py + 24)

    let cx = px + 12
    for (let i = 0; i < player.cards.length; i++) {
      const card = player.cards[i]
      const cardW = 100, cardH = 70

      ctx.fillStyle = '#2d3748'
      this.roundRect(cx, py + 38, cardW, cardH, 8)
      ctx.fill()

      ctx.textAlign = 'center'
      ctx.font = '20px sans-serif'
      ctx.fillStyle = '#fff'
      ctx.fillText(card.emoji, cx + cardW / 2, py + 62)

      ctx.font = '10px sans-serif'
      ctx.fillStyle = '#d1d5db'
      ctx.fillText(card.name, cx + cardW / 2, py + 82)

      ctx.font = '9px sans-serif'
      ctx.fillStyle = '#9ca3af'
      // 截断描述
      const desc = card.description.length > 10 ? card.description.slice(0, 10) + '..' : card.description
      ctx.fillText(desc, cx + cardW / 2, py + 98)

      cx += cardW + 10
      if (cx + cardW > px + pw) break
    }
  }

  // ===== 玩家信息面板 =====
  drawPlayerPanel(startY) {
    const g = this.game
    if (!g) return
    const ctx = this.ctx

    for (let i = 0; i < g.players.length; i++) {
      const p = g.players[i]
      const y = startY + i * 30
      const isCurrent = i === g.currentPlayer

      // 高亮当前玩家
      if (isCurrent) {
        ctx.fillStyle = 'rgba(245,158,11,0.12)'
        ctx.fillRect(8, y - 12, this.W - 16, 28)
      }

      ctx.textAlign = 'left'
      ctx.font = (isCurrent ? 'bold ' : '') + '12px sans-serif'
      ctx.fillStyle = p.bankrupt ? '#4b5563' : (isCurrent ? '#f59e0b' : '#d1d5db')
      ctx.fillText(p.avatar + ' ' + p.name, 16, y)

      // 金钱
      ctx.textAlign = 'right'
      ctx.fillStyle = p.bankrupt ? '#ef4444' : '#10b981'
      ctx.fillText('¥' + p.money, this.W - 16, y)

      // 地皮数
      ctx.fillStyle = '#6b7280'
      ctx.fillText(p.properties.length + '块', this.W - 80, y)
    }
  }

  // ===== 日志区域 =====
  drawLogArea(startY, maxWidth, maxHeight) {
    if (!this.logs.length) return
    const ctx = this.ctx
    // 只显示最后一条日志，紧凑风格
    const lastLog = this.logs[this.logs.length - 1]
    ctx.textAlign = 'center'
    ctx.font = '13px sans-serif'
    ctx.fillStyle = '#9ca3af'
    const text = lastLog.length > 35 ? lastLog.slice(0, 35) + '..' : lastLog
    ctx.fillText(text, this.W / 2, startY + 10)
  }

  // ===== 网络消息处理 =====
  onNetMessage(type, data) {
    if (type === 'game-state') {
      this.game = data.game
      this.renderer.setCurrentPlayer(this.game.currentPlayer)
      const cp = this.game.players[this.game.currentPlayer]
      const myId = this.network.getOpenId()
      this.isMyTurn = cp.openId === myId
    } else if (type === 'room-info') {
      this.onlinePlayers = data.players || []
      this.roomId = data.roomId || this.roomId
    } else if (type === 'player-action' && this.network.getIsHost()) {
      this.handleGuestAction(data)
    }
  }

  async handleGuestAction(action) {
    const g = this.game
    if (!g) return
    // 找到操作的玩家
    const pIdx = g.players.findIndex(p => p.openId === action.openId)
    if (pIdx < 0 || pIdx !== g.currentPlayer) return

    if (action.type === 'roll') {
      await this.handleRoll()
    } else if (action.type === 'buy') {
      await this.handleBuy(action.payload.buy)
    }
  }

  // ===== 绘制辅助 =====
  drawButton(x, y, w, h, text, color, id) {
    const ctx = this.ctx

    // 按钮背景
    ctx.fillStyle = color
    this.roundRect(x, y, w, h, 12)
    ctx.fill()

    // 按钮高光（顶部半透明）
    ctx.fillStyle = 'rgba(255,255,255,0.15)'
    this.roundRect(x, y, w, h / 2, 12)
    ctx.fill()

    // 文字
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.font = 'bold 18px sans-serif'
    ctx.fillStyle = '#fff'
    ctx.fillText(text, x + w / 2, y + h / 2)
    ctx.textBaseline = 'alphabetic'
  }

  hitBtn(tx, ty, x, y, w, h) {
    return tx >= x && tx <= x + w && ty >= y && ty <= y + h
  }

  roundRect(x, y, w, h, r) {
    const ctx = this.ctx
    ctx.beginPath()
    ctx.moveTo(x + r, y)
    ctx.arcTo(x + w, y, x + w, y + h, r)
    ctx.arcTo(x + w, y + h, x, y + h, r)
    ctx.arcTo(x, y + h, x, y, r)
    ctx.arcTo(x, y, x + w, y, r)
    ctx.closePath()
  }

  addLog(msg) {
    this.logs.push(msg)
    if (this.logs.length > 50) this.logs.shift()
  }

  appendLogs(msgs) {
    for (const m of msgs) this.addLog(m)
  }
}
