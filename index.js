const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Audit-Key",
  "Content-Type": "application/json"
}

// Clave de auditoría — se configura como variable de entorno en Cloudflare
const AUDIT_SECRET = "CLHQ-Q5PTRLA01"

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS })
    const url = new URL(request.url)
    const path = url.pathname

    // Registrar evento de auditoría
    async function audit(env, tipo, data) {
      try {
        const ts = new Date().toISOString()
        const key = "audit:" + ts + ":" + Math.random().toString(36).substring(2,8)
        const entry = {
          tipo,
          ts,
          ip: request.headers.get("CF-Connecting-IP") || "unknown",
          pais: request.headers.get("CF-IPCountry") || "unknown",
          agente: request.headers.get("User-Agent") || "unknown",
          ...data
        }
        await env.PHEROMONES.put(key, JSON.stringify(entry))

        // Actualizar índice de auditoría
        const rawIdx = await env.PHEROMONES.get("__audit_index__")
        let idx = []
        if (rawIdx) { try { idx = JSON.parse(rawIdx) } catch(e) {} }
        idx.unshift(key)
        if (idx.length > 500) idx = idx.slice(0, 500) // máx 500 entradas
        await env.PHEROMONES.put("__audit_index__", JSON.stringify(idx))
      } catch(e) {}
    }

    // Verificar clave de auditoría
    function isAdmin(request) {
      const key = request.headers.get("X-Audit-Key") || url.searchParams.get("key") || ""
      return key === AUDIT_SECRET
    }

    // --- BASE ---
    if (path === "/") {
      await audit(env, "VISIT", { path: "/" })
      return json({
        status: "HormigasAIS ONLINE",
        nodo: "A16-SanMiguel-SV",
        protocolo: "LBH v2.0",
        author: "CLHQ",
        endpoints: ["/verify", "/seal", "/seal/{firma}", "/push/{nodo}", "/all", "/consensus", "/audit (privado)"]
      })
    }

    // --- VERIFY ---
    if (path === "/verify") {
      await audit(env, "VERIFY", { resultado: "VALIDADO" })
      return json({
        status: "VALIDADO",
        signature: "CLHQ-MASTER-KEY",
        protocol: "Lenguaje-Binario-HormigasAIS",
        timestamp: new Date().toISOString(),
        origin: "Nodo-Soberano-A16"
      })
    }

    // --- SEAL POST ---
    if (path === "/seal" && request.method === "POST") {
      try {
        const body = await request.json()
        const sello = {
          owner: body.owner || "HormigasAIS",
          asset: body.asset || "unknown",
          hash: body.hash || "",
          plan: body.plan || "free",
          protocol: "Lenguaje-Binario-HormigasAIS",
          timestamp: new Date().toISOString(),
          nodo: "A16-SanMiguel-SV",
          signature: "CLHQ-" + Math.random().toString(36).substring(2, 10).toUpperCase()
        }
        await env.PHEROMONES.put("seal:" + sello.signature, JSON.stringify(sello))

        // Actualizar índice de sellos
        const rawIdx = await env.PHEROMONES.get("__seals_index__")
        let idx = []
        if (rawIdx) { try { idx = JSON.parse(rawIdx) } catch(e) {} }
        idx.unshift(sello.signature)
        await env.PHEROMONES.put("__seals_index__", JSON.stringify(idx))

        // Auditoría
        await audit(env, "SEAL_EMITIDO", {
          signature: sello.signature,
          owner: sello.owner,
          asset: sello.asset,
          plan: sello.plan,
          hash: sello.hash ? sello.hash.substring(0,16) + "..." : ""
        })

        return json({ status: "SELLADO", sello })
      } catch(e) {
        await audit(env, "SEAL_ERROR", { error: e.message })
        return json({ error: "Paquete LBH invalido" }, 400)
      }
    }

    // --- SEAL GET ---
    if (path.startsWith("/seal/") && request.method === "GET") {
      const sig = path.split("/")[2]
      const data = await env.PHEROMONES.get("seal:" + sig, "json")
      await audit(env, "SEAL_VERIFICADO", {
        signature: sig,
        encontrado: !!data,
        owner: data ? data.owner : null
      })
      if (data) return json({ status: "VERIFICADO", sello: data })
      return json({ error: "Sello no encontrado" }, 404)
    }

    // --- AUDIT (privado) ---
    if (path === "/audit") {
      if (!isAdmin(request)) {
        await audit(env, "AUDIT_ACCESO_DENEGADO", { motivo: "clave incorrecta" })
        return json({ error: "Acceso denegado — clave de auditoría requerida" }, 401)
      }

      const limite = parseInt(url.searchParams.get("limit") || "50")
      const tipo = url.searchParams.get("tipo") || null

      const rawIdx = await env.PHEROMONES.get("__audit_index__")
      let idx = []
      if (rawIdx) { try { idx = JSON.parse(rawIdx) } catch(e) {} }

      const entries = []
      for (const key of idx.slice(0, limite)) {
        const entry = await env.PHEROMONES.get(key, "json")
        if (entry) {
          if (!tipo || entry.tipo === tipo) entries.push(entry)
        }
      }

      return json({
        total: entries.length,
        desde: entries.length > 0 ? entries[entries.length-1].ts : null,
        hasta: entries.length > 0 ? entries[0].ts : null,
        eventos: entries
      })
    }

    // --- AUDIT/STATS (privado) ---
    if (path === "/audit/stats") {
      if (!isAdmin(request)) {
        return json({ error: "Acceso denegado" }, 401)
      }

      const rawIdx = await env.PHEROMONES.get("__audit_index__")
      let idx = []
      if (rawIdx) { try { idx = JSON.parse(rawIdx) } catch(e) {} }

      const rawSeals = await env.PHEROMONES.get("__seals_index__")
      let seals = []
      if (rawSeals) { try { seals = JSON.parse(rawSeals) } catch(e) {} }

      // Contar por tipo
      const stats = { total_eventos: idx.length, total_sellos: seals.length, por_tipo: {} }
      for (const key of idx.slice(0, 200)) {
        const entry = await env.PHEROMONES.get(key, "json")
        if (entry) {
          stats.por_tipo[entry.tipo] = (stats.por_tipo[entry.tipo] || 0) + 1
        }
      }

      return json({
        nodo: "A16-SanMiguel-SV",
        timestamp: new Date().toISOString(),
        stats
      })
    }

    // --- PUSH ---
    if (path.startsWith("/push/") && request.method === "POST") {
      const node = path.split("/")[2]
      try {
        const body = await request.json()
        const data = {
          type: body.type || "learning",
          node,
          value: Number(body.value) || 0,
          trust: Number(body.trust) || 0.5,
          timestamp: new Date().toISOString()
        }
        await env.PHEROMONES.put(node, JSON.stringify(data))
        const raw = await env.PHEROMONES.get("__index__")
        let nodes = []
        if (raw) { try { nodes = JSON.parse(raw) } catch(e) {} }
        if (!nodes.includes(node)) {
          nodes.push(node)
          await env.PHEROMONES.put("__index__", JSON.stringify(nodes))
        }
        await audit(env, "FEROMONA_PUSH", { node, type: data.type, value: data.value })
        return json({ ok: true, stored: data, nodes_total: nodes.length })
      } catch(e) { return json({ error: "Paquete LBH invalido" }, 400) }
    }

    // --- ALL ---
    if (path === "/all") {
      const raw = await env.PHEROMONES.get("__index__")
      let nodes = []
      if (raw) { try { nodes = JSON.parse(raw) } catch(e) {} }
      const result = []
      for (const node of nodes) {
        const data = await env.PHEROMONES.get(node, "json")
        if (data) result.push(data)
      }
      return json(result)
    }

    // --- CONSENSUS ---
    if (path === "/consensus") {
      const raw = await env.PHEROMONES.get("__index__")
      let nodes = []
      if (raw) { try { nodes = JSON.parse(raw) } catch(e) {} }
      let total = 0, count = 0
      for (const node of nodes) {
        const data = await env.PHEROMONES.get(node, "json")
        if (data) { total += Number(data.value) || 0; count++ }
      }
      const promedio = count > 0 ? total / count : 0
      return json({
        consensus: promedio > 0.6 ? "ACEPTAR" : "RECHAZAR",
        promedio: promedio.toFixed(4),
        nodos: count
      })
    }

    await audit(env, "RUTA_NO_VALIDA", { path })
    return json({ error: "Ruta LBH no valida" }, 404)
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: CORS })
}
