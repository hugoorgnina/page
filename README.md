# 💜 Ale y Hugo

Un "Discord" privado **solo para dos personas**. Funciona desde el navegador del celular (y también en PC), sin instalar nada y sin cuentas de Discord.

## Qué puede hacer

- 🧭 **Servers como en Discord**: crea un server con nombre y foto, y aparece en el **buscador** para que los demás se unan. Ponle **contraseña** si quieres que sea privado (solo entra quien la sepa).
- 📚 **Canales**: cada server tiene canales de **texto** (#general y los que cree el dueño) y de **voz**.
- 🎧 **Canales de voz grupales**: entra y sal cuando quieras; los demás se quedan dentro. Soporta a varios a la vez, cada uno con su cuadrito.
- 💬 **Chat de texto** con historial y 📷 **fotos** (galería o cámara del celular)
- 📞 **Llamadas tipo WhatsApp**: timbran con sonido y vibración, se aceptan o rechazan
- 🎥 **Cámara** que se prende y apaga sin cortar el micrófono
- 🖥️ **Compartir pantalla** (PC y varios Android; en iPhone el sistema no lo permite desde el navegador)
- 🖼️ **Foto de perfil** para cada uno
- 🔑 **Iniciar sesión con Google** (opcional; si no, con nombre y contraseña)
- 📱 Se puede **"instalar" como app**: en Chrome → menú ⋮ → *Agregar a pantalla de inicio*

Se pueden crear hasta **12 cuentas** (configurable con `MAX_USERS`); después de eso nadie más puede registrarse aunque tenga el enlace.

## Cómo publicarlo gratis (paso a paso, con Render)

Necesitas que esté en internet con **HTTPS** para que funcionen el micrófono y la cámara. La forma más fácil y gratis (ya viene el archivo `render.yaml` que configura todo solo):

1. Entra a [render.com](https://render.com) y crea una cuenta con el botón **GitHub** (así se conecta solo a tus repositorios).
2. Dale a **New → Blueprint**.
3. Elige este repositorio (`page`) y la rama `claude/discord-clone-two-user-cvr9q4`.
4. Dale a **Deploy** y espera 1-2 minutos. No hay que escribir nada: la configuración viene en `render.yaml`.
5. Render te da una dirección tipo `https://ale-y-hugo.onrender.com`. **Ese es tu Discord privado** 🎉
6. Ábrelo, crea tu cuenta (nombre + contraseña), y pásale el enlace a tu novia para que cree la suya.

Si el Blueprint no te aparece, la ruta manual también sirve: **New → Web Service** → eliges el repo y la rama → Build Command `npm install`, Start Command `npm start`, Instance Type `Free`.

> ⚠️ **Nota del plan gratis de Render**: si nadie usa la app por 15 minutos, el servidor "se duerme" y la primera visita tarda ~40 segundos en despertarlo. Además, cuando el servidor se reinicia, **el historial de chat y las fotos se borran** (la app vuelve a iniciar sesión sola, no tienes que hacer nada). Si más adelante quieren que el historial nunca se borre, se puede agregar un disco persistente en Render (de pago) apuntando la variable `DATA_DIR` al disco.

También funciona en Railway, Fly.io, Glitch o cualquier servidor con Node.js 18+.

## Cómo probarlo en tu compu

```bash
npm install
npm start
```

Y abre `http://localhost:3000`.

## Iniciar sesión con Google (opcional)

Si no lo configuras, no pasa nada: se entra con nombre y contraseña. Si lo quieres:

1. Ve a [console.cloud.google.com](https://console.cloud.google.com) → crea un proyecto.
2. **APIs y servicios → Pantalla de consentimiento OAuth** → tipo *Externo* → llena lo básico.
3. **Credenciales → Crear credenciales → ID de cliente de OAuth** → tipo *Aplicación web*.
4. En **Orígenes de JavaScript autorizados** pon tu dirección de Render (ej. `https://tu-app.onrender.com`).
5. Copia el **Client ID** y en Render ve a **Environment** y agrega la variable `GOOGLE_CLIENT_ID` con ese valor.

## Variables de entorno (todas opcionales)

| Variable | Para qué sirve | Por defecto |
|---|---|---|
| `PORT` | Puerto del servidor | `3000` |
| `MAX_USERS` | Cuántas cuentas se pueden crear | `12` |
| `INVITE_CODE` | Si lo pones, se necesita ese código para crear cuenta | (vacío) |
| `GOOGLE_CLIENT_ID` | Activa el botón "Iniciar con Google" | (vacío) |
| `DATA_DIR` | Carpeta donde se guardan mensajes y fotos | `./data` |
| `ICE_SERVERS` | JSON con servidores STUN/TURN propios para las llamadas | STUN de Google + TURN gratuito de Open Relay |

## Consejos

- **En iPhone** usa Safari; en Android usa Chrome. Ambos piden permiso de micrófono/cámara la primera vez.
- **Compartir pantalla** funciona en PC (Chrome, Edge, Firefox) y en Android con Chrome reciente. En iPhone, Apple no lo permite desde el navegador.
- Si la llamada conecta pero **no se escucha**, suele ser la red del celular bloqueando la conexión directa; ya viene configurado un servidor TURN gratuito de respaldo, pero si falla mucho pueden crear una cuenta gratis en [metered.ca](https://www.metered.ca/tools/openrelay/) y poner sus propios servidores en `ICE_SERVERS`.
- La sala de voz recuerda que estabas dentro: si se te cae el internet un momento, vuelve a entrar sola.
