export default {
  async fetch(request, env, ctx) {
    return new Response('ok')
  },
  async scheduled(event, env, ctx) {
    // наполняется в Task 11
  },
}
