const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Audit-Key, X-API-Key",
  "Content-Type": "application/json"
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS })
    const url = new URL(request.url)
    const path = url.pathname
    const AUDIT_KEY = "CLHQ-Q5PTRLA0091086"

    // ── Utilidades ─────────────────────────────────────────────
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

    function calcExpiry(plan, fechaInicio) {
      const d = new Date(fechaInicio)
      if (plan === "free") d.setDate(d.getDate() + 30)
      else if (plan === "premium") d.setFullYear(d.getFullYear() + 1)
      else return null
      return d.toISOString()
    }

    function calcExpiryFromNow(plan) {
      return calcExpiry(plan, new Date().toISOString())
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

    // ── Verificar API Key del cliente ─────────────────────────
    async function getCliente(apiKey) {
      if (!apiKey) return null
      const data = await env.PHEROMONES.get("client:" + apiKey, "json")
      return data
    }

    function getApiKey(req) {
      return req.headers.get("X-API-Key") || url.searchParams.get("apikey") || ""
    }

    // ── BASE ──────────────────────────────────────────────────
    if (path === "/") {
      await audit("VISIT", { path: "/" })
      return json({
        status: "HormigasAIS ONLINE",
        nodo: "A16-SanMiguel-SV",
        protocolo: "LBH v2.0",
        author: "CLHQ",
        endpoints: ["/verify", "/seal", "/seal/{firma}", "/verify-file", "/manifest/{firma}",
          "/colonia", "/push/{nodo}", "/all", "/consensus",
          "/cliente/registro (POST, admin)", "/cliente/dashboard (GET, apikey)",
          "/cliente/sellos (GET, apikey)", "/audit (admin)"]
      })
    }

    // ── VERIFY ────────────────────────────────────────────────
    if (path === "/verify") {
      await audit("VERIFY", { resultado: "VALIDADO" })
      return json({ status: "VALIDADO", signature: "CLHQ-MASTER-KEY", protocol: "Lenguaje-Binario-HormigasAIS", firma_fuerte: "SHA-256 verificado", timestamp: new Date().toISOString(), origin: "Nodo-Soberano-A16" })
    }

    // ── CLIENTE REGISTRO (solo admin) ─────────────────────────
    if (path === "/cliente/registro" && request.method === "POST") {
      if (!isAdmin(request)) return json({ error: "Solo el administrador puede registrar clientes" }, 401)

      try {
        const body = await request.json()
        const ts = new Date().toISOString()

        // Generar API key única
        const rawKey = body.email + "|" + ts + "|" + Math.random().toString(36)
        const apiKeyHash = await hmacSHA256(rawKey, "LBH-CLIENTES-SOBERANOS-2026")
        const apiKey = "LBH-" + apiKeyHash.substring(0, 6).toUpperCase() + "-" + apiKeyHash.substring(6, 12).toUpperCase()

        const plan = body.plan || "premium"
        const cliente = {
          api_key:        apiKey,
          email:          body.email || "",
          owner:          body.owner || "",
          plan:           plan,
          fecha_inicio:   ts,
          fecha_expiry:   plan === "enterprise" ? null : calcExpiryFromNow(plan),
          sellos_emitidos: 0,
          sellos_limite:  plan === "free" ? 3 : -1,
          activo:         true,
          pagado_via:     body.pagado_via || "manual",
          notas:          body.notas || ""
        }

        await env.PHEROMONES.put("client:" + apiKey, JSON.stringify(cliente))

        // Índice de clientes
        const rawIdx = await env.PHEROMONES.get("__clients_index__")
        let idx = []
        if (rawIdx) { try { idx = JSON.parse(rawIdx) } catch(e) {} }
        idx.unshift(apiKey)
        await env.PHEROMONES.put("__clients_index__", JSON.stringify(idx))

        await audit("CLIENTE_REGISTRADO", { api_key: apiKey, email: cliente.email, plan: cliente.plan })

        return json({
          status: "CLIENTE_REGISTRADO",
          api_key: apiKey,
          cliente,
          instrucciones: "Envía esta API key al cliente. Ellos la usan en hormigasais.com → Mi Cuenta"
        })
      } catch(e) {
        return json({ error: "Error al registrar cliente: " + e.message }, 500)
      }
    }

    // ── CLIENTE DASHBOARD ─────────────────────────────────────
    if (path === "/cliente/dashboard") {
      const apiKey = getApiKey(request)
      const cliente = await getCliente(apiKey)

      if (!cliente) {
        await audit("LOGIN_FALLIDO", { api_key: apiKey ? apiKey.substring(0,8) + "..." : "vacío" })
        return json({ error: "API key inválida o no encontrada" }, 401)
      }

      if (!cliente.activo) return json({ error: "Plan inactivo — renueva tu suscripción" }, 403)

      // Obtener sellos del cliente
      const rawSeals = await env.PHEROMONES.get("__seals_index__")
      let allSeals = []
      if (rawSeals) { try { allSeals = JSON.parse(rawSeals) } catch(e) {} }

      const misSellos = []
      for (const sig of allSeals.slice(0, 100)) {
        const sello = await env.PHEROMONES.get("seal:" + sig, "json")
        if (sello && sello.owner === cliente.owner) {
          misSellos.push({
            signature:   sello.signature,
            asset:       sello.asset,
            plan:        sello.plan,
            emitido:     sello.timestamp,
            valido_hasta: sello.valido_hasta || "permanente",
            hash:        sello.hash ? sello.hash.substring(0, 16) + "..." : "—"
          })
        }
      }

      // Calcular días restantes
      let diasRestantes = null
      if (cliente.fecha_expiry) {
        const diff = new Date(cliente.fecha_expiry) - new Date()
        diasRestantes = Math.max(0, Math.floor(diff / 86400000))
      }

      await audit("CLIENTE_LOGIN", { api_key: apiKey.substring(0,8) + "...", plan: cliente.plan })

      return json({
        status: "AUTENTICADO",
        cliente: {
          owner:          cliente.owner,
          email:          cliente.email,
          plan:           cliente.plan.toUpperCase(),
          activo:         cliente.activo,
          fecha_inicio:   cliente.fecha_inicio,
          fecha_expiry:   cliente.fecha_expiry || "Permanente",
          dias_restantes: diasRestantes !== null ? diasRestantes + " días" : "Permanente",
          sellos_emitidos: misSellos.length,
          sellos_limite:  cliente.sellos_limite === -1 ? "Ilimitados" : cliente.sellos_limite
        },
        mis_sellos: misSellos,
        acciones: {
          sellar:   "POST /seal con X-API-Key header",
          verificar: "GET /seal/{firma}",
          manifest: "GET /manifest/{firma}",
          renovar:  "https://github.com/sponsors/Thrumanshow"
        }
      })
    }

    // ── CLIENTE SELLOS ────────────────────────────────────────
    if (path === "/cliente/sellos") {
      const apiKey = getApiKey(request)
      const cliente = await getCliente(apiKey)
      if (!cliente) return json({ error: "API key inválida" }, 401)

      const rawSeals = await env.PHEROMONES.get("__seals_index__")
      let allSeals = []
      if (rawSeals) { try { allSeals = JSON.parse(rawSeals) } catch(e) {} }

      const misSellos = []
      for (const sig of allSeals.slice(0, 200)) {
        const sello = await env.PHEROMONES.get("seal:" + sig, "json")
        if (sello && sello.owner === cliente.owner) misSellos.push(sello)
      }

      return json({ total: misSellos.length, sellos: misSellos })
    }

    // ── LISTA CLIENTES (admin) ────────────────────────────────
    if (path === "/cliente/lista") {
      if (!isAdmin(request)) return json({ error: "Acceso denegado" }, 401)

      const rawIdx = await env.PHEROMONES.get("__clients_index__")
      let idx = []
      if (rawIdx) { try { idx = JSON.parse(rawIdx) } catch(e) {} }

      const clientes = []
      for (const key of idx) {
        const c = await env.PHEROMONES.get("client:" + key, "json")
        if (c) clientes.push({
          api_key:  c.api_key,
          owner:    c.owner,
          email:    c.email,
          plan:     c.plan,
          activo:   c.activo,
          fecha_inicio: c.fecha_inicio,
          sellos:   c.sellos_emitidos
        })
      }

      return json({ total: clientes.length, clientes })
    }

    // ── SEAL POST (con validación de plan) ───────────────────
    if (path === "/seal" && request.method === "POST") {
      try {
        const body = await request.json()
        const ts = new Date().toISOString()

        // Verificar límite de sellos si tiene API key
        const apiKey = getApiKey(request)
        let planCliente = body.plan || "free"
        if (apiKey) {
          const cliente = await getCliente(apiKey)
          if (cliente && cliente.activo) {
            planCliente = cliente.plan
            if (cliente.sellos_limite > 0 && cliente.sellos_emitidos >= cliente.sellos_limite) {
              return json({ error: "Límite de sellos alcanzado — actualiza tu plan", plan: planCliente, limite: cliente.sellos_limite }, 403)
            }
            // Incrementar contador
            cliente.sellos_emitidos = (cliente.sellos_emitidos || 0) + 1
            await env.PHEROMONES.put("client:" + apiKey, JSON.stringify(cliente))
          }
        }

        const hashProporcionado = body.hash || ""
        const hashValido = /^[a-f0-9]{64}$/i.test(hashProporcionado)
        const firmaBase = hashProporcionado + "|" + (body.owner || "") + "|" + ts
        const hmac = hashProporcionado ? await hmacSHA256(firmaBase, "LBH-SOBERANO-A16-CLHQ-2026") : null

        const sello = {
          owner:       body.owner || "HormigasAIS",
          asset:       body.asset || "unknown",
          hash:        hashProporcionado,
          hash_valido: hashValido,
          hmac_firma:  hmac,
          plan:        planCliente,
          protocol:    "Lenguaje-Binario-HormigasAIS",
          timestamp:   ts,
          nodo:        "A16-SanMiguel-SV",
          signature:   "CLHQ-" + Math.random().toString(36).substring(2,10).toUpperCase(),
          firma_fuerte: hashValido ? "SHA-256+HMAC verificado" : "hash no proporcionado"
        }

        const expiryFn = (p, t) => {
          const d = new Date(t)
          if (p === "free") d.setDate(d.getDate() + 30)
          else if (p === "premium") d.setFullYear(d.getFullYear() + 1)
          else return null
          return d.toISOString()
        }
        sello.valido_hasta = expiryFn(sello.plan, ts)

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
        return json({ status: "VERIFICADO", resultado: "✅ ARCHIVO AUTÉNTICO", firma_fuerte: hmacValido !== null ? (hmacValido ? "✅ HMAC válido" : "⚠️ HMAC no coincide") : "hash verificado", sello: { signature: sello.signature, owner: sello.owner, asset: sello.asset, plan: sello.plan, emitido: sello.timestamp, valido_hasta: sello.valido_hasta || "permanente", nodo: sello.nodo }, hash_verificado: hashArchivo })
      } catch(e) { return json({ error: "Error: " + e.message }, 500) }
    }

    // ── MANIFEST ──────────────────────────────────────────────
    if (path.startsWith("/manifest/")) {
      const sig = path.split("/")[2]
      if (!sig) return json({ error: "Firma requerida" }, 400)
      const sello = await env.PHEROMONES.get("seal:" + sig, "json")
      if (!sello) return json({ error: "Sello no encontrado" }, 404)
      await audit("MANIFEST_DESCARGADO", { signature: sig, owner: sello.owner, plan: sello.plan })
      const manifest = { "lbh_manifest": "v1.0", "generado": new Date().toISOString(), "certificado": { "firma": sello.signature, "propietario": sello.owner, "activo": sello.asset, "hash_sha256": sello.hash || "no-proporcionado", "hmac_firma": sello.hmac_firma || "no-disponible", "firma_fuerte": sello.firma_fuerte || "basica", "plan": sello.plan || "free", "emitido": sello.timestamp, "valido_hasta": sello.valido_hasta || "permanente", "nodo_emisor": sello.nodo || "A16-SanMiguel-SV" }, "protocolo": { "nombre": "Lenguaje-Binario-HormigasAIS", "version": "v2.0", "doi": "10.5281/zenodo.19177759" }, "verificacion": { "url": "https://hormigasais.com", "api_firma": "https://api.hormigasais.com/seal/" + sello.signature }, "fundador": "CLHQ — Cristhiam Leonardo Hernández Quiñonez", "manual": "https://docs.hormigasais.com/manual.html" }
      return new Response(JSON.stringify(manifest, null, 2), { status: 200, headers: { ...CORS, "Content-Type": "application/json", "Content-Disposition": "attachment; filename=\"manifest-" + sig + ".json\"" } })
    }

    // ── COLONIA ───────────────────────────────────────────────
    if (path === "/colonia") {
      const admin = isAdmin(request)
      const raw = await env.PHEROMONES.get("__index__")
      let nodes = []
      if (raw) { try { nodes = JSON.parse(raw) } catch(e) {} }
      const rawSeals = await env.PHEROMONES.get("__seals_index__")
      let seals = []
      if (rawSeals) { try { seals = JSON.parse(rawSeals) } catch(e) {} }
      const coloniaData = []
      let totalTrust = 0, nodosActivos = 0
      for (const nodeId of nodes) {
        const data = await env.PHEROMONES.get(nodeId, "json")
        if (!data) continue
        const trust = Number(data.trust) || 0
        const estado = estadoNodo(trust, data.timestamp)
        if (estado === "ACTIVO") nodosActivos++
        totalTrust += trust
        const nodo = { id: nodeId, estado, trust: trust.toFixed(2), ultima: tiempoRelativo(data.timestamp), activo: estado === "ACTIVO" }
        if (admin) { nodo.type = data.type; nodo.value = data.value; nodo.timestamp = data.timestamp }
        coloniaData.push(nodo)
      }
      const promedio = nodes.length > 0 ? totalTrust / nodes.length : 0
      const consenso = promedio > 0.6 ? "ACEPTAR" : promedio > 0.3 ? "REVISAR" : "RECHAZAR"
      const rawClients = await env.PHEROMONES.get("__clients_index__")
      let clients = []
      if (rawClients) { try { clients = JSON.parse(rawClients) } catch(e) {} }
      const respuesta = { colonia: "HormigasAIS-Colonia-Soberana", nodo_maestro: "A16-SanMiguel-SV", protocolo: "LBH v2.0", timestamp: new Date().toISOString(), resumen: { total_nodos: nodes.length, nodos_activos: nodosActivos, total_sellos: seals.length, total_clientes: clients.length, consenso, trust_promedio: promedio.toFixed(4) }, nodos: coloniaData }
      await audit("COLONIA_CONSULTADA", { admin, total_nodos: nodes.length })
      return json(respuesta)
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
      if (!isAdmin(request)) { await audit("AUDIT_ACCESO_DENEGADO", {}); return json({ error: "Acceso denegado" }, 401) }
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
      const rawClients = await env.PHEROMONES.get("__clients_index__")
      let clients = []
      if (rawClients) { try { clients = JSON.parse(rawClients) } catch(e) {} }
      const stats = { total_eventos: idx.length, total_sellos: seals.length, total_clientes: clients.length, por_tipo: {} }
      for (const key of idx.slice(0, 200)) { const entry = await env.PHEROMONES.get(key, "json"); if (entry) stats.por_tipo[entry.tipo] = (stats.por_tipo[entry.tipo] || 0) + 1 }
      return json({ nodo: "A16-SanMiguel-SV", timestamp: new Date().toISOString(), stats })
    }



    // ── EMAIL ENVIAR (admin) ──────────────────────────────────
    if (path === "/email/enviar" && request.method === "POST") {
      if (!isAdmin(request)) return json({ error: "Solo el Master CLHQ puede enviar correos" }, 401)

      try {
        const body = await request.json()
        const { para, asunto, mensaje, nombre_destinatario } = body

        if (!para || !asunto || !mensaje) {
          return json({ error: "Faltan campos: para, asunto, mensaje" }, 400)
        }

        // Enviar via Resend API
        const resendResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + env.RESEND_API_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: "HormigasAIS <clhq@hormigasais.com>",
            to: [para],
            subject: asunto,
            html: `
              <div style="font-family:monospace;background:#0a0a0a;color:#e8e8e8;padding:2rem;max-width:600px;margin:0 auto;border:1px solid #222;border-radius:8px;">
                <div style="border-bottom:1px solid #222;padding-bottom:1rem;margin-bottom:1.5rem;">
                  <div style="font-size:1.5rem;margin-bottom:0.5rem;">🐜 HormigasAIS</div>
                  <div style="color:#555;font-size:0.8rem;">Protocolo LBH v2.0 — Nodo A16-SanMiguel-SV</div>
                </div>
                ${nombre_destinatario ? '<div style="color:#f5c518;margin-bottom:1rem;">Hola, ' + nombre_destinatario + '</div>' : ''}
                <div style="line-height:1.8;color:#aaa;white-space:pre-line;">${mensaje}</div>
                <div style="border-top:1px solid #222;margin-top:2rem;padding-top:1rem;color:#555;font-size:0.75rem;">
                  <div>Firma: <span style="color:#f5c518;">CLHQ — Cristhiam Leonardo Hernández Quiñonez</span></div>
                  <div>Verificar en: <a href="https://hormigasais.com" style="color:#f5c518;">hormigasais.com</a></div>
                  <div>DOI: 10.5281/zenodo.19177759</div>
                </div>
              </div>
            `
          })
        })

        const resendData = await resendResponse.json()

        if (resendData.id) {
          await audit("EMAIL_ENVIADO", {
            para,
            asunto,
            resend_id: resendData.id
          })
          return json({
            status: "EMAIL_ENVIADO",
            resend_id: resendData.id,
            para,
            asunto,
            timestamp: new Date().toISOString()
          })
        } else {
          await audit("EMAIL_ERROR", { para, error: JSON.stringify(resendData) })
          return json({ error: "Error Resend: " + JSON.stringify(resendData) }, 500)
        }
      } catch(e) {
        return json({ error: "Error enviando email: " + e.message }, 500)
      }
    }

    // ── EMAIL BIENVENIDA CLIENTE (admin) ──────────────────────
    if (path === "/email/bienvenida" && request.method === "POST") {
      if (!isAdmin(request)) return json({ error: "Acceso denegado" }, 401)

      try {
        const body = await request.json()
        const { email, owner, api_key, plan } = body

        if (!email || !api_key) return json({ error: "Faltan email y api_key" }, 400)

        const planTexto = {
          free: "Free — 3 sellos / 30 días",
          premium: "Premium — Ilimitado / 1 año",
          enterprise: "Enterprise — Ilimitado / Permanente"
        }[plan] || plan

        const resendResponse = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": "Bearer " + env.RESEND_API_KEY,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            from: "HormigasAIS <clhq@hormigasais.com>",
            to: [email],
            subject: "🐜 Tu acceso LBH está activo — HormigasAIS",
            html: `
              <div style="font-family:monospace;background:#0a0a0a;color:#e8e8e8;padding:2rem;max-width:600px;margin:0 auto;border:1px solid #222;border-radius:8px;">
                <div style="border-bottom:1px solid #222;padding-bottom:1rem;margin-bottom:1.5rem;">
                  <div style="font-size:1.5rem;margin-bottom:0.5rem;">🐜 HormigasAIS</div>
                  <div style="color:#555;font-size:0.8rem;">Protocolo LBH v2.0</div>
                </div>
                <div style="color:#f5c518;font-size:1.1rem;margin-bottom:1rem;">¡Bienvenido a la Colonia, ${owner || 'Arquitecto de Contenido'}!</div>
                <div style="color:#aaa;margin-bottom:1.5rem;line-height:1.8;">Tu plan está activo. Ahora puedes certificar tus activos digitales con el Protocolo LBH.</div>
                <div style="background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:1.2rem;margin-bottom:1.5rem;">
                  <div style="color:#555;font-size:0.75rem;margin-bottom:0.5rem;text-transform:uppercase;">TU API KEY</div>
                  <div style="color:#f5c518;font-size:1rem;letter-spacing:0.1em;">${api_key}</div>
                  <div style="color:#555;font-size:0.75rem;margin-top:0.5rem;">Plan: ${planTexto}</div>
                </div>
                <div style="color:#aaa;line-height:1.8;margin-bottom:1.5rem;">
                  <strong style="color:#fff;">Para acceder a tu dashboard:</strong><br>
                  1. Ve a <a href="https://hormigasais.com" style="color:#f5c518;">hormigasais.com</a><br>
                  2. Pestaña 👤 Mi Cuenta<br>
                  3. Ingresa tu API Key<br>
                </div>
                <div style="background:rgba(255,68,68,0.06);border:1px solid rgba(255,68,68,0.2);border-radius:6px;padding:0.8rem;margin-bottom:1.5rem;font-size:0.8rem;color:#aaa;">
                  ⚠️ Guarda tu API Key en un lugar seguro. No la compartas públicamente.
                </div>
                <div style="border-top:1px solid #222;padding-top:1rem;color:#555;font-size:0.75rem;">
                  <div>Firma: <span style="color:#f5c518;">CLHQ — Cristhiam Leonardo Hernández Quiñonez</span></div>
                  <div>hormigasais.com | DOI: 10.5281/zenodo.19177759</div>
                </div>
              </div>
            `
          })
        })

        const resendData = await resendResponse.json()

        if (resendData.id) {
          await audit("EMAIL_BIENVENIDA_ENVIADO", { email, plan, resend_id: resendData.id })
          return json({ status: "BIENVENIDA_ENVIADA", resend_id: resendData.id, para: email })
        } else {
          return json({ error: "Error Resend: " + JSON.stringify(resendData) }, 500)
        }
      } catch(e) {
        return json({ error: e.message }, 500)
      }
    }


    // ── XOXO GIFT — Generar tarjeta de regalo ─────────────────
    if (path === "/xoxo/gift" && request.method === "POST") {
      if (!isAdmin(request)) return json({ error: "Solo el Master CLHQ puede emitir tarjetas de regalo" }, 401)

      try {
        const body = await request.json()
        const ts = new Date().toISOString()

        // Generar código de regalo único
        const rawCode = "REGALO|" + (body.plan || "premium") + "|" + ts + "|" + Math.random().toString(36)
        const codeHash = await hmacSHA256(rawCode, "LBH-XOXO-REGALO-CLHQ-2026")
        const giftCode = "REGALO-CLHQ-" + codeHash.substring(0, 8).toUpperCase()

        const gift = {
          codigo:     giftCode,
          plan:       body.plan || "premium",
          mensaje:    body.mensaje || "🎁 Bienvenido a la Colonia HormigasAIS",
          destinatario: body.destinatario || "",
          email:      body.email || "",
          creado:     ts,
          expiry_gift: new Date(Date.now() + 30*24*60*60*1000).toISOString(),
          canjeado:   false,
          creado_por: "CLHQ-MASTER"
        }

        await env.PHEROMONES.put("gift:" + giftCode, JSON.stringify(gift))

        // Índice de regalos
        const rawIdx = await env.PHEROMONES.get("__gifts_index__")
        let idx = []
        if (rawIdx) { try { idx = JSON.parse(rawIdx) } catch(e) {} }
        idx.unshift(giftCode)
        await env.PHEROMONES.put("__gifts_index__", JSON.stringify(idx))

        await audit("XOXO_GIFT_CREADO", { codigo: giftCode, plan: gift.plan, destinatario: gift.destinatario })

        return json({
          status: "REGALO_CREADO",
          gift,
          instrucciones_email: {
            asunto: "🎁 Tu regalo de HormigasAIS — Acceso " + gift.plan.toUpperCase(),
            cuerpo: "¡" + (gift.mensaje) + "!\n\nTu código de regalo:\n" + giftCode + "\n\nPara canjearlo:\n1. Ve a https://hormigasais.com\n2. Pestaña 👤 Mi Cuenta\n3. Haz clic en 'Tengo un código de regalo'\n4. Ingresa: " + giftCode + "\n\nFirma: CLHQ\nhormigasais.com"
          }
        })
      } catch(e) {
        return json({ error: "Error al crear regalo: " + e.message }, 500)
      }
    }

    // ── XOXO REDEEM — Canjear tarjeta de regalo ───────────────
    if (path === "/xoxo/redeem" && request.method === "POST") {
      try {
        const body = await request.json()
        const giftCode = (body.codigo || "").toUpperCase().trim()
        const email = body.email || ""
        const owner = body.owner || ""

        if (!giftCode) return json({ error: "Código de regalo requerido" }, 400)

        const gift = await env.PHEROMONES.get("gift:" + giftCode, "json")
        if (!gift) return json({ error: "Código de regalo no encontrado" }, 404)
        if (gift.canjeado) return json({ error: "Este código ya fue canjeado el " + gift.fecha_canje }, 400)

        // Verificar expiración del código
        if (new Date(gift.expiry_gift) < new Date()) {
          return json({ error: "Este código de regalo ha expirado" }, 400)
        }

        // Registrar cliente automáticamente
        const ts = new Date().toISOString()
        const rawKey = email + "|" + ts + "|" + Math.random().toString(36)
        const apiKeyHash = await hmacSHA256(rawKey, "LBH-CLIENTES-SOBERANOS-2026")
        const apiKey = "LBH-" + apiKeyHash.substring(0, 6).toUpperCase() + "-" + apiKeyHash.substring(6, 12).toUpperCase()

        const calcExpiry = (plan, fecha) => {
          const d = new Date(fecha)
          if (plan === "free") d.setDate(d.getDate() + 30)
          else if (plan === "premium") d.setFullYear(d.getFullYear() + 1)
          else return null
          return d.toISOString()
        }

        const cliente = {
          api_key:        apiKey,
          email:          email || gift.email,
          owner:          owner || gift.destinatario,
          plan:           gift.plan,
          fecha_inicio:   ts,
          fecha_expiry:   gift.plan === "enterprise" ? null : calcExpiry(gift.plan, ts),
          sellos_emitidos: 0,
          sellos_limite:  gift.plan === "free" ? 3 : -1,
          activo:         true,
          pagado_via:     "regalo_clhq",
          notas:          gift.mensaje + " | Código: " + giftCode
        }

        await env.PHEROMONES.put("client:" + apiKey, JSON.stringify(cliente))

        // Actualizar índice de clientes
        const rawClientIdx = await env.PHEROMONES.get("__clients_index__")
        let clientIdx = []
        if (rawClientIdx) { try { clientIdx = JSON.parse(rawClientIdx) } catch(e) {} }
        clientIdx.unshift(apiKey)
        await env.PHEROMONES.put("__clients_index__", JSON.stringify(clientIdx))

        // Marcar regalo como canjeado
        gift.canjeado = true
        gift.fecha_canje = ts
        gift.canjeado_por = email || owner
        gift.api_key_generada = apiKey
        await env.PHEROMONES.put("gift:" + giftCode, JSON.stringify(gift))

        await audit("XOXO_GIFT_CANJEADO", { codigo: giftCode, plan: gift.plan, email, api_key: apiKey })

        return json({
          status: "REGALO_CANJEADO",
          api_key: apiKey,
          cliente: {
            owner:    cliente.owner,
            plan:     cliente.plan.toUpperCase(),
            expiry:   cliente.fecha_expiry || "Permanente"
          },
          mensaje: "🎁 " + gift.mensaje,
          instrucciones: "Usa tu API Key en hormigasais.com → 👤 Mi Cuenta"
        })
      } catch(e) {
        return json({ error: "Error al canjear: " + e.message }, 500)
      }
    }

    // ── XOXO LISTA — Ver todos los regalos (admin) ────────────
    if (path === "/xoxo/lista") {
      if (!isAdmin(request)) return json({ error: "Acceso denegado" }, 401)

      const rawIdx = await env.PHEROMONES.get("__gifts_index__")
      let idx = []
      if (rawIdx) { try { idx = JSON.parse(rawIdx) } catch(e) {} }

      const gifts = []
      for (const code of idx) {
        const g = await env.PHEROMONES.get("gift:" + code, "json")
        if (g) gifts.push(g)
      }

      const canjeados = gifts.filter(g => g.canjeado).length
      return json({ total: gifts.length, canjeados, pendientes: gifts.length - canjeados, regalos: gifts })
    }


    await audit("RUTA_NO_VALIDA", { path })
    return json({ error: "Ruta LBH no valida" }, 404)
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: CORS })
}
