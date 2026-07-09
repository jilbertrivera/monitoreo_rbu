const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { body, validationResult } = require('express-validator');
const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { logger, auditarBusqueda, auditarLogin, auditarExportacion } = require('./logger');
const { cargarUsuarios, verificarCredenciales, getEstadoUsuarios, getGoogleSheetsStatus } = require('./usuarios');
const { generarExcel, generarPdf, ETIQUETAS_CAMPOS } = require('./exportar');

// ── Validación de configuración crítica al arrancar ──────────────────────
const JWT_SECRET = process.env.JWT_SECRET;
const PLACEHOLDERS_PROHIBIDOS = ['tu_secreto_muy_seguro_cambiar_en_produccion_2026', 'change_me', 'secret'];

if (!JWT_SECRET || JWT_SECRET.length < 32) {
  console.error('✖ JWT_SECRET no está definido o es demasiado corto (mínimo 32 caracteres). Genera uno con: node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'hex\'))"');
  process.exit(1);
}
if (PLACEHOLDERS_PROHIBIDOS.includes(JWT_SECRET)) {
  console.error('✖ JWT_SECRET sigue siendo un valor de ejemplo. Cámbialo antes de arrancar en producción.');
  process.exit(1);
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const SUPABASE_SCHEMA = (process.env.SUPABASE_SCHEMA || 'public').trim().toLowerCase();
const SUPABASE_TABLE_RAW = (process.env.SUPABASE_TABLE || '').trim();

function parseSupabaseTable(rawTable, defaultSchema) {
  const normalized = String(rawTable).trim();
  if (!normalized) return { schema: defaultSchema, table: '' };

  if (normalized.includes('.')) {
    const [prefix, suffix] = normalized.split('.');
    const prefixLower = prefix.trim().toLowerCase();
    const suffixLower = suffix.trim().toLowerCase();

    if (prefixLower === 'public') {
      return { schema: 'public', table: suffixLower };
    }

    if (defaultSchema !== 'public') {
      return { schema: defaultSchema, table: normalized.toLowerCase() };
    }

    return { schema: defaultSchema, table: suffixLower };
  }

  return { schema: defaultSchema, table: normalized.toLowerCase() };
}

const { schema: TABLA_ESQUEMA, table: TABLA_NOMBRE } = parseSupabaseTable(SUPABASE_TABLE_RAW, SUPABASE_SCHEMA);
const TABLA = `${TABLA_ESQUEMA}.${TABLA_NOMBRE}`;
const dbEnvSet = Boolean(SUPABASE_URL || SUPABASE_KEY || TABLA_NOMBRE);
const SUPABASE_CONFIGURED = Boolean(SUPABASE_URL && SUPABASE_KEY && TABLA_NOMBRE);
if (dbEnvSet && !SUPABASE_CONFIGURED) {
  const faltantes = ['SUPABASE_URL', 'SUPABASE_KEY', 'SUPABASE_TABLE'].filter(k => !process.env[k]);
  console.warn(`⚠ Configuración de Supabase incompleta. Faltan: ${faltantes.join(', ')}. El servidor arrancará en modo solo login.`);
}

const app = express();
app.set('trust proxy', 1);

// ── Seguridad de cabeceras HTTP ───────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: false // la UI es estática simple; ajustar si se sirve contenido externo
}));

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);

function isAllowedOrigin(origin) {
  if (!origin || origin === 'null' || origin === 'file://' || origin.includes('localhost') || origin.includes('127.0.0.1') || origin.includes('[::1]')) {
    return true;
  }
  if (ALLOWED_ORIGINS.length === 0) {
    return false;
  }
  return ALLOWED_ORIGINS.includes(origin);
}

const corsOptions = {
  origin(origin, callback) {
    if (isAllowedOrigin(origin)) {
      return callback(null, true);
    }
    const message = `CORS origin denied: ${origin}`;
    logger.warn(message);
    return callback(new Error(message));
  },
  credentials: true,
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  optionsSuccessStatus: 200,
  preflightContinue: false
};
app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json({ limit: '100kb' }));

const staticRoot = fs.existsSync(path.join(__dirname, 'public'))
  ? path.join(__dirname, 'public')
  : __dirname;
app.use(express.static(staticRoot));

app.use((req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  next();
});

// ── Rate limiting ──────────────────────────────────────────────────────────
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de inicio de sesión. Intenta de nuevo en unos minutos.' }
});

const busquedaLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas búsquedas en poco tiempo. Espera unos segundos.' }
});

const exportLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiadas exportaciones en poco tiempo. Intenta más tarde.' }
});

// ── Configuración Supabase ─────────────────────────────────────────────────
let supabase;

function initializeSupabase() {
  supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false }
  });
  logger.info('Cliente Supabase inicializado');
}

// ── Constantes de dominio ───────────────────────────────────────────────────
const CAMPOS_VALIDOS = ['VC_DNI', 'VC_DEPARTAMENTO', 'VC_PATERNO', 'VC_MATERNO', 'VC_NOMBRE'];
const CAMPOS_RESULTADOS = [
  'VC_DNI', 'VC_CODIGO_UBIGEO', 'VC_DEPARTAMENTO', 'VC_PROVINCIA', 'VC_DISTRITO',
  'VC_CCPP', 'VC_SECTOR', 'VC_DIRECCION_P65', 'VC_DIRECCION_DJ', 'VC_DIRECCION_SISFOH',
  'VC_PATERNO', 'VC_MATERNO', 'VC_NOMBRE', 'VC_FECHA_NACIMIENTO', 'NM_EDAD',
  'VC_RANGO_EDAD', 'VC_SEXO', 'VC_TELEFONO_TAYTA', 'VC_CONTACTO', 'VC_FECHA_INGRESO',
  'VC_FECHA_REINGRESO', 'VC_FECHA_ULTIMA_VISITA', 'VC_FECHA_SINCRONIZACION'
];
const MAX_RESULTADOS_POR_PAGINA = 50;
const MAX_RESULTADOS_EXPORTACION = 5000;

// ── Middleware de autenticación ─────────────────────────────────────────────
function verificarToken(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Token no proporcionado' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.usuario = decoded.usuario;
    next();
  } catch (error) {
    return res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

function manejarErroresValidacion(req, res, next) {
  const errores = validationResult(req);
  if (!errores.isEmpty()) {
    return res.status(400).json({ error: 'Datos inválidos', detalles: errores.array() });
  }
  next();
}

function obtenerIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;
}

// ── Construcción segura de consultas para Supabase ─────────────────────────
function normalizarBusquedaTexto(texto) {
  return String(texto || '').trim().replace(/\s+/g, ' ').slice(0, 100);
}

function encodeLikeValue(value) {
  return `%${String(value).trim().replace(/%/g, '')}%`;
}

function construirCondicionBusqueda(campo, valor) {
  const texto = normalizarBusquedaTexto(valor);
  if (!texto) return null;

  const tokens = texto.split(' ').filter(Boolean);
  if (campo === 'VC_DNI' && /^\d{8}$/.test(texto)) {
    return { expression: `${campo}.eq.${encodeURIComponent(texto)}`, count: 1 };
  }

  if (tokens.length === 1) {
    return { expression: `${campo}.ilike.${encodeURIComponent(encodeLikeValue(tokens[0]))}`, count: 1 };
  }

  const parts = tokens.map(token => `${campo}.ilike.${encodeURIComponent(encodeLikeValue(token))}`);
  return { expression: `and(${parts.join(',')})`, count: tokens.length };
}

function construirCondicionLista(campo, lista) {
  const valores = lista.map(v => normalizarBusquedaTexto(v)).filter(Boolean);
  if (valores.length === 0) return null;

  if (campo === 'VC_DNI' && valores.every(v => /^\d{8}$/.test(v))) {
    const encodedValues = valores.map(v => encodeURIComponent(v)).join(',');
    return { expression: `${campo}.in.(${encodedValues})` };
  }

  const expressions = valores.map((valor) => {
    const tokens = valor.split(' ').filter(Boolean);
    if (tokens.length === 0) return null;
    if (tokens.length === 1) {
      return `${campo}.ilike.${encodeURIComponent(encodeLikeValue(tokens[0]))}`;
    }
    const parts = tokens.map(token => `${campo}.ilike.${encodeURIComponent(encodeLikeValue(token))}`);
    return `and(${parts.join(',')})`;
  }).filter(Boolean);

  if (expressions.length === 0) return null;
  return { expression: expressions.length === 1 ? expressions[0] : `or(${expressions.join(',')})` };
}

function buildSupabaseQuery(expression) {
  const query = supabase
    .schema(TABLA_ESQUEMA)
    .from(TABLA_NOMBRE)
    .select(CAMPOS_RESULTADOS.join(','), { count: 'exact' });
  if (expression) {
    query.or(expression);
  }
  return query;
}

async function ejecutarBusquedaPaginada(expression, pagina, porPagina) {
  const offset = (pagina - 1) * porPagina;

  const countQuery = buildSupabaseQuery(expression).select('*', { head: true, count: 'exact' });
  const { error: countError, count } = await countQuery;
  if (countError) throw countError;

  const dataQuery = buildSupabaseQuery(expression)
    .order('VC_DNI', { ascending: true })
    .range(offset, offset + porPagina - 1);

  const { data, error: dataError } = await dataQuery;
  if (dataError) throw dataError;

  return { total: count || 0, datos: data || [] };
}

async function ejecutarBusquedaCompleta(expression, max) {
  const { data, error } = await buildSupabaseQuery(expression)
    .order('VC_DNI', { ascending: true })
    .limit(max);

  if (error) throw error;
  return data || [];
}

// ════════════════════════════════════════════════════════════════════════
// RUTAS
// ════════════════════════════════════════════════════════════════════════

app.post('/api/login',
  loginLimiter,
  [
    body('usuario').trim().notEmpty().withMessage('Usuario requerido').isLength({ max: 100 }),
    body('password').notEmpty().withMessage('Contraseña requerida').isLength({ max: 200 })
  ],
  manejarErroresValidacion,
  async (req, res) => {
    const usuarioIngresado = req.body.usuario;
    const passwordIngresado = req.body.password;
    const ip = obtenerIp(req);

    const estadoUsuarios = getEstadoUsuarios();
    if (estadoUsuarios.total === 0) {
      logger.warn('Intento de login sin usuarios cargados desde Google Sheets');
      return res.status(503).json({ error: 'No hay usuarios cargados. Revisa la configuración de Google Sheets.' });
    }

    try {
      const usuarioValido = await verificarCredenciales(usuarioIngresado, passwordIngresado);

      if (!usuarioValido) {
        auditarLogin({ usuario: usuarioIngresado, ip, exito: false, motivo: 'credenciales_invalidas' });
        return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
      }

      const token = jwt.sign({ usuario: usuarioValido.usuario }, JWT_SECRET, { expiresIn: '8h' });

      auditarLogin({ usuario: usuarioValido.usuario, ip, exito: true });
      logger.info(`Login exitoso: ${usuarioValido.usuario} desde ${ip}`);

      res.json({ success: true, token, mensaje: `Bienvenido ${usuarioValido.usuario}` });
    } catch (error) {
      logger.error(`Error en login: ${error.message}`);
      res.status(500).json({ error: 'Error interno al procesar el inicio de sesión' });
    }
  }
);

app.post('/api/logout', (req, res) => {
  res.json({ success: true, mensaje: 'Sesión cerrada' });
});

app.get('/api/test-conexion', (req, res) => {
  const estado = getEstadoUsuarios();
  const googleStatus = getGoogleSheetsStatus();
  res.json({
    success: true,
    mensaje: 'Servidor disponible',
    usuariosCargados: estado.total,
    googleSheets: googleStatus
  });
});

app.get('/api/health', (req, res) => {
  res.json({
    success: true,
    uptime: process.uptime(),
    env: process.env.NODE_ENV || 'production',
    timestamp: new Date().toISOString()
  });
});

app.get('/api/me', verificarToken, (req, res) => {
  res.json({ usuario: req.usuario });
});

// Búsqueda simple (paginada)
app.post('/api/buscar',
  verificarToken,
  busquedaLimiter,
  [
    body('criterio').trim().notEmpty().withMessage('Criterio requerido').isLength({ max: 100 }),
    body('campo').trim().notEmpty().isIn(CAMPOS_VALIDOS).withMessage('Campo inválido'),
    body('pagina').optional().isInt({ min: 1 }).toInt(),
    body('porPagina').optional().isInt({ min: 1, max: MAX_RESULTADOS_POR_PAGINA }).toInt()
  ],
  manejarErroresValidacion,
  async (req, res) => {
    const { criterio, campo } = req.body;
    const pagina = req.body.pagina || 1;
    const porPagina = req.body.porPagina || 25;
    const ip = obtenerIp(req);

    try {
      if (!supabase) {
        return res.status(503).json({ error: 'Servicio de búsqueda no disponible' });
      }
      const condicion = construirCondicionBusqueda(campo, criterio);
      if (!condicion) {
        return res.status(400).json({ error: 'Criterio inválido' });
      }
      const { total, datos } = await ejecutarBusquedaPaginada(condicion.expression, pagina, porPagina);

      auditarBusqueda({ usuario: req.usuario, ip, tipo: 'simple', criterios: { campo, criterio }, totalResultados: total });

      res.json({
        success: true,
        total,
        pagina,
        porPagina,
        totalPaginas: Math.ceil(total / porPagina),
        data: datos
      });
    } catch (error) {
      logger.error(`Error en búsqueda simple: ${error.message}`);
      res.status(500).json({ error: `Error en la búsqueda: ${error.message}`, detalle: error.message });
    }
  }
);

// Búsqueda avanzada (paginada)
app.post('/api/buscar-avanzado',
  verificarToken,
  busquedaLimiter,
  [
    body('criterios').isObject().withMessage('Criterios debe ser un objeto'),
    body('pagina').optional().isInt({ min: 1 }).toInt(),
    body('porPagina').optional().isInt({ min: 1, max: MAX_RESULTADOS_POR_PAGINA }).toInt()
  ],
  manejarErroresValidacion,
  async (req, res) => {
    const { criterios } = req.body;
    const pagina = req.body.pagina || 1;
    const porPagina = req.body.porPagina || 25;
    const ip = obtenerIp(req);

    const expressions = [];

    for (const [campo, valor] of Object.entries(criterios)) {
      if (!CAMPOS_VALIDOS.includes(campo) || !valor || !String(valor).trim()) continue;
      const condicion = construirCondicionBusqueda(campo, valor);
      if (condicion) {
        expressions.push(condicion.expression);
      }
    }

    if (expressions.length === 0) {
      return res.status(400).json({ error: 'Ingresa al menos un criterio válido' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Servicio de búsqueda no disponible' });
    }

    try {
      const expression = expressions.length === 1 ? expressions[0] : `and(${expressions.join(',')})`;
      const { total, datos } = await ejecutarBusquedaPaginada(expression, pagina, porPagina);

      auditarBusqueda({ usuario: req.usuario, ip, tipo: 'avanzada', criterios, totalResultados: total });

      res.json({
        success: true,
        total,
        pagina,
        porPagina,
        totalPaginas: Math.ceil(total / porPagina),
        data: datos
      });
    } catch (error) {
      logger.error(`Error en búsqueda avanzada: ${error.message}`);
      res.status(500).json({ error: `Error en la búsqueda: ${error.message}`, detalle: error.message });
    }
  }
);

// Búsqueda múltiple (varios valores del mismo campo, ej: lista de DNIs)
app.post('/api/buscar-multiple',
  verificarToken,
  busquedaLimiter,
  [
    body('campo').trim().notEmpty().isIn(CAMPOS_VALIDOS).withMessage('Campo inválido'),
    body('valores').isArray({ min: 1, max: 200 }).withMessage('Valores debe ser un array de 1 a 200 elementos'),
    body('valores.*').trim().notEmpty().isLength({ max: 100 }),
    body('pagina').optional().isInt({ min: 1 }).toInt(),
    body('porPagina').optional().isInt({ min: 1, max: MAX_RESULTADOS_POR_PAGINA }).toInt()
  ],
  manejarErroresValidacion,
  async (req, res) => {
    const { campo } = req.body;
    const valores = req.body.valores.map(v => String(v).trim()).filter(Boolean).slice(0, 200);
    const pagina = req.body.pagina || 1;
    const porPagina = req.body.porPagina || 25;
    const ip = obtenerIp(req);

    if (valores.length === 0) {
      return res.status(400).json({ error: 'Ingresa al menos un valor para buscar' });
    }

    try {
      if (!supabase) {
        return res.status(503).json({ error: 'Servicio de búsqueda no disponible' });
      }

      const condicion = construirCondicionLista(campo, valores);
      if (!condicion) {
        return res.status(400).json({ error: 'Valores inválidos para la búsqueda múltiple' });
      }

      const { total, datos } = await ejecutarBusquedaPaginada(condicion.expression, pagina, porPagina);

      auditarBusqueda({ usuario: req.usuario, ip, tipo: 'multiple', criterios: { campo, cantidad: valores.length }, totalResultados: total });

      res.json({
        success: true,
        total,
        pagina,
        porPagina,
        totalPaginas: Math.ceil(total / porPagina),
        data: datos
      });
    } catch (error) {
      logger.error(`Error en búsqueda múltiple: ${error.message}`);
      res.status(500).json({ error: `Error en la búsqueda: ${error.message}`, detalle: error.message });
    }
  }
);

// Búsqueda múltiple avanzada (varios valores por campo, combinados con AND entre campos)
app.post('/api/buscar-multiple-avanzado',
  verificarToken,
  busquedaLimiter,
  [
    body('criterios').isObject().withMessage('Criterios debe ser un objeto'),
    body('pagina').optional().isInt({ min: 1 }).toInt(),
    body('porPagina').optional().isInt({ min: 1, max: MAX_RESULTADOS_POR_PAGINA }).toInt()
  ],
  manejarErroresValidacion,
  async (req, res) => {
    const { criterios } = req.body;
    const pagina = req.body.pagina || 1;
    const porPagina = req.body.porPagina || 25;
    const ip = obtenerIp(req);

    const expressions = [];

    for (const [campo, valoresRaw] of Object.entries(criterios)) {
      if (!CAMPOS_VALIDOS.includes(campo)) continue;
      const lista = (Array.isArray(valoresRaw) ? valoresRaw : [valoresRaw])
        .map(v => String(v || '').trim())
        .filter(Boolean)
        .slice(0, 200);
      if (lista.length === 0) continue;

      const condicion = construirCondicionLista(campo, lista);
      if (condicion) {
        expressions.push(condicion.expression);
      }
    }

    if (expressions.length === 0) {
      return res.status(400).json({ error: 'Ingresa al menos un criterio válido' });
    }

    if (!supabase) {
      return res.status(503).json({ error: 'Servicio de búsqueda no disponible' });
    }

    try {
      const expression = expressions.length === 1 ? expressions[0] : `and(${expressions.join(',')})`;
      const { total, datos } = await ejecutarBusquedaPaginada(expression, pagina, porPagina);

      auditarBusqueda({ usuario: req.usuario, ip, tipo: 'multiple-avanzada', criterios, totalResultados: total });

      res.json({
        success: true,
        total,
        pagina,
        porPagina,
        totalPaginas: Math.ceil(total / porPagina),
        data: datos
      });
    } catch (error) {
      logger.error(`Error en búsqueda múltiple avanzada: ${error.message}`);
      res.status(500).json({ error: `Error en la búsqueda: ${error.message}`, detalle: error.message });
    }
  }
);

// ── Exportación ─────────────────────────────────────────────────────────────
async function resolverCriteriosExportacion(req) {
  if (req.body.tipo === 'simple') {
    const { campo, criterio } = req.body;
    if (!campo || !CAMPOS_VALIDOS.includes(campo) || !criterio) return null;
    const condicion = construirCondicionBusqueda(campo, criterio);
    return condicion ? { expression: condicion.expression, texto: `${ETIQUETAS_CAMPOS[campo] || campo}: ${criterio}` } : null;
  }

  if (req.body.tipo === 'multiple-avanzada') {
    const { criterios } = req.body;
    if (!criterios || typeof criterios !== 'object') return null;
    const expressions = [];
    const textoPartes = [];
    for (const [campo, valoresRaw] of Object.entries(criterios)) {
      if (!CAMPOS_VALIDOS.includes(campo)) continue;
      const lista = (Array.isArray(valoresRaw) ? valoresRaw : [valoresRaw])
        .map(v => String(v || '').trim())
        .filter(Boolean)
        .slice(0, 200);
      if (lista.length === 0) continue;
      const condicion = construirCondicionLista(campo, lista);
      if (condicion) {
        expressions.push(condicion.expression);
        textoPartes.push(`${ETIQUETAS_CAMPOS[campo] || campo}: ${lista.join(', ')}`);
      }
    }
    if (expressions.length === 0) return null;
    return { expression: expressions.length === 1 ? expressions[0] : `and(${expressions.join(',')})`, texto: textoPartes.join(' | ') };
  }

  if (req.body.tipo === 'multiple') {
    const { campo, valores } = req.body;
    if (!campo || !CAMPOS_VALIDOS.includes(campo) || !Array.isArray(valores) || valores.length === 0) return null;
    const condicion = construirCondicionLista(campo, valores.slice(0, 200));
    if (!condicion) return null;
    return { expression: condicion.expression, texto: `${ETIQUETAS_CAMPOS[campo] || campo}: ${valores.length} valores` };
  }

  if (req.body.tipo === 'avanzada') {
    const criterios = req.body.criterios || {};
    const expressions = [];
    const textoPartes = [];
    for (const [campo, valor] of Object.entries(criterios)) {
      if (!CAMPOS_VALIDOS.includes(campo) || !valor || !String(valor).trim()) continue;
      const condicion = construirCondicionBusqueda(campo, valor);
      if (condicion) {
        expressions.push(condicion.expression);
        textoPartes.push(`${ETIQUETAS_CAMPOS[campo] || campo}: ${String(valor).trim()}`);
      }
    }
    if (expressions.length === 0) return null;
    return { expression: expressions.length === 1 ? expressions[0] : `and(${expressions.join(',')})`, texto: textoPartes.join(', ') };
  }

  return null;
}

app.post('/api/exportar/excel',
  verificarToken,
  exportLimiter,
  [body('tipo').isIn(['simple', 'avanzada', 'multiple', 'multiple-avanzada'])],
  manejarErroresValidacion,
  async (req, res) => {
    const ip = obtenerIp(req);
    try {
      const resuelto = await resolverCriteriosExportacion(req);
      if (!resuelto) return res.status(400).json({ error: 'Criterios inválidos para exportar' });

      const datos = await ejecutarBusquedaCompleta(resuelto.expression, MAX_RESULTADOS_EXPORTACION);
      const buffer = await generarExcel(datos, req.usuario);

      auditarExportacion({ usuario: req.usuario, ip, formato: 'excel', totalRegistros: datos.length });

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="resultados_rbu_${Date.now()}.xlsx"`);
      res.send(buffer);
    } catch (error) {
      logger.error(`Error en exportación Excel: ${error.message}`);
      res.status(500).json({ error: 'Error al generar el archivo Excel' });
    }
  }
);

app.post('/api/exportar/pdf',
  verificarToken,
  exportLimiter,
  [body('tipo').isIn(['simple', 'avanzada', 'multiple', 'multiple-avanzada'])],
  manejarErroresValidacion,
  async (req, res) => {
    const ip = obtenerIp(req);
    try {
      const resuelto = await resolverCriteriosExportacion(req);
      if (!resuelto) return res.status(400).json({ error: 'Criterios inválidos para exportar' });

      const datos = await ejecutarBusquedaCompleta(resuelto.expression, MAX_RESULTADOS_EXPORTACION);
      const buffer = await generarPdf(datos, req.usuario, resuelto.texto);

      auditarExportacion({ usuario: req.usuario, ip, formato: 'pdf', totalRegistros: datos.length });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="resultados_rbu_${Date.now()}.pdf"`);
      res.send(buffer);
    } catch (error) {
      logger.error(`Error en exportación PDF: ${error.message}`);
      res.status(500).json({ error: 'Error al generar el archivo PDF' });
    }
  }
);

app.post('/api/reload-users', verificarToken, async (req, res) => {
  try {
    await cargarUsuarios();
    res.json({ success: true, ...getEstadoUsuarios() });
  } catch (error) {
    res.status(500).json({ error: 'Error al recargar usuarios' });
  }
});

// Manejador genérico de errores no capturados en rutas
app.use((err, req, res, next) => {
  logger.error(`Error no manejado: ${err.stack || err.message}`);
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ── Arranque ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || process.env.SERVER_PORT || 3000;

async function start() {
  if (SUPABASE_CONFIGURED) {
    initializeSupabase();
  } else {
    logger.warn('No hay configuración completa de Supabase. Las rutas de búsqueda y exportación estarán deshabilitadas.');
  }

  await cargarUsuarios();

  setInterval(async () => {
    logger.info('Recargando usuarios desde Google Sheets...');
    await cargarUsuarios();
  }, 5 * 60 * 1000);

  app.listen(PORT, '0.0.0.0', () => {
    logger.info(`Servidor ejecutándose en http://localhost:${PORT}`);
    if (SUPABASE_CONFIGURED) logger.info(`Tabla: ${TABLA}`);
    else logger.warn('Servidor iniciado sin conexión a Supabase. Solo login y carga de usuarios funcionarán.');
  });
}

process.on('SIGINT', async () => {
  logger.info('Cerrando servidor...');
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Cerrando servidor (SIGTERM)...');
  process.exit(0);
});

start().catch(err => {
  logger.error(`Error fatal al iniciar: ${err.message}`);
  process.exit(1);
});
