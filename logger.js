const winston = require('winston');
require('winston-daily-rotate-file');
const path = require('path');
const fs = require('fs');

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

// Transporte general (errores, eventos del sistema)
const appTransport = new winston.transports.DailyRotateFile({
  dirname: LOG_DIR,
  filename: 'app-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: '30d',
  level: 'info'
});

// Transporte de auditoría (quién buscó qué y cuándo) — separado para retención/compliance
const auditTransport = new winston.transports.DailyRotateFile({
  dirname: LOG_DIR,
  filename: 'audit-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxFiles: '180d'
});

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: logFormat,
  transports: [
    appTransport,
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ],
  exceptionHandlers: [appTransport],
  rejectionHandlers: [appTransport]
});

const auditLogger = winston.createLogger({
  level: 'info',
  format: logFormat,
  transports: [auditTransport]
});

/**
 * Registra un evento de auditoría: quién, qué acción, sobre qué criterio, con qué resultado.
 * No registra contraseñas ni tokens completos.
 */
function auditarBusqueda({ usuario, ip, tipo, criterios, totalResultados }) {
  auditLogger.info('busqueda', {
    evento: 'busqueda',
    usuario,
    ip,
    tipo,
    criterios,
    totalResultados,
    timestamp: new Date().toISOString()
  });
}

function auditarLogin({ usuario, ip, exito, motivo }) {
  auditLogger.info('login', {
    evento: 'login',
    usuario,
    ip,
    exito,
    motivo: motivo || null,
    timestamp: new Date().toISOString()
  });
}

function auditarExportacion({ usuario, ip, formato, totalRegistros }) {
  auditLogger.info('exportacion', {
    evento: 'exportacion',
    usuario,
    ip,
    formato,
    totalRegistros,
    timestamp: new Date().toISOString()
  });
}

module.exports = { logger, auditarBusqueda, auditarLogin, auditarExportacion };
