// Solo Tinta Ink — Cloudflare Worker v1
// Backend propio: D1 + R2.
// No incluye promociones, catálogo público de precios ni lógica de seña.
// IMPORTANTE: reemplazar el PIN inicial en producción mediante /api/admin/settings/pin.

const MAX_REFERENCE_BYTES = 8 * 1024 * 1024;
const MAX_PORTFOLIO_BYTES = 12 * 1024 * 1024;
const SESSION_DAYS = 30;
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

async function createQuote(request, env, db) {
  if (!(request.headers.get("content-type") || "").includes("multipart/form-data")) {
    return json(400, {error:"La solicitud debe enviarse como multipart/form-data"});
  }

  const form = await request.formData();
  const name = String(form.get("name") || "").trim();
  const whatsapp = cleanWA(form.get("whatsapp"));
  const description = String(form.get("description") || "").trim();
  const bodyArea = String(form.get("body_area") || "").trim();
  const size = String(form.get("size") || "").trim();

  if (!name || name.length > 120 || !validWA(whatsapp) || !description || description.length > 3000) {
    return json(400, {error:"Completá nombre, WhatsApp y descripción correctamente."});
  }

  const client = await upsertClient(db, name, whatsapp);
  let referenceKey = null;
  const image = form.get("reference_image");

  if (image && typeof image !== "string") {
    if (image.size > MAX_REFERENCE_BYTES) {
      return json(413, {error:"La imagen supera el límite de 8 MB."});
    }
    const type = String(image.type || "").toLowerCase();
    if (!["image/jpeg","image/png","image/webp","image/gif"].includes(type)) {
      return json(400, {error:"La referencia debe ser una imagen JPG, PNG, WEBP o GIF."});
    }
    referenceKey = `references/${new Date().toISOString().slice(0,10)}/${uid("ref")}`;
    await env.R2.put(referenceKey, image.stream(), {
      httpMetadata: {contentType:type}
    });
  }

  const id = uid("q");
  await db.prepare(`
    INSERT INTO quotes(
      id,client_id,description,body_area,size,reference_key,status
    ) VALUES(?,?,?,?,?,?, 'pending_quote')
  `).bind(id,client.id,description,bodyArea,size,referenceKey).run();

  await createNotification(
    db,
    "new_quote",
    "Nueva solicitud de presupuesto",
    `Nueva solicitud de presupuesto — ${client.name}`,
    id
  );

  return json(201, {ok:true, quoteId:id});
}

async function adminData(db) {
  const [settings, quotes, appointments, clients, portfolio, stock, notifications, followups, dayBlocks] =
    await Promise.all([
      getSettings(db),
      db.prepare(`
        SELECT q.*, c.name, c.whatsapp
        FROM quotes q JOIN clients c ON c.id=q.client_id
        ORDER BY q.created_at DESC
      `).all(),
      db.prepare(`
        SELECT a.*, c.name, c.whatsapp
        FROM appointments a JOIN clients c ON c.id=a.client_id
        ORDER BY a.date, a.start_time
      `).all(),
      db.prepare("SELECT * FROM clients ORDER BY name").all(),
      db.prepare("SELECT * FROM portfolio ORDER BY created_at DESC").all(),
      db.prepare("SELECT * FROM stock_items ORDER BY name").all(),
      db.prepare("SELECT * FROM notifications ORDER BY created_at DESC LIMIT 100").all(),
      db.prepare(`
        SELECT f.*, c.name
        FROM followups f JOIN clients c ON c.id=f.client_id
        ORDER BY f.created_at DESC LIMIT 200
      `).all(),
      db.prepare("SELECT * FROM day_blocks ORDER BY date").all()
    ]);

  return {
    settings: {
      studio_name:settings.studio_name,
      artist_name:settings.artist_name,
      description:settings.description,
      address:settings.address,
      maps_url:settings.maps_url,
      instagram:settings.instagram,
      schedule:settings.schedule
    },
    quotes:quotes.results || [],
    appointments:appointments.results || [],
    clients:clients.results || [],
    portfolio:portfolio.results || [],
    stock:stock.results || [],
    notifications:notifications.results || [],
    followups:followups.results || [],
    day_blocks:dayBlocks.results || [],
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

async function getReference(env, db, request, id) {
  if (!(await isAdmin(request, db))) return json(401,{error:"No autorizado"});
  const q = await db.prepare("SELECT reference_key FROM quotes WHERE id=?").bind(id).first();
  if (!q?.reference_key) return new Response("Imagen no encontrada",{status:404});
  const obj = await env.R2.get(q.reference_key);
  if (!obj) return new Response("Imagen no encontrada",{status:404});
  return new Response(obj.body,{
    headers:{
      "content-type":obj.httpMetadata?.contentType || "application/octet-stream",
      "cache-control":"private, max-age=300"
    }
  });
}

async function cleanupReferences(env, db) {
  const rows = await db.prepare(`
    SELECT q.id,q.reference_key,a.date AS appointment_date,q.quoted_at,q.created_at
    FROM quotes q
    LEFT JOIN appointments a ON a.quote_id=q.id
    WHERE q.reference_key IS NOT NULL
  `).all();

  const now = Date.now();
  for (const q of rows.results || []) {
    const base = q.appointment_date
      ? Date.parse(`${q.appointment_date}T00:00:00-03:00`)
      : Date.parse(q.quoted_at || q.created_at);
    if (!Number.isFinite(base)) continue;

    if (now >= base + 14 * 86400000) {
      await env.R2.delete(q.reference_key);
      await db.prepare("UPDATE quotes SET reference_key=NULL WHERE id=?").bind(q.id).run();
    }
  }
}

async function sendDueReminderNotifications(db) {
  // En v1 almacenamos el aviso. La entrega push real requiere configurar
  // VAPID/Web Push; el endpoint de suscripción ya queda preparado.
  const rows = await db.prepare(`
    SELECT a.id,a.date,a.start_time,c.name
    FROM appointments a
    JOIN clients c ON c.id=a.client_id
    WHERE a.status='scheduled'
      AND datetime(a.date || ' ' || a.start_time) BETWEEN datetime('now','-2 minutes')
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

async function handleAPI(request, env, ctx) {
  const db = env.DB;
  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/api\/?/, "") || "";
  const method = request.method;

  if (method === "GET" && path === "health") {
    return json(200,{ok:true,service:"solo-tinta-ink",date:todayAR()});
  }

  if (method === "POST" && path === "login") {
    return adminLogin(request,db,await parseJSON(request));
  }

  if (method === "POST" && path === "quote") {
    return createQuote(request,env,db);
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
      schedule:s.schedule
    });
  }

  if (method === "GET" && path === "portfolio") {
    const rows = await db.prepare(
      "SELECT id,description,created_at,updated_at FROM portfolio ORDER BY created_at DESC"
    ).all();
    const origin = url.origin;
    return json(200,{
      portfolio:(rows.results || []).map(p => ({
        ...p,
        image_url: `${origin}/api/portfolio-image?id=${encodeURIComponent(p.id)}`
      }))
    });
  }

  if (method === "GET" && path === "portfolio-image") {
    const p = await db.prepare("SELECT r2_key FROM portfolio WHERE id=?")
      .bind(url.searchParams.get("id")).first();
    if (!p?.r2_key) return new Response("Imagen no encontrada",{status:404});
    const obj = await env.R2.get(p.r2_key);
    if (!obj) return new Response("Imagen no encontrada",{status:404});
    return new Response(obj.body,{
      headers:{
        "content-type":obj.httpMetadata?.contentType || "application/octet-stream",
        "cache-control":"public, max-age=3600"
      }
    });
  }

  if (method === "GET" && path === "reference") {
    return getReference(env,db,request,url.searchParams.get("quote_id"));
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
        SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled
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
      cancelled:Number(summary?.cancelled || 0)
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
    return json(200,await adminData(db));
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
      SELECT q.*,c.name,c.whatsapp FROM quotes q JOIN clients c ON c.id=q.client_id WHERE q.id=?
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
Cualquier consulta avísame! Si te parece podemos reservar una fecha y hora
¡Muchas gracias!`
    });
  }

  if (method === "GET" && path === "admin/quote") {
    const q = await db.prepare(`
      SELECT q.*,c.name,c.whatsapp FROM quotes q JOIN clients c ON c.id=q.client_id WHERE q.id=?
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
    await db.prepare("DELETE FROM day_blocks WHERE date=?")
      .bind(url.searchParams.get("date")).run();
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
    const allowed = ["studio_name","artist_name","description","address","maps_url","instagram"];
    const s = await getSettings(db);
    const next = Object.fromEntries(allowed.map(k => [k, body[k] !== undefined ? String(body[k]) : s[k]]));
    await db.prepare(`
      UPDATE settings
      SET studio_name=?,artist_name=?,description=?,address=?,maps_url=?,instagram=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=1
    `).bind(next.studio_name,next.artist_name,next.description,next.address,next.maps_url,next.instagram).run();
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
    const form = await request.formData();
    const image = form.get("image");
    const description = String(form.get("description") || "").trim();
    if (!image || typeof image === "string") return json(400,{error:"Falta la imagen."});
    if (image.size > MAX_PORTFOLIO_BYTES) return json(413,{error:"La imagen supera 12 MB."});
    const type = String(image.type || "").toLowerCase();
    if (!["image/jpeg","image/png","image/webp"].includes(type)) {
      return json(400,{error:"Portfolio: JPG, PNG o WEBP."});
    }
    const id = uid("pf");
    const key = `portfolio/${new Date().toISOString().slice(0,10)}/${id}`;
    await env.R2.put(key,image.stream(),{httpMetadata:{contentType:type}});
    await db.prepare("INSERT INTO portfolio(id,r2_key,description) VALUES(?,?,?)")
      .bind(id,key,description).run();
    return json(201,{ok:true,id});
  }

  if (method === "DELETE" && path === "admin/portfolio") {
    const id = url.searchParams.get("id");
    const p = await db.prepare("SELECT r2_key FROM portfolio WHERE id=?").bind(id).first();
    if (p) {
      await env.R2.delete(p.r2_key);
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

  if (method === "POST" && path === "admin/stock/restock") {
    const body = await parseJSON(request);
    const id = String(body.id || "");
    const qty = Number(body.quantity);
    if (!id || !Number.isFinite(qty) || qty <= 0) return json(400,{error:"Cantidad inválida."});
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
      if (url.pathname.startsWith("/api/")) {
        return handleAPI(request,env,ctx);
      }
      if (env.ASSETS) {
        const assetPath = url.pathname === "/" || url.pathname === "/reservar" || url.pathname === "/reservar/"
          ? "/index.html"
          : url.pathname === "/gestion" || url.pathname === "/gestion/"
            ? "/gestion.html"
            : url.pathname;
        return env.ASSETS.fetch(new Request(new URL(assetPath, request.url), request));
      }
      return new Response("No encontrado",{status:404});
    } catch (e) {
      console.error(e);
      return json(500,{error:"Error interno",diagnostic:"SOLOTINTA_INTERNAL_ERROR"});
    }
  },

  async scheduled(event, env, ctx) {
    if (!env.DB) return;
    ctx.waitUntil((async () => {
      await cleanupReferences(env,env.DB);
      await sendDueReminderNotifications(env.DB);
    })());
  }
};
