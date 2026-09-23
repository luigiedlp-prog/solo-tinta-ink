# Solo Tinta Ink — versión final (build 2026-09-23-FINAL5)

## Arquitectura
- Cloudflare Worker + Cloudflare D1 + Static Assets del propio Worker
- Sin R2 ni almacenamiento de objetos: la referencia del cliente es un **link** (opcional)
- Fotos del portfolio: las 11 originales están en `photos.js`; desde Gestión > Portfolio se pueden agregar, cambiar y borrar fotos (se guardan en D1). Todo se sirve por `/api/photo/<id>`

## Puesta en marcha
1. Crear una D1 llamada `solo-tinta-ink` y poner su ID en `database_id` de `wrangler.toml`.
2. Subir a GitHub / `wrangler deploy`.
3. Abrir `https://TU-DOMINIO/api/health`: debe decir `"db":"ok"`. Las tablas se crean solas la primera vez (no hace falta correr schema.sql a mano).
4. Entrar a `/gestion` con el PIN temporal `5837` y cambiarlo en Ajustes > Cambiar PIN.

## Diagnóstico
- `/api/health` muestra la versión (`build`) y el estado de la base (`db` y `detail`).
- Si `/gestion` falla al entrar, ahora el mensaje incluye el detalle del error.

## Rutas
`/reservar` pública · `/gestion` con PIN · `/api/*` API
