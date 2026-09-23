// Solo Tinta Ink — Cloudflare Worker v1
// Backend propio: D1 + Assets estáticos.
// No incluye promociones, catálogo público de precios ni lógica de seña.
// IMPORTANTE: reemplazar el PIN inicial en producción mediante /api/admin/settings/pin.

const PORTFOLIO_ITEMS = [
  {
    "id": "tortuga",
    "image_url": "/api/photo/tortuga",
    "description": "Tortuga en línea fina."
  },
  {
    "id": "lineas",
    "image_url": "/api/photo/lineas",
    "description": "Diseño de líneas finas."
  },
  {
    "id": "media-manga",
    "image_url": "/api/photo/media-manga",
    "description": "Media manga."
  },
  {
    "id": "enzo-fernandez",
    "image_url": "/api/photo/enzo-fernandez",
    "description": "Retrato de Enzo Fernández."
  },
  {
    "id": "angel",
    "image_url": "/api/photo/angel",
    "description": "Ángel en black & grey."
  },
  {
    "id": "ojo",
    "image_url": "/api/photo/ojo",
    "description": "Diseño de ojo en realismo."
  },
  {
    "id": "douglas-haig",
    "image_url": "/api/photo/douglas-haig",
    "description": "Escudo de Douglas Haig."
  },
  {
    "id": "tigre-microrealismo",
    "image_url": "/api/photo/tigre-microrealismo",
    "description": "Tigre en microrealismo."
  },
  {
    "id": "microrealismo",
    "image_url": "/api/photo/microrealismo",
    "description": "Diseño de microrealismo."
  },
  {
    "id": "aguila",
    "image_url": "/api/photo/aguila",
    "description": "Águila en realismo."
  },
  {
    "id": "manga-completa",
    "image_url": "/api/photo/manga-completa",
    "description": "Manga completa."
  }
];

import PHOTOS from "./photos.js";

const SESSION_DAYS = 30;
const BUILD = "2026-09-23-FINAL6";

const MAX_NOTE_LENGTH = 2000;

const DEFAULT_SCHEDULE = {
  0: [],
  1: [["09:30","21:30"]],
  2: [["09:30","21:30"]],
  3: [["09:30","21:30"]],
  4: [["09:30","21:30"]],
  5: [["09:30","21:30"]],
  6: [["09:30","21:30"]]
};

function json(status, data, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra
    }
  });
}

function uid(prefix = "id") {
  return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(String(value));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function cleanWA(v) {
  return String(v ?? "").replace(/\D/g, "");
}

function validWA(v) {
  const x = cleanWA(v);
  return x.length >= 10 && x.length <= 15;
}

function minutes(hhmm) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(hhmm));
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

function hhmm(total) {
  const m = ((Number(total) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2,"0")}:${String(m % 60).padStart(2,"0")}`;
}

function validDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v));
}

function validTime(v) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(v));
}

function todayAR() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Argentina/Buenos_Aires"
  }).format(new Date());
}

function nowARMinutes() {
  const p = new Intl.DateTimeFormat("en-GB", {
    timeZone: "America/Argentina/Buenos_Aires",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(new Date());
  return Number(p.find(x => x.type === "hour")?.value || 0) * 60 +
         Number(p.find(x => x.type === "minute")?.value || 0);
}

function dateDiff(a, b) {
  const A = Date.parse(`${a}T00:00:00Z`);
  const B = Date.parse(`${b}T00:00:00Z`);
  return Math.round((A - B) / 86400000);
}

function normalizeDuration(value) {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  const s = String(value ?? "").trim();
  if (/^\d+$/.test(s)) return Number(s);
  const m = /^(\d{1,2}):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
}

async function getSettings(db) {
  const row = await db.prepare("SELECT * FROM settings WHERE id=1").first();
  if (!row) throw new Error("Settings not initialized");
  let schedule = DEFAULT_SCHEDULE;
  try { schedule = JSON.parse(row.schedule_json || "") || DEFAULT_SCHEDULE; } catch {}
  return {...row, schedule};
}

function scheduleFor(settings, date) {
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  return settings.schedule?.[day] || [];
}

// Regla del producto: el turno debe EMPEZAR dentro del horario.
// Puede terminar después del cierre.
function startAllowed(settings, date, time) {
  if (!validDate(date) || !validTime(time)) return false;
  const day = new Date(`${date}T12:00:00Z`).getUTCDay();
  const ranges = settings.schedule?.[day] || [];
  const t = minutes(time);

  if (date === todayAR() && t < nowARMinutes()) return false;

  return ranges.some(([start, end]) => t >= minutes(start) && t <= minutes(end));
}

async function dayIsBlocked(db, date) {
  return !!await db.prepare("SELECT date FROM day_blocks WHERE date=?").bind(date).first();
}

async function hasOverlap(db, date, time, duration, excludeId = null) {
  const start = minutes(time);
  const end = start + duration;
  if (!Number.isInteger(start) || !Number.isInteger(duration) || duration <= 0) return true;

  const rows = await db.prepare(`
    SELECT id, start_time, duration_minutes
    FROM appointments
    WHERE date=?
      AND status IN ('scheduled','another_session')
      ${excludeId ? "AND id<>?" : ""}
  `).bind(...(excludeId ? [date, excludeId] : [date])).all();

  return (rows.results || []).some(a => {
    const aStart = minutes(String(a.start_time).slice(0,5));
    const aEnd = aStart + Number(a.duration_minutes);
    return aStart < end && aEnd > start;
  });
}

async function canSchedule(db, settings, date, time, duration, excludeId = null) {
  if (!startAllowed(settings, date, time)) {
    return {ok:false, error:"El horario de inicio está fuera del horario de atención."};
  }
  if (await dayIsBlocked(db, date)) {
    return {ok:false, error:"La agenda está llena para ese día."};
  }
  if (await hasOverlap(db, date, time, duration, excludeId)) {
    return {ok:false, error:"Ese horario ya está ocupado."};
  }
  return {ok:true};
}

async function sessionHashFromRequest(request, db) {
  const cookie = request.headers.get("cookie") || "";
  const m = /st_session=([^;]+)/.exec(cookie);
  if (!m) return null;
  const tokenHash = await sha256(m[1]);
  const row = await db.prepare(`
    SELECT token_hash FROM auth_sessions
    WHERE token_hash=? AND expires_at > CURRENT_TIMESTAMP
  `).bind(tokenHash).first();
  return row ? tokenHash : null;
}

async function isAdmin(request, db) {
  return !!await sessionHashFromRequest(request, db);
}

function sessionCookie(token, maxAge) {
  return `st_session=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

async function adminLogin(request, db, body) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // Registrar el intento ANTES de contar: si se cuenta primero y se inserta
  // después, una ráfaga de pedidos simultáneos puede leer el conteo viejo
  // (todavía sin los inserts de los demás) y esquivar el límite entre todos.
  await db.prepare("INSERT INTO auth_attempts(ip) VALUES(?)").bind(ip).run();

  const recent = await db.prepare(`
    SELECT COUNT(*) AS n FROM auth_attempts
    WHERE ip=? AND created_at > datetime('now','-15 minutes')
  `).bind(ip).first();

  if (Number(recent?.n || 0) > 20) {
    return json(429, {error:"Demasiados intentos. Esperá unos minutos."});
  }

  const settings = await getSettings(db);
  const supplied = String(body.pin || "");
  const hash = await sha256(supplied);

  if (hash !== settings.pin_hash) {
    return json(401, {error:"PIN incorrecto"});
  }

  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
  const tokenHash = await sha256(token);
  await db.prepare(`
    INSERT INTO auth_sessions(token_hash, expires_at)
    VALUES(?, datetime('now', '+${SESSION_DAYS} days'))
  `).bind(tokenHash).run();

  return json(200, {ok:true}, {
    "set-cookie": sessionCookie(token, SESSION_DAYS * 86400)
  });
}

async function parseJSON(request) {
  try { return await request.json(); }
  catch { return {}; }
}

async function upsertClient(db, name, whatsapp) {
  const wa = cleanWA(whatsapp);
  const trimmedName = String(name || "").trim();

  // INSERT atómico: si dos solicitudes llegan casi al mismo tiempo con el mismo
  // WhatsApp nuevo (ej. doble toque en "Pedir presupuesto"), sólo una crea el
  // cliente y la otra no falla, simplemente no hace nada (evita el error por
  // violar la restricción UNIQUE de whatsapp).
  await db.prepare(
    "INSERT INTO clients(id,name,whatsapp) VALUES(?,?,?) ON CONFLICT(whatsapp) DO NOTHING"
  ).bind(uid("cli"), trimmedName, wa).run();

  let c = await db.prepare("SELECT * FROM clients WHERE whatsapp=?").bind(wa).first();

  if (trimmedName && trimmedName !== c.name) {
    await db.prepare("UPDATE clients SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(trimmedName, c.id).run();
    c = {...c, name:trimmedName};
  }
  return c;
}

async function createNotification(db, type, title, body, targetId = null) {
  const id = uid("n");
  await db.prepare(`
    INSERT INTO notifications(id,type,title,body,target_id)
    VALUES(?,?,?,?,?)
  `).bind(id,type,title,body,targetId).run();
}

async function createQuote(request, db) {
  const contentType = request.headers.get("content-type") || "";
  let data = {};

  if (contentType.includes("application/json")) {
    data = await parseJSON(request);
  } else if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    data = Object.fromEntries(form.entries());
  } else {
    return json(400, {error:"Enviá los datos como JSON o formulario."});
  }

  const name = String(data.name || "").trim();
  const whatsapp = cleanWA(data.whatsapp);
  const description = String(data.description || "").trim();
  const bodyArea = String(data.body_area || "").trim();
  const size = String(data.size || "").trim();
  const referenceLink = String(data.reference_link || "").trim();

  if (!name || name.length > 120 || !validWA(whatsapp) || !description || description.length > 3000) {
    return json(400, {error:"Completá nombre, WhatsApp y descripción correctamente."});
  }

  let referenceValue = null;
  if (referenceLink) {
    let u = null;
    try { u = new URL(/^https?:\/\//i.test(referenceLink) ? referenceLink : "https://" + referenceLink); } catch {}
    if (!u || referenceLink.length > 500 || !["http:","https:"].includes(u.protocol) || !u.hostname.includes(".")) {
      return json(400,{error:"El link de referencia no es válido."});
    }
    referenceValue = u.toString();
  }

  const client = await upsertClient(db, name, whatsapp);
  const id = uid("q");
  await db.prepare(`
    INSERT INTO quotes(
      id,client_id,description,body_area,size,reference_data,status
    ) VALUES(?,?,?,?,?,?, 'pending_quote')
  `).bind(id,client.id,description,bodyArea,size,referenceValue).run();

  await createNotification(
    db,
    "new_quote",
    "Nueva solicitud de presupuesto",
    `Nueva solicitud de presupuesto — ${client.name}`,
    id
  );

  return json(201, {ok:true, quoteId:id});
}

const PORTFOLIO_IDS = new Set(PORTFOLIO_ITEMS.map(x => x.id));
const MAX_PORTFOLIO = 30;

// Fotos originales (photos.js) + fotos agregadas o reemplazadas desde Gestión (D1).
async function getPortfolio(db) {
  let rows = [];
  try {
    rows = (await db.prepare(`
      SELECT id, description, COALESCE(deleted,0) AS deleted,
             CASE WHEN image_data IS NOT NULL THEN 1 ELSE 0 END AS has_data,
             created_at, updated_at
      FROM portfolio
    `).all()).results || [];
  } catch {}
  const byId = new Map(rows.map(r => [r.id, r]));
  const ver = r => "?v=" + String(r?.updated_at || "").replace(/\D/g, "");
  const custom = rows
    .filter(r => !PORTFOLIO_IDS.has(r.id) && !r.deleted && r.has_data)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .map(r => ({id: r.id, image_url: "/api/photo/" + r.id + ver(r), description: r.description || "", custom: true}));
  const builtin = PORTFOLIO_ITEMS
    .filter(x => !byId.get(x.id)?.deleted)
    .map(x => {
      const r = byId.get(x.id);
      return {...x, image_url: "/api/photo/" + x.id + (r?.has_data ? ver(r) : ""), description: r ? (r.description || "") : (x.description || "")};
    });
  return [...custom, ...builtin];
}

async function adminData(db, request) {
  const [settings, quotes, appointments, clients, stock, notifications, followups, dayBlocks, portfolio] =
    await Promise.all([
      getSettings(db),
      db.prepare(`
        SELECT q.id,q.client_id,q.description,q.body_area,q.size,
               CASE WHEN q.reference_data IS NOT NULL THEN 1 ELSE 0 END AS has_reference,
               q.status,q.price,q.duration_minutes,q.quoted_at,q.discarded_at,q.created_at,q.updated_at,
               c.name,c.whatsapp
        FROM quotes q JOIN clients c ON c.id=q.client_id
        ORDER BY q.created_at DESC
      `).all(),
      db.prepare(`
        SELECT a.*, c.name, c.whatsapp
        FROM appointments a JOIN clients c ON c.id=a.client_id
        ORDER BY a.date, a.start_time
      `).all(),
      db.prepare("SELECT * FROM clients ORDER BY name").all(),
      db.prepare("SELECT * FROM stock_items ORDER BY name").all(),
      db.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100").all(),
      db.prepare(`
        SELECT f.*, c.name
        FROM followups f JOIN clients c ON c.id=f.client_id
        ORDER BY f.created_at DESC LIMIT 200
      `).all(),
      db.prepare("SELECT * FROM day_blocks ORDER BY date").all(),
      getPortfolio(db)
    ]);

  return {
    settings: {
      studio_name:settings.studio_name,
      artist_name:settings.artist_name,
      description:settings.description,
      address:settings.address,
      maps_url:settings.maps_url,
      instagram:settings.instagram,
      safety_info:settings.safety_info,
      contact_info:settings.contact_info,
      schedule:settings.schedule
    },
    quotes:quotes.results || [],
    appointments:appointments.results || [],
    clients:clients.results || [],
    stock:stock.results || [],
    notifications:notifications.results || [],
    followups:followups.results || [],
    day_blocks:dayBlocks.results || [],
    portfolio,
    today:todayAR()
  };
}

async function acquireDayLock(db, date) {
  // Limpia locks abandonados por una caída o interrupción anterior.
  await db.prepare("DELETE FROM schedule_locks WHERE created_at < datetime('now', '-2 minutes')").run();
  const token = uid("lock");
  const r = await db.prepare(
    "INSERT OR IGNORE INTO schedule_locks(date,token) VALUES(?,?)"
  ).bind(date, token).run();
  return Number(r?.meta?.changes || 0) === 1 ? token : null;
}

async function releaseDayLock(db, date, token) {
  if (!token) return;
  await db.prepare("DELETE FROM schedule_locks WHERE date=? AND token=?")
    .bind(date, token).run();
}

async function scheduleAppointment(db, body, quoteId = null) {
  const clientId = String(body.client_id || "");
  const date = String(body.date || "");
  const startTime = String(body.start_time || "");
  const duration = normalizeDuration(body.duration_minutes ?? body.duration);
  const price = Number(body.price);

  if (!clientId || !validDate(date) || !validTime(startTime) ||
      !Number.isInteger(duration) || duration <= 0 || duration > 24*60 ||
      !Number.isInteger(price) || price < 0) {
    return {status:400,data:{error:"Datos del turno inválidos."}};
  }

  const lock = await acquireDayLock(db, date);
  if (!lock) {
    return {status:409,data:{error:"La agenda está siendo actualizada. Probá de nuevo en un segundo."}};
  }

  try {
    const settings = await getSettings(db);
    const check = await canSchedule(db,settings,date,startTime,duration);
    if (!check.ok) return {status:409,data:{error:check.error}};

    const id = uid("apt");

    await db.prepare(`
      INSERT INTO appointments(
        id,client_id,quote_id,date,start_time,duration_minutes,price,status
      ) VALUES(?,?,?,?,?,?,?,'scheduled')
    `).bind(id,clientId,quoteId,date,startTime,duration,price).run();

    if (quoteId) {
      await db.prepare(`
        UPDATE quotes
        SET status='scheduled', updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).bind(quoteId).run();
    }

    await createNotification(
      db,
      "appointment_scheduled",
      "Nuevo turno agendado",
      `Se agendó un nuevo turno para ${date} a las ${startTime}.`,
      id
    );

    return {status:201,data:{ok:true,id}};
  } finally {
    await releaseDayLock(db, date, lock);
  }
}

async function markCompleted(db, body) {
  const id = String(body.id || "");
  const a = await db.prepare("SELECT * FROM appointments WHERE id=?").bind(id).first();
  if (!a || a.status !== "scheduled") return {status:400,data:{error:"Turno no encontrado o ya modificado."}};

  const payment = ["cash","transfer"].includes(body.payment_method) ? body.payment_method : null;
  if (!payment) return {status:400,data:{error:"Elegí Efectivo o Transferencia."}};

  const guard = await db.prepare(`
    UPDATE appointments
    SET status='completed', payment_method=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='scheduled'
  `).bind(payment,id).run();

  if (Number(guard?.meta?.changes || 0) !== 1) {
    return {status:409,data:{error:"Ese turno ya fue modificado."}};
  }

  await db.prepare(`
    INSERT INTO history_events(id,client_id,appointment_id,event_type,payload_json)
    VALUES(?,?,?,?,?)
  `).bind(uid("hist"),a.client_id,id,"appointment_completed",
    JSON.stringify({payment_method:payment,price:a.price})).run();

  return {status:200,data:{ok:true}};
}

async function cancelAppointment(db, body) {
  const id = String(body.id || "");
  const a = await db.prepare("SELECT * FROM appointments WHERE id=?").bind(id).first();
  if (!a || a.status !== "scheduled") return {status:400,data:{error:"Turno no encontrado o ya modificado."}};

  await db.prepare(`
    UPDATE appointments
    SET status='cancelled', updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND status='scheduled'
  `).bind(id).run();

  await createNotification(
    db,
    "appointment_cancelled",
    "Turno cancelado",
    `Se canceló el turno de ${a.date} a las ${String(a.start_time).slice(0,5)}.`,
    id
  );

  await db.prepare(`
    INSERT INTO history_events(id,client_id,appointment_id,event_type,payload_json)
    VALUES(?,?,?,?,?)
  `).bind(uid("hist"),a.client_id,id,"appointment_cancelled",
    JSON.stringify({date:a.date,time:String(a.start_time).slice(0,5)})).run();

  return {status:200,data:{ok:true}};
}

async function getReference(db, request, id) {
  if (!(await isAdmin(request, db))) return json(401,{error:"No autorizado"});
  const q = await db.prepare("SELECT reference_data FROM quotes WHERE id=?").bind(id).first();
  if (!q?.reference_data) return new Response("Imagen no encontrada",{status:404});
  if (/^https?:\/\//i.test(q.reference_data)) return Response.redirect(q.reference_data, 302);
  const m = /^data:(image\/(?:webp|jpeg|png));base64,([A-Za-z0-9+/=]+)$/i.exec(q.reference_data);
  if (!m) return new Response("Imagen no encontrada",{status:404});
  const binary = atob(m[2]);
  const bytes = new Uint8Array(binary.length);
  for (let i=0;i<binary.length;i++) bytes[i]=binary.charCodeAt(i);
  return new Response(bytes,{headers:{
    "content-type":m[1].toLowerCase(),
    "cache-control":"private, no-store",
    "content-disposition":"inline"
  }});
}

async function cleanupReferenceData(db) {
  // Solo limpia imágenes viejas guardadas como data: (los links son livianos y se conservan).
  const rows = await db.prepare(`
    SELECT q.id,a.date AS appointment_date,q.quoted_at,q.created_at
    FROM quotes q
    LEFT JOIN appointments a ON a.quote_id=q.id
    WHERE q.reference_data LIKE 'data:%'
  `).all();
  const now=Date.now();
  for (const q of rows.results || []) {
    const base=q.appointment_date
      ? Date.parse(`${q.appointment_date}T00:00:00-03:00`)
      : Date.parse(String(q.quoted_at || q.created_at).replace(" ","T")+"Z");
    if (Number.isFinite(base) && now >= base + 14*86400000) {
      await db.prepare("UPDATE quotes SET reference_data=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .bind(q.id).run();
    }
  }
  await db.prepare("DELETE FROM auth_sessions WHERE expires_at < CURRENT_TIMESTAMP").run();
  await db.prepare("DELETE FROM auth_attempts WHERE created_at < datetime('now','-1 day')").run();
}

async function sendDueReminderNotifications(db) {
  // En v1 almacenamos el aviso. La entrega push real requiere configurar
  // VAPID/Web Push; el endpoint de suscripción ya queda preparado.
  const rows = await db.prepare(`
    SELECT a.id,a.date,a.start_time,c.name
    FROM appointments a
    JOIN clients c ON c.id=a.client_id
    WHERE a.status='scheduled'
      AND datetime(a.date || ' ' || a.start_time, '+3 hours') BETWEEN datetime('now','-2 minutes')
      AND datetime('now','+62 minutes')
  `).all();

  for (const a of rows.results || []) {
    const exists = await db.prepare(`
      SELECT id FROM notifications
      WHERE type='appointment_reminder' AND target_id=?
    `).bind(a.id).first();

    if (!exists) {
      await createNotification(
        db,
        "appointment_reminder",
        "Turno próximo",
        `Tenés un turno con ${a.name} a las ${String(a.start_time).slice(0,5)}.`,
        a.id
      );
    }
  }
}

const SCHEMA_STATEMENTS = [
 "CREATE TABLE IF NOT EXISTS settings (\n  id INTEGER PRIMARY KEY CHECK (id = 1),\n  studio_name TEXT NOT NULL DEFAULT 'Solo Tinta Ink',\n  artist_name TEXT NOT NULL DEFAULT 'Felipe Herrera',\n  description TEXT NOT NULL DEFAULT '',\n  address TEXT NOT NULL DEFAULT '',\n  maps_url TEXT NOT NULL DEFAULT '',\n  instagram TEXT NOT NULL DEFAULT '@solo.tinta.ink',\n  safety_info TEXT NOT NULL DEFAULT '',\n  contact_info TEXT NOT NULL DEFAULT '',\n  schedule_json TEXT NOT NULL,\n  pin_hash TEXT NOT NULL,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
 "CREATE TABLE IF NOT EXISTS auth_sessions (\n  token_hash TEXT PRIMARY KEY,\n  expires_at TEXT NOT NULL,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
 "CREATE TABLE IF NOT EXISTS auth_attempts (\n  ip TEXT NOT NULL,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
 "CREATE TABLE IF NOT EXISTS clients (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  whatsapp TEXT NOT NULL UNIQUE,\n  notes TEXT NOT NULL DEFAULT '',\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
 "CREATE TABLE IF NOT EXISTS quotes (\n  id TEXT PRIMARY KEY,\n  client_id TEXT NOT NULL REFERENCES clients(id),\n  description TEXT NOT NULL,\n  body_area TEXT NOT NULL DEFAULT '',\n  size TEXT NOT NULL DEFAULT '',\n  reference_data TEXT,\n  status TEXT NOT NULL CHECK (\n    status IN ('pending_quote','awaiting_confirmation','scheduled','discarded','cancelled')\n  ),\n  price INTEGER,\n  duration_minutes INTEGER,\n  quoted_at TEXT,\n  discarded_at TEXT,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
 "CREATE TABLE IF NOT EXISTS appointments (\n  id TEXT PRIMARY KEY,\n  client_id TEXT NOT NULL REFERENCES clients(id),\n  quote_id TEXT REFERENCES quotes(id),\n  date TEXT NOT NULL,\n  start_time TEXT NOT NULL,\n  duration_minutes INTEGER NOT NULL,\n  price INTEGER NOT NULL,\n  status TEXT NOT NULL CHECK (\n    status IN ('scheduled','completed','cancelled','another_session')\n  ) DEFAULT 'scheduled',\n  payment_method TEXT CHECK (payment_method IN ('cash','transfer') OR payment_method IS NULL),\n  another_session_note TEXT NOT NULL DEFAULT '',\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
 "CREATE TABLE IF NOT EXISTS day_blocks (\n  date TEXT PRIMARY KEY,\n  reason TEXT NOT NULL DEFAULT '',\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
 "CREATE TABLE IF NOT EXISTS followups (\n  id TEXT PRIMARY KEY,\n  client_id TEXT NOT NULL REFERENCES clients(id),\n  note TEXT NOT NULL,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
 "CREATE TABLE IF NOT EXISTS portfolio (\n  id TEXT PRIMARY KEY,\n  image_path TEXT NOT NULL UNIQUE,\n  description TEXT NOT NULL DEFAULT '',\n  image_data TEXT,\n  image_mime TEXT,\n  deleted INTEGER NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
 "CREATE TABLE IF NOT EXISTS stock_items (\n  id TEXT PRIMARY KEY,\n  name TEXT NOT NULL,\n  quantity REAL NOT NULL DEFAULT 0,\n  unit TEXT NOT NULL DEFAULT 'unidad',\n  minimum_quantity REAL NOT NULL DEFAULT 0,\n  last_restocked_at TEXT,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
 "CREATE TABLE IF NOT EXISTS stock_movements (\n  id TEXT PRIMARY KEY,\n  stock_item_id TEXT NOT NULL REFERENCES stock_items(id),\n  appointment_id TEXT REFERENCES appointments(id),\n  type TEXT NOT NULL CHECK (type IN ('restock','usage','adjustment')),\n  quantity REAL NOT NULL,\n  note TEXT NOT NULL DEFAULT '',\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
 "CREATE TABLE IF NOT EXISTS notifications (\n  id TEXT PRIMARY KEY,\n  type TEXT NOT NULL,\n  title TEXT NOT NULL,\n  body TEXT NOT NULL,\n  target_id TEXT,\n  seen INTEGER NOT NULL DEFAULT 0,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
 "CREATE TABLE IF NOT EXISTS push_subscriptions (\n  id TEXT PRIMARY KEY,\n  endpoint TEXT NOT NULL UNIQUE,\n  subscription_json TEXT NOT NULL,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
 "CREATE TABLE IF NOT EXISTS schedule_locks (\n  date TEXT PRIMARY KEY,\n  token TEXT NOT NULL,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
 "CREATE TABLE IF NOT EXISTS history_events (\n  id TEXT PRIMARY KEY,\n  client_id TEXT NOT NULL REFERENCES clients(id),\n  appointment_id TEXT REFERENCES appointments(id),\n  quote_id TEXT REFERENCES quotes(id),\n  event_type TEXT NOT NULL,\n  payload_json TEXT NOT NULL DEFAULT '{}',\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);",
 "CREATE INDEX IF NOT EXISTS idx_quotes_status_created\n  ON quotes(status, created_at);",
 "CREATE INDEX IF NOT EXISTS idx_quotes_client\n  ON quotes(client_id, created_at);",
 "CREATE INDEX IF NOT EXISTS idx_appointments_date_time\n  ON appointments(date, start_time);",
 "CREATE INDEX IF NOT EXISTS idx_appointments_client\n  ON appointments(client_id, date);",
 "CREATE INDEX IF NOT EXISTS idx_followups_client\n  ON followups(client_id, created_at);",
 "CREATE INDEX IF NOT EXISTS idx_stock_movements_item\n  ON stock_movements(stock_item_id, created_at);",
 "CREATE INDEX IF NOT EXISTS idx_notifications_seen_created\n  ON notifications(seen, created_at);",
 "CREATE INDEX IF NOT EXISTS idx_history_client_created\n  ON history_events(client_id, created_at);",
 "CREATE INDEX IF NOT EXISTS idx_history_appointment\n  ON history_events(appointment_id, created_at);",
 "CREATE INDEX IF NOT EXISTS idx_history_quote\n  ON history_events(quote_id, created_at);",
 "CREATE INDEX IF NOT EXISTS idx_schedule_locks_created\n  ON schedule_locks(created_at);",
 "INSERT OR IGNORE INTO settings\n(id, studio_name, artist_name, description, address, maps_url, instagram, safety_info, contact_info, schedule_json, pin_hash)\nVALUES\n(\n  1,\n  'Solo Tinta Ink',\n  'Felipe Herrera',\n  'Estudio de tatuajes especializado en fine line, black & grey y realismo. Feli atiende con cita previa, un cliente a la vez, para dar tranquilidad y atención personalizada en cada sesión.',\n  '',\n  '',\n  '@solo.tinta.ink',\n  '',\n  '',\n  '{\"0\":[],\"1\":[[\"09:30\",\"21:30\"]],\"2\":[[\"09:30\",\"21:30\"]],\"3\":[[\"09:30\",\"21:30\"]],\"4\":[[\"09:30\",\"21:30\"]],\"5\":[[\"09:30\",\"21:30\"]],\"6\":[[\"09:30\",\"21:30\"]]}',\n  'f4707bd71b28e638dc2c6981e3750e0cccf4dae5b06a17457808508ab273318e'\n);",
 "INSERT INTO portfolio (id, image_path, description) VALUES\n('tortuga','/portfolio/images/tortuga.webp','Tortuga en línea fina.'),\n('lineas','/portfolio/images/lineas.webp','Diseño de líneas finas.'),\n('media-manga','/portfolio/images/media-manga.webp','Media manga.'),\n('enzo-fernandez','/portfolio/images/enzo-fernandez.webp','Retrato de Enzo Fernández.'),\n('angel','/portfolio/images/angel.webp','Ángel en black & grey.'),\n('ojo','/portfolio/images/ojo.webp','Diseño de ojo en realismo.'),\n('douglas-haig','/portfolio/images/douglas-haig.webp','Escudo de Douglas Haig.'),\n('tigre-microrealismo','/portfolio/images/tigre-microrealismo.webp','Tigre en microrealismo.'),\n('microrealismo','/portfolio/images/microrealismo.webp','Diseño de microrealismo.'),\n('aguila','/portfolio/images/aguila.webp','Águila en realismo.'),\n('manga-completa','/portfolio/images/manga-completa.webp','Manga completa.')\nON CONFLICT(id) DO NOTHING;",
 "INSERT OR IGNORE INTO stock_items(id,name,quantity,unit,minimum_quantity)\nVALUES\n('stock_black_ink','Tinta negra',0,'ml',30),\n('stock_color_ink','Tinta de color',0,'ml',30),\n('stock_caps','Caps',0,'unidad',20),\n('stock_vaseline','Vaselina',0,'g',50),\n('stock_fields','Campos',0,'unidad',10),\n('stock_gloves','Guantes',0,'unidad',20),\n('stock_needles','Agujas',0,'unidad',10);"
];

const EXPECTED_COLUMNS = {"settings": [["id", "INTEGER"], ["studio_name", "TEXT"], ["artist_name", "TEXT"], ["description", "TEXT"], ["address", "TEXT"], ["maps_url", "TEXT"], ["instagram", "TEXT"], ["safety_info", "TEXT"], ["contact_info", "TEXT"], ["schedule_json", "TEXT"], ["pin_hash", "TEXT"], ["created_at", "TEXT"], ["updated_at", "TEXT"]], "auth_sessions": [["token_hash", "TEXT"], ["expires_at", "TEXT"], ["created_at", "TEXT"]], "auth_attempts": [["ip", "TEXT"], ["created_at", "TEXT"]], "clients": [["id", "TEXT"], ["name", "TEXT"], ["whatsapp", "TEXT"], ["notes", "TEXT"], ["created_at", "TEXT"], ["updated_at", "TEXT"]], "quotes": [["id", "TEXT"], ["client_id", "TEXT"], ["description", "TEXT"], ["body_area", "TEXT"], ["size", "TEXT"], ["reference_data", "TEXT"], ["status", "TEXT"], ["price", "INTEGER"], ["duration_minutes", "INTEGER"], ["quoted_at", "TEXT"], ["discarded_at", "TEXT"], ["created_at", "TEXT"], ["updated_at", "TEXT"]], "appointments": [["id", "TEXT"], ["client_id", "TEXT"], ["quote_id", "TEXT"], ["date", "TEXT"], ["start_time", "TEXT"], ["duration_minutes", "INTEGER"], ["price", "INTEGER"], ["status", "TEXT"], ["payment_method", "TEXT"], ["another_session_note", "TEXT"], ["created_at", "TEXT"], ["updated_at", "TEXT"]], "day_blocks": [["date", "TEXT"], ["reason", "TEXT"], ["created_at", "TEXT"]], "followups": [["id", "TEXT"], ["client_id", "TEXT"], ["note", "TEXT"], ["created_at", "TEXT"]], "portfolio": [["id", "TEXT"], ["image_path", "TEXT"], ["description", "TEXT"], ["image_data", "TEXT"], ["image_mime", "TEXT"], ["deleted", "INTEGER"], ["created_at", "TEXT"], ["updated_at", "TEXT"]], "stock_items": [["id", "TEXT"], ["name", "TEXT"], ["quantity", "REAL"], ["unit", "TEXT"], ["minimum_quantity", "REAL"], ["last_restocked_at", "TEXT"], ["created_at", "TEXT"], ["updated_at", "TEXT"]], "stock_movements": [["id", "TEXT"], ["stock_item_id", "TEXT"], ["appointment_id", "TEXT"], ["type", "TEXT"], ["quantity", "REAL"], ["note", "TEXT"], ["created_at", "TEXT"]], "notifications": [["id", "TEXT"], ["type", "TEXT"], ["title", "TEXT"], ["body", "TEXT"], ["target_id", "TEXT"], ["seen", "INTEGER"], ["created_at", "TEXT"]], "push_subscriptions": [["id", "TEXT"], ["endpoint", "TEXT"], ["subscription_json", "TEXT"], ["created_at", "TEXT"]], "schedule_locks": [["date", "TEXT"], ["token", "TEXT"], ["created_at", "TEXT"]], "history_events": [["id", "TEXT"], ["client_id", "TEXT"], ["appointment_id", "TEXT"], ["quote_id", "TEXT"], ["event_type", "TEXT"], ["payload_json", "TEXT"], ["created_at", "TEXT"]]};
const VOLATILE_TABLES = ["auth_sessions","auth_attempts","schedule_locks"];

async function rebuildPortfolio(db) {
  const info = (await db.prepare("PRAGMA table_info(portfolio)").all()).results || [];
  const have = new Set(info.map(c => c.name));
  const names = EXPECTED_COLUMNS.portfolio.map(([n]) => n);
  const fallback = {image_path:"'/api/photo/'||id", description:"''", deleted:"0", created_at:"CURRENT_TIMESTAMP", updated_at:"CURRENT_TIMESTAMP"};
  const select = names.map(n => have.has(n) ? n : (fallback[n] || "NULL")).join(",");
  const create = SCHEMA_STATEMENTS.find(s => /^CREATE TABLE IF NOT EXISTS portfolio\b/i.test(s))
    .replace(/^CREATE TABLE IF NOT EXISTS portfolio\b/i, "CREATE TABLE portfolio_new");
  await db.batch([
    db.prepare("DROP TABLE IF EXISTS portfolio_new"),
    db.prepare(create),
    db.prepare(`INSERT OR IGNORE INTO portfolio_new(${names.join(",")}) SELECT ${select} FROM portfolio`),
    db.prepare("DROP TABLE portfolio"),
    db.prepare("ALTER TABLE portfolio_new RENAME TO portfolio")
  ]);
}

let schemaOk = false;
// Deja la base lista aunque venga de una versión anterior: crea tablas que falten,
// recrea las temporales (sesiones/intentos) si tienen otra estructura y agrega columnas faltantes.
async function ensureSchema(db) {
  if (schemaOk) return;
  const tableStmts = SCHEMA_STATEMENTS.filter(s => /^CREATE TABLE/i.test(s));
  const indexStmts = SCHEMA_STATEMENTS.filter(s => /^CREATE INDEX/i.test(s));
  const seedStmts = SCHEMA_STATEMENTS.filter(s => !/^CREATE/i.test(s));

  for (const t of VOLATILE_TABLES) {
    const info = await db.prepare(`PRAGMA table_info(${t})`).all();
    const have = new Set((info.results || []).map(c => c.name));
    if (have.size && EXPECTED_COLUMNS[t].some(([n]) => !have.has(n))) {
      await db.prepare(`DROP TABLE ${t}`).run();
    }
  }
  await db.batch(tableStmts.map(s => db.prepare(s)));

  for (const [t, cols] of Object.entries(EXPECTED_COLUMNS)) {
    const info = await db.prepare(`PRAGMA table_info(${t})`).all();
    const rows = info.results || [];
    const have = new Set(rows.map(c => c.name));
    for (const [name, type] of cols) {
      if (!have.has(name)) await db.prepare(`ALTER TABLE ${t} ADD COLUMN ${name} ${type || "TEXT"}`).run();
    }
    // Columnas viejas obligatorias y sin valor por defecto (ej. r2_key) rompen los INSERT nuevos: se eliminan.
    const expectedNames = new Set(cols.map(c => c[0]));
    for (const c of rows) {
      if (!expectedNames.has(c.name) && c.notnull && c.dflt_value == null && !c.pk) {
        try { await db.prepare(`ALTER TABLE ${t} DROP COLUMN "${c.name}"`).run(); }
        catch (e) { if (t === "portfolio") { await rebuildPortfolio(db); break; } throw e; }
      }
    }
  }
  await db.batch(indexStmts.map(s => db.prepare(s)));

  const seeded = await db.prepare("SELECT id FROM settings WHERE id=1").first();
  if (!seeded) await db.batch(seedStmts.map(s => db.prepare(s)));
  schemaOk = true;
}

async function handleAPI(request, env, ctx) {
  const db = env.DB;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "") || "";
  const method = request.method;

  if (method === "GET" && path === "health") {
    let dbState = "ok", detail = "";
    try { await ensureSchema(db); } catch (e) { dbState = "error"; detail = String(e?.message || e).slice(0,300); }
    return json(200,{ok:dbState==="ok",service:"solo-tinta-ink",build:BUILD,date:todayAR(),db:dbState,detail});
  }

  await ensureSchema(db);

  if (method === "POST" && path === "login") {
    return adminLogin(request,db,await parseJSON(request));
  }

  if (method === "POST" && path === "quote") {
    return createQuote(request,db);
  }

  if (method === "GET" && path === "settings") {
    const s = await getSettings(db);
    return json(200,{
      studio_name:s.studio_name,
      artist_name:s.artist_name,
      description:s.description,
      address:s.address,
      maps_url:s.maps_url,
      instagram:s.instagram,
      safety_info:s.safety_info,
      contact_info:s.contact_info,
      schedule:s.schedule
    });
  }

  if (method === "GET" && path === "portfolio") {
    return json(200,{portfolio:await getPortfolio(db)});
  }

  if (method === "GET" && path === "reference") {
    return getReference(db,request,url.searchParams.get("quote_id"));
  }

  if (method === "GET" && path === "admin/finance") {
    if (!(await isAdmin(request,db))) return json(401,{error:"No autorizado"});
    const month = /^\d{4}-\d{2}$/.test(url.searchParams.get("month") || "")
      ? url.searchParams.get("month")
      : todayAR().slice(0,7);

    const summary = await db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN status='completed' THEN price ELSE 0 END),0) AS total_income,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS tattoos_completed,
        COALESCE(AVG(CASE WHEN status='completed' THEN price END),0) AS average_ticket,
        SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN status='scheduled' THEN 1 ELSE 0 END) AS scheduled,
        COALESCE(SUM(CASE WHEN status='scheduled' THEN price ELSE 0 END),0) AS scheduled_income,
        COALESCE(SUM(CASE WHEN status='completed' AND payment_method='cash' THEN price ELSE 0 END),0) AS cash_income,
        COALESCE(SUM(CASE WHEN status='completed' AND payment_method='transfer' THEN price ELSE 0 END),0) AS transfer_income
      FROM appointments
      WHERE substr(date,1,7)=?
    `).bind(month).first();

    const daily = await db.prepare(`
      SELECT date,
        SUM(CASE WHEN status='completed' THEN price ELSE 0 END) AS income,
        SUM(CASE WHEN status='completed' THEN 1 ELSE 0 END) AS completed,
        SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled
      FROM appointments
      WHERE substr(date,1,7)=?
      GROUP BY date
      ORDER BY date
    `).bind(month).all();

    return json(200,{month,summary:{
      total_income:Number(summary?.total_income || 0),
      tattoos_completed:Number(summary?.tattoos_completed || 0),
      average_ticket:Number(summary?.average_ticket || 0),
      cancelled:Number(summary?.cancelled || 0),
      scheduled:Number(summary?.scheduled || 0),
      scheduled_income:Number(summary?.scheduled_income || 0),
      cash_income:Number(summary?.cash_income || 0),
      transfer_income:Number(summary?.transfer_income || 0)
    },daily:daily.results || []});
  }

  if (method === "GET" && path === "admin/client") {
    if (!(await isAdmin(request,db))) return json(401,{error:"No autorizado"});
    const id = url.searchParams.get("id");
    const client = await db.prepare("SELECT * FROM clients WHERE id=?").bind(id).first();
    if (!client) return json(404,{error:"Cliente no encontrado"});

    const [quotes,appointments,followups,history] = await Promise.all([
      db.prepare("SELECT * FROM quotes WHERE client_id=? ORDER BY created_at DESC").bind(id).all(),
      db.prepare("SELECT * FROM appointments WHERE client_id=? ORDER BY date DESC,start_time DESC").bind(id).all(),
      db.prepare("SELECT * FROM followups WHERE client_id=? ORDER BY created_at DESC").bind(id).all(),
      db.prepare("SELECT * FROM history_events WHERE client_id=? ORDER BY created_at DESC").bind(id).all()
    ]);

    const tattoos = (appointments.results || []).filter(a => a.status === "completed");
    const spent = tattoos.reduce((sum,a)=>sum+Number(a.price||0),0);
    return json(200,{client,
      tattoos_count:tattoos.length,
      total_spent:spent,
      last_appointment:appointments.results?.[0] || null,
      quotes:quotes.results || [],
      appointments:appointments.results || [],
      followups:followups.results || [],
      history:(history.results || []).map(h => ({...h,payload:JSON.parse(h.payload_json || "{}")}))});
  }

  if (method === "POST" && path === "admin/client/notes") {
    if (!(await isAdmin(request,db))) return json(401,{error:"No autorizado"});
    const body = await parseJSON(request);
    const id = String(body.id || "");
    const notes = String(body.notes || "").trim();
    if (!id) return json(400,{error:"Cliente inválido."});
    if (notes.length > 1000) return json(400,{error:"La nota no puede superar 1000 caracteres."});
    const client = await db.prepare("SELECT id FROM clients WHERE id=?").bind(id).first();
    if (!client) return json(404,{error:"Cliente no encontrado."});
    await db.prepare("UPDATE clients SET notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(notes,id).run();
    await db.prepare(`
      INSERT INTO history_events(id,client_id,event_type,payload_json)
      VALUES(?,?,?,?)
    `).bind(uid("hist"),id,"client_note_updated",JSON.stringify({notes})).run();
    return json(200,{ok:true});
  }

  if (method === "GET" && path === "admin/stock/movements") {
    if (!(await isAdmin(request,db))) return json(401,{error:"No autorizado"});
    const itemId = url.searchParams.get("item_id");
    const rows = await db.prepare(`
      SELECT sm.*, si.name AS item_name
      FROM stock_movements sm
      JOIN stock_items si ON si.id=sm.stock_item_id
      ${itemId ? "WHERE sm.stock_item_id=?" : ""}
      ORDER BY sm.created_at DESC LIMIT 300
    `).bind(...(itemId ? [itemId] : [])).all();
    return json(200,{movements:rows.results || []});
  }

  if (!(await isAdmin(request,db))) {
    return json(401,{error:"No autorizado"});
  }

  if (method === "POST" && path === "logout") {
    const cookie = request.headers.get("cookie") || "";
    const m = /st_session=([^;]+)/.exec(cookie);
    if (m) await db.prepare("DELETE FROM auth_sessions WHERE token_hash=?").bind(await sha256(m[1])).run();
    return json(200,{ok:true},{ "set-cookie": "st_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax" });
  }

  if (method === "GET" && path === "admin/data") {
    return json(200,await adminData(db, request));
  }

  if (method === "POST" && path === "admin/quote/discard") {
    const id = String((await parseJSON(request)).id || "");
    await db.prepare(`
      UPDATE quotes SET status='discarded',discarded_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status IN ('pending_quote','awaiting_confirmation')
    `).bind(id).run();
    return json(200,{ok:true});
  }

  if (method === "POST" && path === "admin/quote/price") {
    const body = await parseJSON(request);
    const duration = normalizeDuration(body.duration);
    const price = Number(body.price);
    if (!Number.isInteger(price) || price < 0 || !Number.isInteger(duration) || duration <= 0) {
      return json(400,{error:"Precio o duración inválidos."});
    }
    const q = await db.prepare(`
      SELECT q.id,q.client_id,q.description,q.body_area,q.size,
             CASE WHEN q.reference_data IS NOT NULL THEN 1 ELSE 0 END AS has_reference,
             q.status,q.price,q.duration_minutes,q.quoted_at,q.discarded_at,q.created_at,q.updated_at,
             c.name,c.whatsapp FROM quotes q JOIN clients c ON c.id=q.client_id WHERE q.id=?
    `).bind(body.id).first();
    if (!q) return json(404,{error:"Presupuesto no encontrado."});

    await db.prepare(`
      UPDATE quotes
      SET price=?,duration_minutes=?,status='awaiting_confirmation',
          quoted_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(price,duration,q.id).run();

    return json(200,{
      ok:true,
      whatsapp:q.whatsapp,
      message:
`¡Hola ${q.name}! Soy Feli de Solo Tinta Ink
Te paso el presupuesto para tu tatuaje: $${price}
Duración estimada: ${Math.floor(duration/60)}:${String(duration%60).padStart(2,"0")} horas
Cualquier consulta avísame! Si te parece podemos coordinar una fecha y hora
¡Muchas gracias!`
    });
  }

  if (method === "GET" && path === "admin/quote") {
    const q = await db.prepare(`
      SELECT q.id,q.client_id,q.description,q.body_area,q.size,
             CASE WHEN q.reference_data IS NOT NULL THEN 1 ELSE 0 END AS has_reference,
             q.status,q.price,q.duration_minutes,q.quoted_at,q.discarded_at,q.created_at,q.updated_at,
             c.name,c.whatsapp FROM quotes q JOIN clients c ON c.id=q.client_id WHERE q.id=?
    `).bind(url.searchParams.get("id")).first();
    return q ? json(200,q) : json(404,{error:"No encontrado"});
  }

  if (method === "POST" && path === "admin/appointment") {
    const body = await parseJSON(request);
    const result = await scheduleAppointment(db,body,body.quote_id || null);
    return json(result.status,result.data);
  }

  if (method === "POST" && path === "admin/appointment/edit") {
    const body = await parseJSON(request);
    const id = String(body.id || "");
    const old = await db.prepare("SELECT * FROM appointments WHERE id=?").bind(id).first();
    if (!old || !["scheduled","another_session"].includes(old.status)) {
      return json(404,{error:"Turno no encontrado."});
    }

    const duration = normalizeDuration(body.duration_minutes ?? body.duration);
    const date = String(body.date || "");
    const start = String(body.start_time || "");
    if (!validDate(date) || !validTime(start) || !Number.isInteger(duration) || duration <= 0) {
      return json(400,{error:"Datos de reprogramación inválidos."});
    }

    const lockDate = date;
    const lock = await acquireDayLock(db, lockDate);
    if (!lock) return json(409,{error:"La agenda está siendo actualizada. Probá de nuevo en un segundo."});

    try {
      const settings = await getSettings(db);
      const check = await canSchedule(db,settings,date,start,duration,id);
      if (!check.ok) return json(409,{error:check.error});

      await db.prepare(`
        UPDATE appointments
        SET date=?,start_time=?,duration_minutes=?,updated_at=CURRENT_TIMESTAMP
        WHERE id=?
      `).bind(date,start,duration,id).run();

      await db.prepare(`
        INSERT INTO history_events(id,client_id,appointment_id,event_type,payload_json)
        VALUES(?,?,?,?,?)
      `).bind(
        uid("hist"), old.client_id, id, "appointment_rescheduled",
        JSON.stringify({
          from_date: old.date,
          from_time: String(old.start_time).slice(0,5),
          from_duration_minutes: old.duration_minutes,
          to_date: date,
          to_time: start,
          to_duration_minutes: duration
        })
      ).run();

      return json(200,{ok:true});
    } finally {
      await releaseDayLock(db, lockDate, lock);
    }
  }

  if (method === "POST" && path === "admin/appointment/cancel") {
    return json(...Object.values(await cancelAppointment(db,await parseJSON(request))));
  }

  if (method === "POST" && path === "admin/appointment/complete") {
    return json(...Object.values(await markCompleted(db,await parseJSON(request))));
  }

  if (method === "POST" && path === "admin/appointment/another-session") {
    const body = await parseJSON(request);
    const id = String(body.id || "");
    const note = String(body.note || "").trim();
    const a = await db.prepare("SELECT * FROM appointments WHERE id=?").bind(id).first();
    if (!a || a.status !== "scheduled") return json(404,{error:"Turno no encontrado."});
    await db.prepare(`
      UPDATE appointments
      SET status='another_session',another_session_note=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND status='scheduled'
    `).bind(note,id).run();
    await db.prepare(`
      INSERT INTO history_events(id,client_id,appointment_id,event_type,payload_json)
      VALUES(?,?,?,?,?)
    `).bind(uid("hist"),a.client_id,id,"another_session",
      JSON.stringify({note})).run();
    return json(200,{ok:true});
  }

  if (method === "POST" && path === "admin/day-block") {
    const body = await parseJSON(request);
    const date = String(body.date || "");
    if (!validDate(date)) return json(400,{error:"Fecha inválida"});
    await db.prepare("INSERT OR REPLACE INTO day_blocks(date,reason) VALUES(?,?)")
      .bind(date,String(body.reason || "Agenda llena")).run();
    return json(200,{ok:true});
  }

  if (method === "DELETE" && path === "admin/day-block") {
    const body = await parseJSON(request);
    const date = String(body.date || url.searchParams.get("date") || "");
    if (!validDate(date)) return json(400,{error:"Fecha inválida"});
    await db.prepare("DELETE FROM day_blocks WHERE date=?").bind(date).run();
    return json(200,{ok:true});
  }

  if (method === "POST" && path === "admin/followup") {
    const body = await parseJSON(request);
    const id = uid("fu");
    const note = String(body.note || "").trim();
    if (!body.client_id || !note || note.length > MAX_NOTE_LENGTH) {
      return json(400,{error:"Nota inválida."});
    }
    await db.prepare("INSERT INTO followups(id,client_id,note) VALUES(?,?,?)")
      .bind(id,body.client_id,note).run();
    await db.prepare(`
      INSERT INTO history_events(id,client_id,event_type,payload_json)
      VALUES(?,?,?,?)
    `).bind(uid("hist"),body.client_id,"followup_created",JSON.stringify({note})).run();
    return json(201,{ok:true,id});
  }

  if (method === "POST" && path === "admin/settings") {
    const body = await parseJSON(request);
    const allowed = ["studio_name","artist_name","description","address","maps_url","instagram","safety_info","contact_info"];
    const s = await getSettings(db);
    const next = Object.fromEntries(allowed.map(k => [k, body[k] !== undefined ? String(body[k]) : s[k]]));
    await db.prepare(`
      UPDATE settings
      SET studio_name=?,artist_name=?,description=?,address=?,maps_url=?,instagram=?,safety_info=?,contact_info=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=1
    `).bind(next.studio_name,next.artist_name,next.description,next.address,next.maps_url,next.instagram,next.safety_info,next.contact_info).run();
    return json(200,{ok:true});
  }

  if (method === "POST" && path === "admin/settings/schedule") {
    const body = await parseJSON(request);
    if (!body.schedule || typeof body.schedule !== "object") return json(400,{error:"Horarios inválidos"});
    const normalized = {};
    for (let d=0; d<7; d++) {
      const ranges = body.schedule[d] ?? body.schedule[String(d)] ?? [];
      if (!Array.isArray(ranges) || ranges.length > 2) return json(400,{error:"Horarios inválidos"});
      normalized[d] = ranges.map(pair => {
        if (!Array.isArray(pair) || pair.length !== 2 || !validTime(pair[0]) || !validTime(pair[1]) || minutes(pair[0]) >= minutes(pair[1])) {
          throw new Error("Rango horario inválido");
        }
        return [pair[0],pair[1]];
      });
    }
    await db.prepare("UPDATE settings SET schedule_json=?,updated_at=CURRENT_TIMESTAMP WHERE id=1")
      .bind(JSON.stringify(normalized)).run();
    return json(200,{ok:true});
  }

  if (method === "POST" && path === "admin/settings/pin") {
    const body = await parseJSON(request);
    const pin = String(body.pin || "");
    if (!/^\d{4}$/.test(pin)) return json(400,{error:"El PIN debe tener 4 dígitos."});
    await db.prepare("UPDATE settings SET pin_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=1")
      .bind(await sha256(pin)).run();
    return json(200,{ok:true});
  }

  if (method === "POST" && path === "admin/notification/read") {
    await db.prepare("UPDATE notifications SET seen=1 WHERE id=?")
      .bind((await parseJSON(request)).id).run();
    return json(200,{ok:true});
  }

  if (method === "POST" && path === "admin/notifications/clear") {
    await db.prepare("DELETE FROM notifications WHERE seen=1").run();
    return json(200,{ok:true});
  }

  if (method === "POST" && path === "admin/push/subscribe") {
    const body = await parseJSON(request);
    if (!body.endpoint || !body.keys) return json(400,{error:"Suscripción inválida."});
    await db.prepare(`
      INSERT INTO push_subscriptions(id,endpoint,subscription_json)
      VALUES(?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET subscription_json=excluded.subscription_json
    `).bind(uid("push"),body.endpoint,JSON.stringify(body)).run();
    return json(200,{ok:true});
  }

  if (method === "POST" && path === "admin/portfolio") {
    const body = await parseJSON(request);
    const id = String(body.id || '').trim();
    const description = String(body.description || '').trim();
    const items = await getPortfolio(db);
    const item = items.find(x => x.id === id);
    if (!item) return json(404,{error:"Trabajo de portfolio no encontrado."});
    if (description.length > 500) return json(400,{error:"La descripción es demasiado larga."});
    await db.prepare(`
      INSERT INTO portfolio(id,image_path,description) VALUES(?,?,?)
      ON CONFLICT(id) DO UPDATE SET description=excluded.description,updated_at=CURRENT_TIMESTAMP
    `).bind(id,"/api/photo/"+id,description).run();
    return json(200,{ok:true});
  }


  if (method === "POST" && path === "admin/portfolio/photo") {
    const body = await parseJSON(request);
    const m = /^data:(image\/(?:jpeg|webp|png));base64,([A-Za-z0-9+/=]+)$/i.exec(String(body.image || ""));
    if (!m) return json(400,{error:"La foto no es válida."});
    if (m[2].length > 900000) return json(413,{error:"La foto es demasiado pesada. Elegí otra."});
    let id = String(body.id || "");
    let description = String(body.description || "").trim().slice(0,500);
    if (id) {
      if (!PORTFOLIO_IDS.has(id)) {
        const own = await db.prepare("SELECT id FROM portfolio WHERE id=?").bind(id).first();
        if (!own) return json(404,{error:"Trabajo no encontrado."});
      } else if (!description) {
        description = PORTFOLIO_ITEMS.find(x => x.id === id)?.description || "";
      }
    } else {
      const items = await getPortfolio(db);
      if (items.length >= MAX_PORTFOLIO) return json(409,{error:`Llegaste al máximo de ${MAX_PORTFOLIO} fotos. Borrá alguna para agregar otra.`});
      id = uid("ph");
    }
    await db.prepare(`
      INSERT INTO portfolio(id,image_path,description,image_data,image_mime,deleted)
      VALUES(?,?,?,?,?,0)
      ON CONFLICT(id) DO UPDATE SET image_data=excluded.image_data,image_mime=excluded.image_mime,deleted=0,updated_at=CURRENT_TIMESTAMP
    `).bind(id,"/api/photo/"+id,description,m[2],m[1].toLowerCase()).run();
    return json(200,{ok:true,id});
  }

  if (method === "POST" && path === "admin/portfolio/delete") {
    const id = String((await parseJSON(request)).id || "");
    if (!id) return json(400,{error:"Falta la foto."});
    if (PORTFOLIO_IDS.has(id)) {
      await db.prepare(`
        INSERT INTO portfolio(id,image_path,description,deleted) VALUES(?,?,'',1)
        ON CONFLICT(id) DO UPDATE SET deleted=1,image_data=NULL,image_mime=NULL,updated_at=CURRENT_TIMESTAMP
      `).bind(id,"/api/photo/"+id).run();
    } else {
      await db.prepare("DELETE FROM portfolio WHERE id=?").bind(id).run();
    }
    return json(200,{ok:true});
  }

  if (method === "POST" && path === "admin/stock") {
    const body = await parseJSON(request);
    const id = body.id || uid("stk");
    const name = String(body.name || "").trim();
    const quantity = Number(body.quantity ?? 0);
    const unit = String(body.unit || "unidad").trim();
    const minimum = Number(body.minimum_quantity ?? 0);
    if (!name || !Number.isFinite(quantity) || !Number.isFinite(minimum) || minimum < 0) {
      return json(400,{error:"Datos de stock inválidos."});
    }
    const exists = await db.prepare("SELECT id FROM stock_items WHERE id=?").bind(id).first();
    if (exists) {
      await db.prepare(`
        UPDATE stock_items SET name=?,quantity=?,unit=?,minimum_quantity=?,updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).bind(name,quantity,unit,minimum,id).run();
    } else {
      await db.prepare(`
        INSERT INTO stock_items(id,name,quantity,unit,minimum_quantity,last_restocked_at)
        VALUES(?,?,?,?,?,CURRENT_TIMESTAMP)
      `).bind(id,name,quantity,unit,minimum).run();
    }
    return json(200,{ok:true,id});
  }

  if (method === "DELETE" && path === "admin/stock") {
    const body = await parseJSON(request);
    const id = String(body.id || "");
    if (!id) return json(400,{error:"Falta el insumo."});
    const item = await db.prepare("SELECT id FROM stock_items WHERE id=?").bind(id).first();
    if (!item) return json(404,{error:"Insumo no encontrado."});
    await db.prepare("DELETE FROM stock_movements WHERE stock_item_id=?").bind(id).run();
    await db.prepare("DELETE FROM stock_items WHERE id=?").bind(id).run();
    return json(200,{ok:true});
  }

  if (method === "POST" && path === "admin/stock/adjust") {
    const body = await parseJSON(request);
    const id = String(body.id || "");
    const delta = Number(body.delta);
    if (!id || !Number.isFinite(delta) || delta === 0) return json(400,{error:"Cantidad inválida."});
    const item = await db.prepare("SELECT * FROM stock_items WHERE id=?").bind(id).first();
    if (!item) return json(404,{error:"Insumo no encontrado."});
    if (Number(item.quantity) + delta < 0) {
      return json(409,{error:`No podés restar más de lo que hay (${item.quantity}).`});
    }
    // El WHERE evita que dos pedidos simultáneos dejen el stock en negativo.
    const r = await db.prepare(`
      UPDATE stock_items SET quantity=quantity+?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND quantity+? >= 0
    `).bind(delta,id,delta).run();
    if (!r?.meta?.changes) return json(409,{error:"El stock cambió. Probá de nuevo."});
    await db.prepare(`
      INSERT INTO stock_movements(id,stock_item_id,type,quantity,note)
      VALUES(?,?,'adjustment',?,?)
    `).bind(uid("sm"),id,delta,String(body.note || "Ajuste manual")).run();
    return json(200,{ok:true});
  }

  if (method === "POST" && path === "admin/stock/restock") {
    const body = await parseJSON(request);
    const id = String(body.id || "");
    const qty = Number(body.quantity);
    if (!id || !Number.isFinite(qty) || qty <= 0) return json(400,{error:"Cantidad inválida."});
    if (!(await db.prepare("SELECT id FROM stock_items WHERE id=?").bind(id).first())) return json(404,{error:"Insumo no encontrado."});
    await db.prepare(`
      UPDATE stock_items
      SET quantity=quantity+?,last_restocked_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).bind(qty,id).run();
    await db.prepare(`
      INSERT INTO stock_movements(id,stock_item_id,type,quantity,note)
      VALUES(?,?, 'restock',?,?)
    `).bind(uid("sm"),id,qty,String(body.note || "Reposición")).run();
    return json(200,{ok:true});
  }

  if (method === "POST" && path === "admin/stock/use") {
    const body = await parseJSON(request);
    const appointmentId = String(body.appointment_id || "");
    const items = Array.isArray(body.items) ? body.items : [];
    const a = await db.prepare("SELECT id,status FROM appointments WHERE id=?").bind(appointmentId).first();
    if (!a || a.status !== "completed") return json(400,{error:"El turno debe estar completado."});

    for (const item of items) {
      const qty = Number(item.quantity || 0);
      if (!item.id || !Number.isFinite(qty) || qty <= 0) continue;
      const stock = await db.prepare("SELECT * FROM stock_items WHERE id=?").bind(item.id).first();
      if (!stock) return json(404,{error:"Insumo no encontrado."});
      if (Number(stock.quantity) < qty) return json(409,{error:`Stock insuficiente: ${stock.name}`});
      await db.prepare(`
        UPDATE stock_items SET quantity=quantity-?,updated_at=CURRENT_TIMESTAMP WHERE id=?
      `).bind(qty,item.id).run();
      await db.prepare(`
        INSERT INTO stock_movements(id,stock_item_id,appointment_id,type,quantity,note)
        VALUES(?,?,?,'usage',?,?)
      `).bind(uid("sm"),item.id,appointmentId,qty,"Uso en turno").run();
    }
    return json(200,{ok:true});
  }

  return json(404,{error:"Ruta no encontrada"});
}

export default {
  async fetch(request, env, ctx) {
    try {
      if (!env.DB) return json(500,{error:"Falta binding D1: DB"});
      if (request.method === "OPTIONS") {
        return new Response(null,{status:204,headers:{
          "access-control-allow-origin":"*",
          "access-control-allow-methods":"GET,POST,DELETE,OPTIONS",
          "access-control-allow-headers":"Content-Type"
        }});
      }

      const url = new URL(request.url);
      if (url.pathname === "/api" || url.pathname === "/api/") {
        return new Response("Solo Tinta Ink API",{headers:{"content-type":"text/plain; charset=utf-8"}});
      }
      if (request.method === "GET" && url.pathname.startsWith("/api/photo/")) {
        const id = decodeURIComponent(url.pathname.slice("/api/photo/".length));
        let row = null;
        try { await ensureSchema(env.DB); row = await env.DB.prepare("SELECT image_data, image_mime, COALESCE(deleted,0) AS deleted FROM portfolio WHERE id=?").bind(id).first(); } catch {}
        if (row?.deleted) return new Response("No encontrada", {status:404});
        const b64 = row?.image_data || PHOTOS[id];
        if (!b64) return new Response("No encontrada", {status:404});
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Response(bytes, {headers:{"content-type":row?.image_data ? (row.image_mime || "image/jpeg") : "image/webp","cache-control":"public, max-age=86400"}});
      }
      if (url.pathname.startsWith("/api/")) {
        return await handleAPI(request,env,ctx);
      }
      if (env.ASSETS) {
        const assetPath = url.pathname === "/" || url.pathname === "/reservar" || url.pathname === "/reservar/"
          ? "/index.html"
          : url.pathname === "/gestion" || url.pathname === "/gestion/"
            ? "/gestion.html"
            : url.pathname;
        const assetRes = await env.ASSETS.fetch(new Request(new URL(assetPath, request.url), request));
        if (assetPath.endsWith(".html")) {
          // Evita que el celular muestre una versión vieja guardada en caché.
          const h = new Headers(assetRes.headers);
          h.set("cache-control","no-cache");
          return new Response(assetRes.body,{status:assetRes.status,headers:h});
        }
        return assetRes;
      }
      return new Response("No encontrado",{status:404});
    } catch (e) {
      console.error(e);
      return json(500,{error:"Error interno",detail:String(e?.message || e).slice(0,300),diagnostic:"SOLOTINTA_INTERNAL_ERROR"});
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    ctx.waitUntil(Promise.all([
      cleanupReferenceData(env.DB),
      sendDueReminderNotifications(env.DB)
    ]));
  }
};
