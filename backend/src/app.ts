import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { errorHandler } from './middleware/error-handler';
import healthRoutes from './routes/health';
import workspaceRoutes from './routes/workspaces';
import sessionRoutes from './routes/sessions';
import repoRoutes from './routes/repos';
import configRoutes from './routes/config';
import settingsRoutes from './routes/settings';
import statsRoutes from './routes/stats';

export function createApp() {
  const app = new Hono();

  // Middleware
  app.use('*', cors());

  // Mount route groups
  // Note: Sidecar routes removed - agent runtime now managed by sidecar-v2 (Rust-spawned)
  app.route('/api', healthRoutes);
  app.route('/api', workspaceRoutes);
  app.route('/api', sessionRoutes);
  app.route('/api', repoRoutes);
  app.route('/api', configRoutes);
  app.route('/api', settingsRoutes);
  app.route('/api', statsRoutes);

  // Centralized error handling
  app.onError(errorHandler);

  return app;
}
