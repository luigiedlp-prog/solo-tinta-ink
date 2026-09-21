# Solo Tinta Ink — v1

Paquete de producción para subir a un repositorio y desplegar en Cloudflare Workers.

## Antes de desplegar
1. Crear una base D1 llamada `solo-tinta-ink`.
2. Crear un bucket R2 llamado `solo-tinta-ink`.
3. Reemplazar `REEMPLAZAR_CON_DATABASE_ID` en `wrangler.toml` por el ID real de D1.
4. Ejecutar `schema.sql` sobre la D1.
5. El PIN inicial es **3001**. Cambiarlo desde Gestión → Ajustes → Cambiar PIN apenas entre Feli.

## Despliegue
Con Wrangler instalado y autenticado:

```bash
wrangler d1 execute solo-tinta-ink --remote --file=./schema.sql
wrangler deploy
```

El Worker sirve también la web:
- `/` o `/reservar` → página pública
- `/gestion` → panel de Feli
- `/api/*` → API

## Importante
- No subir fotos reales al repositorio. Las imágenes se almacenan en R2.
- La dirección del estudio queda editable desde Gestión → Ajustes → Datos del estudio.
- El portfolio se carga desde Gestión y aparece automáticamente en la página pública.
