import { build } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
const outDir = path.resolve(process.argv[2] || ".scratch/component-preview");
if (outDir === path.resolve("dist")) throw new Error("组件示例只能构建到隔离目录。");
await build({ configFile: false, plugins: [react()], build: { outDir, emptyOutDir: false, rollupOptions: { input: [path.resolve("index.html"), path.resolve("previews/components/index.html")] } } });
