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
    const AUDIT_KEY = env.AUDIT_KEY || "CLHQ-AUDIT-2026"

    async function audit(tipo, data) {
      try {
        const ts = new Date().toISOString()
        const key = "audit:" + ts + ":" + Math.random().toString(36).substring(2,8)
        const entry = {
          tipo, ts,
          ip: request.headers.get("CF-Connecting-IP") || "unknown",
          pais: request.headers.get("CF-IPCountry") || "unknown",
          ...data
        }
        await env.PHEROMONES.put(key, JSON.stringify(entry))
        const rawIdx = await env.PHEROMONES.get("__audit_index__")
        let idx = []
        if (rawIdx) { try { idx = JSON.parse(rawIdx) } catch(e) {} }
        idx.unshift(key)
        if (idx.length > 500) idx = idx.slice(0, 500)
        await env.PHEROMONES.put("__audit_index__", JSON.stringify(idx))
      } catch(e) {}
    }

    function isAdmin(request) {
      const key = request.headers.get("X-Audit-Key") || url.searchParams.get("key") || ""
      return key === AUDIT_KEY
    }

    function calcExpiry(plan, timestamp) {
      const d = new Date(timestamp)
      if (plan === "free") d.setDate(d.getDate() + 30)
      else if (plan === "premium") d.setFullYear(d.getFullYear() + 1)
      else return null
      return d.toISOString()
    }

    // --- BASE ---
    if (path === "/") {
      await audit("VISIT", { path: "/" })
      return json({
        status: "HormigasAIS ONLINE",
        nodo: "A16-SanMiguel-SV",
        protocolo: "LBH v2.0",
        author: "CLHQ",
        endpoints: ["/verify", "/seal", "/seal/{firma}", "/manifest/{firma}", "/push/{nodo}", "/all", "/consensus", "/audit (privado)"]
      })
    }

    // --- VERIFY ---
    if (path === "/verify") {
      await audit("VERIFY", { resultado: "VALIDADO" })
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
        const ts = new Date().toISOString()
        const sello = {
          owner: body.owner || "HormigasAIS",
          asset: body.asset || "unknown",
          hash: body.hash || "",
          plan: body.plan || "free",
          protocol: "Lenguaje-Binario-HormigasAIS",
          timestamp: ts,
          nodo: "A16-SanMiguel-SV",
          signature: "CLHQ-" + Math.random().toString(36).substring(2, 10).toUpperCase()
        }
        sello.valido_hasta = calcExpiry(sello.plan, ts)
        await env.PHEROMONES.put("seal:" + sello.signature, JSON.stringify(sello))
        const rawIdx = await env.PHEROMONES.get("__seals_index__")
        let idx = []
        if (rawIdx) { try { idx = JSON.parse(rawIdx) } catch(e) {} }
        idx.unshift(sello.signature)
        await env.PHEROMONES.put("__seals_index__", JSON.stringify(idx))
        await audit("SEAL_EMITIDO", { signature: sello.signature, owner: sello.owner, asset: sello.asset, plan: sello.plan })
        return json({ status: "SELLADO", sello })
      } catch(e) {
        await audit("SEAL_ERROR", { error: e.message })
        return json({ error: "Paquete LBH invalido" }, 400)
      }
    }

    // --- SEAL GET ---
    if (path.startsWith("/seal/") && !path.startsWith("/seal/") || path.match(/^\/seal\/[^/]+$/)) {
      const sig = path.split("/")[2]
      if (sig && sig !== "undefined") {
        const data = await env.PHEROMONES.get("seal:" + sig, "json")
        await audit("SEAL_VERIFICADO", { signature: sig, encontrado: !!data, owner: data ? data.owner : null })
        if (data) return json({ status: "VERIFICADO", sello: data })
        return json({ error: "Sello no encontrado" }, 404)
      }
    }

    // --- MANIFEST GET ---
    if (path.startsWith("/manifest/")) {
      const sig = path.split("/")[2]
      if (!sig) return json({ error: "Firma requerida" }, 400)

      const sello = await env.PHEROMONES.get("seal:" + sig, "json")
      if (!sello) {
        await audit("MANIFEST_NO_ENCONTRADO", { signature: sig })
        return json({ error: "Sello no encontrado — no se puede generar manifest" }, 404)
      }

      await audit("MANIFEST_DESCARGADO", { signature: sig, owner: sello.owner, plan: sello.plan })

      const manifest = {
        "lbh_manifest": "v1.0",
        "generado": new Date().toISOString(),
        "certificado": {
          "firma": sello.signature,
          "propietario": sello.owner,
          "activo": sello.asset,
          "hash_sha256": sello.hash || "no-proporcionado",
          "plan": sello.plan || "free",
          "emitido": sello.timestamp,
          "valido_hasta": sello.valido_hasta || "permanente",
          "nodo_emisor": sello.nodo || "A16-SanMiguel-SV"
        },
        "protocolo": {
          "nombre": "Lenguaje-Binario-HormigasAIS",
          "version": "v2.0",
          "especificacion": "MESENTERY v1.0",
          "doi": "10.5281/zenodo.19177759"
        },
        "verificacion": {
          "url": "https://hormigasais.com",
          "api": "https://api.hormigasais.com/seal/" + sello.signature,
          "instrucciones": "Ingresa la firma en https://hormigasais.com → pestaña Verificar"
        },
        "uso": {
          "sitio_web": "<a href=\"https://hormigasais.com/verify?sig=" + sello.signature + "\">Certificado LBH " + sello.signature + "</a>",
          "readme_github": "[![Certificado LBH](badge-" + sello.signature + ".png)](https://hormigasais.com)",
          "redes_sociales": "Comparte tu badge con la firma: " + sello.signature,
          "contratos": "Adjunta este archivo como anexo de propiedad intelectual"
        },
        "fundador": "CLHQ — Cristhiam Leonardo Hernández Quiñonez",
        "manual": "https://docs.hormigasais.com/manual"
      }

      // Retornar como archivo descargable
      const manifestStr = JSON.stringify(manifest, null, 2)
      return new Response(manifestStr, {
        status: 200,
        headers: {
          ...CORS,
          "Content-Type": "application/json",
          "Content-Disposition": "attachment; filename=\"manifest-" + sig + ".json\""
        }
      })
    }

    // --- AUDIT ---
    if (path === "/audit") {
      if (!isAdmin(request)) {
        await audit("AUDIT_ACCESO_DENEGADO", { motivo: "clave incorrecta" })
        return json({ error: "Acceso denegado" }, 401)
      }
      const limite = parseInt(url.searchParams.get("limit") || "50")
      const tipo = url.searchParams.get("tipo") || null
      const rawIdx = await env.PHEROMONES.get("__audit_index__")
      let idx = []
      if (rawIdx) { try { idx = JSON.parse(rawIdx) } catch(e) {} }
      const entries = []
      for (const key of idx.slice(0, limite)) {
        const entry = await env.PHEROMONES.get(key, "json")
        if (entry && (!tipo || entry.tipo === tipo)) entries.push(entry)
      }
      return json({ total: entries.length, eventos: entries })
    }

    // --- AUDIT STATS ---
    if (path === "/audit/stats") {
      if (!isAdmin(request)) return json({ error: "Acceso denegado" }, 401)
      const rawIdx = await env.PHEROMONES.get("__audit_index__")
      let idx = []
      if (rawIdx) { try { idx = JSON.parse(rawIdx) } catch(e) {} }
      const rawSeals = await env.PHEROMONES.get("__seals_index__")
      let seals = []
      if (rawSeals) { try { seals = JSON.parse(rawSeals) } catch(e) {} }
      const stats = { total_eventos: idx.length, total_sellos: seals.length, por_tipo: {} }
      for (const key of idx.slice(0, 200)) {
        const entry = await env.PHEROMONES.get(key, "json")
        if (entry) stats.por_tipo[entry.tipo] = (stats.por_tipo[entry.tipo] || 0) + 1
      }
      return json({ nodo: "A16-SanMiguel-SV", timestamp: new Date().toISOString(), stats })
    }

    // --- PUSH ---
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
        await audit("FEROMONA_PUSH", { node, type: data.type, value: data.value })
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
      return json({ consensus: promedio > 0.6 ? "ACEPTAR" : "RECHAZAR", promedio: promedio.toFixed(4), nodos: count })
    }

    await audit("RUTA_NO_VALIDA", { path })
    return json({ error: "Ruta LBH no valida" }, 404)
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: CORS })
}
