/**
 * 防抖函数
 * 核心思路：事件触发后延迟 `delay` 毫秒再执行回调；
 * 若在延迟期间事件再次触发，则重置计时器并重新倒计时。
 * 常见使用场景：搜索框输入建议、窗口尺寸变化、防止按钮重复点击等。
 *
 * @param fn        需要防抖处理的目标函数
 * @param delay     函数执行前的等待时间（毫秒）
 * @param immediate 是否在第一次触发时立即执行（默认 false）
 *                  - true：首次触发立即执行，delay 静默期内的后续触发被忽略，
 *                          静默期结束后下一次触发可再次立即执行。
 *                  - false：沿用原有防抖逻辑，仅在停止触发 delay 毫秒后执行。
 * @returns         经过防抖包装后的新函数，附带 cancel 方法用于手动取消待执行的计时器
 */
export const debounce = <T extends (...args: any[]) => void>(
  fn: T,
  delay: number,
  immediate: boolean = false
): ((...args: Parameters<T>) => void) & { cancel: () => void } => {
  // 存储计时器 ID，初始值为 null
  let timer: ReturnType<typeof setTimeout> | null = null;

  // 返回防抖包装后的函数
  const debounced = (...args: Parameters<T>): void => {
    if (immediate) {
      // ---------- 立即执行模式 ----------
      // timer 为 null 说明当前处于静默期之外，可以立即执行
      const shouldCallNow = timer === null;

      // 无论是否立即执行，都需要（重新）启动计时器以维持静默期
      if (timer !== null) {
        clearTimeout(timer);
      }

      // 静默期结束后将 timer 重置为 null，开放下一次立即执行
      timer = setTimeout(() => {
        timer = null;
      }, delay);

      // 仅在静默期之外的第一次触发时立即调用目标函数
      if (shouldCallNow) {
        fn(...args);
      }
    } else {
      // ---------- 延迟执行模式（原有逻辑）----------
      // 若已有待执行的计时器，先清除，避免重复执行
      if (timer !== null) {
        clearTimeout(timer);
      }

      // 启动新计时器，在 `delay` 毫秒后执行目标函数
      timer = setTimeout(() => {
        // 使用原始参数调用目标函数
        fn(...args);
        // 执行完毕后将计时器 ID 重置为 null，释放引用
        timer = null;
      }, delay);
    }
  };

  /**
   * 取消当前尚未触发的计时器。
   * 适用于组件卸载、页面离开等场景，防止内存泄漏或意外执行。
   */
  debounced.cancel = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  return debounced;
};
