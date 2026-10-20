import {build} from "esbuild";
import {cp, mkdir} from "node:fs/promises";

await build({entryPoints: ["./src/engine.js", "./src/popup.js"], tsconfigRaw: {}, bundle: true, format: "esm", platform: "browser", target: "chrome116", outdir: "extension", minify: true, legalComments: "eof"});
await mkdir("extension/vendor", {recursive: true});
await cp("LICENSE", "extension/LICENSE");
await cp("node_modules/@ffmpeg/core/dist/esm", "extension/vendor/core", {recursive: true});
await cp("node_modules/@ffmpeg/ffmpeg/dist/esm", "extension/vendor/ffmpeg", {recursive: true});
await cp("node_modules/youtubei.js/LICENSE", "extension/vendor/YouTube.js-LICENSE");
await cp("node_modules/fflate/LICENSE", "extension/vendor/fflate-LICENSE");
await cp("node_modules/meriyah/LICENSE.md", "extension/vendor/meriyah-LICENSE.md");
await cp("vendor/googlevideo-LICENSE", "extension/vendor/googlevideo-LICENSE");
await cp("vendor/protobuf-LICENSE", "extension/vendor/protobuf-LICENSE");
await cp("vendor/protobuf-varint-LICENSE", "extension/vendor/protobuf-varint-LICENSE");
console.log("Extensión lista en la carpeta extension. No requiere instalar un servicio");
