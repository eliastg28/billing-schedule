# billing-schedule · Ciclo de Tarjetas

Aplicación web para gestionar los ciclos de facturación de tarjetas de crédito y saber qué tarjeta conviene usar cada día para tener más días de crédito sin intereses.

Esta rama (`feature/premium`) convierte la app en un servicio con cuentas y dos planes.

| | Gratis | Premium |
|---|---|---|
| Recomendador, simulador y calendario | Sí | Sí |
| Tarjetas | Hasta 2 | Ilimitadas |
| Avisos antes de cada pago y cierre | No | Sí |
| Notificaciones en el dispositivo y por correo | No | Sí |
| Proyección de pagos y cuotas | No | Sí |
| Precio | S/ 0 | S/ 7.90 al mes o S/ 59 al año |

Los límites se aplican en la interfaz **y en la base de datos**: nadie puede saltarlos editando el navegador.

---

## Probar en tu computadora

Necesitas [Node.js 22 o superior](https://nodejs.org). No hay que instalar dependencias.

```bash
node scripts/serve.mjs     # abre http://localhost:5173
npm test                   # pruebas automáticas
```

La app ya no se abre con doble clic en `index.html`: usa módulos de JavaScript, que el navegador solo carga desde un servidor.

### Modo de prueba

Mientras `js/config.js` no tenga los datos de Supabase, la app funciona en **modo local**:

- Los datos se guardan solo en el navegador.
- En **Cuenta** aparece un interruptor **Gratis / Premium** para probar el límite de tarjetas, los avisos, las notificaciones y la proyección de pagos sin cobrar nada.
- El interruptor desaparece cuando se conecta Supabase.

---

## Estructura

```
index.html              Estructura de la página
styles.css              Estilos (tema oscuro por defecto)
sw.js                   Service Worker: app instalable y uso sin conexión
manifest.webmanifest    Datos para instalar la app en el celular
js/
  app.js                Interfaz: vistas, formularios, planes y avisos
  engine.js             Cálculo de ciclos, avisos y cuotas (sin DOM)
  plan.js               Planes, precios y límites
  store.js              Datos: LocalStorage o Supabase
  backend.js            Sesión y cobros con Supabase
  notify.js             Notificaciones del navegador
  config.js             Configuración del servidor  ← se edita al desplegar
supabase/
  schema.sql            Tablas, seguridad (RLS) y límite de tarjetas
  auth-hooks.sql        Bloqueo de correos temporales al registrarse
  disposable-domains.sql Lista de dominios temporales (generada)
  email-templates/      Correos de acceso en español
  cron.sql              Envío diario de avisos por correo
  functions/
    _shared/engine.js   Copia exacta de js/engine.js (lo verifica un test)
    send-reminders/     Avisos por correo (solo Premium)
    create-checkout/    Crea la suscripción en Mercado Pago
    cancel-subscription/Cancela la suscripción
    mercadopago-webhook/Activa o desactiva Premium según Mercado Pago
tests/                  Pruebas (npm test)
scripts/serve.mjs       Servidor local sin dependencias
scripts/update-disposable-domains.mjs  Regenera la lista de dominios temporales
```

Si cambias `js/engine.js`, copia el archivo a `supabase/functions/_shared/engine.js`. El test `server.test.mjs` falla si las copias no son iguales.

---

## Llevarlo a producción

Necesitas cuentas en [Supabase](https://supabase.com), [Resend](https://resend.com) y [Mercado Pago](https://www.mercadopago.com.pe/developers), y la [CLI de Supabase](https://supabase.com/docs/guides/local-development/cli/getting-started).

### 1. Base de datos y cuentas (Supabase)

1. Crea un proyecto (región São Paulo es la más cercana a Perú).
2. En **SQL Editor**, pega `supabase/schema.sql` completo y ejecútalo.
3. En **Authentication > Sign In / Providers**, deja activo **Email** (enlace mágico). El botón de Google solo aparece en la app si activas **Google** con las credenciales de Google Cloud.
4. En **Authentication > URL Configuration**, pon la URL pública de la app en **Site URL** y en **Redirect URLs** (también `http://localhost:5173` para pruebas).
5. En **Settings > API Keys**, copia la URL del proyecto y la clave pública (anon o publishable).
6. **Correos temporales:** en el SQL Editor ejecuta `supabase/auth-hooks.sql` y luego `supabase/disposable-domains.sql`. Después, en **Authentication > Auth Hooks**, agrega un hook **Before User Created** de tipo Postgres con la función `public.hook_before_user_created`.
7. **Correos en español:** en **Authentication > Emails > Templates**, reemplaza **Confirm signup** con `supabase/email-templates/confirmar-cuenta.html` y **Magic Link** con `supabase/email-templates/enlace-de-acceso.html`. El asunto de cada uno está al inicio del archivo.

### 2. Conectar la app

Edita `js/config.js`:

```js
supabaseUrl: 'https://TU-PROYECTO.supabase.co',
supabaseAnonKey: 'TU-CLAVE-PUBLICA',
appUrl: 'https://TU-DOMINIO/',
```

La clave pública puede estar en el código: la seguridad la dan las políticas RLS. **Nunca** pongas la clave `service_role` en el navegador.

Mientras `paymentsEnabled` sea `false`, los planes se muestran como "Muy pronto" y nadie puede iniciar un pago. Cámbialo a `true` cuando termines el paso 5 y pruebes un cobro.

### 3. Correos (Resend)

1. Crea una cuenta y verifica tu dominio (para enviar desde `avisos@tu-dominio.com`).
2. Crea una API key.

### 4. Cobros (Mercado Pago)

1. En **Tus integraciones**, crea una aplicación de tipo suscripciones y copia el **Access Token**. Empieza con las credenciales de **prueba** y usuarios de prueba.
2. En **Webhooks**, configura la URL `https://TU-PROYECTO.supabase.co/functions/v1/mercadopago-webhook`, marca el evento **Planes y suscripciones** y copia la **clave secreta**.

### 5. Secretos y funciones

```bash
supabase login
supabase link --project-ref TU-PROYECTO

supabase secrets set \
  APP_URL=https://TU-DOMINIO/ \
  MP_ACCESS_TOKEN=... \
  MP_WEBHOOK_SECRET=... \
  RESEND_API_KEY=... \
  REMINDERS_FROM="Ciclo de Tarjetas <avisos@tu-dominio.com>" \
  REMINDERS_CRON_SECRET=un-texto-largo-y-aleatorio

supabase functions deploy create-checkout
supabase functions deploy cancel-subscription
supabase functions deploy send-reminders --no-verify-jwt
supabase functions deploy mercadopago-webhook --no-verify-jwt
```

`send-reminders` y `mercadopago-webhook` se despliegan sin verificación JWT porque las llaman el cron y Mercado Pago. Se protegen con su propio secreto y con la firma del webhook.

### 6. Avisos diarios

1. En **Database > Extensions**, activa `pg_cron` y `pg_net`.
2. Edita `supabase/cron.sql` con la URL del proyecto y el mismo `REMINDERS_CRON_SECRET`, y ejecútalo en el SQL Editor.

Los correos salen cada día a las 8:00 (hora de Lima).

### 7. Publicar

GitHub Pages sirve la rama `main`. Al unir esta rama con `main`, la versión publicada será la nueva. También puedes usar Cloudflare Pages, que permite repositorios privados gratis.

### 8. Antes de cobrar a clientes reales

- RUC y régimen tributario (consulta a un contador) para emitir comprobantes.
- Términos y condiciones, política de privacidad y cumplimiento de la Ley 29733 de protección de datos personales.
- Probar todo el flujo de pago con credenciales y usuarios de prueba de Mercado Pago.
- Cambiar a las credenciales de producción.

---

## Limitaciones conocidas

- **Notificaciones del dispositivo:** se muestran al abrir la app o volver a ella. Con la app cerrada, los avisos llegan por correo. Las notificaciones push en segundo plano y WhatsApp quedan para una siguiente etapa.
- **iPhone:** las notificaciones requieren instalar la app en la pantalla de inicio (iOS 16.4 o superior).
- **Fechas:** algunos bancos mueven el cierre o el pago en ciertos meses. La app es una guía: el estado de cuenta manda.
- **Mercado Pago:** la integración sigue la documentación oficial, pero debe probarse con credenciales de prueba antes de lanzar.
