/**
 * 防抖函数
 * 核心思路：事件触发后延迟 `delay` 毫秒再执行回调；
 * 若在延迟期间事件再次触发，则重置计时器并重新倒计时。
 * 常见使用场景：搜索框输入建议、窗口尺寸变化、防止按钮重复点击等。
 *
 * @param fn    需要防抖处理的目标函数
 * @param delay 函数执行前的等待时间（毫秒）
 * @returns     经过防抖包装后的新函数
 */
export const debounce = <T extends (...args: any[]) => void>(
  fn: T,
  delay: number
): ((...args: Parameters<T>) => void) => {
  // 存储计时器 ID，初始值为 null
  let timer: ReturnType<typeof setTimeout> | null = null;

  // 返回防抖包装后的函数
  return (...args: Parameters<T>): void => {
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
  };
};
