export function fakeD1(responses = []) {
  const calls = []
  let i = 0
  const next = () => (i < responses.length ? responses[i++] : { results: [] })
  return {
    calls,
    prepare(sql) {
      const call = { sql, params: null }
      calls.push(call)
      return {
        bind(...params) { call.params = params; return this },
        async all() { return next() },
        async first() { const r = next(); return r.results ? r.results[0] ?? null : r },
        async run() { return next() },
      }
    },
    async batch(stmts) { return stmts.map(() => ({ results: [] })) },
  }
}
