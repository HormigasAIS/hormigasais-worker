const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Audit-Key",
  "Content-Type": "application/json"
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS })
    const url = new URL(request.url)
    const path = url.pathname
    const AUDIT_KEY = "CLHQ-Q5PTRLA0091086"

    async function audit(tipo, data) {
      try {
        const ts = new Date().toISOString()
        const key = "audit:" + ts + ":" + Math.random().toString(36).substring(2,8)
        const entry = { tipo, ts, ip: request.headers.get("CF-Connecting-IP") || "unknown", pais: request.headers.get("CF-IPCountry") || "unknown", ...data }
        await env.PHEROMONES.put(key, JSON.stringify(entry))
        const rawIdx = await env.PHEROMONES.get("__audit_index__")
        let idx = []
        if (rawIdx) { try { idx = JSON.parse(rawIdx) } catch(e) {} }
        idx.unshift(key)
        if (idx.length > 500) idx = idx.slice(0, 500)
        await env.PHEROMONES.put("__audit_index__", JSON.stringify(idx))
      } catch(e) {}
    }

    function isAdmin(req) {
      const k = req.headers.get("X-Audit-Key") || url.searchParams.get("key") || ""
      return k === AUDIT_KEY
    }

    function calcExpiry(plan, timestamp) {
      const d = new Date(timestamp)
      if (plan === "free") d.setDate(d.getDate() + 30)
      else if (plan === "premium") d.setFullYear(d.getFullYear() + 1)
      else return null
      return d.toISOString()
    }

    async function hmacSHA256(message, secret) {
      const enc = new TextEncoder()
      const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
      const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message))
      return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2,"0")).join("").substring(0, 32)
    }

    function tiempoRelativo(ts) {
      const diff = Date.now() - new Date(ts).getTime()
      const min = Math.floor(diff / 60000)
      const h = Math.floor(diff / 3600000)
      const d = Math.floor(diff / 86400000)
      if (d > 0) return "hace " + d + "d"
      if (h > 0) return "hace " + h + "h"
      if (min > 0) return "hace " + min + "min"
      return "ahora"
    }

    function estadoNodo(trust, ultimaActividad) {
      const diff = Date.now() - new Date(ultimaActividad).getTime()
      const horas = diff / 3600000
      if (horas > 24) return "INACTIVO"
      if (trust >= 0.7) return "ACTIVO"
      if (trust >= 0.4) return "DEGRADADO"
      return "CRITICO"
    }

    // ── BASE ──────────────────────────────────────────────────
    if (path === "/") {
      await audit("VISIT", { path: "/" })
      return json({
        status: "HormigasAIS ONLINE",
        nodo: "A16-SanMiguel-SV",
        protocolo: "LBH v2.0",
        firma_fuerte: "activa",
        author: "CLHQ",
        endpoints: ["/verify", "/seal", "/seal/{firma}", "/verify-file", "/manifest/{firma}", "/colonia", "/push/{nodo}", "/all", "/consensus", "/audit"]
      })
    }

    // ── VERIFY ────────────────────────────────────────────────
    if (path === "/verify") {
      await audit("VERIFY", { resultado: "VALIDADO" })
      return json({ status: "VALIDADO", signature: "CLHQ-MASTER-KEY", protocol: "Lenguaje-Binario-HormigasAIS", firma_fuerte: "SHA-256 verificado", timestamp: new Date().toISOString(), origin: "Nodo-Soberano-A16" })
    }

    // ── COLONIA (público básico + admin detallado) ─────────────
    if (path === "/colonia") {
      const admin = isAdmin(request)
      const raw = await env.PHEROMONES.get("__index__")
      let nodes = []
      if (raw) { try { nodes = JSON.parse(raw) } catch(e) {} }

      const rawSeals = await env.PHEROMONES.get("__seals_index__")
      let seals = []
      if (rawSeals) { try { seals = JSON.parse(rawSeals) } catch(e) {} }

      const coloniaData = []
      let totalTrust = 0
      let nodosActivos = 0

      for (const nodeId of nodes) {
        const data = await env.PHEROMONES.get(nodeId, "json")
        if (!data) continue

        const trust = Number(data.trust) || 0
        const estado = estadoNodo(trust, data.timestamp)
        const activo = estado === "ACTIVO"

        totalTrust += trust
        if (activo) nodosActivos++

        const nodoPublico = {
          id:       nodeId,
          estado,
          trust:    trust.toFixed(2),
          ultima:   tiempoRelativo(data.timestamp),
          activo
        }

        if (admin) {
          nodoPublico.type      = data.type
          nodoPublico.value     = data.value
          nodoPublico.timestamp = data.timestamp
          nodoPublico.raw       = data
        }

        coloniaData.push(nodoPublico)
      }

      const promedio = nodes.length > 0 ? totalTrust / nodes.length : 0
      const consenso = promedio > 0.6 ? "ACEPTAR" : promedio > 0.3 ? "REVISAR" : "RECHAZAR"

      const respuesta = {
        colonia: "HormigasAIS-Colonia-Soberana",
        nodo_maestro: "A16-SanMiguel-SV",
        protocolo: "LBH v2.0",
        timestamp: new Date().toISOString(),
        resumen: {
          total_nodos:   nodes.length,
          nodos_activos: nodosActivos,
          total_sellos:  seals.length,
          consenso,
          trust_promedio: promedio.toFixed(4)
        },
        nodos: coloniaData
      }

      if (admin) {
        respuesta.admin = {
          audit_total: (await env.PHEROMONES.get("__audit_index__").then(r => r ? JSON.parse(r).length : 0).catch(() => 0)),
          modo: "admin"
        }
      }

      await audit("COLONIA_CONSULTADA", { admin, total_nodos: nodes.length })
      return json(respuesta)
    }

    // ── SEAL POST ─────────────────────────────────────────────
    if (path === "/seal" && request.method === "POST") {
      try {
        const body = await request.json()
        const ts = new Date().toISOString()
        const hashProporcionado = body.hash || ""
        const hashValido = /^[a-f0-9]{64}$/i.test(hashProporcionado)
        const firmaBase = hashProporcionado + "|" + (body.owner || "") + "|" + ts
        const hmac = hashProporcionado ? await hmacSHA256(firmaBase, "LBH-SOBERANO-A16-CLHQ-2026") : null
        const sello = {
          owner: body.owner || "HormigasAIS", asset: body.asset || "unknown",
          hash: hashProporcionado, hash_valido: hashValido, hmac_firma: hmac,
          plan: body.plan || "free", protocol: "Lenguaje-Binario-HormigasAIS",
          timestamp: ts, nodo: "A16-SanMiguel-SV",
          signature: "CLHQ-" + Math.random().toString(36).substring(2,10).toUpperCase(),
          firma_fuerte: hashValido ? "SHA-256+HMAC verificado" : "hash no proporcionado"
        }
        sello.valido_hasta = calcExpiry(sello.plan, ts)
        await env.PHEROMONES.put("seal:" + sello.signature, JSON.stringify(sello))
        const rawIdx = await env.PHEROMONES.get("__seals_index__")
        let idx = []
        if (rawIdx) { try { idx = JSON.parse(rawIdx) } catch(e) {} }
        idx.unshift(sello.signature)
        await env.PHEROMONES.put("__seals_index__", JSON.stringify(idx))
        if (hashValido) await env.PHEROMONES.put("hash:" + hashProporcionado, sello.signature)
        await audit("SEAL_EMITIDO", { signature: sello.signature, owner: sello.owner, asset: sello.asset, plan: sello.plan, hash_valido: hashValido })
        return json({ status: "SELLADO", sello, firma_fuerte: hashValido ? "✅ Hash SHA-256 válido" : "⚠️ Sin hash" })
      } catch(e) {
        await audit("SEAL_ERROR", { error: e.message })
        return json({ error: "Paquete LBH invalido" }, 400)
      }
    }

    // ── SEAL GET ──────────────────────────────────────────────
    if (path.match(/^\/seal\/[^/]+$/)) {
      const sig = path.split("/")[2]
      const data = await env.PHEROMONES.get("seal:" + sig, "json")
      await audit("SEAL_VERIFICADO", { signature: sig, encontrado: !!data, owner: data ? data.owner : null })
      if (data) return json({ status: "VERIFICADO", sello: data })
      return json({ error: "Sello no encontrado" }, 404)
    }

    // ── VERIFY-FILE ───────────────────────────────────────────
    if (path === "/verify-file" && request.method === "POST") {
      try {
        const body = await request.json()
        const hashArchivo = (body.hash || "").toLowerCase().trim()
        if (!hashArchivo || !/^[a-f0-9]{64}$/i.test(hashArchivo)) return json({ error: "Hash SHA-256 inválido" }, 400)
        const sigEncontrada = await env.PHEROMONES.get("hash:" + hashArchivo)
        if (!sigEncontrada) {
          await audit("VERIFY_FILE_NO_ENCONTRADO", { hash: hashArchivo.substring(0,16) + "..." })
          return json({ status: "NO_ENCONTRADO", mensaje: "Este archivo no tiene ningún sello LBH registrado", hash: hashArchivo }, 404)
        }
        const sello = await env.PHEROMONES.get("seal:" + sigEncontrada, "json")
        if (!sello) return json({ error: "Sello corrupto" }, 500)
        let hmacValido = null
        if (sello.hmac_firma) {
          const firmaBase = hashArchivo + "|" + sello.owner + "|" + sello.timestamp
          const hmacCalculado = await hmacSHA256(firmaBase, "LBH-SOBERANO-A16-CLHQ-2026")
          hmacValido = hmacCalculado === sello.hmac_firma
        }
        await audit("VERIFY_FILE_OK", { signature: sigEncontrada, owner: sello.owner, hmac_valido: hmacValido })
        return json({ status: "VERIFICADO", resultado: "✅ ARCHIVO AUTÉNTICO", firma_fuerte: hmacValido !== null ? (hmacValido ? "✅ HMAC válido" : "⚠️ HMAC no coincide") : "hash verificado", sello: { signature: sello.signature, owner: sello.owner, asset: sello.asset, plan: sello.plan, emitido: sello.timestamp, valido_hasta: sello.valido_hasta || "permanente", nodo: sello.nodo, protocol: sello.protocol }, hash_verificado: hashArchivo })
      } catch(e) { return json({ error: "Error en verificación: " + e.message }, 500) }
    }

    // ── MANIFEST ──────────────────────────────────────────────
    if (path.startsWith("/manifest/")) {
      const sig = path.split("/")[2]
      if (!sig) return json({ error: "Firma requerida" }, 400)
      const sello = await env.PHEROMONES.get("seal:" + sig, "json")
      if (!sello) { await audit("MANIFEST_NO_ENCONTRADO", { signature: sig }); return json({ error: "Sello no encontrado" }, 404) }
      await audit("MANIFEST_DESCARGADO", { signature: sig, owner: sello.owner, plan: sello.plan })
      const manifest = { "lbh_manifest": "v1.0", "generado": new Date().toISOString(), "certificado": { "firma": sello.signature, "propietario": sello.owner, "activo": sello.asset, "hash_sha256": sello.hash || "no-proporcionado", "hmac_firma": sello.hmac_firma || "no-disponible", "firma_fuerte": sello.firma_fuerte || "basica", "plan": sello.plan || "free", "emitido": sello.timestamp, "valido_hasta": sello.valido_hasta || "permanente", "nodo_emisor": sello.nodo || "A16-SanMiguel-SV" }, "protocolo": { "nombre": "Lenguaje-Binario-HormigasAIS", "version": "v2.0", "doi": "10.5281/zenodo.19177759" }, "verificacion": { "url": "https://hormigasais.com", "api_firma": "https://api.hormigasais.com/seal/" + sello.signature, "api_archivo": "POST https://api.hormigasais.com/verify-file" }, "uso": { "sitio_web": "<a href=\"https://hormigasais.com/verify?sig=" + sello.signature + "\">Certificado LBH</a>", "readme_github": "[![LBH](badge-" + sello.signature + ".png)](https://hormigasais.com)", "manual": "https://docs.hormigasais.com/manual.html" }, "fundador": "CLHQ — Cristhiam Leonardo Hernández Quiñonez" }
      return new Response(JSON.stringify(manifest, null, 2), { status: 200, headers: { ...CORS, "Content-Type": "application/json", "Content-Disposition": "attachment; filename=\"manifest-" + sig + ".json\"" } })
    }

    // ── PUSH ──────────────────────────────────────────────────
    if (path.startsWith("/push/") && request.method === "POST") {
      const node = path.split("/")[2]
      try {
        const body = await request.json()
        const data = { type: body.type || "learning", node, value: Number(body.value) || 0, trust: Number(body.trust) || 0.5, timestamp: new Date().toISOString() }
        await env.PHEROMONES.put(node, JSON.stringify(data))
        const raw = await env.PHEROMONES.get("__index__")
        let nodes = []
        if (raw) { try { nodes = JSON.parse(raw) } catch(e) {} }
        if (!nodes.includes(node)) { nodes.push(node); await env.PHEROMONES.put("__index__", JSON.stringify(nodes)) }
        await audit("FEROMONA_PUSH", { node, type: data.type, value: data.value, trust: data.trust })
        return json({ ok: true, stored: data, nodes_total: nodes.length })
      } catch(e) { return json({ error: "Paquete LBH invalido" }, 400) }
    }

    // ── ALL ───────────────────────────────────────────────────
    if (path === "/all") {
      const raw = await env.PHEROMONES.get("__index__")
      let nodes = []
      if (raw) { try { nodes = JSON.parse(raw) } catch(e) {} }
      const result = []
      for (const node of nodes) { const data = await env.PHEROMONES.get(node, "json"); if (data) result.push(data) }
      return json(result)
    }

    // ── CONSENSUS ─────────────────────────────────────────────
    if (path === "/consensus") {
      const raw = await env.PHEROMONES.get("__index__")
      let nodes = []
      if (raw) { try { nodes = JSON.parse(raw) } catch(e) {} }
      let total = 0, count = 0
      for (const node of nodes) { const data = await env.PHEROMONES.get(node, "json"); if (data) { total += Number(data.value) || 0; count++ } }
      const promedio = count > 0 ? total / count : 0
      return json({ consensus: promedio > 0.6 ? "ACEPTAR" : "RECHAZAR", promedio: promedio.toFixed(4), nodos: count })
    }

    // ── AUDIT ─────────────────────────────────────────────────
    if (path === "/audit") {
      if (!isAdmin(request)) { await audit("AUDIT_ACCESO_DENEGADO", { motivo: "clave incorrecta" }); return json({ error: "Acceso denegado" }, 401) }
      const limite = parseInt(url.searchParams.get("limit") || "50")
      const tipo = url.searchParams.get("tipo") || null
      const rawIdx = await env.PHEROMONES.get("__audit_index__")
      let idx = []
      if (rawIdx) { try { idx = JSON.parse(rawIdx) } catch(e) {} }
      const entries = []
      for (const key of idx.slice(0, limite)) { const entry = await env.PHEROMONES.get(key, "json"); if (entry && (!tipo || entry.tipo === tipo)) entries.push(entry) }
      return json({ total: entries.length, eventos: entries })
    }

    if (path === "/audit/stats") {
      if (!isAdmin(request)) return json({ error: "Acceso denegado" }, 401)
      const rawIdx = await env.PHEROMONES.get("__audit_index__")
      let idx = []
      if (rawIdx) { try { idx = JSON.parse(rawIdx) } catch(e) {} }
      const rawSeals = await env.PHEROMONES.get("__seals_index__")
      let seals = []
      if (rawSeals) { try { seals = JSON.parse(rawSeals) } catch(e) {} }
      const stats = { total_eventos: idx.length, total_sellos: seals.length, por_tipo: {} }
      for (const key of idx.slice(0, 200)) { const entry = await env.PHEROMONES.get(key, "json"); if (entry) stats.por_tipo[entry.tipo] = (stats.por_tipo[entry.tipo] || 0) + 1 }
      return json({ nodo: "A16-SanMiguel-SV", timestamp: new Date().toISOString(), stats })
    }

    await audit("RUTA_NO_VALIDA", { path })
    return json({ error: "Ruta LBH no valida" }, 404)
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: CORS })
}
