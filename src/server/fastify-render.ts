import 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    render(template: string, data?: Record<string, unknown>): Promise<string>;
  }
}
