const http = require('http');
const fs = require('fs');

const jsonData = fs.readFileSync('./prueba.json', 'utf8');

const options = {
    hostname: 'localhost',
    port: 3000,
    path: '/api/generar',
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(jsonData)
    }
};

const req = http.request(options, (res) => {
    let body = '';
    res.on('data', chunk => body += chunk);
    res.on('end', () => {
        const respuesta = JSON.parse(body);
        if (respuesta.ok) {
            fs.writeFileSync('./correo_test.html', respuesta.html, 'utf8');
            console.log('✅ HTML guardado en correo_test.html');
        } else {
            console.error('❌ Error:', respuesta.error);
        }
    });
});

req.on('error', (e) => console.error('Error de conexión:', e.message));
req.write(jsonData);
req.end();