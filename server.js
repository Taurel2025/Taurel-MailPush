const express = require('express');
const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');
const { default: axios } = require('axios');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.use((req, res, next) => {
    console.log('----------- Nueva petición -----------');
    // console.log('Método:', req.method);
    // console.log('URL:', req.originalUrl);
    // console.log('Headers:', JSON.stringify(req.headers, null, 2));
    // console.log('Body:', JSON.stringify(req.body, null, 2));
    next();
});

const template = fs.readFileSync(path.join(__dirname, 'template.html'), 'utf8');

// ---------- Utilidades ----------
function formatTime(raw) {
    const str = raw.toString().padStart(6, '0');
    return `${str.slice(0, 2)}:${str.slice(2, 4)}`;
}

function normalizeDate(fechaStr) {
    if (!fechaStr) return '00/00/0000';
    if (fechaStr.includes('/')) return fechaStr;
    if (/^\d{8}$/.test(fechaStr)) {
        const anio = fechaStr.substring(0, 4);
        const mes = fechaStr.substring(4, 6);
        const dia = fechaStr.substring(6, 8);
        return `${dia}/${mes}/${anio}`;
    }
    return fechaStr;
}

function parseFechaHora(fechaStr, horaNum) {
    const fechaNormalizada = normalizeDate(fechaStr);
    const partes = fechaNormalizada.split('/');
    const dia = parseInt(partes[0], 10);
    const mes = parseInt(partes[1], 10) - 1;
    const anio = parseInt(partes[2], 10);
    const horaStr = (horaNum || 0).toString().padStart(6, '0');
    const hh = parseInt(horaStr.slice(0, 2), 10);
    const mm = parseInt(horaStr.slice(2, 4), 10);
    const ss = parseInt(horaStr.slice(4, 6), 10);
    return new Date(anio, mes, dia, hh, mm, ss);
}

// ---------- Normalizador de filas ----------
function extraerRowset(contenedor, mapping = null) {
    if (!contenedor) return [];
    let raw = null;
    if (Array.isArray(contenedor)) {
        raw = contenedor;
    } else if (contenedor.rowset) {
        raw = contenedor.rowset;
    } else {
        const keys = Object.keys(contenedor);
        console.log('Keys encontradas en contenedor:', keys);
        const dataBrowserKey = keys.find(k => k.startsWith('fs_DATABROWSE_'));
        if (dataBrowserKey) {
            const browser = contenedor[dataBrowserKey];
            if (browser && browser.data && browser.data.gridData && browser.data.gridData.rowset) {
                raw = browser.data.gridData.rowset;
            }
        }
    }
    if (!raw) throw new Error('Formato de datos no reconocido');
    if (!mapping) return raw;
    return raw.map((fila) => {
        const mapeada = {};
        for (const [destKey, srcKey] of Object.entries(mapping)) {
            if (fila[srcKey] !== undefined) {
                if (['CodigoEtapa','SecuenciaEtapa','ExpedienteHouse','ExpedienteAduana','HoraEtapa'].includes(destKey)) {
                    mapeada[destKey] = fila[srcKey] !== null && fila[srcKey] !== '' ? Number(fila[srcKey].toString().trim()) : 0;
                } else {
                    mapeada[destKey] = fila[srcKey] ? fila[srcKey].toString().trim() : '';
                }
            } else {
                mapeada[destKey] = undefined;
            }
        }
        return { ...fila, ...mapeada };
    });
}

// ---------- Procesar envío ----------
function procesarEnvio(jsonData) {
    if (!jsonData) throw new Error('Cuerpo JSON vacío');

    const mappingEtapas = { CodigoEtapa: 'F0005_KY', NombreEtapa: 'F0005_DL01' };
    console.log('Extrayendo etapas posibles...', mappingEtapas);
    const etapasPosiblesRaw = extraerRowset(jsonData["DR-MailPush-Etapas"], mappingEtapas);
    console.log('Etapas posibles extraídas:', etapasPosiblesRaw.length, etapasPosiblesRaw.map(e => e.CodigoEtapa));
    if (etapasPosiblesRaw.length === 0) throw new Error('DR-MailPush-Etapas está vacío');
    const etapasPosibles = etapasPosiblesRaw.map(e => ({
        codigo: e.CodigoEtapa,
        nombre: e.NombreEtapa
    }));

    const mappingRealizadas = {
        CodigoEtapa: 'F55SA101_Y55CODETA',
        SecuenciaEtapa: 'F55SA101_Y55SECUEN' in (jsonData["DR-MailPush-V55SA176"]?.fs_DATABROWSE_V55SA176?.data?.gridData?.rowset?.[0] || {}) ? 'F55SA101_Y55SECUEN' : 'F55SA100_Y55SECUEN',
        ExpedienteHouse: 'F55SA101_Y55HOJOB',
        ExpedienteAduana: 'F55SA101_Y55IMJOB',
        FechaEtapa: 'F55SA101_Y55FEETAPA',
        HoraEtapa: 'F55SA101_Y55HETAPA'
    };
    const etapasRealizadasRaw = extraerRowset(jsonData["DR-MailPush-V55SA176"], mappingRealizadas);
    if (etapasRealizadasRaw.length === 0) throw new Error('DR-MailPush-V55SA176 está vacío');

    etapasRealizadasRaw.forEach((e, i) => {
        if (!e.ExpedienteHouse) throw new Error(`Falta ExpedienteHouse en fila ${i}`);
        if (!e.CodigoEtapa) throw new Error(`Falta CodigoEtapa en fila ${i}`);
    });

    const etapasRealizadas = etapasRealizadasRaw
        .map(e => ({
            ...e,
            CodigoEtapa: parseInt(e.CodigoEtapa.toString().trim(), 10),
            FechaEtapa: normalizeDate(e.FechaEtapa),
            HoraEtapa: e.HoraEtapa,
            fechaObj: parseFechaHora(e.FechaEtapa, e.HoraEtapa)
        }))
        .sort((a, b) => a.fechaObj - b.fechaObj);

    let correos = [];
    let cc = '';
    const campoCorreo = jsonData["DR-MailPush-Correo"] || jsonData["DR-MailPush-CorreoCliente"];
    if (campoCorreo) {
        try {
            const filasCorreo = extraerRowset(campoCorreo, { CorreoCliente: 'F01151_EMAL' });
            correos = filasCorreo.map(r => r.CorreoCliente.trim()).filter(Boolean);
        } catch (e) {}
    }
    // if (correos.length === 0 && jsonData.CorreoUsuario) correos = [jsonData.CorreoUsuario.trim()];
    cc = jsonData.CorreoUsuario ? jsonData.CorreoUsuario.trim() : '';
    const nombreCliente = jsonData.NombreCompleto || "Cliente";
    
    const numSeguimiento = etapasRealizadas[0].ExpedienteHouse.toString();
    const numManifiesto = jsonData.NumeroMaster || jsonData.NumeroManifiesto || '';

    const todasCompletadas = etapasPosibles.every(ep => etapasRealizadas.some(r => r.CodigoEtapa === ep.codigo));
    const lastRealizada = todasCompletadas ? null : etapasRealizadas[etapasRealizadas.length - 1];
    const totalEtapas = etapasPosibles.length;

    // ===== GENERAR SOLO LAS FILAS DEL TIMELINE (sin tabla contenedora) =====
    let timelineHtml = '';
    etapasPosibles.forEach((etapaPosible, idx) => {
        const realizada = etapasRealizadas.find(r => r.CodigoEtapa === etapaPosible.codigo);
        const esPrimera = idx === 0;
        const esUltima = idx === totalEtapas - 1;
        let circleStyle = '';
        let circleContent = '○';
        let colorNombre = '#9CA3AF';
        let pesoNombre = 'normal';
        let fechaTexto = 'Pendiente';
        let colorFecha = '#9CA3AF';
        let pesoFecha = 'normal';

        if (realizada) {
            if (todasCompletadas) {
                circleStyle = 'width:40px;height:40px;background:#2163FF;border-radius:50%;line-height:40px;color:white;font-size:18px;text-align:center;';
                circleContent = '✓';
                fechaTexto = `${realizada.FechaEtapa} ${formatTime(realizada.HoraEtapa)}`;
                colorFecha = '#002399';
            } else {
                if (realizada === lastRealizada) {
                    circleStyle = 'width:40px;height:40px;background:#002399;border-radius:50%;line-height:40px;color:white;font-size:18px;text-align:center;border:3px solid #2163FF;box-sizing:border-box;';
                    circleContent = '●';
                    fechaTexto = 'Ahora';
                    colorFecha = '#2163FF';
                    pesoFecha = 'bold';
                } else {
                    circleStyle = 'width:40px;height:40px;background:#2163FF;border-radius:50%;line-height:40px;color:white;font-size:18px;text-align:center;';
                    circleContent = '✓';
                    fechaTexto = `${realizada.FechaEtapa} ${formatTime(realizada.HoraEtapa)}`;
                    colorFecha = '#002399';
                }
            }
            colorNombre = '#002399';
            pesoNombre = 'bold';
        }

        // Línea vertical: columna central de 2px con color gris (excepto en los extremos)
        let lineaColor = '#d1d5db';
        if (esPrimera) lineaColor = 'transparent';
        if (esUltima) lineaColor = 'transparent';

        timelineHtml += `
        <tr>
            <td width="60" style="vertical-align:top; padding:0;">
                <table role="presentation" cellspacing="0" cellpadding="0" width="60" style="height:100%;">
                    <tr>
                        <td width="29" style="vertical-align:top; padding:0;"></td>
                        <td width="2" style="vertical-align:top; padding:0; background-color:${lineaColor}; height:100%;"></td>
                        <td width="29" style="vertical-align:middle; text-align:center; padding:0;">
                            <div style="display:inline-block; ${circleStyle} margin-left:-21px;">${circleContent}</div>
                        </td>
                    </tr>
                </table>
            </td>
            <td style="vertical-align:middle; padding:0 0 15px 20px;">
                <p style="margin:0; font-size:13px; font-weight:${pesoNombre}; color:${colorNombre};">${etapaPosible.nombre}</p>
                <p style="margin:0; font-size:12px; font-weight:${pesoFecha}; color:${colorFecha};">${fechaTexto}</p>
            </td>
        </tr>`;
    });

    const estadoActualTexto = todasCompletadas
        ? 'Completado'
        : (lastRealizada ? lastRealizada.FechaEtapa + ' ' + formatTime(lastRealizada.HoraEtapa) : 'Pendiente');

    const origen = jsonData.CiudadOrigen || 'No especificado';
    const destino = jsonData.CiudadDestino || 'No especificado';
    const puertoOrigen = 'Puerto de Carga';
    const fechaEntrega = todasCompletadas
        ? etapasRealizadas[etapasRealizadas.length - 1].FechaEtapa
        : (lastRealizada ? lastRealizada.FechaEtapa : 'Por determinar');

    let html = template
        .replace('{{ESTADO_ACTUAL}}', estadoActualTexto)
        .replace('{{NOMBRE_CLIENTE}}', nombreCliente)
        .replace('{{NUM_SEGUIMIENTO}}', `${numSeguimiento} / ${numManifiesto}`)
        .replace('{{TIMELINE_HTML}}', timelineHtml)       // ¡solo las filas!
        .replace('{{ORIGEN}}', origen)
        .replace('{{PUERTO_ORIGEN}}', puertoOrigen)
        .replace('{{DESTINO}}', destino)
        .replace('{{FECHA_ENTREGA}}', fechaEntrega);

    return { html, nombreCliente, numSeguimiento, correos, cc };
}

app.get('/', (req, res) => res.send('✅ API de generación de correos Taurel funcionando. Usa POST /api/generar'));

app.post('/generar', (req, res) => {
    try {

        if (datos.correos.length === 0) {
            datos.correos.push(datos.cc);
        }

        const jsonData = req.body;
        const datos = procesarEnvio(jsonData);
        axios.post(process.env.MAIL_SERVER, { emailBody: datos.html, subject: `Estado de envío ${datos.numSeguimiento} - ${datos.nombreCliente}`, recipient: datos.correos.join(', '), cc: datos.cc })
            .then(response => console.log('Simulación de envío exitosa:', response.data))
            .catch(error => console.error('Error en simulación de envío:', error.message));
        res.json({ ok: true, asunto: `Estado de envío ${datos.numSeguimiento} - ${datos.nombreCliente}`, destinatarios: datos.correos, cc: datos.cc, html: datos.html });
    } catch (error) {
        console.error('Error:', error.message);
        res.status(400).json({ ok: false, error: error.message });
    }
});

app.listen(PORT, () => console.log(`🚀 Servidor corriendo en http://localhost:${PORT}\n📬 Endpoint: POST http://localhost:${PORT}/api/generar`));