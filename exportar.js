const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const ETIQUETAS_CAMPOS = {
  VC_DNI: 'DNI',
  VC_CODIGO_UBIGEO: 'Código UBIGEO',
  VC_DEPARTAMENTO: 'Departamento',
  VC_PROVINCIA: 'Provincia',
  VC_DISTRITO: 'Distrito',
  VC_CCPP: 'Centro Poblado',
  VC_SECTOR: 'Sector',
  VC_DIRECCION_P65: 'Dirección P65',
  VC_DIRECCION_DJ: 'Dirección DJ',
  VC_DIRECCION_SISFOH: 'Dirección SISFOH',
  VC_PATERNO: 'Apellido Paterno',
  VC_MATERNO: 'Apellido Materno',
  VC_NOMBRE: 'Nombre',
  VC_FECHA_NACIMIENTO: 'Fecha Nacimiento',
  NM_EDAD: 'Edad',
  VC_RANGO_EDAD: 'Rango Edad',
  VC_SEXO: 'Sexo',
  VC_TELEFONO_TAYTA: 'Teléfono Tayta',
  VC_CONTACTO: 'Contacto',
  VC_FECHA_INGRESO: 'Fecha Ingreso',
  VC_FECHA_REINGRESO: 'Fecha Reingreso',
  VC_FECHA_ULTIMA_VISITA: 'Última Visita',
  VC_FECHA_SINCRONIZACION: 'Fecha Sincronización'
};

async function generarExcel(datos, usuario) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Motor de Búsqueda RBU';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet('Resultados');

  if (datos.length === 0) {
    sheet.addRow(['Sin resultados']);
    return workbook.xlsx.writeBuffer();
  }

  const columnas = Object.keys(datos[0]);
  sheet.columns = columnas.map(col => ({
    header: ETIQUETAS_CAMPOS[col] || col,
    key: col,
    width: 22
  }));

  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1B3A5C' } };
  sheet.getRow(1).alignment = { vertical: 'middle' };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  datos.forEach(row => sheet.addRow(row));

  sheet.eachRow((row, rowNum) => {
    row.eachCell(cell => {
      cell.border = {
        bottom: { style: 'thin', color: { argb: 'FFE0E0E0' } }
      };
      if (rowNum > 1) cell.font = { size: 10 };
    });
  });

  // Hoja de metadatos para trazabilidad de la exportación
  const meta = workbook.addWorksheet('Información');
  meta.addRow(['Generado por', usuario || 'desconocido']);
  meta.addRow(['Fecha de generación', new Date().toLocaleString('es-PE')]);
  meta.addRow(['Total de registros', datos.length]);
  meta.addRow(['Confidencialidad', 'Este archivo contiene datos personales. Uso restringido al personal autorizado.']);
  meta.getColumn(1).font = { bold: true };
  meta.getColumn(1).width = 22;
  meta.getColumn(2).width = 50;

  return workbook.xlsx.writeBuffer();
}

function generarPdf(datos, usuario, criteriosTexto) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
      const chunks = [];
      doc.on('data', chunk => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.fontSize(16).fillColor('#1B3A5C').text('Motor de Búsqueda — Monitoreo RBU', { align: 'left' });
      doc.fontSize(9).fillColor('#666666')
        .text(`Generado por: ${usuario || 'desconocido'}  |  Fecha: ${new Date().toLocaleString('es-PE')}  |  Total: ${datos.length} registro(s)`);
      if (criteriosTexto) {
        doc.text(`Criterios: ${criteriosTexto}`);
      }
      doc.moveDown(0.5);
      doc.fontSize(8).fillColor('#a33').text('Documento con datos personales. Uso restringido al personal autorizado.');
      doc.moveDown(0.8);

      if (datos.length === 0) {
        doc.fontSize(11).fillColor('#333').text('No se encontraron resultados.');
        doc.end();
        return;
      }

      const columnasPreferidas = ['VC_DNI', 'VC_PATERNO', 'VC_MATERNO', 'VC_NOMBRE', 'VC_DEPARTAMENTO', 'VC_PROVINCIA', 'VC_DISTRITO', 'NM_EDAD', 'VC_TELEFONO_TAYTA'];
      const columnas = columnasPreferidas.filter(c => Object.keys(datos[0]).includes(c));

      const tableTop = doc.y + 5;
      const pageWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const colWidth = pageWidth / columnas.length;

      function dibujarEncabezado(y) {
        doc.fontSize(8).fillColor('#FFFFFF');
        doc.rect(doc.page.margins.left, y, pageWidth, 18).fill('#1B3A5C');
        columnas.forEach((col, i) => {
          doc.fillColor('#FFFFFF').text(
            ETIQUETAS_CAMPOS[col] || col,
            doc.page.margins.left + i * colWidth + 4,
            y + 5,
            { width: colWidth - 8, ellipsis: true }
          );
        });
      }

      let y = tableTop;
      dibujarEncabezado(y);
      y += 20;

      datos.forEach((row, idx) => {
        if (y > doc.page.height - doc.page.margins.bottom - 20) {
          doc.addPage();
          y = doc.page.margins.top;
          dibujarEncabezado(y);
          y += 20;
        }
        if (idx % 2 === 0) {
          doc.rect(doc.page.margins.left, y - 2, pageWidth, 16).fill('#F5F7FA');
        }
        doc.fontSize(7.5).fillColor('#333333');
        columnas.forEach((col, i) => {
          doc.text(
            String(row[col] ?? '-'),
            doc.page.margins.left + i * colWidth + 4,
            y,
            { width: colWidth - 8, ellipsis: true }
          );
        });
        y += 16;
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { generarExcel, generarPdf, ETIQUETAS_CAMPOS };
