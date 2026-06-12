import { rmSync, chmodSync } from "node:fs";
import { build } from "esbuild";

const OUT_FILE = "dist/index.js";

// 清理上一次的产物
rmSync("dist", { recursive: true, force: true });

// esbuild 会在「死代码消除」之前先解析所有 import，因此即便 DEV 分支会被裁掉，
// 仍会尝试解析 react-devtools-core（可选依赖，未安装）而报错。
// 这里用插件把它替换成空模块，保证解析通过；配合 define + minify，这段死代码最终会被整体裁掉。
const stubReactDevtools = {
  name: "stub-react-devtools-core",
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: "react-devtools-core",
      namespace: "stub-empty",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub-empty" }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
};

await build({
  entryPoints: ["src/index.ts"],
  outfile: OUT_FILE,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",

  // 把所有依赖一起打进产物，方便直接拷贝到其它项目使用（不依赖 node_modules）
  packages: "bundle",

  // ink 仅在 process.env.DEV === "true" 时才动态加载 react-devtools-core。
  // 这里把该判断固定为 "false"，配合 minify 直接消除这段死代码。
  define: {
    "process.env.DEV": '"false"',
  },
  plugins: [stubReactDevtools],

  // 压缩 + 混淆：去空白、缩短局部变量名、语法压缩
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: "none",

  // 单文件产物，关闭 sourcemap 以避免泄露源码、削弱混淆效果
  sourcemap: false,

  // ESM 产物中为被打进来的 CJS 依赖提供 require / __dirname / __filename
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __createRequire } from 'node:module';",
      "import { fileURLToPath as __fileURLToPath } from 'node:url';",
      "import { dirname as __pathDirname } from 'node:path';",
      "const require = __createRequire(import.meta.url);",
      "const __filename = __fileURLToPath(import.meta.url);",
      "const __dirname = __pathDirname(__filename);",
    ].join("\n"),
  },
});

// 赋予可执行权限，便于作为 CLI 直接运行
chmodSync(OUT_FILE, 0o755);

console.log(`构建完成 -> ${OUT_FILE}`);
