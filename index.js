export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const path = url.pathname.split("/").filter(Boolean)

    if (path.length === 0) {
      return json({ status: "HormigasAIS ONLINE", nodo: "A16-SanMiguel-SV", protocolo: "LBH v1.1" })
    }

    if (path[0] === "push" && request.method === "POST") {
      const node = path[1] || "A16"
      const data = await request.json()
      const payload = { type: data.type || "learning", node, value: data.value || 1, trust: data.trust || 0.5, timestamp: new Date().toISOString() }
      await env.PHEROMONES.put(node, JSON.stringify(payload), { expirationTtl: 600 })
      return json({ ok: true, stored: payload })
    }

    if (path[0] === "get") {
      const data = await env.PHEROMONES.get(path[1])
      return data ? new Response(data, { headers: { "Content-Type": "application/json" } }) : json({ status: "no_data" })
    }

    if (path[0] === "all") {
      const list = await env.PHEROMONES.list()
      let result = []
      for (const key of list.keys) {
        const val = await env.PHEROMONES.get(key.name)
        if (val) result.push(JSON.parse(val))
      }
      return json(result)
    }

    if (path[0] === "consensus") {
      const list = await env.PHEROMONES.list()
      let total = 0, count = 0
      for (const key of list.keys) {
        const val = await env.PHEROMONES.get(key.name)
        if (val) { const d = JSON.parse(val); total += d.value || 0; count++ }
      }
      const promedio = count > 0 ? total / count : 0
      return json({ consensus: promedio > 0.6 ? "ACEPTAR" : "RECHAZAR", promedio, nodos: count })
    }

    return json({ error: "Ruta no valida" })
  }
}

function json(data) {
  return new Response(JSON.stringify(data, null, 2), { headers: { "Content-Type": "application/json" } })
}
