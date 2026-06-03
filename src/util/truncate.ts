/**
 * 输出截断工具
 *
 * 命令输出与文件不同：关键信息（报错、stack trace）常出现在末尾，但开头也有用。
 * 因此当输出超过字节预算时，保留「头部 N 行 + 尾部 M 行」，中间用占位符省略，
 * 而不是简单地截断前面或后面。
 */

/** 头尾截断选项 */
export interface HeadTailOptions {
  /** 字节预算：未超过则原样返回 */
  maxBytes: number;
  /** 保留的头部行数，默认 50 */
  headLines?: number;
  /** 保留的尾部行数，默认 50 */
  tailLines?: number;
}

/**
 * 按字节预算对文本做「头 + 尾」截断。
 *
 * @param text 原始文本
 * @param options 截断选项
 * @returns 未超预算时为原文；超预算时为「头部 + 省略占位 + 尾部」
 */
export function truncateHeadTail(text: string, options: HeadTailOptions): string {
  const { maxBytes } = options;
  const headLines = options.headLines ?? 50;
  const tailLines = options.tailLines ?? 50;

  // 用字节长度判断是否超预算（中文等多字节字符更准确）
  const byteLength = Buffer.byteLength(text, "utf-8");
  if (byteLength <= maxBytes) return text;

  const lines = text.split("\n");
  // 行数太少（单行超长）时无法靠行截断，退化为按字符硬截断头尾
  if (lines.length <= headLines + tailLines) {
    const half = Math.floor(maxBytes / 2);
    const head = text.slice(0, half);
    const tail = text.slice(text.length - half);
    return `${head}\n... [输出过长，已省略中间 ${byteLength - maxBytes} 字节] ...\n${tail}`;
  }

  const head = lines.slice(0, headLines).join("\n");
  const tail = lines.slice(lines.length - tailLines).join("\n");
  const omitted = lines.length - headLines - tailLines;
  return `${head}\n... [输出过长，已省略中间 ${omitted} 行] ...\n${tail}`;
}
