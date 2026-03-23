import { getServerUrl } from '../utils/config.js';

/**
 * Convert the WebSocket server URL to an HTTP base URL.
 * wss://api.workslocal.dev/ws → https://api.workslocal.dev
 */
export function getHttpBaseUrl(serverUrl?: string): string {
  const url = serverUrl ?? getServerUrl();
  return url.replace('wss://', 'https://').replace('ws://', 'http://').replace(/\/ws$/, '');
}
