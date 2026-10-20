# YT Proyector

Aplicación de escritorio (Electron) que funciona como un navegador especializado en YouTube con **dos ventanas independientes**:

- **Panel de control** (privado): pegas enlaces, administras la cola y controlas la reproducción.
- **Pantalla de reproducción** (pública): solo muestra el video, sin barra de direcciones, lista, enlaces ni controles. Se puede mover a un monitor, televisor o proyector y poner a pantalla completa.

## Requisitos

- Windows 10/11 (también funciona en macOS/Linux para desarrollo).
- Node.js 20 o superior (solo para compilar o ejecutar desde el código fuente).
- Conexión a Internet (el video se reproduce con el reproductor oficial de YouTube).

## Instalar y ejecutar desde el código fuente

```bash
npm install
npm start
```

## Generar el ejecutable de Windows

En un equipo con Windows:

```bash
npm install
npm run dist
```

Se crean en la carpeta `dist/`:

- `YT Proyector Setup x.y.z.exe`: instalador.
- `YT-Proyector-portable-x.y.z.exe`: versión portátil, sin instalación.

Sin equipo Windows: sube el proyecto a GitHub y ejecuta el flujo **Compilar para Windows** (pestaña *Actions*, archivo `.github/workflows/build-windows.yml`). Los `.exe` quedan como artefacto descargable.

## Uso básico

1. Pega un enlace en la barra superior y pulsa **Agregar** (o Enter).
   - Video: se agrega a la cola.
   - Lista de reproducción: se abre una ventana para elegir *todos* o *algunos* videos y si se **agregan al final** o **reemplazan la cola** (pide confirmación).
   - Enlace con video y lista a la vez: pregunta cuál de los dos agregar.
2. En la pestaña **Pantalla** pulsa **Abrir** y luego **Pantalla completa**.
3. Doble clic (o ▶) sobre un video de la cola para reproducirlo. Arrastra los videos para reordenarlos.
4. Controla todo desde el panel: reproducir/pausar, anterior/siguiente, ±10 s, reiniciar, detener, volumen, silencio, repetición y reproducción automática.

### Enlaces aceptados

`youtube.com/watch?v=…`, `youtu.be/…`, `/shorts/…`, `/embed/…`, `/live/…`, `m.youtube.com`, `music.youtube.com`, `youtube-nocookie.com`, `…/playlist?list=…` y un ID de 11 caracteres. Cualquier otro dominio se rechaza.

### Atajos de teclado (configurables en la pestaña *Atajos*)

| Acción | Atajo |
|---|---|
| Pausar / reanudar | Espacio |
| Siguiente / anterior | → / ← |
| Agregar enlace | Ctrl + O |
| Guardar lista | Ctrl + S |
| Pantalla completa | F11 (en la pantalla de reproducción alterna su pantalla completa; Esc la cierra) |

Los atajos sin Ctrl/Alt no actúan mientras escribes en un campo de texto.

### Otras funciones

- **Listas guardadas**: guarda la cola, cárgala después (reemplazando o al final) o elige un video y continúa desde él.
- **Historial**: título, fecha y posición; clic para reproducir de nuevo.
- **Recuperación de sesión**: la cola, el video actual y su posición se guardan al cerrar. Activa *Retomar el video al iniciar* para continuar solo.
- **Modo presentación**: abre la pantalla en pantalla completa y deja de mostrar avisos en el panel salvo errores. En la pantalla externa nunca aparece nada administrativo.
- **Búsqueda y filtros**: por título y por estado (actual, pendientes, reproducidos, con error).
- **Indicadores**: estado del reproductor (cargando, reproduciendo, pausa, error), estado de la pantalla y conexión a Internet, con botón **Reintentar**.
- **Videos con error** (privados, con restricción de edad, no incrustables): se informa el motivo y, con la reproducción automática activa, pasa al siguiente.

## Conectar un monitor o televisor por HDMI

1. Conecta el cable HDMI y enciende el televisor/monitor en la entrada correcta.
2. En Windows pulsa **Win + P** y elige **Extender** (con *Duplicar* ambas ventanas se verían en las dos pantallas y el público vería el panel).
3. En la aplicación, pestaña **Pantalla**, pulsa **Detectar pantallas**, selecciona la pantalla del televisor y pulsa **Abrir**. Se abre en pantalla completa si marcaste esa opción; si no, usa **Pantalla completa**.
4. El panel de control queda en la pantalla principal. Si desconectas el cable, la ventana de reproducción vuelve a la pantalla disponible y se avisa en el panel.

Con una sola pantalla, ambas ventanas funcionan normalmente (la de reproducción se abre en ventana; F11 la pone a pantalla completa y Esc sale).

## Usar una pantalla inalámbrica (Miracast)

La aplicación no implementa ningún protocolo inalámbrico: usa la proyección de Windows.

1. Pulsa **Win + K** (Transmitir) y elige tu TV o adaptador compatible con Miracast. Si no aparece, enciende la función en el televisor.
2. Pulsa **Win + P** y elige **Extender**.
3. Continúa como en HDMI: **Detectar pantallas** → seleccionar → **Abrir**.

La latencia inalámbrica puede afectar la imagen o el sonido según el equipo. Para mejor calidad se recomienda HDMI.

## Dependencias y credenciales

- **Dependencias de ejecución**: ninguna adicional; solo Electron (incluido en el ejecutable).
- **Dependencias de desarrollo**: `electron` y `electron-builder`.
- **Reproducción**: usa el reproductor oficial incrustado (YouTube IFrame Player API). No requiere clave. No se descarga, extrae ni guarda ningún archivo de video.
- **Metadatos**: el título de un video se obtiene del servicio público oEmbed de YouTube; las miniaturas, de `i.ytimg.com`.
- **Listas de reproducción**: sin clave se leen de la página pública de la lista (aprox. los primeros 100 videos) o, como respaldo, del RSS público (15 videos). **Opcional**: una clave de la *YouTube Data API v3* (se crea gratis en Google Cloud Console) permite listas largas y duraciones. Está sujeta a cuotas y condiciones de uso de Google. Se guarda localmente, solo la usa el proceso principal y nunca se envía a las ventanas. La reproducción no depende de ella.
- No se pueden importar mezclas automáticas (`RD…`), «Ver más tarde» ni «Me gusta».

## Seguridad

- Ventanas con `contextIsolation`, `sandbox` y sin `nodeIntegration`; comunicación solo por IPC validado.
- Los enlaces se validan (solo dominios de YouTube) y se convierten a identificadores; nunca se navega a la URL pegada.
- La pantalla de reproducción bloquea navegación y ventanas nuevas, y una capa transparente impide que el público haga clic en el reproductor.
- La pantalla se sirve desde `127.0.0.1` (solo 3 archivos) porque YouTube rechaza reproductores incrustados desde `file://`.

## Datos locales

Cola, listas, historial y ajustes se guardan en `data.json` dentro de la carpeta de datos de la aplicación (`%APPDATA%\yt-proyector`).

## Pruebas

```bash
npm test
```

28 pruebas automatizadas simulan el panel de control y la pantalla de reproducción contra el estado centralizado: sincronización de pausa, volumen, saltos, cambio de video, siguiente automático, repetición, errores y omisión, reapertura de la pantalla sin perder la lista, recuperación de sesión y validación de enlaces.

### Lista de comprobación manual (pruebas de aceptación)

1. Pegar un enlace → Agregar → Abrir pantalla → el video se ve en la segunda ventana.
2. Agregar una lista pública → elegir algunos videos → quedan en la cola; probar *Reemplazar* (pide confirmación).
3. Mover la ventana de reproducción a otro monitor y pulsar **Pantalla completa**.
4. Con el video en curso, reordenar/quitar videos y usar los controles: la pantalla externa responde de inmediato.
5. Dejar terminar un video con la reproducción automática activa y luego desactivada.
6. Cerrar la ventana de reproducción con la X y pulsar **Abrir**: continúa en el mismo punto y la lista sigue intacta.
7. Cerrar y abrir la aplicación: la cola se conserva.
8. Agregar un video privado: aparece un mensaje claro y pasa al siguiente.
9. Quitar la conexión a Internet: aparece el aviso y **Reintentar** vuelve a cargar.

## Estructura

```
src/
  main/      main.js (ventanas, IPC, pantallas), playback.js (estado centralizado),
             youtube.js (metadatos/listas), store.js (persistencia), preloads
  control/   Panel de control (HTML/CSS/JS)
  display/   Pantalla de reproducción (IFrame API)
  shared/    Validación de enlaces
tests/       Pruebas automatizadas
```
