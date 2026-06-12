/**
 * 微信小游戏 API Polyfill
 * 补齐第三方库（如 GoEasy）依赖的小程序 API，必须最先加载
 */
if (typeof wx !== 'undefined') {
  if (typeof wx.onAppShow !== 'function') wx.onAppShow = (cb) => wx.onShow && wx.onShow(cb)
  if (typeof wx.offAppShow !== 'function') wx.offAppShow = (cb) => wx.offShow && wx.offShow(cb)
  if (typeof wx.onAppHide !== 'function') wx.onAppHide = (cb) => wx.onHide && wx.onHide(cb)
  if (typeof wx.offAppHide !== 'function') wx.offAppHide = (cb) => wx.offHide && wx.offHide(cb)
}
