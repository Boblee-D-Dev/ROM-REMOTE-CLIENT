require('dotenv').config();

const express = require('express');
const http = require('http');
const path = require('path');
const cors = require('cors');
const compression = require('compression');
const logger = require('./src/utils/logger');
const StartupValidator = require('./src/validators/startupValidator');

const app = express();
const server = http.createServer(app);
const port = process.env.PORT || 3338;
const routes = require('./src/routes');
const debugMiddleware = require('./src/middlewares/debugMiddleware');
const createRawImportMiddleware = require('./src/middlewares/rawImportMiddleware');

const CLIENT_PUBLIC_URL = process.env.CLIENT_PUBLIC_URL || 'http://localhost:8000';
const ENABLE_WSPROXY = process.env.ENABLE_WSPROXY === 'true';
const ENABLE_STATIC_SERVE = process.env.ENABLE_STATIC_SERVE === 'true';
const ESRGAN_ENABLED = process.env.ESRGAN_ENABLED === 'true';
const ESRGAN_CACHE_DIR = process.env.ESRGAN_CACHE_DIR || './upscaled_cache';
const ROBROWSER_PATH = process.env.ROBROWSER_PATH || '../roBrowserLegacy';
const IS_PROD = process.env.NODE_ENV === 'production';

// Global variable to store validation status
let validationStatus = null;

// Game asset extensions that benefit from compression
const COMPRESSIBLE_GAME_EXTENSIONS = /\.(spr|act|rsm|gnd|gat|rsw|str|bmp|tga|pal|lub|lua|txt|xml)$/i;

// Main startup function
async function startServer() {
  // Run startup validation
  logger.info(`Starting roBrowser Remote Client... [${IS_PROD ? 'production' : 'development'}]\n`);

  const validator = new StartupValidator();
  const results = await validator.validateAll();

  // Store status for API endpoint
  validationStatus = validator.getStatusJSON();

  // Print report (verbose in dev, silent in prod unless errors)
  if (IS_PROD) {
    if (!results.success) {
      validator.printReport(results);
    }
  } else {
    validator.printReport(results);
  }

  // If there are fatal errors, exit
  if (!results.success) {
    logger.error('Server cannot start due to configuration errors.');
    logger.error('Run "npm run doctor" for a full diagnosis.\n');
    process.exit(1);
  }

  // CORS: play client (moon-ro.com) fetches GRF assets cross-origin from this host.
  // Prefer CORS_ORIGINS (comma-separated); always include CLIENT_PUBLIC_URL + local dev.
  // Note: Origin is scheme+host+port — http://robrowser.test:8080 ≠ http://robrowser.test
  const corsFromEnv = (process.env.CORS_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const corsOrigins = Array.from(new Set([
    CLIENT_PUBLIC_URL,
    ...corsFromEnv,
    'https://moon-ro.com',
    'https://www.moon-ro.com',
    'http://robrowser.test',
    'https://robrowser.test',
    'http://robrowser.test:8080',
    'https://robrowser.test:8080',
  ].filter(Boolean)));

  function isAllowedCorsOrigin(origin) {
    if (!origin) return true;
    if (corsOrigins.includes(origin)) return true;
    try {
      const host = new URL(origin).hostname;
      // Any port on local robrowser.test (live-server / custom ports)
      if (host === 'robrowser.test' || host.endsWith('.robrowser.test')) {
        return true;
      }
    } catch (e) {
      /* ignore */
    }
    return false;
  }

  const corsOptions = {
    origin: function (origin, callback) {
      callback(null, isAllowedCorsOrigin(origin));
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    credentials: true,
  };
  logger.info(`CORS origins (exact): ${corsOrigins.join(', ')}`);
  logger.info('CORS also allows any port on *.robrowser.test');

  app.use(cors(corsOptions));
  app.use(express.json());
  app.use(express.urlencoded({ extended: true }));

  // Compression middleware - compresses text AND binary game assets
  app.use(compression({
    threshold: 1024,
    filter: (req, res) => {
      // Compress game assets (SPR, RSM, GND, etc.) that are highly compressible
      if (COMPRESSIBLE_GAME_EXTENSIONS.test(req.path)) {
        return true;
      }
      // Default compression filter for text/json/etc
      return compression.filter(req, res);
    }
  }));

  // Debug middleware only in development
  if (!IS_PROD) {
    app.use(debugMiddleware);
  }

  // ESRGAN upscaling middleware - serves upscaled assets from disk cache
  // Plugin: @chicowall/robrowser-esrgan (external package)
  let esrganInstance = null;
  if (ESRGAN_ENABLED) {
    const createEsrganMiddleware = require('@chicowall/robrowser-esrgan');
    const cachePath = path.resolve(__dirname, ESRGAN_CACHE_DIR);
    esrganInstance = await createEsrganMiddleware({ cacheDir: cachePath, logger });
    app.use(esrganInstance.middleware);
  }

  // Validation status endpoint (JSON for frontend)
  app.get('/api/health', (req, res) => {
    const Client = require('./src/controllers/clientController');
    const missingInfo = Client.getMissingFilesSummary ? Client.getMissingFilesSummary() : null;
    const cacheStats = Client.getCacheStats ? Client.getCacheStats() : null;
    const indexStats = Client.getIndexStats ? Client.getIndexStats() : null;

    res.json({
      ...validationStatus,
      missingFiles: missingInfo,
      cache: cacheStats,
      index: indexStats,
      esrgan: esrganInstance ? esrganInstance.getStats() : { enabled: false },
    });
  });

  // Missing files endpoint
  app.get('/api/missing-files', (req, res) => {
    const Client = require('./src/controllers/clientController');
    const summary = Client.getMissingFilesSummary ? Client.getMissingFilesSummary() : { total: 0, files: [] };
    res.json(summary);
  });

  // Cache stats endpoint
  app.get('/api/cache-stats', (req, res) => {
    const Client = require('./src/controllers/clientController');
    res.json({
      cache: Client.getCacheStats ? Client.getCacheStats() : null,
      index: Client.getIndexStats ? Client.getIndexStats() : null,
    });
  });

  // Serve roBrowserLegacy static files (replaces live-server)
  if (ENABLE_STATIC_SERVE) {
    const roBrowserAbsPath = path.resolve(__dirname, ROBROWSER_PATH);
    logger.debug(`Static serve enabled: ${roBrowserAbsPath}`);

    // Handle Vite-style ?raw imports (must come before express.static)
    app.use(createRawImportMiddleware(roBrowserAbsPath));

    app.use(express.static(roBrowserAbsPath));
  }

  // API routes (GRF file serving, search, etc.)
  app.use('/', routes);

  // Embedded WebSocket proxy (replaces standalone wsproxy)
  if (ENABLE_WSPROXY) {
    const { attachWsProxy } = require('./src/wsProxy');
    const ALLOWED_TARGETS = process.env.WS_ALLOWED_TARGETS
      ? process.env.WS_ALLOWED_TARGETS.split(',').map(s => s.trim()).filter(Boolean)
      : [
          '127.0.0.1:6900',  // Login
          '127.0.0.1:6121',  // Char
          '127.0.0.1:5121',  // Map
        ];

    attachWsProxy(server, { allowedTargets: ALLOWED_TARGETS });
  }

  server.listen(port, process.env.HOST || '127.0.0.1', async () => {
    const host = process.env.HOST || '127.0.0.1';
    logger.info(`Server ready on http://${host}:${port}` +
      (ENABLE_STATIC_SERVE ? ` | Game: http://${host}:${port}/applications/pwa/index.html` : '') +
      (ENABLE_WSPROXY ? ` | WS Proxy: /ws/` : ''));

    // Cache warm-up (runs after server is ready, non-blocking)
    if (process.env.CACHE_WARM_UP === 'true') {
      const warmLimit = parseInt(process.env.CACHE_WARM_UP_LIMIT) || 500;
      logger.debug(`Warming cache (up to ${warmLimit} files)...`);
      const Client = require('./src/controllers/clientController');
      Client.warmCache([], warmLimit).catch(err => {
        logger.error('Cache warm-up error:', err.message);
      });
    }
  });
}

// Start server
startServer().catch((error) => {
  logger.error('Fatal error while starting server:', error);
  process.exit(1);
});
