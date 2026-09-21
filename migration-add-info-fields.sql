-- Ejecutar UNA sola vez contra la base D1 que ya está en producción,
-- para agregar los campos del popup "Información del estudio" y
-- dejarlos completos con contenido de ejemplo.
-- Si tu base es nueva y corriste schema.sql completo, no hace falta este archivo:
-- las columnas y los textos ya vienen incluidos ahí.
--
-- Uso: wrangler d1 execute solo-tinta-ink --remote --file=migration-add-info-fields.sql
--
-- Los textos de abajo son de ejemplo — Feli los puede editar en cualquier
-- momento desde Gestión > Ajustes > "Editar datos del estudio".

ALTER TABLE settings ADD COLUMN safety_info TEXT NOT NULL DEFAULT '';
ALTER TABLE settings ADD COLUMN contact_info TEXT NOT NULL DEFAULT '';

UPDATE settings SET
  description = 'Estudio de tatuajes especializado en fine line, black & grey y realismo. Feli atiende con cita previa, un cliente a la vez, para dar tranquilidad y atención personalizada en cada sesión.',
  address = 'Av. Colón 1140, Pergamino, Buenos Aires',
  maps_url = 'https://maps.google.com/?q=Av.+Colón+1140,+Pergamino,+Buenos+Aires',
  safety_info = 'Todo el material de un solo uso (agujas, guantes, campos, vaselina) se abre nuevo delante del cliente y se descarta después de cada sesión. El instrumental reutilizable se esteriliza en autoclave certificado, y se trabaja con tintas homologadas para uso dérmico. Feli mantiene actualizado su curso de bioseguridad para tatuadores.',
  contact_info = 'WhatsApp del estudio: +54 9 2477 40-1234 · También por Instagram (@solo.tinta.ink)'
WHERE id = 1;
