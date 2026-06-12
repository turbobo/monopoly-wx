/**
 * 轻量级 Tween 缓动动画系统
 * 纯 JS 实现，支持多种缓动函数
 */

// 缓动函数
export const Easing = {
  linear: t => t,
  easeInQuad: t => t * t,
  easeOutQuad: t => t * (2 - t),
  easeInOutQuad: t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
  easeInCubic: t => t * t * t,
  easeOutCubic: t => (--t) * t * t + 1,
  easeInOutCubic: t => t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
  easeOutBack: t => { const s = 1.70158; return (t -= 1) * t * ((s + 1) * t + s) + 1 },
  easeOutBounce: t => {
    if (t < 1 / 2.75) return 7.5625 * t * t
    if (t < 2 / 2.75) return 7.5625 * (t -= 1.5 / 2.75) * t + 0.75
    if (t < 2.5 / 2.75) return 7.5625 * (t -= 2.25 / 2.75) * t + 0.9375
    return 7.5625 * (t -= 2.625 / 2.75) * t + 0.984375
  },
  easeOutElastic: t => {
    if (t === 0 || t === 1) return t
    return Math.pow(2, -10 * t) * Math.sin((t - 0.075) * (2 * Math.PI) / 0.3) + 1
  }
}

export class TweenManager {
  constructor() {
    this.tweens = []
  }

  /**
   * 创建一个 Tween 动画
   * @param {object} target - 要动画化的对象
   * @param {object} to - 目标属性值 { x: 100, y: 200, alpha: 0 }
   * @param {number} duration - 持续时间（帧数，60fps 下 60=1秒）
   * @param {object} opts - 选项 { easing, delay, onComplete, onUpdate, yoyo }
   * @returns {object} tween 实例
   */
  add(target, to, duration, opts = {}) {
    const from = {}
    for (const key in to) {
      from[key] = target[key] !== undefined ? target[key] : 0
    }
    const tween = {
      target, from, to, duration,
      elapsed: 0,
      delay: opts.delay || 0,
      easing: opts.easing || Easing.easeOutCubic,
      onComplete: opts.onComplete || null,
      onUpdate: opts.onUpdate || null,
      yoyo: opts.yoyo || false,
      repeat: opts.repeat || 0,
      repeatCount: 0,
      forward: true,
      active: true,
    }
    this.tweens.push(tween)
    return tween
  }

  // 缩放动画（弹性效果）
  bounce(target, scale, duration = 20) {
    return this.add(target, { scaleX: scale, scaleY: scale }, duration, {
      easing: Easing.easeOutBack,
      onComplete: () => {
        this.add(target, { scaleX: 1, scaleY: 1 }, 15, { easing: Easing.easeOutCubic })
      }
    })
  }

  // 闪烁效果
  flash(target, times = 3, duration = 10) {
    const tw = this.add(target, { alpha: 0 }, duration, { easing: Easing.linear })
    let count = 0
    tw.onUpdate = (t) => {
      const phase = Math.sin(t * Math.PI * times)
      target.alpha = phase > 0 ? 1 : 0.3
    }
    tw.onComplete = () => { target.alpha = 1 }
    return tw
  }

  // 抖动效果
  shake(target, intensity = 5, duration = 20) {
    const origX = target.x, origY = target.y
    const tw = this.add(target, { _shake: 1 }, duration, { easing: Easing.linear })
    tw.onUpdate = (t) => {
      const decay = 1 - t
      target.x = origX + (Math.random() - 0.5) * intensity * 2 * decay
      target.y = origY + (Math.random() - 0.5) * intensity * 2 * decay
    }
    tw.onComplete = () => { target.x = origX; target.y = origY }
    return tw
  }

  // 每帧更新
  update() {
    this.tweens = this.tweens.filter(tw => {
      if (!tw.active) return false
      if (tw.delay > 0) { tw.delay--; return true }

      tw.elapsed++
      let t = Math.min(tw.elapsed / tw.duration, 1)
      const easedT = tw.forward ? tw.easing(t) : tw.easing(1 - t)

      // 插值属性
      for (const key in tw.to) {
        tw.target[key] = tw.from[key] + (tw.to[key] - tw.from[key]) * easedT
      }

      if (tw.onUpdate) tw.onUpdate(t)

      if (t >= 1) {
        if (tw.yoyo) {
          tw.forward = !tw.forward
          tw.elapsed = 0
          if (!tw.forward) tw.repeatCount++
          if (tw.repeatCount > tw.repeat) {
            tw.active = false
            if (tw.onComplete) tw.onComplete()
            return false
          }
          return true
        }
        tw.active = false
        if (tw.onComplete) tw.onComplete()
        return false
      }
      return true
    })
  }

  // 清除所有
  clear() {
    this.tweens = []
  }

  // 当前活跃数量
  get count() { return this.tweens.length }
}
