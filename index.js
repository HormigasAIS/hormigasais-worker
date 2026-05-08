const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json"
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS })
    const url = new URL(request.url)
    const path = url.pathname

    if (path === "/") {
      return json({
        status: "HormigasAIS ONLINE",
        nodo: "A16-SanMiguel-SV",
        protocolo: "LBH v2.0",
        author: "CLHQ",
        endpoints: ["/verify", "/seal", "/push/{node}", "/all", "/consensus"]
      })
    }

    if (path === "/verify") {
      return json({
        status: "VALIDADO",
        signature: "CLHQ-MASTER-KEY",
        protocol: "Lenguaje-Binario-HormigasAIS",
        timestamp: new Date().toISOString(),
        origin: "Nodo-Soberano-A16"
      })
    }

    if (path === "/seal" && request.method === "POST") {
      try {
        const body = await request.json()
        const sello = {
          owner: body.owner || "HormigasAIS",
          asset: body.asset || "unknown",
          hash: body.hash || "",
          protocol: "Lenguaje-Binario-HormigasAIS",
          timestamp: new Date().toISOString(),
          nodo: "A16-SanMiguel-SV",
          signature: "CLHQ-" + Math.random().toString(36).substring(2, 10).toUpperCase()
        }
        await env.PHEROMONES.put("seal:" + sello.signature, JSON.stringify(sello))
        return json({ status: "SELLADO", sello })
      } catch(e) { return json({ error: "Paquete LBH invalido" }, 400) }
    }

    if (path.startsWith("/seal/") && request.method === "GET") {
      const sig = path.split("/")[2]
      const data = await env.PHEROMONES.get("seal:" + sig, "json")
      if (data) return json({ status: "VERIFICADO", sello: data })
      return json({ error: "Sello no encontrado" }, 404)
    }

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
        return json({ ok: true, stored: data, nodes_total: nodes.length })
      } catch(e) { return json({ error: "Paquete LBH invalido" }, 400) }
    }

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

    return json({ error: "Ruta LBH no valida" }, 404)
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: CORS })
}
