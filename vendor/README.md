`googlevideo.js` contiene la librería GoogleVideo y el lector Protobuf que necesita, empaquetados como ES Modules para el navegador. No descarga ni ejecuta scripts de YouTube.

Fuente: https://github.com/LuanRT/googlevideo/tree/96d1418984d00ac2797a1dafe4625d1368b5b9aa

Exportaciones incluidas: `SabrStream`, `buildSabrFormat`, `VideoPlaybackAbrRequest`, `Logger`, `LogLevel` y `u8ToBase64`. Se generó con esbuild 0.25.12, `--bundle --platform=browser --format=esm --target=chrome116 --minify --legal-comments=eof`.

Se conservan las licencias de GoogleVideo (MIT) y de `@bufbuild/protobuf` 2.16.0 (Apache-2.0 y BSD-3-Clause). El compilador de la extensión incorpora este archivo local, sin depender de una CDN o de un servicio de descarga.
