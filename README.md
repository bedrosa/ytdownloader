# YouTube Local

Extensión para Chrome y Edge que descarga vídeos de YouTube desde el popup, con la resolución elegida y audio incluido. La descarga y la unión de pistas se realizan dentro del navegador.

No necesita CMD, Python, Node.js ni un servicio local para usarla. No utiliza servicios externos de descarga ni añade botones a YouTube.

## Instalación

1. Descarga `youtube-local.zip` desde [Releases](https://github.com/bedrosa/ytdownloader/releases) y descomprímelo. También puedes clonar este repositorio y utilizar su carpeta `extension`.
2. Abre `chrome://extensions` o `edge://extensions` y activa **Modo de desarrollador**.
3. Pulsa **Cargar descomprimida** y selecciona la carpeta que contiene `manifest.json`.
4. Fija **YouTube Local** en la barra del navegador.
5. Abre un vídeo de YouTube, pulsa el icono de la extensión y elige calidad y formato.
6. Pulsa **Descargar con audio**. El archivo se guarda en la carpeta de descargas configurada en el navegador.

Para actualizar, sustituye los archivos y pulsa la flecha circular de la ficha de **YouTube Local** en la página de extensiones. El pie del popup muestra la versión instalada.

## Funciones y límites

- Selección de resolución exacta, sin bajar la calidad automáticamente
- MP4 con pistas compatibles y MKV para combinar más códecs, sin recodificar
- Audio incluido en el archivo final
- Sin límite artificial de tamaño, aunque la unión utiliza memoria del navegador
- Uso exclusivo del popup, sin botones dentro de YouTube
- Una descarga a la vez, con opción de cancelar

La extensión recoge las peticiones del reproductor tanto desde la página como mediante los eventos del navegador. Solo conserva las últimas peticiones de pistas de YouTube en memoria. No exporta cookies ni solicita contraseñas.

Las respuestas de vídeo se transfieren entre la pestaña y el procesador por fragmentos, sin enviar una respuesta completa en un mensaje. El tamaño del fragmento no limita el tamaño total del archivo. La versión 2.1.5 corrige el error `Message exceeded maximum allowed size of 64MiB` que podía aparecer con respuestas grandes.

Si faltan datos recientes del vídeo, recarga automáticamente la pestaña una vez. Esa recarga puede reiniciar la posición de reproducción. Las validaciones, restricciones de cuenta o región y los cambios de YouTube pueden impedir descargar un vídeo. No admite directos en curso ni contenido con DRM.

## Durante una descarga

Puedes cerrar el popup y volver a abrirlo para consultar el progreso. Al cerrar la pestaña de YouTube se cancela el procesamiento pendiente. Si el archivo ya se está guardando mediante el gestor de descargas del navegador, ese guardado puede terminar.

Al terminar y cerrar el popup se liberan los trabajadores y el documento de procesamiento. El navegador suspende el proceso normal de eventos de la extensión cuando queda inactivo. Al salir del navegador se termina el procesamiento y se pierde el estado de la sesión.

## Solución de problemas

- **No aparece el vídeo:** abre su pestaña y vuelve a pulsar el icono de la extensión
- **Recargando YouTube:** espera a que obtenga las peticiones nuevas, hasta 30 segundos
- **No se reciben peticiones compatibles:** comprueba la reproducción y conserva el mensaje completo, que incluye el diagnóstico de captura
- **YouTube rechaza la validación:** la descarga se detiene sin cambiar la calidad elegida
- **No se puede unir el archivo:** prueba MKV o una calidad menor si falta memoria
- **Error después de actualizar:** comprueba la versión del popup y recarga la extensión desde su ficha

## Desarrollo

Se necesita Node.js 24 o posterior solo para desarrollar y compilar:

```sh
npm ci
npm test
npm run build
```

El código fuente está en `src` y en los archivos editables de `extension`: `background.js`, `capture.js`, `popup.html`, `popup.css` y `manifest.json`. La compilación genera `extension/engine.js`, `extension/popup.js` y copia las dependencias locales. La carpeta `extension` se versiona para permitir instalarla directamente.

Los cambios se preparan en una rama y se integran mediante pull request. La acción **CI** ejecuta las pruebas, compila, comprueba que los archivos generados están actualizados y guarda un ZIP instalable. Un tag `vX.Y.Z` que coincida con la versión del paquete y del manifiesto publica una release con el ZIP y su checksum SHA-256.

Las pruebas cubren selección de pistas, descarga por fragmentos, protocolo SABR, validación del reproductor, captura desde la página, cancelación y ciclo de vida del popup. No realizan descargas reales de YouTube en GitHub Actions.

## Protección de main

La configuración de protección está en `.github/main-protection.json`: exige pull request, el check **Validar extensión** y conversaciones resueltas. Bloquea el borrado y los force push, también para administradores. No exige la revisión de otra persona para permitir trabajar en solitario.

GitHub requiere un plan compatible, como GitHub Pro, para activar esta protección en repositorios privados. Con ese plan puede aplicarse mediante GitHub CLI:

```sh
gh api --method PUT repos/bedrosa/ytdownloader/branches/main/protection --input .github/main-protection.json
```

## Autor y licencias

Proyecto de [bedrosa](https://github.com/bedrosa), con licencia [MIT](LICENSE).

Las dependencias conservan sus autores y licencias originales. El núcleo WebAssembly de FFmpeg se distribuye sin modificar bajo GPL-2.0-or-later. Consulta [los componentes incluidos](extension/vendor/THIRD-PARTY.md) y [la procedencia del cliente SABR](vendor/README.md).
