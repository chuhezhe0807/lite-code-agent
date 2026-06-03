/**
 * 防抖函数
 * 核心思想：在事件被触发后，延迟 delay 毫秒再执行回调；
 * 若在延迟期间再次触发，则重置计时器，重新计时。
 * 常用场景：搜索框输入联想、窗口 resize、按钮防重复点击等。
 *
 * @param fn    需要防抖处理的目标函数
 * @param delay 延迟执行的等待时间（毫秒）
 * @returns     经过防抖包装后的新函数
 */
export const debounce = <T extends (...args: any[]) => void>(
  fn: T,
  delay: number
): ((...args: Parameters<T>) => void) => {
  // 用于存储定时器 ID，初始为 null
  let timer: ReturnType<typeof setTimeout> | null = null;

  // 返回包装后的防抖函数
  return (...args: Parameters<T>): void => {
    // 若已存在未执行的定时器，则先清除，避免重复触发
    if (timer !== null) {
      clearTimeout(timer);
    }

    // 重新开启定时器，在 delay 毫秒后执行目标函数
    timer = setTimeout(() => {
      // 使用原始上下文与参数调用目标函数
      fn(...args);
      // 执行完毕后将定时器 ID 置空，释放引用
      timer = null;
    }, delay);
  };
};
