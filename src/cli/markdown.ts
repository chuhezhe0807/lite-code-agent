/**
 * Markdown → 终端富文本（ANSI）渲染
 *
 * 模型回复通常是 Markdown（标题/列表/粗体/代码块/表格等）。这里用 marked 解析、
 * marked-terminal 转成带 ANSI 样式的字符串，再交给 Ink 的 <Text> 显示（Ink 是
 * ANSI-aware 的，能正确处理嵌入的样式码与按宽度换行）。
 *
 * 说明：
 *   - 是否真的输出颜色由 chalk 自动探测终端能力决定（真实 TTY 下开启，管道/测试下为纯文本）。
 *   - 表格按传入的列宽渲染；段落不在此硬折行（reflowText=false），交给 Ink 按 Box 宽度换行。
 *   - 去掉尾部多余换行，行间距交由外层 Box 的 margin 控制。
 */

import { Marked, type MarkedExtension } from "marked";
import { markedTerminal } from "marked-terminal";

/**
 * 把 Markdown 文本渲染为终端可显示的字符串。
 * @param md Markdown 源文本
 * @param width 终端列宽（用于表格等需要固定宽度的元素）
 */
export function renderMarkdown(md: string, width: number): string {
  const marked = new Marked();
  // @types/marked-terminal 的大版本与运行时（v7）不一致，返回类型对不上 marked.use
  // 期望的 MarkedExtension，这里按实际运行时形态强转。
  marked.use(
    markedTerminal({
      width: Math.max(20, width),
      // 段落不硬折行，交给 Ink 按 Box 宽度换行，避免与 Ink 的换行叠加
      reflowText: false,
    }) as unknown as MarkedExtension,
  );
  const out = marked.parse(md, { async: false }) as string;
  // 去掉尾部空行（marked-terminal 常追加 \n\n），行距由外层 margin 控制
  return out.replace(/\s+$/, "");
}
