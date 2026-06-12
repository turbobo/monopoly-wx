/**
 * 大富翁中国行 - 微信小游戏主控制器
 * 替代 v3 的 page.tsx React UI，全部用 Canvas 绘制
 */
import {
  BOARD, BOARD_SIZE, createGame, executeTurn, buyProperty,
  rollDice, aiDecision, totalWealth, rollDice as _rd,
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
      if (this.buyPrompt) this.drawBuyPrompt()
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
      this.addLog('请检查 GoEasy AppKey 配置')
    }
  }

  // ===== 大厅界面 =====
  drawLobby() {
    const ctx = this.ctx, cx = this.W / 2
    const btnW = this.W * 0.7
    const btnX = cx - btnW / 2
    const H = this.H

    ctx.textAlign = 'center'
    ctx.fillStyle = '#f59e0b'
    ctx.font = 'bold 32px sans-serif'
    ctx.fillText('在线对战', cx, H * 0.10)

    // 创建房间按钮
    const createY = H * 0.18
    this.drawButton(btnX, createY, btnW, 56, '🏠 创建房间', '#f59e0b', 'lobby-create')

    // 加入房间
    const joinY = H * 0.30
    this.drawButton(btnX, joinY, btnW, 56, '🔗 加入房间', '#3b82f6', 'lobby-join')

    // 房间号 + 邀请按钮
    const roomY = H * 0.44
    if (this.roomId) {
      ctx.font = 'bold 24px sans-serif'
      ctx.fillStyle = '#10b981'
      ctx.fillText('房间号: ' + this.roomId, cx - 40, roomY + 16)
      this.drawButton(cx + 60, roomY, 70, 36, '复制', '#374151', 'lobby-copy')

      // 邀请好友按钮
      const inviteY = roomY + 50
      this.drawButton(btnX, inviteY, btnW, 50, '📨 邀请好友', '#8b5cf6', 'lobby-invite')
    }

    // 玩家列表
    ctx.font = '16px sans-serif'
    ctx.textAlign = 'left'
    let listY = H * 0.52
    for (const p of this.onlinePlayers) {
      ctx.fillStyle = p.isHost ? '#f59e0b' : '#d1d5db'
      ctx.fillText((p.isHost ? '👑 ' : '  ') + p.name, 40, listY)
      listY += 32
    }

    // 开始游戏按钮（仅房主可见）
    if (this.network.getIsHost() && this.onlinePlayers.length >= 1) {
      this.drawButton(cx - btnW / 2, H * 0.70, btnW, 56, '🎮 开始游戏', '#10b981', 'lobby-start')
    }

    // 返回按钮
    this.drawButton(20, H - 80, 100, 48, '← 返回', '#374151', 'lobby-back')

    // 日志
    this.drawLogArea(H * 0.79, this.W - 20, H * 0.12)
  }

  handleLobbyTouch(x, y) {
    const cx = this.W / 2
    const btnW = this.W * 0.7
    const btnX = cx - btnW / 2
    const H = this.H
    const roomY = H * 0.44

    const createY = H * 0.18
    const joinY = H * 0.30

    if (this.hitBtn(x, y, btnX, createY, btnW, 56)) this.onCreateRoom()
    else if (this.hitBtn(x, y, btnX, joinY, btnW, 56)) this.onJoinRoom()
    else if (this.hitBtn(x, y, cx + 60, roomY, 70, 36)) this.onCopyRoomId()
    else if (this.roomId && this.hitBtn(x, y, btnX, roomY + 50, btnW, 50)) this.onInviteFriend()
    else if (this.hitBtn(x, y, btnX, H * 0.70, btnW, 56)) this.onHostStartGame()
    else if (this.hitBtn(x, y, 20, H - 80, 100, 48)) {
      this.network.leaveRoom()
      this.screen = SCREEN.MENU
    }
  }

  async onCreateRoom() {
    try {
      this.roomId = await this.network.createRoom()
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
    if (this.roomId) {
      wx.setClipboardData({ data: this.roomId })
      this.addLog('房间号已复制')
    }
  }

  onInviteFriend() {
    if (!this.roomId) return
    wx.shareAppMessage({
      title: '来玩大富翁！房间号: ' + this.roomId,
      imageUrl: '',  // 可加分享图片路径
      query: 'roomId=' + this.roomId
    })
    this.addLog('分享卡片已生成，发送给好友即可')
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

    const boardTop = this.renderer.boardCssTop
    const boardBottom = this.getBoardBottom()

    // 顶部信息栏
    const cp = g.players[g.currentPlayer]
    ctx.textAlign = 'left'
    ctx.font = 'bold 14px sans-serif'
    ctx.fillStyle = '#f59e0b'
    ctx.fillText('第' + g.round + '回合', 12, boardTop + 16)

    ctx.fillStyle = cp.color || '#fff'
    ctx.fillText(cp.avatar + ' ' + cp.name, 80, boardTop + 16)

    // 骰子按钮
    if (this.isMyTurn && !this.rolling && g.phase === 'roll') {
      const cx = this.W / 2
      this.drawButton(cx - 55, boardBottom + 4, 110, 42, '🎲 掷骰子', '#f59e0b', 'game-roll')
    }

    // 骰子结果显示
    if (this.diceResult) {
      ctx.textAlign = 'center'
      ctx.font = 'bold 20px sans-serif'
      ctx.fillStyle = '#fff'
      ctx.fillText(this.diceResult[0] + ' + ' + this.diceResult[1] + ' = ' + (this.diceResult[0] + this.diceResult[1]), this.W / 2, boardBottom + 68)
    }

    // 道具卡按钮
    const myPlayer = g.players.find(p => p.openId === this.network.getOpenId() || (this.mode === 'ai' && p.id === 0))
    if (myPlayer && myPlayer.cards && myPlayer.cards.length > 0) {
      this.drawButton(this.W - 80, boardBottom + 4, 70, 32, '🃏 ' + myPlayer.cards.length, '#8b5cf6', 'game-cards')
    }

    // 玩家信息面板
    this.drawPlayerPanel(boardBottom + 80)

    // 日志区域
    this.drawLogArea(boardBottom + 80 + g.players.length * 32 + 10, this.W - 20, 150)

    // 道具卡面板
    if (this.showCards && myPlayer) this.drawCardPanel(myPlayer)

    // 控制按钮
    this.drawButton(12, this.H - 44, 60, 32, this.paused ? '▶' : '⏸', '#374151', 'game-pause')
    this.drawButton(80, this.H - 44, 60, 32, this.muted ? '🔇' : '🔊', '#374151', 'game-mute')
    this.drawButton(this.W - 72, this.H - 44, 60, 32, '退出', '#991b1b', 'game-exit')
  }

  handleGameTouch(x, y) {
    const g = this.game
    if (!g) return
    const boardBottom = this.getBoardBottom()
    const cx = this.W / 2

    // 掷骰子
    if (this.hitBtn(x, y, cx - 55, boardBottom + 4, 110, 42)) this.handleRoll()
    // 道具卡
    else if (this.hitBtn(x, y, this.W - 80, boardBottom + 4, 70, 32)) this.showCards = !this.showCards
    // 购买确认
    else if (this.buyPrompt && this.hitBtn(x, y, cx - 90, this.H / 2 + 30, 80, 40)) this.handleBuy(true)
    else if (this.buyPrompt && this.hitBtn(x, y, cx + 10, this.H / 2 + 30, 80, 40)) this.handleBuy(false)
    // 暂停
    else if (this.hitBtn(x, y, 12, this.H - 44, 60, 32)) this.paused = !this.paused
    // 静音
    else if (this.hitBtn(x, y, 80, this.H - 44, 60, 32)) { this.muted = !this.muted; Sound.setMuted(this.muted) }
    // 退出
    else if (this.hitBtn(x, y, this.W - 72, this.H - 44, 60, 32)) {
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

    // 购买阶段
    if (g.phase === 'action') {
      const tile = BOARD[cp.position]
      this.buyPrompt = { tile, price: tile.price }
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
    const tile = BOARD[cp.position]

    if (buy) {
      buyProperty(cp, tile.id)
      Sound.playBuySound()
      this.addLog('🏠 ' + cp.name + ' 购买了 ' + tile.name)
    } else {
      this.addLog('❌ ' + cp.name + ' 跳过了 ' + tile.name)
    }

    g.phase = 'roll'
    this.buyPrompt = null

    if (this.mode === 'online' && this.network.getIsHost()) {
      await this.network.broadcastGameState(g)
    }

    if (this.mode === 'ai') setTimeout(() => this.processAITurns(), 500)
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

    const steps = dice[0] + dice[1]
    const fromTile = cp.position

    // 播放逐格移动动画，动画结束后再执行 executeTurn 的后续逻辑
    this.renderer.playMoveAnimation(
      cp.id, fromTile, steps, cp.color || '#f59e0b', cp.avatar || '🤖',
      () => {
        // 动画结束：执行游戏逻辑
        const msgs = executeTurn(g, dice)
        this.appendLogs(msgs)
        this.renderer.setCurrentPlayer(g.currentPlayer)

        if (g.phase === 'action') {
          const tile = BOARD[cp.position]
          if (aiDecision(cp, tile, g.difficulty, g)) {
            buyProperty(cp, tile.id)
            this.addLog('🏠 ' + cp.name + ' 购买了 ' + tile.name)
          } else {
            this.addLog('❌ ' + cp.name + ' 跳过了 ' + tile.name)
          }
          g.phase = 'roll'
        }

        if (!g.gameOver) setTimeout(() => this.processAITurns(), 600)
      },
      () => { Sound.playMove && Sound.playMove() },
      1.2  // AI 回合适当加速
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
    ctx.textAlign = 'left'
    ctx.font = '11px sans-serif'

    const maxLines = Math.floor(maxHeight / 16)
    const visible = this.logs.slice(-maxLines)
    for (let i = 0; i < visible.length; i++) {
      ctx.fillStyle = i === visible.length - 1 ? '#d1d5db' : '#6b7280'
      const text = visible[i].length > 30 ? visible[i].slice(0, 30) + '..' : visible[i]
      ctx.fillText(text, 16, startY + i * 16)
    }
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
