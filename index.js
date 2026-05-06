export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname

    if (path === "/") {
      return json({ status: "HormigasAIS ONLINE", nodo: "A16-SanMiguel-SV", protocolo: "LBH v2.0" })
    }

    if (path.startsWith("/push/") && request.method === "POST") {
      const node = path.split("/")[2]
      try {
        const body = await request.json()
        const data = { type: body.type || "learning", node, value: Number(body.value) || 0, trust: Number(body.trust) || 0.5, timestamp: new Date().toISOString() }
        await env.PHEROMONES.put(node, JSON.stringify(data))
        const raw = await env.PHEROMONES.get("__index__")
        let nodes = []
        if (raw) { try { nodes = JSON.parse(raw) } catch {} }
        if (!nodes.includes(node)) { nodes.push(node); await env.PHEROMONES.put("__index__", JSON.stringify(nodes)) }
        return json({ ok: true, stored: data, nodes_total: nodes.length })
      } catch(e) { return json({ error: "invalid json" }, 400) }
    }

    if (path === "/all") {
      const raw = await env.PHEROMONES.get("__index__")
      let nodes = []
      if (raw) { try { nodes = JSON.parse(raw) } catch {} }
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
      if (raw) { try { nodes = JSON.parse(raw) } catch {} }
      let total = 0, count = 0
      for (const node of nodes) {
        const data = await env.PHEROMONES.get(node, "json")
        if (data) { total += Number(data.value) || 0; count++ }
      }
      const promedio = count > 0 ? total / count : 0
      return json({ consensus: promedio > 0.6 ? "ACEPTAR" : "RECHAZAR", promedio, nodos: count })
    }

    return json({ error: "Ruta no valida" }, 404)
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { "Content-Type": "application/json" } })
}
