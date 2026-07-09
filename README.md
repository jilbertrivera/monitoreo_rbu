# Motor de Búsqueda RBU

Aplicación de búsqueda interna que usa:

- frontend estático en GitHub Pages
- backend Node.js/Express desplegado en Render (u otro host Node.js)
- Supabase como origen de datos
- Google Sheets para autenticación de usuarios

## Archivos principales

- `index.html` - Página de login.
- `busqueda.html` - Interfaz de búsqueda e importación/exportación.
- `server.js` - API backend en Node.js/Express.
- `usuarios.js` - Carga de usuarios desde Google Sheets.
- `exportar.js` - Genera archivos Excel/PDF.
- `hash-password.js` - Utilidad para generar hashes bcrypt.
- `.env.example` - Plantilla de variables de entorno.

## Instalación local

1. Copia `.env.example` a `.env`.
2. Llena los valores reales en `.env`.
3. Instala dependencias:
   ```bash
   npm install
   ```
4. Inicia el servidor local:
   ```bash
   npm start
   ```
5. Abre en el navegador:
   ```
   http://localhost:3000/index.html
   ```

## Configuración de variables de entorno

En `.env` o en el panel de Render / Railway, configura:

- `SUPABASE_URL` - URL pública de tu proyecto Supabase.
- `SUPABASE_KEY` - Clave de servicio o anon de Supabase.
- `SUPABASE_SCHEMA` - Esquema de la tabla en Supabase, generalmente `public`.
- `SUPABASE_TABLE` - Nombre de la tabla en Supabase.
- `JWT_SECRET` - Secreto JWT de al menos 32 caracteres.
- `GOOGLE_SHEET_ID` - ID de la hoja de cálculo de Google Sheets.
- `GOOGLE_API_KEY` - API key de Google para leer Sheets.
- `GOOGLE_SHEET_NAME` - Nombre de la pestaña con usuarios.
- `GOOGLE_SHEET_GID` - GID de la hoja con usuarios.
- `GOOGLE_PUBLISHED_ID` - ID opcional de CSV publicado si usas la hoja publicada.
- `ALLOWED_ORIGINS` - Orígenes permitidos separados por comas. Ejemplo:
  `https://<tu-usuario>.github.io,https://tu-app.onrender.com`

## Despliegue del backend en Render / Railway

1. Conecta este repositorio al servicio.
2. Usa el comando de inicio:
   ```bash
   npm start
   ```
3. Asegúrate de que la aplicación escuche `process.env.PORT`.
4. Define las variables de entorno listadas arriba.
5. Publica el servicio.

### Verificación del backend

- Abre `https://tu-app.onrender.com/api/health`.
- Debe devolver:
  ```json
  { "success": true, "uptime": ..., "env": ... }
  ```
- Abre `https://tu-app.onrender.com/api/test-conexion` para comprobar la carga de usuarios de Google Sheets.

## Despliegue del frontend en GitHub Pages

GitHub Pages puede alojar solo los archivos estáticos del frontend (`index.html`, `busqueda.html`, CSS y JavaScript).

1. Publica el repositorio en GitHub Pages.
2. En `index.html` y `busqueda.html`, define la URL de tu backend antes de cualquier script, por ejemplo:
   ```html
   <script>
     window.API_BASE_URL = 'https://tu-app.onrender.com/api';
   </script>
   ```
3. Asegúrate de que `ALLOWED_ORIGINS` incluya el dominio de GitHub Pages y el dominio del backend.

## Flujo esperado

1. Usuario abre GitHub Pages.
2. El frontend envía peticiones a `https://tu-app.onrender.com/api`.
3. El backend en Render usa Supabase para ejecutar las búsquedas.
4. Los resultados se muestran en el frontend.

## Requisitos

- Node.js 18+
- Proyecto Supabase con `SUPABASE_URL` y `SUPABASE_KEY`
- Secreto JWT seguro
- Acceso válido a Google Sheets

## Notas importantes

- El backend ya no depende de Oracle.
- **No publiques `.env`**. Las credenciales de Supabase son obligatorias y deben estar en `.env`.
- `.gitignore` ya excluye `.env`, `node_modules/` y `logs/`.
- Si la API de Google Sheets da error 403, usa `GOOGLE_PUBLISHED_ID` y publica la hoja en CSV.

## Seguridad

- ✅ El servidor **no arranca** sin `JWT_SECRET` válido (mínimo 32 caracteres, no permite placeholders).
- ✅ Comparación de credenciales con tiempo constante para evitar timing attacks.
- ✅ Rate limiting en login (10/15min), búsquedas (30/min) y exportaciones (15/5min).
- ✅ Headers de seguridad con Helmet.
- ✅ Validación de inputs con express-validator.
- ✅ CORS restrictivo con lista blanca configurable.
- ✅ Auditoría completa de búsquedas, logins y exportaciones (logs separados, retención 180 días).
- ✅ Soporte para hashes bcrypt en credenciales (migración gradual desde texto plano).
- ✅ Límites de paginación y exportación para prevenir DoS.
