import express, { Express } from 'express';
import cors from 'cors';
import logger from '../logger.js';

import os from 'os';

const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN;

function getLocalIp(): string {
  const interfaces = os.networkInterfaces();
  for (const interfaceName in interfaces) {
    const networkInterface = interfaces[interfaceName];
    if (!networkInterface) continue;

    for (const network of networkInterface) {
      if (network.family === 'IPv4' && !network.internal) {
        return network.address;
      }
    }
  }
  return 'localhost'; // Default to localhost if LAN IP isn't found
}

function isPrivateIp(hostname: string): boolean {
  if (hostname === 'localhost' || hostname.endsWith('.localhost')) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true;
  // 172.16.0.0 – 172.31.255.255
  const match = hostname.match(/^172\.(\d{1,2})\.\d{1,3}\.\d{1,3}$/);
  if (match) {
    const second = Number(match[1]);
    return second >= 16 && second <= 31;
  }
  return false;
}

/**
 * Check if the request origin is allowed, i.e., from localhost or LAN IP, or
 * matches the `ALLOWED_ORIGIN` environment variable. The function also allows
 * requests with no origin (e.g., `curl`).
 *
 * If `ALLOWED_ORIGIN` is set to a wildcard (`*`), all origins are allowed.
 *
 * @param origin - The origin to check.
 * @returns True if the origin is allowed, false otherwise.
 */
function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) {
    return true;
  }

  if (ALLOWED_ORIGIN === '*') {
    return true;
  }

  try {
    const url = new URL(origin);
    const host = url.hostname;

    // mDNS / home hostnames (e.g. http://pod.lan, http://8sleep.local)
    if (host.endsWith('.lan') || host.endsWith('.local')) {
      return true;
    }

    if (isPrivateIp(host)) {
      return true;
    }

    if (
      origin.startsWith(`http://${getLocalIp()}:`) ||
      origin.startsWith('http://localhost') ||
      (ALLOWED_ORIGIN && origin.startsWith(ALLOWED_ORIGIN))
    ) {
      return true;
    }
  } catch {
    return false;
  }

  return false;
}

export default function (app: Express) {
  app.use((req, res, next) => {
    const startTime = Date.now();

    // Hook into the response `finish` event to log after the response is sent
    res.on('finish', () => {
      const duration = Date.now() - startTime;
      logger.info(`${req.method} ${req.originalUrl} - ${res.statusCode} - ${duration}ms`);
    });

    next();
  });

  app.use(express.json());

  // Allow local development + LAN hostnames
  app.use(
    cors({
      origin: (origin, callback) => {
        if (isAllowedOrigin(origin)) {
          return callback(null, true);
        }

        logger.warn(`CORS blocked origin: ${origin}`);
        return callback(new Error('Not allowed by CORS'));
      }
    })
  );

  // Logging
  app.use((req, res, next) => {
    const clientIp = req.headers['x-forwarded-for'] || req.ip;
    const method = req.method;
    const endpoint = req.originalUrl;
    logger.debug(`${method} ${endpoint} - IP: ${clientIp}`);
    next();
  });
}
