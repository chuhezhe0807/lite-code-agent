/**
 * glob 匹配与文件遍历的公共工具
 *
 * 供只读搜索工具 grep（US-022）与 glob（US-023）复用：
 *   - globToRegExp：把 glob 模式（支持 ** / * / ?）编译为正则。
 *   - createGlobMatcher：按 gitignore 语义生成「路径是否匹配」的判定函数
 *     （模式不含 "/" 时按文件名 basename 匹配，否则按完整相对路径匹配）。
 *   - walkFiles：递归遍历目录，惰性产出文件的绝对路径，默认跳过噪音目录。
 *
 * 设计为纯函数 + 生成器，不引入第三方依赖，便于学习与测试。
 */

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

/** 遍历时默认跳过的噪音目录（避免扫 node_modules 卡顿、避免输出爆炸） */
export const IGNORED_DIRS = new Set(["node_modules", ".git", "dist"]);

/** 把系统路径分隔符统一成 posix 风格，保证匹配与展示跨平台一致 */
export function toPosix(p: string): string {
  return p.split(/[\\/]/).join("/");
}

/**
 * 把 glob 模式编译为锚定整串的正则。
 * 约定：
 *   - `**` 跨目录匹配任意字符（含 `/`）；`** /`（连斜杠）匹配零或多个完整目录层级。
 *   - `*`  匹配除 `/` 外的任意字符（不跨目录）。
 *   - `?`  匹配除 `/` 外的单个字符。
 *   - 其余正则元字符按字面量转义。
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        i++; // 吃掉第二个 *
        if (glob[i + 1] === "/") {
          i++; // 吃掉斜杠：`**/` => 零或多个目录层级
          re += "(?:[^/]*/)*";
        } else {
          re += ".*"; // `**` => 任意字符含 /
        }
      } else {
        re += "[^/]*"; // `*` => 不跨目录
      }
    } else if (c === "?") {
      re += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      re += "\\" + c; // 转义正则元字符
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

/**
 * 生成一个「相对路径是否匹配该 glob」的判定函数。
 * 沿用 gitignore 语义：模式不含 "/" 时只匹配文件名（basename），
 * 因此 `*.ts` 能匹配任意层级下的 .ts 文件；含 "/" 时匹配完整相对路径。
 */
export function createGlobMatcher(glob: string): (relPath: string) => boolean {
  const re = globToRegExp(glob);
  const matchBasename = !glob.includes("/");
  return (relPath: string) => {
    const posix = toPosix(relPath);
    const target = matchBasename ? (posix.split("/").pop() ?? posix) : posix;
    return re.test(target);
  };
}

/**
 * 递归遍历 absRoot 下的所有文件，惰性产出文件的绝对路径。
 *   - 跳过 IGNORED_DIRS 中的目录。
 *   - 同级条目按名称排序，保证产出顺序稳定。
 *   - 读取失败的目录（无权限等）直接跳过，不中断整体遍历。
 * 调用方可在拿到足够结果后提前 break 以控制开销。
 */
export async function* walkFiles(absRoot: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(absRoot, { withFileTypes: true });
  } catch {
    return; // 无权限/读取失败的目录跳过
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = join(absRoot, e.name);
    if (e.isDirectory()) {
      if (IGNORED_DIRS.has(e.name)) continue;
      yield* walkFiles(full);
    } else if (e.isFile()) {
      yield full;
    }
  }
}

/** 计算 abs 相对 root 的 posix 风格相对路径（用于匹配与展示） */
export function relPosix(root: string, abs: string): string {
  return toPosix(relative(root, abs));
}
