/**
 * =============================================================================
 *  CUÁLTOCA · js/notify.js
 * -----------------------------------------------------------------------------
 *  Service Worker (app instalable) y notificaciones del navegador.
 *  Las notificaciones se muestran cuando la app se abre o vuelve a primer plano;
 *  los avisos con la app cerrada llegan por correo (Edge Function send-reminders).
 * =============================================================================
 */
import { storageGet, storageSet } from './store.js';
import { fromISO, diffDays, toISO } from './engine.js';

const NOTIFIED_KEY = 'ciclo-tarjetas:notified:v1';
const LOG_RETENTION_DAYS = 45;

/** El Service Worker exige https (o localhost). */
export const canUseServiceWorker = () =>
  'serviceWorker' in navigator &&
  (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');

export async function registerServiceWorker() {
  if (!canUseServiceWorker()) return null;
  try {
    return await navigator.serviceWorker.register('./sw.js');
  } catch (err) {
    console.warn('No se pudo registrar el Service Worker.', err);
    return null;
  }
}

export const notificationsSupported = () => 'Notification' in window;

/** 'granted' | 'denied' | 'default' | 'unsupported' */
export const notificationPermission = () => (notificationsSupported() ? Notification.permission : 'unsupported');

export async function requestNotificationPermission() {
  if (!notificationsSupported()) return 'unsupported';
  return Notification.requestPermission();
}

/** Muestra una notificación (vía Service Worker si existe: es lo que funciona en Android). */
export async function showNotification(title, options = {}) {
  if (notificationPermission() !== 'granted') return false;
  const opts = { icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', lang: 'es', ...options };
  try {
    if (canUseServiceWorker()) {
      const registration = await navigator.serviceWorker.getRegistration();
      if (registration) {
        await registration.showNotification(title, opts);
        return true;
      }
    }
    new Notification(title, opts);
    return true;
  } catch (err) {
    console.warn('No se pudo mostrar la notificación.', err);
    return false;
  }
}

function readLog() {
  try {
    const log = JSON.parse(storageGet(NOTIFIED_KEY) || '{}');
    return log && typeof log === 'object' ? log : {};
  } catch {
    return {};
  }
}

/**
 * Notifica los avisos que aún no se mostraron en este dispositivo.
 * @param alerts   resultado de computeAlerts()
 * @param messageFor función (alert) => { title, body }
 * @param today    fecha actual (Date)
 * @returns cantidad de notificaciones mostradas
 */
export async function deliverAlertNotifications(alerts, messageFor, today) {
  if (notificationPermission() !== 'granted') return 0;
  const log = readLog();

  // Limpia registros antiguos para que el almacenamiento no crezca sin límite.
  for (const [key, isoDate] of Object.entries(log)) {
    const date = fromISO(isoDate);
    if (!date || diffDays(date, today) > LOG_RETENTION_DAYS) delete log[key];
  }

  let shown = 0;
  for (const alert of alerts) {
    if (log[alert.key]) continue;
    const { title, body } = messageFor(alert);
    if (await showNotification(title, { body, tag: alert.key, data: { url: './#inicio' } })) {
      log[alert.key] = toISO(today);
      shown++;
    }
  }
  storageSet(NOTIFIED_KEY, JSON.stringify(log));
  return shown;
}
