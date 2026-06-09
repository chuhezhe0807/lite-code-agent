/**
 * Debounce function
 * Core idea: delay the callback execution by `delay` milliseconds after the event is triggered;
 * if the event fires again during the delay period, reset the timer and restart the countdown.
 * Common use cases: search input suggestions, window resize, preventing duplicate button clicks, etc.
 *
 * @param fn    The target function to be debounced
 * @param delay The waiting time (in milliseconds) before the function is executed
 * @returns     A new debounce-wrapped function
 */
export const debounce = <T extends (...args: any[]) => void>(
  fn: T,
  delay: number
): ((...args: Parameters<T>) => void) => {
  // Stores the timer ID; initialized to null
  let timer: ReturnType<typeof setTimeout> | null = null;

  // Return the debounce-wrapped function
  return (...args: Parameters<T>): void => {
    // If a pending timer already exists, clear it to prevent duplicate execution
    if (timer !== null) {
      clearTimeout(timer);
    }

    // Start a new timer to execute the target function after `delay` milliseconds
    timer = setTimeout(() => {
      // Invoke the target function with the original arguments
      fn(...args);
      // Reset the timer ID to null after execution to free the reference
      timer = null;
    }, delay);
  };
};
