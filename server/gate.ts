import type { FastifyInstance } from 'fastify';

/**
 * Shared access password. Honest for an internal tool: the endpoints fetch arbitrary
 * URLs and spend model credits, so they do not belong behind nothing at all. Structured
 * so magic-link auth is a swap rather than a rewrite.
 */
export async function registerGate(app: FastifyInstance) {
  const password = process.env.CONSOLE_PASSWORD;
  if (!password) {
    app.log.warn('CONSOLE_PASSWORD unset — API is open. Set it before deploying.');
    return;
  }
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url === '/api/health') return;
    const header = req.headers['x-console-password'];
    if (header !== password) {
      return reply.code(401).send({ error: 'unauthorised' });
    }
  });
}
