# Solo Tinta Ink — v1 corregido

Paquete de producción para Cloudflare Workers + D1 + R2.

## Qué fue corregido en esta versión

- D1: se mantiene `database_id` como marcador porque debe ser el ID real de la D1 que crees en tu cuenta.
- Stock: la página de Gestión ahora envía `quantity`, que es el campo que espera la API.
- Finanzas: corregida la validación del formato `YYYY-MM`.
- Agenda: los locks diarios abandonados se limpian automáticamente después de 2 minutos para evitar bloqueos permanentes tras una caída.
- Se conserva la regla de agenda: importa que el turno empiece dentro del horario; el servicio puede terminar después del cierre.
- Los horarios pasados del día actual no se muestran/reservan.
- Los turnos no se pueden solapar teniendo en cuenta la duración del servicio.

## IMPORTANTE: instalación desde cero

Si la D1 anterior fue eliminada, hay que crear una D1 nueva. El ZIP no puede contener un `database_id` real porque ese ID lo genera Cloudflare para cada base.

### 1. Crear la D1

Desde la carpeta del proyecto, con Wrangler autenticado:

```bash
npx wrangler login
npx wrangler d1 create solo-tinta-ink
```

Cloudflare mostrará una configuración parecida a:

```toml
[[d1_databases]]
binding = "DB"
database_name = "solo-tinta-ink"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copiá solamente el `database_id` real y reemplazá en `wrangler.toml`:

```toml
database_id = "REEMPLAZAR_CON_DATABASE_ID"
```

por:

```toml
database_id = "EL-ID-REAL-DE-CLOUDFLARE"
```

No cambies `binding = "DB"` ni `database_name = "solo-tinta-ink"`.

### 2. Crear el bucket R2

```bash
npx wrangler r2 bucket create solo-tinta-ink
```

Si Cloudflare responde que el bucket ya existe, NO lo borres: significa que todavía podés reutilizarlo.

### 3. Inicializar la D1 remota

Desde la carpeta donde están `schema.sql` y `wrangler.toml`:

```bash
npx wrangler d1 execute solo-tinta-ink --remote --file=./schema.sql
```

Confirmá cuando Wrangler lo solicite.

### 4. Verificar la D1

Podés comprobar que la base responde con:

```bash
npx wrangler d1 execute solo-tinta-ink --remote --command="SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"
```

### 5. Probar el proyecto antes del deploy (opcional)

```bash
npx wrangler dev
```

### 6. Deploy

```bash
npx wrangler deploy
```

## Si lo vas a desplegar desde GitHub + Cloudflare

1. Subí este proyecto al repositorio.
2. Asegurate de que `wrangler.toml` ya tenga el `database_id` real.
3. En Cloudflare Workers & Pages, conectá el repositorio.
4. Usá como comando de deploy:

```bash
npx wrangler deploy
```

5. El directorio raíz debe ser el directorio donde están `worker.js` y `wrangler.toml`.
6. No hace falta un comando de build para este proyecto.

## Recursos que espera el proyecto

Deben existir con estos nombres:

- D1: `solo-tinta-ink`
- R2: `solo-tinta-ink`
- Worker: `solo-tinta-ink`

Bindings:

- `DB` → D1 `solo-tinta-ink`
- `R2` → R2 `solo-tinta-ink`
- `ASSETS` → `./public`

## Después del primer acceso

El PIN inicial es:

```text
3001
```

Entrá a Gestión y cambialo inmediatamente.

## URLs del Worker

- `/` → página pública
- `/reservar` → página pública
- `/gestion` → panel de Gestión
- `/api/*` → API

## Fotos

Las fotos dinámicas del portfolio se almacenan en R2. No hace falta hacer público el bucket: el Worker las sirve mediante sus endpoints.

## Nota sobre datos anteriores

Si la D1 anterior fue eliminada, los datos anteriores (clientes, turnos, historial, stock, etc.) no están dentro de este ZIP. `schema.sql` reconstruye la estructura y los datos iniciales de la aplicación, no una copia de los datos de producción.
