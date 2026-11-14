// 清除“遮住视口大部分”的同意弹窗，包括放在（跨域）iframe 里的第三方同意平台。
// 只在就绪判断认为内容没出现、且 Jev 看截图确认有同意弹窗挡住视口时才调用；内容已就绪时不碰页面。
// 先点明示的“拒绝/仅必要”（点击发生在各自的 iframe 里，Playwright 可进入跨域 frame），点不掉再隐藏；
// 隐藏可撤销，调用方在内容概率反而下降时还原。不接受追踪，不处理年龄确认或登录。
import type { ReadinessPage } from './readiness.ts';

/** 明示的拒绝类按钮文案（多语言）。只匹配整句，避免误点“Accept … partners”之类。 */
export const REFUSAL_LABEL = /^(?:(?:i )?do not agree|i disagree|disagree|reject(?: all)?(?: cookies)?|decline(?: all)?(?: cookies)?|deny(?: all)?|refuse(?: all)?|no,? thanks|(?:use |allow |accept )?(?:only )?(?:strictly )?necessary(?: cookies)?(?: only)?|continue without (?:accepting|agreeing)|tout refuser|refuser(?: tout| et fermer| les cookies)?|continuer sans accepter|je refuse|non merci|alle ablehnen|ablehnen|nein,? danke|nur (?:notwendige|erforderliche)(?: cookies)?|rechazar(?: todo| todas)?|solo necesarias|rifiuta(?: tutto| tutti)?|solo necessari|(?:拒绝|全部拒绝|所有拒绝)(?:全部|所有)?(?:非必要)?(?:cookie|cookies)?|仅(?:使用|允许|接受)?必要(?:的)?(?:cookie|cookies)?)$/i;

/** 在一个文档（主文档或某个 iframe）里点第一个可见的拒绝按钮；也会进入 shadow root。 */
const CLICK_REFUSAL = `(() => {
  const refusal = new RegExp(${JSON.stringify(REFUSAL_LABEL.source)}, 'i')
  const roots = [document]
  const walk = root => { for (const element of root.querySelectorAll('*')) if (element.shadowRoot) { roots.push(element.shadowRoot); walk(element.shadowRoot) } }
  walk(document)
  const visible = element => { const rect = element.getBoundingClientRect(); const style = getComputedStyle(element); return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' }
  for (const root of roots) for (const control of root.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')) {
    const label = (control.innerText || control.textContent || control.value || control.getAttribute('aria-label') || '').trim().replace(/\\s+/g, ' ')
    if (!visible(control) || control.disabled || control.getAttribute('aria-disabled') === 'true' || !refusal.test(label)) continue
    if (control.tagName === 'A' && !/^(?:#|javascript:)/i.test(control.getAttribute('href') || '')) continue
    control.click()
    return true
  }
  return false
})()`;

/**
 * 隐藏挡住视口的同意层：铺开的 iframe（第三方同意平台）、没有文字的全屏蒙层、含同意字样的对话框；
 * 并解除常见的滚动锁。每个被隐藏的元素原来的 display 记在 window.__yuHidden，可由 RESTORE 还原。
 */
const HIDE = `(() => {
  const vw = window.innerWidth, vh = window.innerHeight
  const hidden = window.__yuHidden || (window.__yuHidden = [])
  const consent = /cookies?|consent|privacy|confidentialit|datenschutz|einwilligung|rgpd|gdpr|donn[ée]es personnelles|privacidad|隐私|同意/i
  const shown = element => { const style = getComputedStyle(element); if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false; const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 }
  const coverage = element => { const rect = element.getBoundingClientRect(); return Math.max(0, Math.min(rect.right, vw) - Math.max(rect.left, 0)) * Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0)) / (vw * vh) }
  // 第三方同意平台常见结构：iframe 自己是 static，外层容器才是铺满视口的 fixed。向上找 fixed/sticky 祖先。
  const fixedAncestor = element => { for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) { const position = getComputedStyle(node).position; if (position === 'fixed' || position === 'sticky') return node } return null }
  const found = []
  // 同意层挂在 body 末尾或靠近根部；大页面按文档顺序全量扫描会在到达它之前就被截断，所以只取：
  // iframe、对话框，以及 body 下三层以内的元素（容器、蒙层、弹窗通常在这里）。
  const pool = new Set(document.querySelectorAll('iframe, dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"]'))
  const near = (parent, depth) => { if (depth > 3) return; for (const child of parent.children) { if (pool.size > 4000) return; pool.add(child); near(child, depth + 1) } }
  if (document.body) near(document.body, 1)
  for (const element of pool) {
    if (element === document.body || element === document.documentElement || hidden.some(item => item.element === element)) continue
    const style = getComputedStyle(element)
    const dialogLike = element.matches('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')
    const positioned = style.position === 'fixed' || style.position === 'sticky'
    if ((!positioned && !dialogLike && element.tagName !== 'IFRAME') || !shown(element)) continue
    const cover = coverage(element)
    if (element.querySelector('main, article, [role="main"]')) continue
    const text = (element.innerText || element.textContent || '').replace(/\\s+/g, ' ').trim()
    const iframeLayer = element.tagName === 'IFRAME' && (positioned || !!fixedAncestor(element)) && cover >= 0.2
    const backdrop = positioned && cover >= 0.5 && text.length < 5 && !element.querySelector('video, canvas, img, svg, iframe')
    const dialog = (dialogLike || positioned) && cover >= 0.05 && consent.test(text)
    if (iframeLayer || backdrop || dialog) found.push(element)
  }
  // iframe 外面如果只有一个空的 fixed 容器（没有自己的文字），连容器一起隐藏，避免留下透明的点击拦截层。
  const targets = found.map(element => {
    if (element.tagName !== 'IFRAME') return element
    const layer = fixedAncestor(element)
    return layer && (layer.innerText || '').replace(/\\s+/g, '').length === 0 && layer.querySelectorAll('iframe').length === 1 ? layer : element
  })
  const outer = [...new Set(targets)].filter(element => !targets.some(other => other !== element && other.contains(element)))
  for (const element of outer) {
    hidden.push({ element, value: element.style.getPropertyValue('display'), priority: element.style.getPropertyPriority('display') })
    element.style.setProperty('display', 'none', 'important')
  }
  if (outer.length > 0) for (const root of [document.documentElement, document.body]) {
    if (!root) continue
    const style = getComputedStyle(root)
    if (style.overflow === 'hidden' || style.overflowY === 'hidden') root.style.setProperty('overflow', 'auto', 'important')
    if (root === document.body && style.position === 'fixed') root.style.setProperty('position', 'static', 'important')
  }
  return outer.length
})()`;

const RESTORE = `(() => {
  const hidden = window.__yuHidden || []
  for (const item of hidden) { if (item.value) item.element.style.setProperty('display', item.value, item.priority); else item.element.style.removeProperty('display') }
  window.__yuHidden = []
  return hidden.length
})()`;

/** 页面内脚本，导出供测试和排错直接在页面里运行。 */
export const CONSENT_SCRIPTS = { CLICK_REFUSAL, HIDE, RESTORE };

export interface ConsentTools {
  /** 点掉或隐藏挡住视口的同意层；返回点击数和隐藏数。 */
  clearConsentOverlay(): Promise<{ clicked: number; hidden: number }>;
  /** 还原 clearConsentOverlay 隐藏的元素（点击无法撤销）。 */
  restoreConsentOverlay(): Promise<number>;
}

interface PlaywrightFrame { evaluate<T>(expression: string): Promise<T> }
interface PlaywrightPageLike extends ReadinessPage {
  frames?(): PlaywrightFrame[];
  mainFrame?(): PlaywrightFrame;
}

const within = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

/** 给 Playwright 页面补上清除同意层的能力；对不支持 frames 的页面对象退化为只在主文档里操作。 */
export function withConsentTools<T extends PlaywrightPageLike>(page: T): T & ConsentTools {
  const tools: ConsentTools = {
    async clearConsentOverlay() {
      let clicked = 0;
      const main = page.mainFrame?.();
      const children = (page.frames?.() ?? []).filter((frame) => frame !== main);
      // 各 iframe 并行尝试；每个 frame 限时，慢的或已卸载的直接跳过。
      const results = await Promise.all(children.map((frame) => within(frame.evaluate<boolean>(CLICK_REFUSAL), 1500, false)));
      clicked += results.filter(Boolean).length;
      if (!clicked && await within(page.evaluate<boolean>(CLICK_REFUSAL), 800, false)) clicked++;
      if (clicked) await page.waitForTimeout(300).catch(() => {});
      const hidden = await within(page.evaluate<number>(HIDE), 1500, 0);
      return { clicked, hidden };
    },
    async restoreConsentOverlay() {
      return within(page.evaluate<number>(RESTORE), 1000, 0);
    },
  };
  return Object.assign(Object.create(page), {
    // Playwright 的页面方法依赖 this，直接代理到原对象。
    evaluate: (expression: string) => page.evaluate(expression),
    waitForTimeout: (ms: number) => page.waitForTimeout(ms),
    screenshot: page.screenshot ? (options?: unknown) => (page as any).screenshot(options) : undefined,
    ...tools,
  });
}
