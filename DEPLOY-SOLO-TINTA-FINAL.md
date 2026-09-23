# Solo Tinta Ink — versión final

## Arquitectura
- Cloudflare Worker
- Cloudflare D1
- Static Assets del propio Worker
- Sin almacenamiento de objetos externo

Las fotos del portfolio están incluidas en `public/portfolio/images/`.
Las referencias que adjunta un cliente se comprimen en el navegador y se guardan temporalmente en D1; Gestión puede abrirlas desde `/api/reference`.

## Puesta en marcha
1. Crear una D1 llamada `solo-tinta-ink`.
2. Reemplazar `database_id` en `wrangler.toml` por el ID de esa D1.
3. Ejecutar `schema.sql` sobre la D1 nueva.
4. El schema trae un PIN temporal `5837` para poder entrar por primera vez. Cambialo desde Gestión antes de entregar el acceso a Feli.
5. Ejecutar `wrangler deploy`.

## Rutas
- `/reservar` — web pública.
- `/gestion` — gestión protegida por PIN.
- `/api/*` — API.

## Flujo público
El cliente pide presupuesto y adjunta una imagen de referencia. No elige fecha ni hora. Feli responde por WhatsApp y carga manualmente el turno en Gestión.

## Portfolio
Las imágenes son fijas. Gestión solo edita sus descripciones.

## Importante
El ZIP no contiene credenciales personales ni una contraseña final de Feli. El PIN debe establecerse antes de producción.
