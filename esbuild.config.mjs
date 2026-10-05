import esbuild from "esbuild";
import process from "process";
import fs from "node:fs";
import path from "node:path";
import { builtinModules as builtins } from "node:module";

// Load .env (for PATHS_TEST_INSTALL) if present. Node 20.12+/22+ built-in.
try {
    process.loadEnvFile();
} catch {
    /* no .env — fine */
}

const prod = process.argv[2] === "production";

// PATHS_TEST_INSTALL: copy built files into your Obsidian vault plugin folder(s)
// for local testing. Separate multiple paths with the system path delimiter.
const installPaths = (process.env?.PATHS_TEST_INSTALL || "")
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);

const copyToInstallPaths = {
    name: "copy-to-install-paths",
    setup(build) {
        build.onEnd(() => {
            if (!installPaths.length) return;
            const files = ["main.js", "manifest.json", "styles.css"];
            for (const dir of installPaths) {
                fs.mkdirSync(dir, { recursive: true });
                for (const f of files) {
                    if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, f));
                }
            }
            console.log(`Copied build to: ${installPaths.join(", ")}`);
        });
    },
};

const ctx = await esbuild.context({
    entryPoints: ["src/main.ts"],
    bundle: true,
    format: "cjs",
    target: "es2018",
    jsx: "automatic",
    external: ["obsidian", "electron", "@codemirror/*", ...builtins],
    define: { global: "window" },
    sourcemap: prod ? false : "inline",
    treeShaking: true,
    minify: prod,
    outfile: "main.js",
    logLevel: "info",
    plugins: [copyToInstallPaths],
});

if (prod) {
    await ctx.rebuild();
    process.exit(0);
} else {
    await ctx.watch();
    console.log("watching...");
}
